/**
 * 지표 코어 — 순수 함수만. 외부 IO 없음, 시각은 전부 Clock을 통해서만 얻는다.
 * 수식의 진실의 원천은 DESIGN.md §3(= SPEC.md §2와 동일해야 한다). 코드·문서가 다르면
 * 문서 기준으로 코드를 고친다(WORKFLOW.md — "테스트를 수식에 맞추는" 방향의 수정 금지).
 */
import type {
  Clock,
  InventoryRow,
  Numeric,
  ProductRow,
  SalesAgg,
  SalesPeriodAggRow,
  StockRow,
} from "./types.js";

// ── 경계: Numeric(문자열) → number 파싱 정책 ────────────────────────────
// numeric 컬럼은 문자열로 넘어온다(pg/PGlite 공통). 여기서만 명시적으로 number로 바꾸고,
// 이후 계산은 전부 number로 한다 — 중간 반올림은 하지 않는다(표시 반올림·재주문 ceil 제외).

function parseNumeric(raw: Numeric, fieldName: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(
      `${fieldName} 값이 유효한 숫자가 아닙니다: "${raw}". Warehouse가 반환한 numeric 문자열을 확인하세요.`,
    );
  }
  return n;
}

// ── 5종 순수 수식 (DESIGN §3) ────────────────────────────────────────────

/** 근사 셀스루 = soldQty/(soldQty+endStock). 분모 0 → null(신규/무재고 구분 표기). */
export function sellThroughRatio(soldQty: number, endStock: number): number | null {
  const denom = soldQty + endStock;
  if (denom === 0) return null;
  return soldQty / denom;
}

/** 일평균판매 = 창(N일) 내 총판매량 / N (달력일, 무판매일 포함). */
export function avgDailySales(totalSoldQty: number, windowDays: number): number {
  if (windowDays <= 0) {
    throw new Error(`windowDays는 1 이상이어야 합니다. 받은 값: ${windowDays}.`);
  }
  return totalSoldQty / windowDays;
}

/** 재고커버일수 = inStock/avgDailySales. avgDailySales=0 → null(∞ 표기). */
export function daysOfCover(inStock: number, avgDailySalesValue: number): number | null {
  if (avgDailySalesValue === 0) return null;
  return inStock / avgDailySalesValue;
}

/** 품절위험 = daysOfCover < leadTimeDays+safetyDays. daysOfCover=null(∞)이면 위험 아님. */
export function isStockoutRisk(
  daysOfCoverValue: number | null,
  leadTimeDays: number,
  safetyDays: number,
): boolean {
  if (daysOfCoverValue === null) return false;
  return daysOfCoverValue < leadTimeDays + safetyDays;
}

/** 재주문 제안량 = max(0, ceil(targetCoverDays*avgDailySales - inStock)). */
export function reorderQty(
  avgDailySalesValue: number,
  inStock: number,
  targetCoverDays: number,
): number {
  return Math.max(0, Math.ceil(targetCoverDays * avgDailySalesValue - inStock));
}

// ── 사업장 타임존 반개방 기간 경계 (DESIGN §11.3, Clock 주입) ───────────────
// 외부 날짜 라이브러리 없이 Intl.DateTimeFormat만으로 타임존-안전 자정 변환을 한다.
// 머신 로컬 타임존에 의존하지 않고, DST가 있는 지역에서도 안전하다.

function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  const asIfUtc = Date.UTC(
    Number(map["year"]),
    Number(map["month"]) - 1,
    Number(map["day"]),
    Number(map["hour"]),
    Number(map["minute"]),
    Number(map["second"]),
  );
  return asIfUtc - instant.getTime();
}

/** timeZone 기준 (year, month, day) 자정에 해당하는 UTC 시각. DST 경계에서도 정확하다. */
function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  // 오프셋을 추정→보정하는 고정점 반복. 오프셋이 자정 부근에서 바뀌는 극단적 DST 지역까지
  // 감안해 2회면 충분히 수렴한다(일반적인 시간대 규칙에서).
  for (let i = 0; i < 2; i++) {
    const offsetMs = offsetMsAt(new Date(guess), timeZone);
    const wanted = Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMs;
    if (wanted === guess) break;
    guess = wanted;
  }
  return new Date(guess);
}

