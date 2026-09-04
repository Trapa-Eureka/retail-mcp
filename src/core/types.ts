/**
 * Domain types + core interfaces (DESIGN.md §4).
 * `core/` defines only interfaces and pure calculations — this file performs no external IO.
 */

/**
 * Boundary representation of a Postgres `numeric` column. The pg/PGlite drivers return numeric as a
 * string, and an implicit conversion to a JS number can lose precision. Parsing is done explicitly
 * at the boundary right before the core calculation (CLAUDE.md implementation notes).
 */
export type Numeric = string;

/** A point in time handled as an ISO 8601 string. Used only at the raw Loyverse API response boundary; converted to Date afterwards. */
export type IsoDateTimeString = string;

// ── Clock ────────────────────────────────────────────────────────────────

export interface Clock {
  now(): Date;
}

// ── Raw Loyverse API response shapes (LoyverseClient boundary) ────────────

export interface LvStore {
  id: string;
  name: string;
}

export interface LvItemVariant {
  variant_id: string;
  sku: string | null;
}

export interface LvItem {
  id: string;
  item_name: string;
  category_id: string | null;
  variants: LvItemVariant[];
}

export interface LvReceiptLineItem {
  variant_id: string;
  item_id: string;
  quantity: number;
  gross_total_money: number;
  total_discount: number;
}

export interface LvReceipt {
  receipt_number: string;
  store_id: string;
  /** "SALE" | "REFUND". A refund line's quantity is positive (the refunded qty) — the sign flip happens in the ETL. */
  receipt_type: "SALE" | "REFUND";
  /** The original sale receipt number, only on REFUND receipts. null on SALE. */
  refund_for: string | null;
  created_at: IsoDateTimeString;
  /** Basis of the incremental-sync watermark (DESIGN §11.1). Filtering uses this field, not receipt_date. */
  updated_at: IsoDateTimeString;
  receipt_date: IsoDateTimeString;
  /** null unless cancelled. Cancelled receipts are excluded from aggregation (ETL policy, SPEC §9). */
  cancelled_at: IsoDateTimeString | null;
  line_items: LvReceiptLineItem[];
}

export interface LvInventoryLevel {
  variant_id: string;
  store_id: string;
  in_stock: number;
  updated_at: IsoDateTimeString;
}

export interface Page<T> {
  items: T[];
  /**
   * API pagination token (pageCursor). Used in memory only while processing all pages of one
   * resource and never stored in the DB (sync_state) — a different concept from the watermark.
   */
  cursor: string | null;
}

/**
 * Boundary dedicated to the Loyverse REST API — not just the name but the return types
 * (receipt_number/cancelled_at/receipt_type of LvReceipt, etc.) are Loyverse-specific structures.
 * The whole receipt-level incremental sync model in `etl/sync.ts` (watermark = last receipt
 * updated_at) presupposes this contract.
 *
 * The CSV/Excel channel (TASKS T12 onwards) does not implement this interface — CSV files have no
 * receipts, only a single "period total sold qty", which does not fit this contract. Instead the
 * CSV path (`folderScan.ts`, TASKS T18) writes to the `Warehouse` directly (with domain row types
 * such as SalesPeriodAggRow). Not generalising `LoyverseClient` into a source-neutral name is
 * deliberate — a name that honestly reflects the Loyverse-specific structure is clearer.
 */
export interface LoyverseClient {
  listStores(): Promise<LvStore[]>;
  listItems(cursor?: string): Promise<Page<LvItem>>;
  /**
   * sinceISO corresponds to the real API's `updated_at_min` query parameter — filtering is by
   * `updated_at`, not `receipt_date`. When an old receipt is later refunded or cancelled and thus
   * updated, the next incremental sync does not miss it (DESIGN §11.1).
   */
  listReceipts(sinceISO: string, cursor?: string): Promise<Page<LvReceipt>>;
  listInventory(cursor?: string): Promise<Page<LvInventoryLevel>>;
}

// ── Warehouse domain rows (correspond to migrations/001_init.sql) ──────────

export interface StoreRow {
  id: string;
  name: string;
}

