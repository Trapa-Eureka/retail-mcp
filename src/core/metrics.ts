/**
 * Metrics core — pure functions only. No external IO; the current time is obtained only through Clock.
 * The source of truth for the formulas is DESIGN.md §3 (which must equal SPEC.md §2). When code and
 * docs disagree, fix the code to match the docs (WORKFLOW.md — never "fit the tests to the formula").
 */
import type {
  Clock,
  InventoryRow,
  Numeric,
  ProductRow,
  PurchaseAgg,
  SalesAgg,
  SalesPeriodAggRow,
  StockRow,
} from "./types.js";

// ── Boundary: Numeric (string) → number parsing policy ──────────────────
// numeric columns arrive as strings (pg and PGlite alike). They are converted to number explicitly
// here and nowhere else; all subsequent arithmetic is done in number — no intermediate rounding
// (except display rounding and the reorder ceil).

function parseNumeric(raw: Numeric, fieldName: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(
      `${fieldName} is not a valid number: "${raw}". Check the numeric string returned by the Warehouse.`,
    );
  }
  return n;
}

// ── The five pure formulas (DESIGN §3) ───────────────────────────────────

/** Approximate sell-through = soldQty/(soldQty+endStock). Denominator 0 → null (new item / no stock marker). */
export function sellThroughRatio(soldQty: number, endStock: number): number | null {
  const denom = soldQty + endStock;
  if (denom === 0) return null;
  return soldQty / denom;
}

/** Average daily sales = total sold qty within the window (N days) / N (calendar days, including days without sales). */
export function avgDailySales(totalSoldQty: number, windowDays: number): number {
  if (windowDays <= 0) {
    throw new Error(`windowDays must be at least 1. Received: ${windowDays}.`);
  }
  return totalSoldQty / windowDays;
}

/** Days of cover = inStock/avgDailySales. avgDailySales=0 → null (rendered as ∞). */
export function daysOfCover(inStock: number, avgDailySalesValue: number): number | null {
  if (avgDailySalesValue === 0) return null;
  return inStock / avgDailySalesValue;
}

/** Stockout risk = daysOfCover < leadTimeDays+safetyDays. daysOfCover=null (∞) is never at risk. */
export function isStockoutRisk(
  daysOfCoverValue: number | null,
  leadTimeDays: number,
  safetyDays: number,
): boolean {
  if (daysOfCoverValue === null) return false;
  return daysOfCoverValue < leadTimeDays + safetyDays;
}

/** Reorder suggestion qty = max(0, ceil(targetCoverDays*avgDailySales - inStock)). */
export function reorderQty(
  avgDailySalesValue: number,
  inStock: number,
  targetCoverDays: number,
): number {
  return Math.max(0, Math.ceil(targetCoverDays * avgDailySalesValue - inStock));
}

/**
 * Pack-multiple rounding (SPEC §14) — rounds the unit-level suggestion computed by reorderQty() up
 * to a multiple of the pack size so it becomes a quantity that can actually be ordered. reorderQty()
 * itself is untouched (this is purely a post-processing wrapper around its output). Without a
 * packSize (single units can be purchased) nothing is rounded and the value is returned as is —
 * packCount is then null because the concept does not exist (not 0: "there is no pack unit" and
 * "0 packs are needed" are different things).
 */
export interface PackRoundedOrder {
  /** Actual order qty rounded up to a pack-size multiple. Equals reorderQtyValue when there is no packSize. */
  finalOrderQty: number;
  /** Number of packs (boxes) to order. null when there is no packSize. */
  packCount: number | null;
}

export function roundToPackMultiple(
  reorderQtyValue: number,
  packSize: number | null | undefined,
): PackRoundedOrder {
  if (packSize === null || packSize === undefined) {
    return { finalOrderQty: reorderQtyValue, packCount: null };
  }
  if (!Number.isFinite(packSize) || packSize <= 0) {
    throw new Error(`packSize must be a number greater than 0. Received: ${packSize}.`);
  }
  if (reorderQtyValue === 0) return { finalOrderQty: 0, packCount: 0 };
  const packCount = Math.ceil(reorderQtyValue / packSize);
  return { finalOrderQty: packCount * packSize, packCount };
}

// ── Half-open period boundaries in the business timezone (DESIGN §11.3, Clock injected) ──
// Timezone-safe midnight conversion using only Intl.DateTimeFormat, no external date library.
// Independent of the machine's local timezone and safe in regions with DST.

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