export interface CalendarWindow {
  /** 반개방 구간 시작 — timeZone 기준 (오늘-windowDays) 자정. */
  periodStart: Date;
  /** 반개방 구간 끝(포함 안 함) — timeZone 기준 오늘 자정. */
  periodEnd: Date;
  timeZone: string;
}

/**
 * `[사업장 현지 오늘-N일 시작, 현지 오늘 시작)` 반개방 구간을 계산한다(DESIGN §11.3).
 * "오늘"은 Clock에서만 얻는다 — 머신 로컬 시각을 직접 쓰지 않는다.
 */
export function calendarWindow(clock: Clock, windowDays: number, timeZone: string): CalendarWindow {
  if (windowDays <= 0) {
    throw new Error(`windowDays는 1 이상이어야 합니다. 받은 값: ${windowDays}.`);
  }
  const now = clock.now();
  const todayParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = Number(todayParts.find((p) => p.type === "year")?.value);
  const m = Number(todayParts.find((p) => p.type === "month")?.value);
  const d = Number(todayParts.find((p) => p.type === "day")?.value);

  const periodEnd = zonedMidnightUtc(y, m, d, timeZone);

  // 달력일 뺄셈은 시간대 개념이 아닌 순수 날짜 산술이므로 UTC 기준 Date로 안전하게 수행한 뒤
  // 그 (year, month, day)를 다시 timeZone 자정으로 변환한다.
  const startDateOnly = new Date(Date.UTC(y, m - 1, d));
  startDateOnly.setUTCDate(startDateOnly.getUTCDate() - windowDays);
  const periodStart = zonedMidnightUtc(
    startDateOnly.getUTCFullYear(),
    startDateOnly.getUTCMonth() + 1,
    startDateOnly.getUTCDate(),
    timeZone,
  );

  return { periodStart, periodEnd, timeZone };
}

// ── 배열 파이프라인: (SalesAgg[], StockRow[], opts) → *Row[] ────────────────
// DESIGN §3: "전부 순수 함수: (rows: SalesAgg[], stock: StockRow[], opts) → MetricRow[]".
// sell_through와 stockout_risk/reorder_suggestions는 서로 다른 판매 기간(SalesAgg 질의
// 기간)을 쓰므로 별도 파이프라인 함수로 나눈다 — 호출자가 각자 맞는 기간으로 querySalesAgg한
// 결과를 넘긴다.

export interface SellThroughRow {
  storeId: string;
  variantId: string;
  name: string;
  category: string | null;
  /** 기간 내 원시 순판매량(환불 포함, 음수 가능). */
  soldQtyRaw: number;
  /** 계산에 사용한 판매량 = max(0, soldQtyRaw). */
  soldQty: number;
  /** 원시 기말재고(음수 가능). */
  endStockRaw: number;
  /** 계산에 사용한 기말재고 = max(0, endStockRaw). */
  endStock: number;
  /** null = 신규/무재고(soldQty+endStock=0). */
  sellThrough: number | null;
  warnings: string[];
}

/**
 * sell_through 지표 배열을 계산한다. salesAgg는 호출자가 원하는 기간(period_days)으로
 * querySalesAgg한 결과, stock은 현재고(queryStock) 결과다. (storeId, variantId) 기준으로
 * 두 배열의 키를 합집합해 조인한다 — 기간 내 판매가 0건이라도 현재고가 있는 품목은
 * soldQty=0으로 포함된다(판매0+재고X 같은 골든 케이스가 실제로 나오려면 필요하다).
 */
