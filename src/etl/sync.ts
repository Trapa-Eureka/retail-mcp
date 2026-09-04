/**
 * ETL sync orchestration (DESIGN §5, §11.1, §11.2).
 * Order: stores → items → receipts → inventory (this order is kept because of FK dependencies —
 * sales_lines/inventory_levels/inventory_snapshots reference stores and products).
 * Processing all pages of one resource + upsert + watermark update are wrapped in a single
 * Warehouse.transaction() — if a page fails midway, that resource's data and watermark roll back
 * together and the next run safely retries from the previous watermark. This is an assembly layer
 * with no LLM involvement — the whole process is deterministic.
 *
 * This file is the **Loyverse-only path** (TASKS T12) — it assumes `LoyverseClient`'s
 * receipt-level incremental sync model as-is. The CSV/Excel channel does not reuse `syncAll()`;
 * it writes to `Warehouse` directly from its own orchestration (`folderScan.ts`, TASKS T18) —
 * folder scanning is a "re-read the whole current file every time as a snapshot" model, which
 * does not fit the watermark/cursor based incremental sync here.
 */
import { randomUUID } from "node:crypto";
import type {
  Clock,
  InventoryRow,
  LoyverseClient,
  LvItem,
  ProductRow,
  SalesLineRow,
  StoreRow,
  Warehouse,
} from "../core/types.js";

export type SyncResource = "stores" | "items" | "receipts" | "inventory";

export interface ResourceSyncResult {
  resource: SyncResource;
  status: "success" | "failed" | "skipped";
  /** Number of rows this run attempted to load (on success). 0 if failed/skipped. */
  itemCount: number;
  error?: string;
  /** Filled only on success — null if failed/skipped (the previous success time is read from sync_status in the DB). */
  lastSyncedAt: Date | null;
}

export interface SyncResult {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  resources: ResourceSyncResult[];
  /** false if any resource is not success — an earlier resource's success is not hidden behind a later failure. */
  ok: boolean;
}

export interface SyncOptions {
  /** Default: clock.now().toISOString() — identifier that ties inventory snapshots and logs to one run. */
  runId?: string;
  /** Default: all four. For partial-sync tests (e.g. stores only in the smoke script). */
  resources?: SyncResource[];
}

export interface SyncDeps {
  loyverseClient: LoyverseClient;
  warehouse: Warehouse;
  clock: Clock;
}

const RECEIPTS_EPOCH_ISO = "1970-01-01T00:00:00.000Z";
/** Maximum rows per upsert call — stays well below the Postgres parameter cap (65535) (T10 prepared for 50k rows). */
const UPSERT_CHUNK_SIZE = 1000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function syncStores(deps: SyncDeps): Promise<ResourceSyncResult> {
  try {
    const stores = await deps.loyverseClient.listStores();
    const rows: StoreRow[] = stores.map((s) => ({ id: s.id, name: s.name }));
    const at = deps.clock.now();
    await deps.warehouse.transaction(async (tx) => {
      for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) await tx.upsertStores(batch);
      await tx.setCursor("stores", at.toISOString(), at);
    });
    return { resource: "stores", status: "success", itemCount: rows.length, lastSyncedAt: at };
  } catch (err) {
    return {
      resource: "stores",
      status: "failed",
      itemCount: 0,
      error: errorMessage(err),
      lastSyncedAt: null,
    };
  }
}

async function syncItems(deps: SyncDeps): Promise<ResourceSyncResult> {
  try {
    const allItems: LvItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await deps.loyverseClient.listItems(cursor);
      allItems.push(...page.items);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);

    const rows: ProductRow[] = allItems.flatMap((item) =>
      item.variants.map((v) => ({
        variantId: v.variant_id,
        itemId: item.id,
        name: item.item_name,
        sku: v.sku,
        // Resolving the category "name" (Categories API) is outside the DESIGN §4 LoyverseClient
        // contract — v0.1 stores category_id as-is (name resolution is queued for v0.2).
        category: item.category_id,
      })),
    );

    const at = deps.clock.now();
    await deps.warehouse.transaction(async (tx) => {
      for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) await tx.upsertProducts(batch);
      await tx.setCursor("items", at.toISOString(), at);
    });
    return { resource: "items", status: "success", itemCount: rows.length, lastSyncedAt: at };
  } catch (err) {
    return {
      resource: "items",
      status: "failed",
      itemCount: 0,
      error: errorMessage(err),
      lastSyncedAt: null,
    };
  }
}

