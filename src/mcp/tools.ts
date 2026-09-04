/**
 * The actual logic of the 6 MCP tools (DESIGN.md §6). `src/server.ts` only assembles — it
 * registers this file's functions via `McpServer.registerTool()` — per CLAUDE.md ("server.ts only
 * registers/assembles tools, no logic") all logic lives here.
 *
 * The 4 query tools (sell_through/inventory_status/stockout_risk/reorder_suggestions) run with
 * read-only DB credentials (DESIGN §11.4) — in this file those 4 functions call only the
 * Warehouse query-/get-style methods and never the upsert-style ones. `reorder_suggestions` reuses
 * `buildReorderReport()` from `agent/reorder.ts` as-is, structurally guaranteeing "tool result =
 * agent report" (TESTING §4 MCP regression guard).
 *
 * Common response metadata (DESIGN §11.6): all 4 query tools include
 * generated_at/data_last_synced_at/timezone/filters/warnings. Freshness evaluation is shared via
 * core/freshness.ts (SPEC §9).
 */
import { buildReorderReport, type BuildReportOptions, type ReportDeps } from "../agent/reorder.js";
import { computeFreshness, DEFAULT_STALE_THRESHOLD_HOURS } from "../core/freshness.js";
import {
  DEFAULT_WINDOW_DAYS,
  calendarWindow,
  computeReorderMetrics,
  computeSellThrough,
  type ReorderMetricRow,
  type SellThroughRow,
} from "../core/metrics.js";
import type {
  Clock,
  ExploreSqlExecutor,
  ExploreSqlResult,
  LoyverseClient,
  ReorderReport,
  Warehouse,
} from "../core/types.js";
import { syncAll, type SyncResource, type SyncResult } from "../etl/sync.js";

// ── Common ──────────────────────────────────────────────────────────────

export interface QueryToolDeps {
  warehouse: Warehouse;
  clock: Clock;
  businessTimezone: string;
  /** Default DEFAULT_STALE_THRESHOLD_HOURS (24, adjustable via env STALE_THRESHOLD_HOURS). */
  staleThresholdHours?: number;
}

export interface CommonMeta {
  generated_at: string;
  data_last_synced_at: string | null;
  timezone: string;
  filters: Record<string, unknown>;
  warnings: string[];
}

function buildMeta(
  clock: Clock,
  businessTimezone: string,
  filters: Record<string, unknown>,
  freshness: { dataLastSyncedAt: Date | null; warnings: string[] },
  extraWarnings: string[],
): CommonMeta {
  return {
    generated_at: clock.now().toISOString(),
    data_last_synced_at: freshness.dataLastSyncedAt
      ? freshness.dataLastSyncedAt.toISOString()
      : null,
    timezone: businessTimezone,
    filters,
    warnings: [...extraWarnings, ...freshness.warnings],
  };
}

/**
 * Throws an error carrying the cause when a store_id is given but does not exist (TESTING §4 MCP
 * tools item). buildReorderReport() in `agent/reorder.ts` has the same check (it queries
 * separately because it also needs the Warehouse.queryStores result to build store names) — it
 * is a ~5-line check, so each deliberately keeps its own copy.
 */
async function assertStoreExists(warehouse: Warehouse, storeId: string | undefined): Promise<void> {
  if (storeId === undefined) return;
  const stores = await warehouse.queryStores(storeId);
  if (stores.length === 0) {
    throw new Error(
      `Unknown store_id: "${storeId}". Check the registered store ids with the sync_status ` +
        "tool or in the stores table.",
    );
  }
}

// ── sell_through ────────────────────────────────────────────────────────

export interface SellThroughInput {
  storeId?: string;
  category?: string;
  periodDays: number;
  order: "asc" | "desc";
  top: number;
}

export interface SellThroughRowOut {
  store_id: string;
  variant_id: string;
  name: string;
  category: string | null;
  sold_qty_raw: number;
  sold_qty: number;
  end_stock_raw: number;
  end_stock: number;
  /** null = new/no stock (sales + ending stock = 0) — SPEC §2. */
  sell_through: number | null;
  warnings: string[];
}

export interface SellThroughResult {
  rows: SellThroughRowOut[];
  note: string;
  meta: CommonMeta;
}

