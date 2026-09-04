/**
 * Warehouse implementation shared by pg and PGlite. The connection is injected from outside
 * (production = pg.Pool, tests = PGlite).
 * All SQL is parameterised fixed queries — values are never interpolated directly into SQL.
 * `transaction(fn)` is implemented with real BEGIN/COMMIT/ROLLBACK (DESIGN §11.1, T1 adversarial review 002-02).
 */
import type {
  AgentSendEntry,
  AgentSendStatus,
  InventoryRow,
  ProductRow,
  PurchaseAgg,
  PurchaseReceiptRow,
  SalesAgg,
  SalesAggQuery,
  SalesLineRow,
  SalesPeriodAggRow,
  StockQuery,
  StockRow,
  StoreRow,
  SyncStateRow,
  Warehouse,
} from "../core/types.js";

// ── Connection abstraction ─────────────────────────────────────────────

/** Minimal interface for running parameterised queries on a single session. */
export interface DbSession {
  query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface DbConnection extends DbSession {
  /** Returns the session. A real return for pg.Pool; a no-op for single-session backends like PGlite. */
  release(): void;
}

/** How pgWarehouse obtains a session — either pg.Pool.connect() or a wrapped PGlite instance. */
export interface DbConnectionProvider {
  acquire(): Promise<DbConnection>;
}

/** Minimal signature satisfied by a node-postgres Pool (taken as a structural type instead of a direct dependency). */
export interface PgPoolLike {
  connect(): Promise<{
    query<T extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
    release(): void;
  }>;
}

export function createPgConnectionProvider(pool: PgPoolLike): DbConnectionProvider {
  return {
    async acquire() {
      const client = await pool.connect();
      return {
        query: (text, params) => client.query(text, params),
        release: () => client.release(),
      };
    },
  };
}

/** Minimal signature satisfied by a PGlite instance (test-only). */
export interface PgliteLike {
  query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export function createPgliteConnectionProvider(db: PgliteLike): DbConnectionProvider {
  return {
    acquire() {
      // PGlite is always a single session — release is a no-op, and multiple acquire() calls share the same session
      // (a known limitation of the test environment: real multi-connection concurrency cannot be verified with PGlite).
      return Promise.resolve({
        query: (text: string, params?: unknown[]) => db.query(text, params),
        release: () => {},
      });
    },
  };
}

/** Exported so that exploreSqlExecutor.ts (explore_sql only) can reuse the same acquire/release pattern. */
export async function withSession<T>(
  provider: DbConnectionProvider,
  fn: (session: DbSession) => Promise<T>,
): Promise<T> {
  const conn = await provider.acquire();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

// ── SQL helpers ─────────────────────────────────────────────────────────

/** Builds a `($1,$2), ($3,$4), ...` VALUES clause for rowCount rows × colCount columns. */
/**
 * `literalSuffix` (optional) is a SQL literal appended verbatim to every row — used only for
 * constants the caller hard-codes in source (e.g. `, true`), never for user input. This does
 * not break the parameter-binding principle; it is a shortcut for constants that would
 * otherwise need one extra parameter per row.
 */
function buildValuesPlaceholders(rowCount: number, colCount: number, literalSuffix = ""): string {
  const rows: string[] = [];
  let idx = 1;
  for (let r = 0; r < rowCount; r++) {
    const cols: string[] = [];
    for (let c = 0; c < colCount; c++) cols.push(`$${idx++}`);
    rows.push(`(${cols.join(", ")}${literalSuffix})`);
  }
  return rows.join(", ");
}

// ── Per-resource writes/queries (bound to a fixed session) ─────────────────

async function upsertStoresOn(session: DbSession, rows: StoreRow[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) params.push(r.id, r.name);
  await session.query(
    `insert into stores (id, name)
     values ${buildValuesPlaceholders(rows.length, 2)}
     on conflict (id) do update set name = excluded.name`,
    params,
  );
}

/**
 * `low_stock_threshold`/`pack_size` distinguish three states (006 DATA-005, TASKS T33, see the
 * `ProductRow` docs in `core/types.ts`) — `undefined` (this upsert batch carries no information
 * about the field → keep the existing value), `null` (explicit clear → overwrite with null), a
 * value (set to that value). Whether a column is present in the file is a property of the file
 * header, so it does not vary row by row within one batch (one file) — either all rows are
 * undefined or none are. Therefore the SET clause itself is chosen once per batch by asking
 * "is there at least one row with any information about this field": if so, always overwrite
 * with `excluded.x`, so a null is applied as-is (clear); if not, leave `products.x` (itself) so
 * the existing value is preserved — `coalesce` is no longer needed, since it would only be an
 * effective no-op when the whole batch is "no information" (the old approach also mistook null
 * for "no information", leaving no way at all to express an explicit clear — exactly the defect
 * 006 DATA-005 pointed out).
 */
async function upsertProductsOn(session: DbSession, rows: ProductRow[]): Promise<void> {
  if (rows.length === 0) return;
  const thresholdProvided = rows.some((r) => r.lowStockThreshold !== undefined);
  const packSizeProvided = rows.some((r) => r.packSize !== undefined);

  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.variantId,
      r.itemId,
      r.name,
      r.sku,
      r.category,
      r.lowStockThreshold ?? null,
      r.packSize ?? null,
    );
  }
  const thresholdSet = thresholdProvided
    ? "low_stock_threshold = excluded.low_stock_threshold"
    : "low_stock_threshold = products.low_stock_threshold";
  const packSizeSet = packSizeProvided
    ? "pack_size = excluded.pack_size"
    : "pack_size = products.pack_size";
  await session.query(
    `insert into products (variant_id, item_id, name, sku, category, low_stock_threshold, pack_size)
     values ${buildValuesPlaceholders(rows.length, 7)}
     on conflict (variant_id) do update set
       item_id = excluded.item_id, name = excluded.name,
       sku = excluded.sku, category = excluded.category,
       ${thresholdSet},
       ${packSizeSet}`,
    params,
  );
}

async function upsertSalesLinesOn(session: DbSession, rows: SalesLineRow[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.receiptId,
      r.lineNo,
      r.storeId,
      r.variantId,
      r.qty,
      r.gross,
      r.discount,
      r.soldAt.toISOString(),
    );
  }
  await session.query(
    `insert into sales_lines (receipt_id, line_no, store_id, variant_id, qty, gross, discount, sold_at)
     values ${buildValuesPlaceholders(rows.length, 8)}
     on conflict (receipt_id, line_no) do update set
       store_id = excluded.store_id, variant_id = excluded.variant_id,
       qty = excluded.qty, gross = excluded.gross, discount = excluded.discount,
       sold_at = excluded.sold_at`,
    params,
  );
}