/** The UTC instant of midnight on (year, month, day) in timeZone. Exact even across DST boundaries. */
function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  // Fixed-point iteration: estimate the offset, then correct. Two rounds are enough to converge
  // (under ordinary timezone rules), even for extreme DST zones whose offset changes near midnight.
  for (let i = 0; i < 2; i++) {
    const offsetMs = offsetMsAt(new Date(guess), timeZone);
    const wanted = Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMs;
    if (wanted === guess) break;
    guess = wanted;
  }
  return new Date(guess);
}

export interface CalendarWindow {
  /** Start of the half-open interval — midnight of (today - windowDays) in timeZone. */
  periodStart: Date;
  /** End of the half-open interval (exclusive) — midnight of today in timeZone. */
  periodEnd: Date;
  timeZone: string;
}

/**
 * Computes the half-open interval `[start of local today - N days, start of local today)` in the
 * business timezone (DESIGN §11.3). "Today" comes only from the Clock — the machine's local time is
 * never used directly.
 */
export function calendarWindow(clock: Clock, windowDays: number, timeZone: string): CalendarWindow {
  if (windowDays <= 0) {
    throw new Error(`windowDays must be at least 1. Received: ${windowDays}.`);
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

  // Calendar-day subtraction is pure date arithmetic with no timezone notion, so it is done safely
  // on a UTC-based Date and the resulting (year, month, day) is converted back to timeZone midnight.
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

// ── Array pipelines: (SalesAgg[], StockRow[], opts) → *Row[] ─────────────
// DESIGN §3: "all pure functions: (rows: SalesAgg[], stock: StockRow[], opts) → MetricRow[]".
// sell_through and stockout_risk/reorder_suggestions use different sales periods (the SalesAgg query
// period), so they are split into separate pipeline functions — each caller passes the result of
// querySalesAgg for the period appropriate to it.

export interface SellThroughRow {
  storeId: string;
  variantId: string;
  name: string;
  category: string | null;
  /** Raw net sold qty within the period (refunds included, may be negative). */
  soldQtyRaw: number;
  /** Sold qty used in the calculation = max(0, soldQtyRaw). */
  soldQty: number;
  /** Raw end-of-period stock (may be negative). */
  endStockRaw: number;
  /** End stock used in the calculation = max(0, endStockRaw). */
  endStock: number;
  /** null = new item / no stock (soldQty+endStock=0). */
  sellThrough: number | null;
  warnings: string[];
}

/**
 * Computes the sell_through metric rows. salesAgg is the result of querySalesAgg for the period the
 * caller wants (period_days); stock is the current stock (queryStock) result. The two arrays are
 * joined on the union of their (storeId, variantId) keys — an item with current stock but zero sales
 * in the period is still included with soldQty=0 (required for golden cases such as "0 sales + stock X"
 * to actually appear).
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
        `Refunds exceeded sales, so the period net sold qty is negative (${soldQtyRaw}) — 0 was used in the calculation.`,
      );
    }

    const endStockRaw = stockRow ? parseNumeric(stockRow.inStockRaw, "inStockRaw") : 0;
    const endStock = Math.max(0, endStockRaw);
    if (endStockRaw < 0) {
      warnings.push(`Current stock is negative (${endStockRaw}) — 0 was used in the calculation.`);
    }
    if (!stockRow) {
      warnings.push("No current stock data — treated as 0.");
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
  /** avgDailySales window (days). Default 28. */
  windowDays?: number;
  /** Lead time (days). Default 7. */
  leadTimeDays?: number;
  /** Safety stock days. Default 3. */
  safetyDays?: number;
  /** Reorder target cover days. Default 21. */
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
  /** Raw net sold qty summed over windowDays (refunds included, may be negative). */
  soldQtyRaw: number;
  soldQty: number;
  inStockRaw: number;
  /** Current stock used in the calculation = max(0, inStockRaw). */
  inStock: number;
  avgDailySales: number;
  /** null = infinite (∞) cover — no sales. */
  daysOfCover: number | null;
  stockoutRisk: boolean;
  reorderQty: number;
  warnings: string[];
}

/**
 * Computes the metric rows shared by stockout_risk / reorder_suggestions / the reorder agent.
 * salesAgg must be the result of querySalesAgg over opts.windowDays (default 28) — the caller
 * queries beforehand using the period produced by calendarWindow(). Joined on (storeId, variantId).
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
        `Refunds exceeded sales, so the net sold qty over the ${windowDays}-day window is negative (${soldQtyRaw}) — 0 was used in the calculation.`,
      );
    }

    const inStockRaw = stockRow ? parseNumeric(stockRow.inStockRaw, "inStockRaw") : 0;
    const inStock = Math.max(0, inStockRaw);
    if (inStockRaw < 0) {
      warnings.push(`Current stock is negative (${inStockRaw}) — 0 was used in the calculation.`);
    }
    if (!stockRow) {
      warnings.push("No current stock data — treated as 0.");
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

/**
 * Applies roundToPackMultiple() to the rows computed by computeReorderMetrics (or the history rows
 * of computeCsvReorderMetrics), using ProductRow.packSize joined on (storeId,variantId) —
 * computeReorderMetrics itself is untouched (the same pattern TASKS T17 used when wrapping
 * computeReorderMetrics with computeCsvReorderMetrics).
 */
export type PackRoundedReorderRow = ReorderMetricRow &
  PackRoundedOrder & { packSize: number | null };

export function applyPackRounding(
  rows: ReorderMetricRow[],
  products: ProductRow[],
): PackRoundedReorderRow[] {
  const productByVariant = new Map(products.map((p) => [p.variantId, p]));
  return rows.map((row) => {
    const product = productByVariant.get(row.variantId);
    const packSize =
      product?.packSize !== undefined && product.packSize !== null
        ? parseNumeric(product.packSize, "pack_size")
        : null;
    return { ...row, packSize, ...roundToPackMultiple(row.reorderQty, packSize) };
  });
}

// ── CSV/Excel channel: sell-through / threshold branch (SPEC §12, TASKS T17) ─────────────
//
// Loyverse can re-aggregate "any period the caller wants" via querySalesAgg, but the CSV/Excel
// channel cannot — one sales_period_agg row only represents "the single period reported by the file
// that scan read", and with no ledger (raw transactions) it cannot be re-aggregated over another
// period. So instead of Warehouse.querySalesPeriodAgg (which returns SalesAgg[] — deliberately
// without period information, TASKS T12), this takes the raw rows T16 just parsed
// (SalesPeriodAggRow — periodStart/periodEnd preserved) directly. It assumes T18 (folder scan) calls
// it right after parsing, before writing to the warehouse — no DB re-query is needed.
//
// computeReorderMetrics itself is untouched (it is already source-neutral) — instead the (store,SKU)
// pairs with sales history are grouped by their "actual period length (days)" and that function is
// called once per group with the windowDays matching that period. Even if rows with different period
// lengths are mixed in one file (each item reporting its own sales period), each is computed with its
// own correct windowDays.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CsvMetricsOptions extends ReorderOptions {
  /** Global default used when an item has no per-item low-stock threshold override (ProductRow.lowStockThreshold). */
  defaultLowStockThreshold: number;
}