function toSellThroughRowOut(r: SellThroughRow): SellThroughRowOut {
  return {
    store_id: r.storeId,
    variant_id: r.variantId,
    name: r.name,
    category: r.category,
    sold_qty_raw: r.soldQtyRaw,
    sold_qty: r.soldQty,
    end_stock_raw: r.endStockRaw,
    end_stock: r.endStock,
    sell_through: r.sellThrough,
    warnings: r.warnings,
  };
}

export async function sellThroughTool(
  deps: QueryToolDeps,
  input: SellThroughInput,
): Promise<SellThroughResult> {
  await assertStoreExists(deps.warehouse, input.storeId);
  const { periodStart, periodEnd } = calendarWindow(
    deps.clock,
    input.periodDays,
    deps.businessTimezone,
  );

  const [salesAgg, stock, syncState] = await Promise.all([
    deps.warehouse.querySalesAgg({
      periodStart,
      periodEnd,
      ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
    }),
    deps.warehouse.queryStock({
      ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
    }),
    deps.warehouse.getSyncState(),
  ]);

  const rows = computeSellThrough(salesAgg, stock);
  // null (new/no stock) cannot be ranked, so it always goes last regardless of sort direction.
  const sorted = [...rows].sort((a, b) => {
    if (a.sellThrough === null && b.sellThrough === null) return a.name.localeCompare(b.name);
    if (a.sellThrough === null) return 1;
    if (b.sellThrough === null) return -1;
    return input.order === "asc" ? a.sellThrough - b.sellThrough : b.sellThrough - a.sellThrough;
  });
  const top = sorted.slice(0, input.top);

  const freshness = computeFreshness(
    syncState,
    ["receipts", "inventory"],
    deps.clock.now(),
    deps.staleThresholdHours ?? DEFAULT_STALE_THRESHOLD_HOURS,
  );

  return {
    rows: top.map(toSellThroughRowOut),
    note:
      "Approximate formula (SPEC §2): sell-through = period sales qty ÷ (period sales qty + ending stock). " +
      "The canonical definition (sales ÷ (opening stock + receipts)) comes in v0.2 once receipt data is available.",
    meta: buildMeta(
      deps.clock,
      deps.businessTimezone,
      {
        store_id: input.storeId ?? null,
        category: input.category ?? null,
        period_days: input.periodDays,
        order: input.order,
        top: input.top,
      },
      freshness,
      [],
    ),
  };
}

// ── inventory_status ──────────────────────────────────────────────────

export interface InventoryStatusInput {
  storeId?: string;
  belowDaysCover?: number;
}

export interface InventoryStatusRowOut {
  store_id: string;
  variant_id: string;
  name: string;
  category: string | null;
  in_stock: number;
  avg_daily_sales: number;
  /** null = ∞ (infinite cover) — means no recent sales. */
  days_of_cover: number | null;
  warnings: string[];
}

export interface InventoryStatusResult {
  rows: InventoryStatusRowOut[];
  meta: CommonMeta;
}

function toInventoryStatusRowOut(r: ReorderMetricRow): InventoryStatusRowOut {
  return {
    store_id: r.storeId,
    variant_id: r.variantId,
    name: r.name,
    category: r.category,
    in_stock: r.inStock,
    avg_daily_sales: r.avgDailySales,
    days_of_cover: r.daysOfCover,
    warnings: r.warnings,
  };
}