async function upsertInventoryOn(session: DbSession, rows: InventoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) params.push(r.storeId, r.variantId, r.inStock, r.updatedAt.toISOString());
  // active (TASKS T31, DATA-002 tombstone) — upserted rows are always active=true. This upsert
  // path itself means "this source reports this row as current state now", so a row that was
  // previously tombstoned (inactive) is automatically reactivated here when it reappears (no
  // separate reactivate method needed).
  await session.query(
    `insert into inventory_levels (store_id, variant_id, in_stock, updated_at, active)
     values ${buildValuesPlaceholders(rows.length, 4, ", true")}
     on conflict (store_id, variant_id) do update set
       in_stock = excluded.in_stock, updated_at = excluded.updated_at, active = true`,
    params,
  );
}

async function appendInventorySnapshotOn(
  session: DbSession,
  runId: string,
  at: Date,
  rows: InventoryRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) params.push(runId, at.toISOString(), r.storeId, r.variantId, r.inStock);
  await session.query(
    `insert into inventory_snapshots (run_id, snapped_at, store_id, variant_id, in_stock)
     values ${buildValuesPlaceholders(rows.length, 5)}
     on conflict (run_id, store_id, variant_id) do update set in_stock = excluded.in_stock`,
    params,
  );
}

async function upsertSalesPeriodAggOn(
  session: DbSession,
  rows: SalesPeriodAggRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.storeId,
      r.variantId,
      r.periodStart.toISOString(),
      r.periodEnd.toISOString(),
      r.soldQty,
    );
  }
  // active (TASKS T31, DATA-002 tombstone) — always true, for the same reason as upsertInventoryOn.
  await session.query(
    `insert into sales_period_agg (store_id, variant_id, period_start, period_end, sold_qty, active)
     values ${buildValuesPlaceholders(rows.length, 5, ", true")}
     on conflict (store_id, variant_id) do update set
       period_start = excluded.period_start,
       period_end = excluded.period_end,
       sold_qty = excluded.sold_qty,
       active = true`,
    params,
  );
}