export interface ProductRow {
  variantId: string;
  itemId: string;
  name: string;
  sku: string | null;
  category: string | null;
  /**
   * Per-item low-stock threshold override (SPEC §12, TASKS T16) — CSV/Excel channel only; the
   * Loyverse path always leaves it undefined. Actually reading it for the threshold judgement is
   * T17's job.
   *
   * **The three values mean different things (006 DATA-005, TASKS T33)** — the upsert applies each
   * differently, so they must not be mixed up:
   * - `undefined` = "this upsert carries no information about this field" (for CSV/Excel: the file
   *   has no such column at all, backward compatibility with older templates) → keep the existing
   *   DB value.
   * - `null` = "explicitly clear it" (for CSV/Excel: the column exists but this row's cell is
   *   empty) → overwrite with null even if a value exists.
   * - a value = set to this value.
   *
   * `upsertProductsOn` in `pgWarehouse.ts` actually implements this distinction — across the whole
   * batch (one file), "if any row is not undefined" the field is considered owned by this upsert and
   * the entire column is overwritten (column presence is a per-file-header property, so it does not
   * vary row by row within one file — it is either all undefined or all not).
   */
  lowStockThreshold?: Numeric | null;
  /**
   * The minimum pack/box unit the supplier ships (SPEC §14, "pack-multiple rounding"). Absent means
   * single units can be purchased — the reorder suggestion is not rounded. Unlike
   * lowStockThreshold it is not CSV/Excel-only (source-neutral) — any channel may fill it. Actually
   * filling and using it for rounding is the job of roundToPackMultiple/applyPackRounding in
   * core/metrics.ts.
   *
   * The meaning of the three states `undefined`/`null`/value is the same as for
   * `lowStockThreshold` (006 DATA-005, TASKS T33) — see the doc above.
   */
  packSize?: Numeric | null;
}

export interface SalesLineRow {
  receiptId: string;
  lineNo: number;
  storeId: string;
  variantId: string;
  /** Refunds are negative. Raw net sold qty — the max(0, ·) normalisation is applied in core/metrics.ts right before calculation. */
  qty: Numeric;
  gross: Numeric;
  discount: Numeric;
  soldAt: Date;
}

export interface InventoryRow {
  storeId: string;
  variantId: string;
  /** Raw current stock. Negative values are a data-quality warning — clamped to 0 in calculations (SPEC §9), stored raw. */
  inStock: Numeric;
  updatedAt: Date;
}

/**
 * Period-total sales data of the CSV/Excel channel (SPEC §12, TASKS T12). Unlike Loyverse's
 * SalesLineRow (receipt-line level) there is only one aggregate value, "N units sold during this
 * period" — CSV files have no receipts. Stored separately rather than squeezed into sales_lines as
 * fake receipts.
 */
export interface SalesPeriodAggRow {
  storeId: string;
  variantId: string;
  /** Which period this sold qty sums over — the CSV's values as given (inclusive boundaries), not a half-open interval. */
  periodStart: Date;
  periodEnd: Date;
  /** Sum of sold qty within the period. CSV does not represent refunds separately, so it cannot be negative. */
  soldQty: Numeric;
}

/**
 * One receipt (inbound) record from the SCM sheet integration (SPEC §13). "Ordered" (not yet
 * received) status is not handled — only what has already been received is recorded. Multiple
 * records with the same (storeId, variantId, receivedAt) are overwritten by the last value (not
 * summed — a v0.1 limitation; the source sheet has no event sequence number).
 */
export interface PurchaseReceiptRow {
  storeId: string;
  variantId: string;
  receivedAt: Date;
  /** Received qty. Cannot be negative (return-inbound is out of v0.1 scope). */
  receivedQty: Numeric;
  unitCost?: Numeric | null;
  currency?: string | null;
  vendor?: string | null;
}

/**
 * Sum of received qty within a period — shaped like the SalesAgg returned by
 * querySalesAgg/querySalesPeriodAgg so that the stock reconciliation in core/metrics.ts can treat
 * the sales and receipt aggregates symmetrically (SPEC §13).
 */
export interface PurchaseAgg {
  storeId: string;
  variantId: string;
  /** Sum of received qty within the period (raw value, never negative). */
  receivedQtyRaw: Numeric;
}

export interface SalesAggQuery {
  storeId?: string;
  category?: string;
  /** Half-open interval [periodStart, periodEnd) — UTC boundaries computed in the business timezone. */
  periodStart: Date;
  periodEnd: Date;
}

export interface SalesAgg {
  storeId: string;
  variantId: string;
  name: string;
  category: string | null;
  /** Sum of raw net sold qty within the period (refunds included, may be negative). */
  soldQtyRaw: Numeric;
}

export interface StockQuery {
  storeId?: string;
  variantIds?: string[];
  /**
   * Category filter (added in T9). When the sell_through tool filters by category, queryStock
   * itself must filter by category to stop stock-only items of other categories leaking into the
   * result with category=null — in the joined result built by computeSellThrough only the salesAgg
   * side's category is trustworthy, and stock-only rows have no category.
   */
  category?: string;
}

