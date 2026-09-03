/**
 * MCP 도구 6종의 실제 로직 (DESIGN.md §6). `src/server.ts`는 이 파일의 함수들을
 * `McpServer.registerTool()`로 등록하는 조립만 한다 — CLAUDE.md "server.ts는 도구 등록·조립만,
 * 로직 없음"에 따라 로직은 전부 여기 있다.
 *
 * 조회 도구 4종(sell_through/inventory_status/stockout_risk/reorder_suggestions)은 읽기 전용
 * DB 자격 증명으로 실행한다(DESIGN §11.4) — 이 파일에서 이 4개 함수는 Warehouse의 query 계열/get
 * 계열 메서드만 호출하고 upsert류를 호출하지 않는다. `reorder_suggestions`는 `agent/reorder.ts`의
 * `buildReorderReport()`를 그대로 재사용해 "도구 결과 = 에이전트 리포트"를 구조적으로 보장한다
 * (TESTING §4 MCP 회귀 가드).
 *
 * 응답 공통 메타데이터(DESIGN §11.6): generated_at/data_last_synced_at/timezone/filters/warnings를
 * 4개 조회 도구 모두 포함한다. 신선도 판정은 core/freshness.ts를 공유한다(SPEC §9).
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

// ── 공통 ────────────────────────────────────────────────────────────────

export interface QueryToolDeps {
  warehouse: Warehouse;
  clock: Clock;
  businessTimezone: string;
  /** 기본값 DEFAULT_STALE_THRESHOLD_HOURS(24, env STALE_THRESHOLD_HOURS로 조정). */
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
 * store_id가 주어졌는데 존재하지 않으면 원인이 담긴 에러를 던진다(TESTING §4 MCP 도구 항목).
 * `agent/reorder.ts`의 buildReorderReport()에도 동일한 검증이 있다(그쪽은 Warehouse.queryStores
 * 결과를 매장명 조립에도 써야 해서 별도로 조회한다) — 5줄 남짓의 검증이라 의도적으로 각자 둔다.
 */
async function assertStoreExists(warehouse: Warehouse, storeId: string | undefined): Promise<void> {
  if (storeId === undefined) return;
  const stores = await warehouse.queryStores(storeId);
  if (stores.length === 0) {
    throw new Error(
      `존재하지 않는 store_id입니다: "${storeId}". sync_status 도구나 stores 테이블에서 ` +
        "등록된 매장 id를 확인하세요.",
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
  /** null = 신규/무재고(판매+기말재고=0) — SPEC §2. */
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
  // null(신규/무재고)은 순위를 매길 수 없으니 정렬 방향과 무관하게 항상 끝으로 보낸다.
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
      "근사식(SPEC §2): 셀스루 = 기간 판매수량 ÷ (기간 판매수량 + 기말재고). " +
      "정통 정의(판매 ÷ (기초재고+입고))는 입고 데이터 확보 후 v0.2.",
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
  /** null = ∞(무한 커버) — 최근 판매가 없다는 뜻. */
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
    // ∞(null) 커버는 어떤 유한 임계값보다도 "미달"이 아니다.
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
  /** YYYY-MM-DD(사업장 타임존 기준). daysOfCover를 올림한 날수만큼 오늘에 더한 근사값. */
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
  // periodEnd = calendarWindow()이 계산한 "사업장 현지 오늘 자정"(DESIGN §11.3) — 예상 소진일의
  // 기준일로 쓴다. daysOfCover는 소수일 수 있어 올림한다(더 이르게, 안전한 쪽으로 경고).
  const rows: StockoutRiskRowOut[] = [];
  for (const r of risky) {
    if (r.daysOfCover === null) continue; // isStockoutRisk가 null이면 false를 반환하므로 도달 불가.
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
    note: "expected_stockout_date는 daysOfCover를 올림해 오늘(사업장 타임존)에 더한 근사값입니다.",
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

// ── reorder_suggestions (에이전트와 동일 함수) ───────────────────────────

export interface ReorderSuggestionsInput {
  storeId?: string;
  targetDaysCover: number;
  leadTimeDays: number;
}

/**
 * DESIGN §6: "제안 수량 표 — 에이전트와 동일 함수". agent/reorder.ts의 buildReorderReport()를
 * 그대로 호출해 반환한다 — 별도 변환 없이 같은 ReorderReport를 반환해야 TESTING §4의
 * "reorder_suggestions 결과 = 에이전트 리포트 표와 완전 동일" 회귀 가드가 성립한다.
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

// ── sync_now (쓰기, 운영 기본값 비활성 — DESIGN §11.4) ────────────────────

export interface SyncNowDeps {
  loyverseClient: LoyverseClient;
  warehouse: Warehouse;
  clock: Clock;
  /** 동시 호출 중 하나만 실행되게 한다(advisory lock). 나머지는 즉시 실행 중 오류. */
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

// ── explore_sql (v0.2 대기열, TASKS T27) — 운영 기본값 비활성, EXPLORE_SQL_ENABLED=true 필요 ──
//
// 실제 안전장치(SQL 검증 + BEGIN READ ONLY)는 core/sqlValidator.ts와
// adapters/exploreSqlExecutor.ts에 있다 — 여기는 다른 5개 도구와 같은 얇은 조립 계층이다.

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