/**
 * tombstone (TASKS T31, DATA-002) — within the `storeIds` range, only marks the
 * `inventory_levels`/`sales_period_agg` rows for (store, SKU) pairs absent from this scan as
 * `active=false` (no physical deletion). `unnest($2::text[], $3::text[])` builds the "set of
 * (store, SKU) keys present in this scan" and only rows not in it are selected — if the present
 * list is empty (e.g. not a single row with sales history in this scan), every existing active
 * row in the `storeIds` range becomes a target (correct behaviour, because it means this scan
 * authoritatively reported "no sales history" for those stores).
 */
async function deactivateMissingCsvRowsOn(
  session: DbSession,
  params: {
    storeIds: string[];
    presentInventory: { storeId: string; variantId: string }[];
    presentSales: { storeId: string; variantId: string }[];
  },
): Promise<void> {
  if (params.storeIds.length === 0) return;

  await session.query(
    `update inventory_levels
     set active = false
     where store_id = any($1::text[])
       and active = true
       and not exists (
         select 1 from unnest($2::text[], $3::text[]) as present(store_id, variant_id)
         where present.store_id = inventory_levels.store_id
           and present.variant_id = inventory_levels.variant_id
       )`,
    [
      params.storeIds,
      params.presentInventory.map((k) => k.storeId),
      params.presentInventory.map((k) => k.variantId),
    ],
  );

  await session.query(
    `update sales_period_agg
     set active = false
     where store_id = any($1::text[])
       and active = true
       and not exists (
         select 1 from unnest($2::text[], $3::text[]) as present(store_id, variant_id)
         where present.store_id = sales_period_agg.store_id
           and present.variant_id = sales_period_agg.variant_id
       )`,
    [
      params.storeIds,
      params.presentSales.map((k) => k.storeId),
      params.presentSales.map((k) => k.variantId),
    ],
  );
}

/**
 * Because the PK is only `(store_id, variant_id, received_at)`, this function itself still has
 * the contract "a second upsert for the same date overwrites the first" (migrations/004
 * comment) — passing several receipts for the same store/SKU/date to this function without
 * summing them silently shrinks the quantity. The actual loss prevention happens on the caller
 * side (`mapScmRowsToPurchaseReceipts` in `core/scmSchema.ts`), which sums same-date rows
 * before import (006 DATA-008, TASKS T33) — this function does not enforce that contract, so any
 * new caller must pre-aggregate the same way.
 */
async function upsertPurchaseReceiptsOn(
  session: DbSession,
  rows: PurchaseReceiptRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.storeId,
      r.variantId,
      // date column — received_at is "that date", not a timestamp, so the time component is dropped (UTC date).
      r.receivedAt.toISOString().slice(0, 10),
      r.receivedQty,
      r.unitCost ?? null,
      r.currency ?? null,
      r.vendor ?? null,
    );
  }
  await session.query(
    `insert into purchase_receipts
       (store_id, variant_id, received_at, received_qty, unit_cost, currency, vendor)
     values ${buildValuesPlaceholders(rows.length, 7)}
     on conflict (store_id, variant_id, received_at) do update set
       received_qty = excluded.received_qty,
       unit_cost = excluded.unit_cost,
       currency = excluded.currency,
       vendor = excluded.vendor`,
    params,
  );
}