async function syncReceipts(deps: SyncDeps): Promise<ResourceSyncResult> {
  try {
    const previousWatermark = await deps.warehouse.getCursor("receipts");
    const sinceISO = previousWatermark ?? RECEIPTS_EPOCH_ISO;
    // Receipts whose updated_at is greater than OR "equal to" the watermark are queried again
    // (stable re-query on ties, DESIGN §11.1) — receiving an already-loaded receipt again is safe
    // thanks to the PK(receipt_id, line_no) upsert.
    let maxUpdatedAt: string | null = previousWatermark;
    let itemCount = 0;

    await deps.warehouse.transaction(async (tx) => {
      const allLines: SalesLineRow[] = [];
      let cursor: string | undefined;
      do {
        const page = await deps.loyverseClient.listReceipts(sinceISO, cursor);
        for (const receipt of page.items) {
          itemCount += 1;
          if (maxUpdatedAt === null || receipt.updated_at > maxUpdatedAt) {
            maxUpdatedAt = receipt.updated_at;
          }
          // Cancelled receipts are treated as incomplete transactions and excluded from aggregation (SPEC §9, DESIGN §11.3).
          // Note (known limitation, v0.1): if a receipt that was already loaded earlier is cancelled
          // later, its lines are not reloaded/updated here — logic that deletes already-loaded
          // sales_lines is out of v0.1 scope (assuming cancellations usually happen right after
          // creation). To be addressed in v0.2.
          if (receipt.cancelled_at !== null) continue;

          const sign = receipt.receipt_type === "REFUND" ? -1 : 1;
          receipt.line_items.forEach((li, lineNo) => {
            allLines.push({
              receiptId: receipt.receipt_number,
              lineNo,
              storeId: receipt.store_id,
              variantId: li.variant_id,
              qty: String(sign * li.quantity),
              gross: String(sign * li.gross_total_money),
              discount: String(li.total_discount),
              soldAt: new Date(receipt.receipt_date),
            });
          });
        }
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined);

      for (const batch of chunk(allLines, UPSERT_CHUNK_SIZE)) {
        await tx.upsertSalesLines(batch);
      }
      if (maxUpdatedAt !== null && maxUpdatedAt !== previousWatermark) {
        await tx.setCursor("receipts", maxUpdatedAt, deps.clock.now());
      }
    });

    return { resource: "receipts", status: "success", itemCount, lastSyncedAt: deps.clock.now() };
  } catch (err) {
    return {
      resource: "receipts",
      status: "failed",
      itemCount: 0,
      error: errorMessage(err),
      lastSyncedAt: null,
    };
  }
}

async function syncInventory(deps: SyncDeps, runId: string): Promise<ResourceSyncResult> {
  try {
    const rawLevels: {
      store_id: string;
      variant_id: string;
      in_stock: number;
      updated_at: string;
    }[] = [];
    let cursor: string | undefined;
    do {
      const page = await deps.loyverseClient.listInventory(cursor);
      rawLevels.push(...page.items);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);

    // An empty inventory response is treated as a sync error rather than silently leaving the
    // existing stock in place (DESIGN §11.2) — upserts never delete, so no data is destroyed, but
    // a genuinely empty response is itself most likely a sign of a token permission/API problem.
    if (rawLevels.length === 0) {
      throw new Error(
        "Loyverse inventory response is empty. Existing stock is left unchanged and this is " +
          "treated as a sync error. Check that the Loyverse token has the INVENTORY_READ permission " +
          "and that the account actually has inventory data.",
      );
    }

    const at = deps.clock.now();
    const rows: InventoryRow[] = rawLevels.map((l) => ({
      storeId: l.store_id,
      variantId: l.variant_id,
      inStock: String(l.in_stock),
      updatedAt: new Date(l.updated_at),
    }));

    await deps.warehouse.transaction(async (tx) => {
      for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) await tx.upsertInventory(batch);
      for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
        await tx.appendInventorySnapshot(runId, at, batch);
      }
      await tx.setCursor("inventory", at.toISOString(), at);
    });

    return { resource: "inventory", status: "success", itemCount: rows.length, lastSyncedAt: at };
  } catch (err) {
    return {
      resource: "inventory",
      status: "failed",
      itemCount: 0,
      error: errorMessage(err),
      lastSyncedAt: null,
    };
  }
}

function skipped(resource: SyncResource, reason: string): ResourceSyncResult {
  return { resource, status: "skipped", itemCount: 0, error: reason, lastSyncedAt: null };
}

/**
 * Syncs the four resources in order. If the stores/items sync was attempted in this run and
 * failed, receipts/inventory are not even attempted and are reported as "skipped" because of the
 * FK dependency (both reference stores and products, so attempting them would only fail with an
 * FK violation) — resources that were not run are reported separately from resources that failed.
 */
export async function syncAll(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncResult> {
  const startedAt = deps.clock.now();
  // Generated with randomUUID rather than the clock so that repeated runs with a FixedClock are
  // still distinguishable per run (TESTING §7: two syncs with a same-time FixedClock must be
  // distinguishable per run without snapshot PK collisions).
  const runId = opts.runId ?? randomUUID();
  const wanted = new Set<SyncResource>(
    opts.resources ?? ["stores", "items", "receipts", "inventory"],
  );
  const results: ResourceSyncResult[] = [];

  let storesOk = true;
  if (wanted.has("stores")) {
    const r = await syncStores(deps);
    results.push(r);
    storesOk = r.status === "success";
  }

  let itemsOk = true;
  if (wanted.has("items")) {
    const r = await syncItems(deps);
    results.push(r);
    itemsOk = r.status === "success";
  }

  const dependenciesOk = storesOk && itemsOk;
  const skipReason = "skipped FK-dependent resource because the stores/items sync failed";

  if (wanted.has("receipts")) {
    results.push(dependenciesOk ? await syncReceipts(deps) : skipped("receipts", skipReason));
  }
  if (wanted.has("inventory")) {
    results.push(
      dependenciesOk ? await syncInventory(deps, runId) : skipped("inventory", skipReason),
    );
  }

  const finishedAt = deps.clock.now();
  return {
    runId,
    startedAt,
    finishedAt,
    resources: results,
    ok: results.every((r) => r.status === "success"),
  };
}