/** A row with sales history — the §2 approximations (avgDailySales/daysOfCover/stockoutRisk/reorderQty/sell-through) apply as is. */
export type CsvHistoryMetricRow = ReorderMetricRow & {
  mode: "history";
  /** Approximate sell-through (§2) from the same raw sold qty / stock — same definition as computeSellThrough. */
  sellThrough: number | null;
};

/** A row without sales history — sell-through/reorder are skipped and only the simple threshold is judged (SPEC §12). */
export interface CsvThresholdMetricRow {
  mode: "no_history";
  storeId: string;
  variantId: string;
  name: string;
  category: string | null;
  inStockRaw: number;
  inStock: number;
  /** The threshold actually applied to this item (per-item override first, else defaultLowStockThreshold). */
  threshold: number;
  belowThreshold: boolean;
  warnings: string[];
}

export type CsvMetricRow = CsvHistoryMetricRow | CsvThresholdMetricRow;

function csvKey(storeId: string, variantId: string): string {
  return `${storeId}:${variantId}`;
}

/**
 * Takes one inventory scan of the CSV/Excel channel (inventory/salesPeriodAgg/products of the T16
 * `ParsedCsvExcelFile`) and computes metrics, branching on whether sales history exists (SPEC §12
 * "no sales history: threshold fallback"). Pure function — no warehouse lookups.
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

  // Group by the actual period length (days) — a file may mix different period lengths.
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
    if (salesByKey.has(csvKey(inv.storeId, inv.variantId))) continue; // handled on the history side.
    const p = productByVariant.get(inv.variantId);
    const warnings: string[] = [];

    const inStockRaw = parseNumeric(inv.inStock, "stock_qty");
    const inStock = Math.max(0, inStockRaw);
    if (inStockRaw < 0) {
      warnings.push(`Current stock is negative (${inStockRaw}) — 0 was used in the calculation.`);
    }

    const threshold =
      p?.lowStockThreshold !== undefined && p.lowStockThreshold !== null
        ? parseNumeric(p.lowStockThreshold, "low_stock_threshold")
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

// ── SCM integration: stock reconciliation / traditional sell-through (SPEC §13) ─────────
//
// The traditional definition (sales ÷ (opening stock + receipts)) is algebraically always equal to
// the §2 approximation (sales ÷ (sales + end stock)) as long as stock is conserved (the identity
// opening stock + receipts − sales = end stock) — the two denominators (opening+receipts,
// end stock+sales) are equal by that identity. So the real value of this function is not "a more
// accurate sell-through number" but reconciling the expected stock computed from the receipt ledger
// against the actual (counted) stock reported by POS/CSV, to find where that identity actually
// breaks — theft, damage, count errors and other movements the ledger does not capture.

export interface StockReconciliationOptions {
  /**
   * Opening stock — the counted stock at the start of the period being computed. Key is
   * `${storeId}:${variantId}`.
   *
   * **006 DATA-006 (TASKS T33)**: missing keys used to be silently treated as 0 in the calculation
   * (unable to distinguish "the SCM ledger started fresh at that point" from "the value is really
   * unknown"). Now a missing key means "opening stock unknown": the row is flagged
   * `insufficientData: true` and `discrepancy` is not emitted as a definitive warning (the
   * calculation still substitutes 0 and keeps the number for reference — it is not hidden
   * completely). The onboarding flow that captures a one-time count is still a later task — until
   * then no caller actually fills this option, so every row being `insufficientData: true` is
   * currently normal.
   */
  openingStock?: Record<string, number>;
  /**
   * Whether the SCM receipt period and the sales data period actually overlap (006 DATA-006,
   * TASKS T33) — the caller (e.g. `agent/folderScan.ts`) compares the two periods itself and passes
   * the result. `false` makes every row `insufficientData: true` with this included in the reasons.
   * **If omitted (undefined) this condition is not checked** — so the `core/metrics.ts` unit tests
   * can verify the calculation logic without passing periods every time; the real operational path
   * always passes it explicitly.
   */
  periodsOverlap?: boolean;
}