/**
 * Symmetric with querySalesAggOn — takes a SalesAggQuery as-is. received_at is a date column,
 * so the period boundaries are cast with `::date` for comparison (SPEC §13 — business-timezone-
 * aware boundary conversion is out of scope for now, documented as a known simplification).
 */
async function queryPurchaseAggOn(session: DbSession, q: SalesAggQuery): Promise<PurchaseAgg[]> {
  const { rows } = await session.query<{
    store_id: string;
    variant_id: string;
    received_qty_raw: string;
  }>(
    `select
       pr.store_id as store_id,
       pr.variant_id as variant_id,
       sum(pr.received_qty)::text as received_qty_raw
     from purchase_receipts pr
     join products p on p.variant_id = pr.variant_id
     where pr.received_at >= $1::date and pr.received_at < $2::date
       and ($3::text is null or pr.store_id = $3)
       and ($4::text is null or p.category = $4)
     group by pr.store_id, pr.variant_id`,
    [q.periodStart.toISOString(), q.periodEnd.toISOString(), q.storeId ?? null, q.category ?? null],
  );
  return rows.map((r) => ({
    storeId: r.store_id,
    variantId: r.variant_id,
    receivedQtyRaw: r.received_qty_raw,
  }));
}

async function getCursorOn(session: DbSession, resource: string): Promise<string | null> {
  const { rows } = await session.query<{ cursor: string | null }>(
    "select cursor from sync_state where resource = $1",
    [resource],
  );
  return rows[0]?.cursor ?? null;
}

async function setCursorOn(
  session: DbSession,
  resource: string,
  watermark: string,
  at: Date,
): Promise<void> {
  await session.query(
    `insert into sync_state (resource, cursor, last_synced_at)
     values ($1, $2, $3)
     on conflict (resource) do update set
       cursor = excluded.cursor, last_synced_at = excluded.last_synced_at`,
    [resource, watermark, at.toISOString()],
  );
}

async function getSyncStateOn(session: DbSession): Promise<SyncStateRow[]> {
  const { rows } = await session.query<{
    resource: string;
    cursor: string | null;
    last_synced_at: string | Date | null;
  }>("select resource, cursor, last_synced_at from sync_state order by resource");
  return rows.map((r) => ({
    resource: r.resource,
    cursor: r.cursor,
    lastSyncedAt: r.last_synced_at === null ? null : new Date(r.last_synced_at),
  }));
}

async function querySalesAggOn(session: DbSession, q: SalesAggQuery): Promise<SalesAgg[]> {
  const { rows } = await session.query<{
    store_id: string;
    variant_id: string;
    name: string;
    category: string | null;
    sold_qty_raw: string;
  }>(
    `select
       sl.store_id as store_id,
       sl.variant_id as variant_id,
       p.name as name,
       p.category as category,
       sum(sl.qty)::text as sold_qty_raw
     from sales_lines sl
     join products p on p.variant_id = sl.variant_id
     where sl.sold_at >= $1 and sl.sold_at < $2
       and ($3::text is null or sl.store_id = $3)
       and ($4::text is null or p.category = $4)
     group by sl.store_id, sl.variant_id, p.name, p.category`,
    [q.periodStart.toISOString(), q.periodEnd.toISOString(), q.storeId ?? null, q.category ?? null],
  );
  return rows.map((r) => ({
    storeId: r.store_id,
    variantId: r.variant_id,
    name: r.name,
    category: r.category,
    soldQtyRaw: r.sold_qty_raw,
  }));
}