export async function inventoryStatusTool(
  deps: QueryToolDeps,
  input: InventoryStatusInput,
): Promise<InventoryStatusResult> {
  await assertStoreExists(deps.warehouse, input.storeId);
  const windowDays = DEFAULT_WINDOW_DAYS;
  const { periodStart, periodEnd } = calendarWindow(deps.clock, windowDays, deps.businessTimezone);

  const [salesAgg, stock, syncState] = await Promise.all([
    deps.warehouse.querySalesAgg({
      periodStart,
      periodEnd,
      ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
    }),
    deps.warehouse.queryStock(input.storeId !== undefined ? { storeId: input.storeId } : {}),
    deps.warehouse.getSyncState(),
  ]);

  let rows = computeReorderMetrics(salesAgg, stock, { windowDays });
  if (input.belowDaysCover !== undefined) {
    const threshold = input.belowDaysCover;
    // ∞ (null) cover is never "below" any finite threshold.
    rows = rows.filter((r) => r.daysOfCover !== null && r.daysOfCover < threshold);
  }
  rows = [...rows].sort((a, b) => {
    if (a.daysOfCover === null && b.daysOfCover === null) return a.name.localeCompare(b.name);
    if (a.daysOfCover === null) return 1;
    if (b.daysOfCover === null) return -1;
    return a.daysOfCover - b.daysOfCover;
  });

  const freshness = computeFreshness(
    syncState,
    ["inventory"],
    deps.clock.now(),
    deps.staleThresholdHours ?? DEFAULT_STALE_THRESHOLD_HOURS,
  );

  return {
    rows: rows.map(toInventoryStatusRowOut),
    meta: buildMeta(
      deps.clock,
      deps.businessTimezone,
      { store_id: input.storeId ?? null, below_days_cover: input.belowDaysCover ?? null },
      freshness,
      [],
    ),
  };
}

// ── stockout_risk ─────────────────────────────────────────────────────

export interface StockoutRiskInput {
  storeId?: string;
  leadTimeDays: number;
  safetyDays: number;
}

export interface StockoutRiskRowOut {
  store_id: string;
  variant_id: string;
  name: string;
  category: string | null;
  in_stock: number;
  avg_daily_sales: number;
  days_of_cover: number;
  /** YYYY-MM-DD (in the business timezone). Approximation: today plus daysOfCover rounded up. */
  expected_stockout_date: string;
  warnings: string[];
}

export interface StockoutRiskResult {
  rows: StockoutRiskRowOut[];
  note: string;
  meta: CommonMeta;
}

export async function stockoutRiskTool(
  deps: QueryToolDeps,
  input: StockoutRiskInput,
): Promise<StockoutRiskResult> {
  await assertStoreExists(deps.warehouse, input.storeId);
  const windowDays = DEFAULT_WINDOW_DAYS;
  const { periodStart, periodEnd } = calendarWindow(deps.clock, windowDays, deps.businessTimezone);

  const [salesAgg, stock, syncState] = await Promise.all([
    deps.warehouse.querySalesAgg({
      periodStart,
      periodEnd,
      ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
    }),
    deps.warehouse.queryStock(input.storeId !== undefined ? { storeId: input.storeId } : {}),
    deps.warehouse.getSyncState(),
  ]);

  const metrics = computeReorderMetrics(salesAgg, stock, {
    windowDays,
    leadTimeDays: input.leadTimeDays,
    safetyDays: input.safetyDays,
  });
  const risky = metrics.filter((r) => r.stockoutRisk);
  risky.sort((a, b) => (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity));

  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: deps.businessTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // periodEnd = "today's midnight in the business timezone" as computed by calendarWindow()
  // (DESIGN §11.3) — used as the base date for the expected stockout date. daysOfCover may be
  // fractional, so it is rounded up (earlier, i.e. warning on the safe side).
  const rows: StockoutRiskRowOut[] = [];
  for (const r of risky) {
    if (r.daysOfCover === null) continue; // Unreachable: isStockoutRisk returns false for null.
    const stockoutAt = new Date(periodEnd.getTime() + Math.ceil(r.daysOfCover) * 86_400_000);
    rows.push({
      store_id: r.storeId,
      variant_id: r.variantId,
      name: r.name,
      category: r.category,
      in_stock: r.inStock,
      avg_daily_sales: r.avgDailySales,
      days_of_cover: r.daysOfCover,
      expected_stockout_date: dateFormatter.format(stockoutAt),
      warnings: r.warnings,
    });
  }

  const freshness = computeFreshness(
    syncState,
    ["receipts", "inventory"],
    deps.clock.now(),
    deps.staleThresholdHours ?? DEFAULT_STALE_THRESHOLD_HOURS,
  );

  return {
    rows,
    note: "expected_stockout_date is an approximation: today (business timezone) plus daysOfCover rounded up.",
    meta: buildMeta(
      deps.clock,
      deps.businessTimezone,
      {
        store_id: input.storeId ?? null,
        lead_time_days: input.leadTimeDays,
        safety_days: input.safetyDays,
      },
      freshness,
      [],
    ),
  };
}