export interface StockReconciliationRow {
  storeId: string;
  variantId: string;
  name: string;
  openingStock: number;
  /** Sum of received qty within the period (raw value). */
  receivedQtyRaw: number;
  /** Raw net sold qty within the period (refunds included, may be negative). */
  soldQtyRaw: number;
  /** Sold qty used in the calculation = max(0, soldQtyRaw). */
  soldQty: number;
  /** Traditional sell-through = soldQty/(openingStock+receivedQtyRaw). null when the denominator is 0. */
  sellThroughTraditional: number | null;
  /** Expected stock per the ledger = openingStock + receivedQtyRaw − soldQtyRaw (no negative clamp —
   * a negative value is itself a ledger anomaly signal). */
  expectedStock: number;
  /** Actual stock reported by POS/CSV. null when there is no data (cannot reconcile). */
  actualStock: number | null;
  /** actualStock − expectedStock. null when actualStock is missing. */
  discrepancy: number | null;
  /** Whether there is a numeric mismatch (pure calculation result) — true whenever discrepancy!==0,
   * regardless of `insufficientData`. Whether to treat it as a "confirmed problem" must be judged
   * together with `insufficientData` (006 DATA-006). */
  hasDiscrepancy: boolean;
  /**
   * `discrepancy` cannot be trusted because the opening stock is unknown (no key in openingStock)
   * or the SCM/sales data periods do not overlap (periodsOverlap===false) (006 DATA-006, TASKS T33).
   * When true, `discrepancy` is still computed (a reference number), but no warning asserting a
   * definitive cause such as "theft, damage or count error" is put in `warnings` — the caller must
   * treat this row as "cannot reconcile", not as "problem found".
   */
  insufficientData: boolean;
  /** Why insufficientData is true (human-readable sentences, cause + what to do). Always an empty
   * array when insufficientData is false. */
  insufficientDataReasons: string[];
  warnings: string[];
}

/** Whether two date ranges overlap (inclusive boundaries) — used to compare the SCM receipt period with the sales period (006 DATA-006). */
export function periodsOverlap(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
): boolean {
  return a.start.getTime() <= b.end.getTime() && b.start.getTime() <= a.end.getTime();
}