/**
 * sales_period_agg has one row per (store, variant) — that row's period_start/period_end is
 * "the period the most recent scan read from the CSV" (the stored total is returned as-is, not
 * re-aggregated). Only rows whose stored period overlaps the queried period are returned — so
 * that a query for a completely different (non-overlapping) period does not silently get an old
 * scan's value as if it were data for that period. This function is not responsible for the
 * fact that the caller's period assumptions (windowDays etc.) may differ from the stored period
 * length (TASKS T17).
 */
async function querySalesPeriodAggOn(session: DbSession, q: SalesAggQuery): Promise<SalesAgg[]> {
  const { rows } = await session.query<{
    store_id: string;
    variant_id: string;
    name: string;
    category: string | null;
    sold_qty_raw: string;
  }>(
    `select
       spa.store_id as store_id,
       spa.variant_id as variant_id,
       p.name as name,
       p.category as category,
       spa.sold_qty::text as sold_qty_raw
     from sales_period_agg spa
     join products p on p.variant_id = spa.variant_id
     where spa.active = true
       and spa.period_start < $2 and spa.period_end > $1
       and ($3::text is null or spa.store_id = $3)
       and ($4::text is null or p.category = $4)`,
    [q.periodStart.toISOString(), q.periodEnd.toISOString(), q.storeId ?? null, q.category ?? null],
  );
  return rows.map((r) => ({
    storeId: r.store_id,
    variantId: r.variant_id,
    name: r.name,
    category: r.category,
    soldQtyRaw: r.sold_qty_raw,
  }));
}

async function queryStockOn(session: DbSession, q: StockQuery): Promise<StockRow[]> {
  const { rows } = await session.query<{
    store_id: string;
    variant_id: string;
    name: string;
    in_stock_raw: string;
    updated_at: string | Date;
  }>(
    `select
       il.store_id as store_id,
       il.variant_id as variant_id,
       p.name as name,
       il.in_stock::text as in_stock_raw,
       il.updated_at as updated_at
     from inventory_levels il
     join products p on p.variant_id = il.variant_id
     where il.active = true
       and ($1::text is null or il.store_id = $1)
       and ($2::text[] is null or il.variant_id = any($2::text[]))
       and ($3::text is null or p.category = $3)`,
    [q.storeId ?? null, q.variantIds ?? null, q.category ?? null],
  );
  return rows.map((r) => ({
    storeId: r.store_id,
    variantId: r.variant_id,
    name: r.name,
    inStockRaw: r.in_stock_raw,
    updatedAt: new Date(r.updated_at),
  }));
}