// ── reorder_suggestions (same function as the agent) ────────────────────

export interface ReorderSuggestionsInput {
  storeId?: string;
  targetDaysCover: number;
  leadTimeDays: number;
}

/**
 * DESIGN §6: "suggested quantity table — same function as the agent". Calls
 * buildReorderReport() from agent/reorder.ts and returns its result as-is — it must return the
 * same ReorderReport without any transformation for the TESTING §4 regression guard
 * "reorder_suggestions result = exactly the agent report table" to hold.
 */
export async function reorderSuggestionsTool(
  deps: QueryToolDeps,
  input: ReorderSuggestionsInput,
): Promise<ReorderReport> {
  const opts: BuildReportOptions = {
    businessTimezone: deps.businessTimezone,
    targetCoverDays: input.targetDaysCover,
    leadTimeDays: input.leadTimeDays,
    ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
    ...(deps.staleThresholdHours !== undefined
      ? { staleThresholdHours: deps.staleThresholdHours }
      : {}),
  };
  const reportDeps: ReportDeps = { warehouse: deps.warehouse, clock: deps.clock };
  return buildReorderReport(reportDeps, opts);
}

// ── sync_status ───────────────────────────────────────────────────────

export interface SyncStatusRowOut {
  resource: string;
  cursor: string | null;
  last_synced_at: string | null;
}

export interface SyncStatusResult {
  resources: SyncStatusRowOut[];
  generated_at: string;
}

export async function syncStatusTool(deps: {
  warehouse: Warehouse;
  clock: Clock;
}): Promise<SyncStatusResult> {
  const syncState = await deps.warehouse.getSyncState();
  return {
    resources: syncState.map((s) => ({
      resource: s.resource,
      cursor: s.cursor,
      last_synced_at: s.lastSyncedAt ? s.lastSyncedAt.toISOString() : null,
    })),
    generated_at: deps.clock.now().toISOString(),
  };
}

// ── sync_now (write, disabled by default in production — DESIGN §11.4) ──

export interface SyncNowDeps {
  loyverseClient: LoyverseClient;
  warehouse: Warehouse;
  clock: Clock;
  /** Lets only one of concurrent calls run (advisory lock). The rest get an "already running" error immediately. */
  runExclusively: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface SyncNowInput {
  resources?: SyncResource[];
}

export interface SyncNowResourceOut {
  resource: SyncResource;
  status: "success" | "failed" | "skipped";
  item_count: number;
  error: string | null;
  last_synced_at: string | null;
}

export interface SyncNowResult {
  run_id: string;
  ok: boolean;
  started_at: string;
  finished_at: string;
  resources: SyncNowResourceOut[];
}

function toSyncNowResult(r: SyncResult): SyncNowResult {
  return {
    run_id: r.runId,
    ok: r.ok,
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt.toISOString(),
    resources: r.resources.map((res) => ({
      resource: res.resource,
      status: res.status,
      item_count: res.itemCount,
      error: res.error ?? null,
      last_synced_at: res.lastSyncedAt ? res.lastSyncedAt.toISOString() : null,
    })),
  };
}

export async function syncNowTool(deps: SyncNowDeps, input: SyncNowInput): Promise<SyncNowResult> {
  const result = await deps.runExclusively(() =>
    syncAll(
      { loyverseClient: deps.loyverseClient, warehouse: deps.warehouse, clock: deps.clock },
      input.resources !== undefined ? { resources: input.resources } : {},
    ),
  );
  return toSyncNowResult(result);
}

// ── explore_sql (v0.2 backlog, TASKS T27) — disabled by default in production, needs EXPLORE_SQL_ENABLED=true ──
//
// The real safeguards (SQL validation + BEGIN READ ONLY) live in core/sqlValidator.ts and
// adapters/exploreSqlExecutor.ts — this is the same thin assembly layer as the other 5 tools.

export interface ExploreSqlDeps {
  executor: ExploreSqlExecutor;
}

export interface ExploreSqlToolInput {
  sql: string;
  limit?: number;
  timeoutMs?: number;
}

export async function exploreSqlTool(
  deps: ExploreSqlDeps,
  input: ExploreSqlToolInput,
): Promise<ExploreSqlResult> {
  return deps.executor.execute(input.sql, {
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
}