export interface StockRow {
  storeId: string;
  variantId: string;
  name: string;
  /** Raw current stock. May be negative — a data-quality warning (SPEC §9). */
  inStockRaw: Numeric;
  updatedAt: Date;
}

// ── Agent send log (DESIGN §11.5) ──────────────────────────────────────────

/**
 * `unchanged` (TASKS T31, DATA-003) — in a CSV/Excel branch scan, when the file content hash equals
 * the one at the last send and the daily digest cap (24 hours) is not hit either, the run ends in
 * this status (quietly, without sending, summarising or rewriting the snapshot). The Loyverse path
 * (agent/reorder.ts) does not use this status.
 */
/**
 * `unknown` (007 OPS-004, TASKS T34) — reserved for the case where the send request failed before an
 * HTTP response arrived (timeout, socket dropped after connecting, etc.), so it "may or may not have
 * been sent" — distinct from `failed` (definitely failed: an HTTP error response, or the connection
 * never even being established, e.g. DNS failure / connection refused) (SR2-MAIL-002, second
 * adversarial review — previously only timeouts were unknown). When the `NotificationProvider`
 * detects this ambiguity it throws an `AmbiguousSendError` (`.name`), and the agent records
 * `status: "unknown"` on seeing it. A human must check the provider dashboard for whether it was
 * actually sent before deciding on a retry — this project has no automatic retry logic (that is
 * itself the policy).
 *
 * Rule for a human retrying with the same run_id (second adversarial review SR2-MAIL-003,
 * `core/sendRetryPolicy.ts`): a same-run_id retry is allowed **only within** the provider's
 * Idempotency-Key dedupe retention period (`NotificationProvider.dedupeTtlMs`) — after it, the
 * provider treats the same key as a new send and would duplicate, so the agent refuses and the
 * human must run with a **new run_id** after checking the dashboard. A row stuck in `sending`
 * (process crash after the reservation) is treated like `unknown` — if the retry is within the
 * retention period it is closed as `unknown` (error_code `stale_sending`) and a new reservation is
 * allowed.
 */
export type AgentSendStatus =
  "no_suggestions" | "dry_run" | "sending" | "sent" | "failed" | "unchanged" | "unknown";

export interface AgentSendEntry {
  /**
   * Idempotency key and reservation key. At most one `sending`/`sent` row is allowed per run_id
   * (agent_send_log_run_id_active_idx). T8 must commit this row with status='sending' **before**
   * calling provider.send() to reserve the right to send — if the insert fails with a unique
   * violation, the send is already in progress/completed, so do not send again (DESIGN §11.5).
   */
  runId: string;
  sentAt: Date;
  status: AgentSendStatus;
  /** null in non-send statuses (no_suggestions, etc.). */
  recipient: string | null;
  subject: string | null;
  suggestionCount: number;
  messageId: string | null;
  dryRun: boolean;
  errorCode: string | null;
}

// ── Sync state (for the T9 sync_status tool) ──────────────────────────────

export interface SyncStateRow {
  resource: string;
  /** sync_state.cursor (= watermark). For receipts it is the last receipt's updated_at — which may
   * differ from the actual sync run time (DESIGN §11.1). For stores/items/inventory it equals lastSyncedAt. */
  cursor: string | null;
  lastSyncedAt: Date | null;
}

// ── Warehouse interface ───────────────────────────────────────────────────

export interface Warehouse {
  /**
   * Commits one resource's data upsert and watermark (setCursor) update in a single transaction
   * (DESIGN §11.1). The `tx` used inside `fn` is a Warehouse bound to the same transaction; if `fn`
   * throws, every write made through it is rolled back — a state where data was loaded but the
   * watermark was not (or vice versa) is structurally impossible. The implementation (T4) must
   * provide real BEGIN/COMMIT/ROLLBACK.
   */
  transaction<T>(fn: (tx: Warehouse) => Promise<T>): Promise<T>;