export function computeSellThrough(salesAgg: SalesAgg[], stock: StockRow[]): SellThroughRow[] {
  const salesByKey = new Map(salesAgg.map((a) => [`${a.storeId}:${a.variantId}`, a]));
  const stockByKey = new Map(stock.map((s) => [`${s.storeId}:${s.variantId}`, s]));
  const keys = new Set<string>([...salesByKey.keys(), ...stockByKey.keys()]);

  const rows: SellThroughRow[] = [];
  for (const key of keys) {
    const agg = salesByKey.get(key);
    const stockRow = stockByKey.get(key);
    const warnings: string[] = [];

    const soldQtyRaw = agg ? parseNumeric(agg.soldQtyRaw, "soldQtyRaw") : 0;
    const soldQty = Math.max(0, soldQtyRaw);
    if (soldQtyRaw < 0) {
      warnings.push(
        `환불이 판매를 초과해 기간 순판매량이 음수(${soldQtyRaw})입니다 — 계산에는 0을 사용했습니다.`,
      );
    }

    const endStockRaw = stockRow ? parseNumeric(stockRow.inStockRaw, "inStockRaw") : 0;
    const endStock = Math.max(0, endStockRaw);
    if (endStockRaw < 0) {
      warnings.push(`현재고가 음수(${endStockRaw})입니다 — 계산에는 0을 사용했습니다.`);
    }
    if (!stockRow) {
      warnings.push("현재고 데이터가 없어 0으로 처리했습니다.");
    }

    const [storeId, variantId] = key.split(":") as [string, string];
    rows.push({
      storeId,
      variantId,
      name: agg?.name ?? stockRow?.name ?? variantId,
      category: agg?.category ?? null,
      soldQtyRaw,
      soldQty,
      endStockRaw,
      endStock,
      sellThrough: sellThroughRatio(soldQty, endStock),
      warnings,
    });
  }
  return rows;
}

export interface ReorderOptions {
  /** avgDailySales 창(일). 기본 28. */
  windowDays?: number;
  /** 리드타임(일). 기본 7. */
  leadTimeDays?: number;
  /** 안전재고일수. 기본 3. */
  safetyDays?: number;
  /** 재주문 목표커버일수. 기본 21. */
  targetCoverDays?: number;
}

export const DEFAULT_WINDOW_DAYS = 28;
export const DEFAULT_LEAD_TIME_DAYS = 7;
export const DEFAULT_SAFETY_DAYS = 3;
export const DEFAULT_TARGET_COVER_DAYS = 21;

export interface ReorderMetricRow {
  storeId: string;
  variantId: string;
  name: string;
  category: string | null;
  /** windowDays 기간 내 원시 순판매량 합(환불 포함, 음수 가능). */
  soldQtyRaw: number;
  soldQty: number;
  inStockRaw: number;
  /** 계산에 사용한 현재고 = max(0, inStockRaw). */
  inStock: number;
  avgDailySales: number;
  /** null = 무한(∞) 커버 — 판매 없음. */
  daysOfCover: number | null;
  stockoutRisk: boolean;
  reorderQty: number;
  warnings: string[];
}

/**
 * stockout_risk/reorder_suggestions/재주문 에이전트가 공유하는 지표 배열을 계산한다.
 * salesAgg는 opts.windowDays(기본 28일) 기간으로 querySalesAgg한 결과여야 한다 — 호출자가
 * calendarWindow()로 만든 기간으로 미리 질의한다. (storeId, variantId)로 조인한다.
 */
