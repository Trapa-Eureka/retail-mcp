/**
 * Mock LoyverseClient that replays fixtures/loyverse/*.json (TESTING.md §2).
 * Parses with the real API response schemas (zod) and returns values narrowed to the internal Lv* types.
 * Cursor-based pagination is actually reproduced — no network calls.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoyverseClient, LvReceipt, Page } from "../core/types.js";
import {
  LvInventoryResponseSchema,
  LvItemsResponseSchema,
  LvReceiptsResponseSchema,
  LvStoresResponseSchema,
  toLvInventoryLevel,
  toLvItem,
  toLvReceipt,
  toLvStore,
} from "../adapters/loyverseSchemas.js";

const DEFAULT_FIXTURES_DIR = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../fixtures/loyverse",
);

export interface FixtureLoyverseClientOptions {
  fixturesDir?: string;
  itemsPageSize?: number;
  receiptsPageSize?: number;
  inventoryPageSize?: number;
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be an integer of 1 or more. Received: ${value}. ` +
        `A page size of 0/negative/fraction/NaN could repeat empty pages forever.`,
    );
  }
}

interface CursorPayload {
  offset: number;
  [key: string]: unknown;
}

/** Encodes the cursor together with the query condition (queryTag) as an opaque token. */
function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { offset?: unknown }).offset !== "number"
  ) {
    throw new Error(
      `Invalid cursor: "${cursor}". Pass only the cursor string exactly as issued by ` +
        `FixtureLoyverseClient in a previous response.`,
    );
  }
  return parsed as CursorPayload;
}

/**
 * Slices an array one page at a time using an offset-based cursor. The cursor is an opaque token
 * that also encodes the query condition at issue time (queryTag, e.g. listReceipts' sinceISO) —
 * reusing it with a different queryTag (e.g. passing a changed sinceISO) is rejected with a clear error.
 */
function paginate<T>(
  all: T[],
  pageSize: number,
  cursor: string | undefined,
  queryTag: Record<string, unknown> = {},
): Page<T> {
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    const { offset: decodedOffset, ...decodedTag } = decoded;
    if (JSON.stringify(decodedTag) !== JSON.stringify(queryTag)) {
      throw new Error(
        "The cursor can only be used with the same query condition as the initial call. " +
          "To change the condition, call again without a cursor.",
      );
    }
    offset = decodedOffset;
  }
  const items = all.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  const cursorOut =
    nextOffset < all.length ? encodeCursor({ offset: nextOffset, ...queryTag }) : null;
  return { items, cursor: cursorOut };
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as unknown;
}

export async function createFixtureLoyverseClient(
  opts: FixtureLoyverseClientOptions = {},
): Promise<LoyverseClient> {
  const dir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const itemsPageSize = opts.itemsPageSize ?? 5;
  const receiptsPageSize = opts.receiptsPageSize ?? 40;
  const inventoryPageSize = opts.inventoryPageSize ?? 10;
  assertPositiveInt("itemsPageSize", itemsPageSize);
  assertPositiveInt("receiptsPageSize", receiptsPageSize);
  assertPositiveInt("inventoryPageSize", inventoryPageSize);

  const storesRaw = LvStoresResponseSchema.parse(await readJson(path.join(dir, "stores.json")));
  const itemsRaw = LvItemsResponseSchema.parse(await readJson(path.join(dir, "items.json")));
  const receiptsRaw = LvReceiptsResponseSchema.parse(
    await readJson(path.join(dir, "receipts.json")),
  );
  const inventoryRaw = LvInventoryResponseSchema.parse(
    await readJson(path.join(dir, "inventory.json")),
  );

  const stores = storesRaw.stores.map(toLvStore);
  const items = itemsRaw.items.map(toLvItem);

  const allReceipts: LvReceipt[] = receiptsRaw.receipts
    .map(toLvReceipt)
    // Like the real API, guarantee ordering by the watermark basis (updated_at) — not receipt_date.
    // Ties are made stably re-queryable by receipt_number (DESIGN §11.1).
    .sort(
      (a, b) =>
        a.updated_at.localeCompare(b.updated_at) ||
        a.receipt_number.localeCompare(b.receipt_number),
    );

  const inventory = inventoryRaw.inventory_levels.map(toLvInventoryLevel);

  return {
    listStores() {
      return Promise.resolve(stores);
    },

    listItems(cursor?: string) {
      // Errors thrown by paginate() (invalid cursor) are delivered as a Promise rejection, not a synchronous throw.
      return Promise.resolve().then(() => paginate(items, itemsPageSize, cursor));
    },

    listReceipts(sinceISO: string, cursor?: string) {
      // sinceISO maps to the real API's updated_at_min — filtering must be by updated_at rather
      // than receipt_date so that later refunds/cancellations/edits of old receipts are not missed.
      return Promise.resolve().then(() => {
        const filtered = allReceipts.filter((r) => r.updated_at >= sinceISO);
        return paginate(filtered, receiptsPageSize, cursor, { sinceISO });
      });
    },

    listInventory(cursor?: string) {
      return Promise.resolve().then(() => paginate(inventory, inventoryPageSize, cursor));
    },
  };
}