  upsertStores(rows: StoreRow[]): Promise<void>;
  upsertProducts(rows: ProductRow[]): Promise<void>;
  /** Updates on PK(receipt_id, line_no) conflict — idempotent. */
  upsertSalesLines(rows: SalesLineRow[]): Promise<void>;
  upsertInventory(rows: InventoryRow[]): Promise<void>;
  appendInventorySnapshot(runId: string, at: Date, rows: InventoryRow[]): Promise<void>;
  /**
   * Period-total sales upsert of the CSV/Excel channel (SPEC §12, TASKS T12) — PK(store_id,
   * variant_id), replaced with the latest value on every scan (same model as inventory_levels, no
   * history accumulation). A separate table from sales_lines (receipt-line level).
   */
  upsertSalesPeriodAgg(rows: SalesPeriodAggRow[]): Promise<void>;
  /**
   * Receipt (inbound) upsert of the SCM sheet integration (SPEC §13). The same (storeId, variantId,
   * receivedAt) is updated to the last value.
   */
  upsertPurchaseReceipts(rows: PurchaseReceiptRow[]): Promise<void>;
  /**
   * Receipt aggregate query symmetric to querySalesAgg — reuses SalesAggQuery as is (same notion of
   * half-open period / store / category filters).
   */
  queryPurchaseAgg(q: SalesAggQuery): Promise<PurchaseAgg[]>;
  /** Reads sync_state.cursor (= watermark). Not the API page token. */
  getCursor(resource: string): Promise<string | null>;
  setCursor(resource: string, watermark: string, at: Date): Promise<void>;
  /** cursor+last_synced_at of every resource (for the T9 `sync_status` tool). Ordered by resource ascending. */
  getSyncState(): Promise<SyncStateRow[]>;
  /** Uses fixed parameterised SQL only. */
  querySalesAgg(q: SalesAggQuery): Promise<SalesAgg[]>;
  /**
   * Queries sales_period_agg in the same SalesAgg return shape as querySalesAgg (TASKS T12) —
   * computeSellThrough/computeReorderMetrics in core/metrics.ts only take SalesAgg[], so whether the
   * source is a sales_lines aggregate or a CSV period total they are reused without any change to
   * the core layer.
   */
  querySalesPeriodAgg(q: SalesAggQuery): Promise<SalesAgg[]>;
  queryStock(q: StockQuery): Promise<StockRow[]>;
  /**
   * Store list / name lookup (added in T8) — used for the per-branch table heading (storeName) of
   * the reorder report and for validating a non-existent store_id filter (shared by the T9 MCP
   * tools). With storeId, only that store.
   */
  queryStores(storeId?: string): Promise<StoreRow[]>;
  /**
   * Product list query (T25) — used where the full `ProductRow` fields not exposed by the
   * `sales_lines`/`inventory_levels` joins (notably `packSize`, SPEC §14) must be read (e.g.
   * pack-multiple rounding in the reorder report). Omitting `variantIds` returns everything; an
   * empty array returns an empty result.
   */
  queryProducts(variantIds?: string[]): Promise<ProductRow[]>;
  /**
   * In a CSV/Excel authoritative scan, deactivates the `inventory_levels`/`sales_period_agg` rows
   * for (store,SKU) pairs absent from this file (tombstone, DATA-002, TASKS T31) — no physical
   * deletion, only marks `active=false` and preserves history. `queryStock`/`querySalesPeriodAgg`
   * return `active=true` rows only. When a pair reappears in a file, `upsertInventory`/
   * `upsertSalesPeriodAgg` (which always write `active=true`) reactivate it automatically.
   * `storeIds` is the store scope this scan represents (the tombstone judgement boundary) — data of
   * other stores is never touched (consistent with the per-branch independent transaction principle
   * of HQ consolidated mode). `presentInventory`/`presentSales` are the (store,SKU) keys actually
   * parsed in this scan — every row for inventory, only rows with sales history for sales (the two
   * sets may differ).
   */
  deactivateMissingCsvRows(params: {
    storeIds: string[];
    presentInventory: { storeId: string; variantId: string }[];
    presentSales: { storeId: string; variantId: string }[];
  }): Promise<void>;
  logAgentSend(e: AgentSendEntry): Promise<void>;
  /**
   * All send-log rows of one run_id (in record order, oldest first) — a read-only lookup so the
   * same-run_id retry policy (`core/sendRetryPolicy.ts`, SR2-MAIL-003) can see the status and time
   * of earlier attempts. This is the agent audit-log table, not "business data" under guardrail 4.
   */
  listAgentSendAttempts(runId: string): Promise<AgentSendEntry[]>;
  /**
   * Right before a same-run_id retry (a human passing `--run-id` explicitly), closes rows stuck in
   * `sending` by a process crash as `unknown` (error_code `stale_sending`) (SR2-MAIL-003). `sent_at`
   * is left untouched — that time approximates when the provider first saw the Idempotency-Key and
   * is the basis of the dedupe retention period calculation. The precondition (within the retention
   * period) is judged by the caller's policy first — this method unconditionally closes. Returns the
   * number of rows closed.
   */
  markStaleSendingUnknown(runId: string): Promise<number>;