async function queryStoresOn(session: DbSession, storeId?: string): Promise<StoreRow[]> {
  const { rows } = await session.query<{ id: string; name: string }>(
    "select id, name from stores where ($1::text is null or id = $1) order by id",
    [storeId ?? null],
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Omitting `variantIds` (undefined) returns everything; an empty array returns an empty result
 * (`= any('{}')` naturally behaves that way — no separate branch needed).
 */
async function queryProductsOn(session: DbSession, variantIds?: string[]): Promise<ProductRow[]> {
  const { rows } = await session.query<{
    variant_id: string;
    item_id: string;
    name: string;
    sku: string | null;
    category: string | null;
    low_stock_threshold: string | null;
    pack_size: string | null;
  }>(
    `select variant_id, item_id, name, sku, category, low_stock_threshold, pack_size
     from products
     where ($1::text[] is null or variant_id = any($1::text[]))
     order by variant_id`,
    [variantIds ?? null],
  );
  return rows.map((r) => ({
    variantId: r.variant_id,
    itemId: r.item_id,
    name: r.name,
    sku: r.sku,
    category: r.category,
    lowStockThreshold: r.low_stock_threshold,
    packSize: r.pack_size,
  }));
}

/**
 * Double-send prevention reservation pattern (DESIGN §11.5): status='sending' is **always
 * attempted only as a new INSERT**. `agent_send_log_run_id_active_idx` (at most one sending/sent
 * per run_id) turns this INSERT into an atomic lock — if a sending/sent row already exists for
 * the same run_id, it fails with a unique violation, which is rethrown as an error carrying the
 * cause, blocking the resend. status='sent'/'failed' look up the sending row this run just
 * reserved by run_id+status='sending' and update "that same row" — so no arbitrary existing row
 * is overwritten based on status alone (avoiding the defect of reverting an already-sent row to
 * sending). status='no_suggestions'/'dry_run' involve no send, so they are not reservations and
 * leave a new audit-log row per run.
 */
async function logAgentSendOn(session: DbSession, e: AgentSendEntry): Promise<void> {
  const insertParams = [
    e.runId,
    e.sentAt.toISOString(),
    e.status,
    e.recipient,
    e.subject,
    e.suggestionCount,
    e.messageId,
    e.dryRun,
    e.errorCode,
  ];

  // OPS-004 (TASKS T34) — "unknown" is also a final state that closes a "sending" reservation
  // (success/failure simply could not be determined, but the attempt itself is over) — it must
  // update the same row as "sent"/"failed". If it were left out here, the sending reservation
  // row would remain and a separate insert row would be created (the catch-all insert path
  // below), leaving two rows for the same run_id.
  if (e.status === "sent" || e.status === "failed" || e.status === "unknown") {
    const { rows } = await session.query<{ id: string }>(
      "select id from agent_send_log where run_id = $1 and status = 'sending' order by id desc limit 1",
      [e.runId],
    );
    const sendingId = rows[0]?.id;
    if (sendingId === undefined) {
      throw new Error(
        `No sending reservation row exists for run_id="${e.runId}", so it cannot be updated to ` +
          `status='${e.status}'. Check that logAgentSend() was called with status='sending' first.`,
      );
    }
    await session.query(
      `update agent_send_log set
         sent_at = $2, status = $3, recipient = $4, subject = $5,
         suggestion_count = $6, message_id = $7, dry_run = $8, error_code = $9
       where id = $1`,
      [sendingId, ...insertParams.slice(1)],
    );
    return;
  }

  try {
    await session.query(
      `insert into agent_send_log
         (run_id, sent_at, status, recipient, subject, suggestion_count, message_id, dry_run, error_code)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      insertParams,
    );
  } catch (err) {
    if (e.status === "sending") {
      throw new Error(
        `run_id="${e.runId}" is a run that is already sending or has already been sent — the new ` +
          "reservation is refused to prevent a duplicate send. Do not retry with the same run_id.",
        { cause: err },
      );
    }
    throw err;
  }
}

// type alias (not an interface) — to satisfy the DbSession.query<T extends Record<string, unknown>> constraint.
type AgentSendLogRow = {
  run_id: string;
  sent_at: string | Date;
  status: AgentSendStatus;
  recipient: string | null;
  subject: string | null;
  suggestion_count: number;
  message_id: string | null;
  dry_run: boolean;
  error_code: string | null;
};

/** SR2-MAIL-003 — read input for the same-run_id retry policy (`core/sendRetryPolicy.ts`). Ascending
 * id = record order. `sent_at` arrives as a Date or a string depending on the driver, so it is normalised to Date at the boundary. */
async function listAgentSendAttemptsOn(
  session: DbSession,
  runId: string,
): Promise<AgentSendEntry[]> {
  const { rows } = await session.query<AgentSendLogRow>(
    `select run_id, sent_at, status, recipient, subject, suggestion_count, message_id, dry_run, error_code
       from agent_send_log where run_id = $1 order by id asc`,
    [runId],
  );
  return rows.map((r) => ({
    runId: r.run_id,
    sentAt: r.sent_at instanceof Date ? r.sent_at : new Date(r.sent_at),
    status: r.status,
    recipient: r.recipient,
    subject: r.subject,
    suggestionCount: r.suggestion_count,
    messageId: r.message_id,
    dryRun: r.dry_run,
    errorCode: r.error_code,
  }));
}

/** SR2-MAIL-003 — closes a row stuck in `sending` as `unknown` (stale_sending). `sent_at` is deliberately
 * kept (it is the reference time for the duplicate-prevention retention window, see the Warehouse comment in core/types.ts).
 * The condition check has already been done by the caller (`agent/sendRetryGate.ts`) — here it just closes unconditionally. */
async function markStaleSendingUnknownOn(session: DbSession, runId: string): Promise<number> {
  const { rows } = await session.query<{ id: string }>(
    `update agent_send_log set status = 'unknown', error_code = 'stale_sending'
       where run_id = $1 and status = 'sending' returning id`,
    [runId],
  );
  return rows.length;
}

/**
 * 007 OPS-005 (TASKS T34) — for `scripts/cleanup.ts` (humans only) exclusively. With `dryRun`
 * nothing is actually deleted; only the target rows are counted (deletion is irreversible, so
 * the script side keeps a `--confirm` double gate so the default is always dry-run — same
 * pattern as SEND_MODE). `DbSession.query` does not expose `rowCount`, so the real delete
 * counts the removed rows via `returning`.
 */
async function deleteOldInventorySnapshotsOn(
  session: DbSession,
  before: Date,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    const { rows } = await session.query<{ count: string }>(
      "select count(*)::text as count from inventory_snapshots where snapped_at < $1",
      [before.toISOString()],
    );
    return Number(rows[0]?.count ?? "0");
  }
  const { rows } = await session.query<{ deleted: number }>(
    "delete from inventory_snapshots where snapped_at < $1 returning 1 as deleted",
    [before.toISOString()],
  );
  return rows.length;
}

async function deleteOldAgentSendLogOn(
  session: DbSession,
  before: Date,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    const { rows } = await session.query<{ count: string }>(
      "select count(*)::text as count from agent_send_log where sent_at < $1",
      [before.toISOString()],
    );
    return Number(rows[0]?.count ?? "0");
  }
  const { rows } = await session.query<{ deleted: number }>(
    "delete from agent_send_log where sent_at < $1 returning 1 as deleted",
    [before.toISOString()],
  );
  return rows.length;
}

// ── Warehouse bound to a fixed session (reused inside transaction()) ─────────

function buildWarehouseOnSession(session: DbSession): Warehouse {
  return {
    // Already inside a transaction, so fn runs as-is on the same session without a new BEGIN.
    transaction: (fn) => fn(buildWarehouseOnSession(session)),
    upsertStores: (rows) => upsertStoresOn(session, rows),
    upsertProducts: (rows) => upsertProductsOn(session, rows),
    upsertSalesLines: (rows) => upsertSalesLinesOn(session, rows),
    upsertInventory: (rows) => upsertInventoryOn(session, rows),
    appendInventorySnapshot: (runId, at, rows) =>
      appendInventorySnapshotOn(session, runId, at, rows),
    upsertSalesPeriodAgg: (rows) => upsertSalesPeriodAggOn(session, rows),
    upsertPurchaseReceipts: (rows) => upsertPurchaseReceiptsOn(session, rows),
    getCursor: (resource) => getCursorOn(session, resource),
    setCursor: (resource, watermark, at) => setCursorOn(session, resource, watermark, at),
    getSyncState: () => getSyncStateOn(session),
    querySalesAgg: (q) => querySalesAggOn(session, q),
    querySalesPeriodAgg: (q) => querySalesPeriodAggOn(session, q),
    queryPurchaseAgg: (q) => queryPurchaseAggOn(session, q),
    queryStock: (q) => queryStockOn(session, q),
    queryStores: (storeId) => queryStoresOn(session, storeId),
    queryProducts: (variantIds) => queryProductsOn(session, variantIds),
    deactivateMissingCsvRows: (params) => deactivateMissingCsvRowsOn(session, params),
    logAgentSend: (e) => logAgentSendOn(session, e),
    listAgentSendAttempts: (runId) => listAgentSendAttemptsOn(session, runId),
    markStaleSendingUnknown: (runId) => markStaleSendingUnknownOn(session, runId),
    deleteOldInventorySnapshots: (before, opts) =>
      deleteOldInventorySnapshotsOn(session, before, opts?.dryRun ?? false),
    deleteOldAgentSendLog: (before, opts) =>
      deleteOldAgentSendLogOn(session, before, opts?.dryRun ?? false),
  };
}

// ── Public factory ──────────────────────────────────────────────────────

export function createPgWarehouse(provider: DbConnectionProvider): Warehouse {
  return {
    async transaction<T>(fn: (tx: Warehouse) => Promise<T>): Promise<T> {
      return withSession(provider, async (session) => {
        await session.query("begin");
        try {
          const tx = buildWarehouseOnSession(session);
          const result = await fn(tx);
          await session.query("commit");
          return result;
        } catch (err) {
          try {
            await session.query("rollback");
          } catch {
            // A failure of the rollback itself is ignored — the original error is thrown below to preserve the cause.
          }
          throw err;
        }
      });
    },
    upsertStores: (rows) => withSession(provider, (session) => upsertStoresOn(session, rows)),
    upsertProducts: (rows) => withSession(provider, (session) => upsertProductsOn(session, rows)),
    upsertSalesLines: (rows) =>
      withSession(provider, (session) => upsertSalesLinesOn(session, rows)),
    upsertInventory: (rows) => withSession(provider, (session) => upsertInventoryOn(session, rows)),
    appendInventorySnapshot: (runId, at, rows) =>
      withSession(provider, (session) => appendInventorySnapshotOn(session, runId, at, rows)),
    upsertSalesPeriodAgg: (rows) =>
      withSession(provider, (session) => upsertSalesPeriodAggOn(session, rows)),
    upsertPurchaseReceipts: (rows) =>
      withSession(provider, (session) => upsertPurchaseReceiptsOn(session, rows)),
    getCursor: (resource) => withSession(provider, (session) => getCursorOn(session, resource)),
    setCursor: (resource, watermark, at) =>
      withSession(provider, (session) => setCursorOn(session, resource, watermark, at)),
    getSyncState: () => withSession(provider, (session) => getSyncStateOn(session)),
    querySalesAgg: (q) => withSession(provider, (session) => querySalesAggOn(session, q)),
    querySalesPeriodAgg: (q) =>
      withSession(provider, (session) => querySalesPeriodAggOn(session, q)),
    queryPurchaseAgg: (q) => withSession(provider, (session) => queryPurchaseAggOn(session, q)),
    queryStock: (q) => withSession(provider, (session) => queryStockOn(session, q)),
    queryStores: (storeId) => withSession(provider, (session) => queryStoresOn(session, storeId)),
    queryProducts: (variantIds) =>
      withSession(provider, (session) => queryProductsOn(session, variantIds)),
    deactivateMissingCsvRows: (params) =>
      withSession(provider, (session) => deactivateMissingCsvRowsOn(session, params)),
    logAgentSend: (e) => withSession(provider, (session) => logAgentSendOn(session, e)),
    listAgentSendAttempts: (runId) =>
      withSession(provider, (session) => listAgentSendAttemptsOn(session, runId)),
    markStaleSendingUnknown: (runId) =>
      withSession(provider, (session) => markStaleSendingUnknownOn(session, runId)),
    deleteOldInventorySnapshots: (before, opts) =>
      withSession(provider, (session) =>
        deleteOldInventorySnapshotsOn(session, before, opts?.dryRun ?? false),
      ),
    deleteOldAgentSendLog: (before, opts) =>
      withSession(provider, (session) =>
        deleteOldAgentSendLogOn(session, before, opts?.dryRun ?? false),
      ),
  };
}