export function computeReorderMetrics(
  salesAgg: SalesAgg[],
  stock: StockRow[],
  opts: ReorderOptions = {},
): ReorderMetricRow[] {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const leadTimeDays = opts.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;
  const safetyDays = opts.safetyDays ?? DEFAULT_SAFETY_DAYS;
  const targetCoverDays = opts.targetCoverDays ?? DEFAULT_TARGET_COVER_DAYS;

  const salesByKey = new Map(salesAgg.map((a) => [`${a.storeId}:${a.variantId}`, a]));
  const keys = new Set<string>([
    ...salesAgg.map((a) => `${a.storeId}:${a.variantId}`),
    ...stock.map((s) => `${s.storeId}:${s.variantId}`),
  ]);

  const rows: ReorderMetricRow[] = [];
  for (const key of keys) {
    const agg = salesByKey.get(key);
    const stockRow = stock.find((s) => `${s.storeId}:${s.variantId}` === key);
    const warnings: string[] = [];

    const soldQtyRaw = agg ? parseNumeric(agg.soldQtyRaw, "soldQtyRaw") : 0;
    const soldQty = Math.max(0, soldQtyRaw);
    if (soldQtyRaw < 0) {
      warnings.push(
        `환불이 판매를 초과해 창(${windowDays}일) 순판매량이 음수(${soldQtyRaw})입니다 — 계산에는 0을 사용했습니다.`,
      );
    }

    const inStockRaw = stockRow ? parseNumeric(stockRow.inStockRaw, "inStockRaw") : 0;
    const inStock = Math.max(0, inStockRaw);
    if (inStockRaw < 0) {
      warnings.push(`현재고가 음수(${inStockRaw})입니다 — 계산에는 0을 사용했습니다.`);
    }
    if (!stockRow) {
      warnings.push("현재고 데이터가 없어 0으로 처리했습니다.");
    }

    const avgDaily = avgDailySales(soldQty, windowDays);
    const cover = daysOfCover(inStock, avgDaily);
    const [storeId, variantId] = key.split(":") as [string, string];

    rows.push({
      storeId,
      variantId,
      name: agg?.name ?? stockRow?.name ?? variantId,
      category: agg?.category ?? null,
      soldQtyRaw,
      soldQty,
      inStockRaw,
      inStock,
      avgDailySales: avgDaily,
      daysOfCover: cover,
      stockoutRisk: isStockoutRisk(cover, leadTimeDays, safetyDays),
      reorderQty: reorderQty(avgDaily, inStock, targetCoverDays),
      warnings,
    });
  }
  return rows;
}

// ── CSV/Excel 채널: 셀스루/임계치 분기 (SPEC §12, TASKS T17) ─────────────────
//
// Loyverse는 querySalesAgg로 "호출자가 원하는 임의 기간"을 다시 집계할 수 있지만, CSV/Excel
// 채널은 그렇지 않다 — sales_period_agg 한 행이 "그 스캔이 읽은 파일이 보고한 기간 하나"를
// 대표할 뿐, 원장(raw transaction)이 없어 다른 기간으로 재집계할 수 없다. 그래서 여기는
// Warehouse.querySalesPeriodAgg(SalesAgg[] 반환 — 의도적으로 기간 정보가 없다, TASKS T12)가
// 아니라 T16이 막 파싱한 원본 행(SalesPeriodAggRow — periodStart/periodEnd 보존)을 직접
// 받는다. 이 함수는 T18(폴더 스캔)이 파싱 직후, 아직 웨어하우스에 쓰기 전에 호출하는 걸
// 전제한다 — DB 재조회가 필요 없다.
//
// computeReorderMetrics 자체는 건드리지 않는다(이미 소스 중립적) — 대신 판매이력이 있는
// (매장,SKU)들을 "실제 기간 길이(day)"별로 묶어 그룹마다 한 번씩 그 함수를 그 기간에 맞는
// windowDays로 호출한다. 한 파일 안에 기간 길이가 다른 행이 섞여 있어도(품목마다 다른
// 판매기간을 적어도) 각자 맞는 windowDays로 계산된다.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CsvMetricsOptions extends ReorderOptions {
  /** 품목별 저재고임계치(ProductRow.lowStockThreshold) override가 없을 때 쓰는 전역 기본값. */
  defaultLowStockThreshold: number;
}

/** 판매이력이 있어 §2 근사식(avgDailySales/daysOfCover/stockoutRisk/reorderQty/셀스루)을 그대로 적용한 행. */
export type CsvHistoryMetricRow = ReorderMetricRow & {
  mode: "history";
  /** 같은 원시 판매량/재고로 계산한 근사 셀스루(§2) — computeSellThrough와 동일한 정의. */
  sellThrough: number | null;
};

/** 판매이력이 없어 셀스루/재주문 계산을 건너뛰고 단순 임계치로만 판정한 행(SPEC §12). */
export interface CsvThresholdMetricRow {
  mode: "no_history";
  storeId: string;
  variantId: string;
  name: string;
  category: string | null;
  inStockRaw: number;
  inStock: number;
  /** 이 품목에 실제로 적용된 임계치(품목별 override 우선, 없으면 defaultLowStockThreshold). */
  threshold: number;
  belowThreshold: boolean;
  warnings: string[];
}