  /**
   * Retention period policy (007 OPS-005, TASKS T34) — deletes rows whose `snapped_at`/`sent_at` is
   * older than `before` (or, with `dryRun`, only counts the rows that would be deleted).
   * `inventory_snapshots`/`agent_send_log` are audit/log tables, not "business data" under
   * guardrail 4 (stores/products/sales/inventory) — exposed only for `scripts/cleanup.ts` (run by
   * humans only). Returns the number of rows deleted (or counted).
   */
  deleteOldInventorySnapshots(before: Date, opts?: { dryRun?: boolean }): Promise<number>;
  deleteOldAgentSendLog(before: Date, opts?: { dryRun?: boolean }): Promise<number>;
}

// ── explore_sql (v0.2 backlog, guardrail 4 exception — pre-announced by name in DESIGN §6) ──────
//
// Every other Warehouse method is a fixed parameterised query. explore_sql is the only tool where the
// user supplies arbitrary SQL text, so it is split into its own interface — to avoid blurring the
// Warehouse contract ("fixed queries only") because of this single case. Implementation is in
// adapters/exploreSqlExecutor.ts; the real line of defence (BEGIN READ ONLY transaction) is
// documented in that file's doc comment.

export interface ExploreSqlOptions {
  /** Maximum result rows. Default 200, maximum 1000 (larger requests are truncated automatically, not an error). */
  limit?: number;
  /** Maximum query execution time (ms). Default 5000, maximum 30000. */
  timeoutMs?: number;
}

export interface ExploreSqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** true when the limit was hit and only part of the result was returned. */
  truncated: boolean;
  timeoutMs: number;
}

export interface ExploreSqlExecutor {
  execute(sql: string, opts?: ExploreSqlOptions): Promise<ExploreSqlResult>;
}

// ── Notifications (same signature as the sheet_mcp NotificationProvider being ported) ─────────

export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * 007 OPS-004 (TASKS T34) — a stable key identifying this send attempt (the agent passes `runId`
   * as is). Resend dedupes re-requests with the same key within 24 hours via the `Idempotency-Key`
   * header without sending twice (verified in the resend.com API docs, 2026-09-03) — so even if a
   * human manually retries with the same runId after a timeout, only one email actually goes out.
   * Providers that do not support it (e.g. MockNotificationProvider) may simply ignore it.
   */
  idempotencyKey?: string;
}

export interface SendResult {
  messageId: string;
}

export interface NotificationProvider {
  readonly channel: "email";
  /**
   * Second adversarial review SR2-MAIL-003 — the retention period (ms) during which this provider
   * prevents duplicate sends via `OutboundMessage.idempotencyKey`. 24 hours for Resend. This value
   * is what lets the agent allow a same-run_id retry after `unknown`/`sending` only within that
   * period (`core/sendRetryPolicy.ts`). Without it (a provider that does not support idempotency)
   * such a retry always risks duplication and is refused — a human must confirm whether it was sent
   * and then run with a new run_id.
   */
  readonly dedupeTtlMs?: number;
  send(msg: OutboundMessage): Promise<SendResult>;
}

// ── Reorder report + summary (LLM boundary) ─────────────────────────────

export interface ReorderLineItem {
  variantId: string;
  name: string;
  /** Display value already normalised with max(0, ·). */
  inStock: number;
  avgDailySales: number;
  /** null = infinite (∞) cover — no sales. */
  daysOfCover: number | null;
  reorderQty: number;
  /**
   * Pack-multiple rounding (SPEC §14, TASKS T24/T25) — without `ProductRow.packSize` (single units
   * can be purchased) `finalOrderQty === reorderQty` and `packSize`/`packCount` are null.
   */
  packSize: number | null;
  /** Qty that can actually be ordered (rounded up to a pack-size multiple). Equals reorderQty when there is no packSize. */
  finalOrderQty: number;
  /** Number of packs (boxes) to order. null when there is no packSize. */
  packCount: number | null;
}

export interface ReorderStoreSection {
  storeId: string;
  storeName: string;
  items: ReorderLineItem[];
}

export interface ReorderReport {
  generatedAt: Date;
  timezone: string;
  dataLastSyncedAt: Date | null;
  stores: ReorderStoreSection[];
  warnings: string[];
}

export interface Summarizer {
  /** Returns only a 2-3 sentence summary. The prompt states explicitly that it must describe only the facts in the input table and invent no new numbers. */
  summarize(input: ReorderReport): Promise<string>;
}