/**
 * Computes stock reconciliation (SCM receipt ledger vs actual stock) together with the traditional
 * sell-through. `purchases` is the result of `Warehouse.queryPurchaseAgg` (or a pre-aggregation for
 * that period); `sales` may come from either channel, `querySalesAgg`/`querySalesPeriodAgg`, as long
 * as it has the same `SalesAgg[]` shape. The three inputs are joined on the union of their
 * (storeId, variantId) keys.
 */
export function computeStockReconciliation(
  inventory: InventoryRow[],
  purchases: PurchaseAgg[],
  sales: SalesAgg[],
  opts: StockReconciliationOptions = {},
): StockReconciliationRow[] {
  const openingStockByKey = opts.openingStock ?? {};
  const stockByKey = new Map(inventory.map((r) => [`${r.storeId}:${r.variantId}`, r]));
  const purchasesByKey = new Map(purchases.map((p) => [`${p.storeId}:${p.variantId}`, p]));
  const salesByKey = new Map(sales.map((s) => [`${s.storeId}:${s.variantId}`, s]));
  const keys = new Set<string>([
    ...stockByKey.keys(),
    ...purchasesByKey.keys(),
    ...salesByKey.keys(),
  ]);

  const rows: StockReconciliationRow[] = [];
  for (const key of keys) {
    const [storeId, variantId] = key.split(":") as [string, string];
    const stockRow = stockByKey.get(key);
    const purchaseAgg = purchasesByKey.get(key);
    const salesAgg = salesByKey.get(key);
    const warnings: string[] = [];
    const insufficientDataReasons: string[] = [];

    const openingStockKnown = key in openingStockByKey;
    if (!openingStockKnown) {
      insufficientDataReasons.push(
        "No opening stock count was provided, so 0 was assumed — if that assumption is wrong, the discrepancy differs from reality.",
      );
    }
    if (opts.periodsOverlap === false) {
      insufficientDataReasons.push(
        "The SCM receipt period and the sales data period do not overlap, so the comparison is not over the same period.",
      );
    }
    const insufficientData = insufficientDataReasons.length > 0;

    const openingStock = openingStockByKey[key] ?? 0;

    const receivedQtyRaw = purchaseAgg
      ? parseNumeric(purchaseAgg.receivedQtyRaw, "receivedQtyRaw")
      : 0;

    const soldQtyRaw = salesAgg ? parseNumeric(salesAgg.soldQtyRaw, "soldQtyRaw") : 0;
    const soldQty = Math.max(0, soldQtyRaw);
    if (soldQtyRaw < 0) {
      warnings.push(
        `Refunds exceeded sales, so the period net sold qty is negative (${soldQtyRaw}) — 0 was used in the calculation.`,
      );
    }

    const expectedStock = openingStock + receivedQtyRaw - soldQtyRaw;
    const denom = openingStock + receivedQtyRaw;
    const sellThroughTraditional = denom === 0 ? null : soldQty / denom;

    let actualStock: number | null = null;
    if (stockRow) {
      actualStock = parseNumeric(stockRow.inStock, "inStock");
    } else {
      warnings.push("No current stock data — cannot reconcile against the counted stock.");
    }

    const discrepancy = actualStock === null ? null : actualStock - expectedStock;
    // When insufficientData, keep the discrepancy number itself (for reference) but do not emit a
    // warning asserting a definitive cause such as "theft, damage or count error" (006 DATA-006 —
    // "warning text states only the mismatch, not a confirmed cause"). insufficientDataReasons says
    // "why it cannot be trusted" instead.
    if (!insufficientData && discrepancy !== null && discrepancy !== 0) {
      warnings.push(
        `Expected stock computed from the receipt ledger (${expectedStock}) differs from actual stock (${actualStock}) ` +
          `by ${discrepancy} — check for theft, damage or count error, or other movements not captured in the ledger.`,
      );
    }

    rows.push({
      storeId,
      variantId,
      name: salesAgg?.name ?? variantId,
      openingStock,
      receivedQtyRaw,
      soldQtyRaw,
      soldQty,
      sellThroughTraditional,
      expectedStock,
      actualStock,
      discrepancy,
      hasDiscrepancy: discrepancy !== null && discrepancy !== 0,
      insufficientData,
      insufficientDataReasons,
      warnings,
    });
  }
  return rows;
}