export type CsvMetricRow = CsvHistoryMetricRow | CsvThresholdMetricRow;

function csvKey(storeId: string, variantId: string): string {
  return `${storeId}:${variantId}`;
}

/**
 * CSV/Excel 채널의 재고 스캔 1회 분(T16 `ParsedCsvExcelFile`의 inventory/salesPeriodAgg/
 * products)을 받아, 판매이력 유무로 분기해 지표를 계산한다(SPEC §12 "판매이력 없을 때:
 * 임계치 폴백"). 순수 함수 — 웨어하우스 조회 없음.
 */
export function computeCsvReorderMetrics(
  inventory: InventoryRow[],
  salesPeriodAgg: SalesPeriodAggRow[],
  products: ProductRow[],
  opts: CsvMetricsOptions,
): CsvMetricRow[] {
  const productByVariant = new Map(products.map((p) => [p.variantId, p]));
  const stockByKey = new Map(inventory.map((r) => [csvKey(r.storeId, r.variantId), r]));
  const salesByKey = new Map(salesPeriodAgg.map((s) => [csvKey(s.storeId, s.variantId), s]));

  // 실제 기간 길이(일)별로 묶는다 — 파일 안에 서로 다른 기간 길이가 섞여 있을 수 있다.
  const groupsByWindowDays = new Map<number, SalesPeriodAggRow[]>();
  for (const s of salesPeriodAgg) {
    const windowDays = (s.periodEnd.getTime() - s.periodStart.getTime()) / MS_PER_DAY;
    const group = groupsByWindowDays.get(windowDays) ?? [];
    group.push(s);
    groupsByWindowDays.set(windowDays, group);
  }

  const historyRows: CsvHistoryMetricRow[] = [];
  for (const [windowDays, group] of groupsByWindowDays) {
    const salesAgg: SalesAgg[] = group.map((s) => {
      const p = productByVariant.get(s.variantId);
      return {
        storeId: s.storeId,
        variantId: s.variantId,
        name: p?.name ?? s.variantId,
        category: p?.category ?? null,
        soldQtyRaw: s.soldQty,
      };
    });
    const stockRows: StockRow[] = [];
    for (const s of group) {
      const inv = stockByKey.get(csvKey(s.storeId, s.variantId));
      if (!inv) continue;
      const p = productByVariant.get(s.variantId);
      stockRows.push({
        storeId: inv.storeId,
        variantId: inv.variantId,
        name: p?.name ?? inv.variantId,
        inStockRaw: inv.inStock,
        updatedAt: inv.updatedAt,
      });
    }

    for (const row of computeReorderMetrics(salesAgg, stockRows, { ...opts, windowDays })) {
      historyRows.push({
        ...row,
        mode: "history",
        sellThrough: sellThroughRatio(row.soldQty, row.inStock),
      });
    }
  }

  const noHistoryRows: CsvThresholdMetricRow[] = [];
  for (const inv of inventory) {
    if (salesByKey.has(csvKey(inv.storeId, inv.variantId))) continue; // history 쪽에서 처리됨.
    const p = productByVariant.get(inv.variantId);
    const warnings: string[] = [];

    const inStockRaw = parseNumeric(inv.inStock, "재고수량");
    const inStock = Math.max(0, inStockRaw);
    if (inStockRaw < 0) {
      warnings.push(`현재고가 음수(${inStockRaw})입니다 — 계산에는 0을 사용했습니다.`);
    }

    const threshold =
      p?.lowStockThreshold !== undefined && p.lowStockThreshold !== null
        ? parseNumeric(p.lowStockThreshold, "저재고임계치")
        : opts.defaultLowStockThreshold;

    noHistoryRows.push({
      mode: "no_history",
      storeId: inv.storeId,
      variantId: inv.variantId,
      name: p?.name ?? inv.variantId,
      category: p?.category ?? null,
      inStockRaw,
      inStock,
      threshold,
      belowThreshold: inStock < threshold,
      warnings,
    });
  }

  return [...historyRows, ...noHistoryRows];
}
