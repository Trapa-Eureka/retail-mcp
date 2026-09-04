import { describe, expect, it } from "vitest";
import {
  applyPackRounding,
  avgDailySales,
  calendarWindow,
  computeCsvReorderMetrics,
  computeReorderMetrics,
  computeSellThrough,
  computeStockReconciliation,
  daysOfCover,
  isStockoutRisk,
  periodsOverlap,
  reorderQty,
  roundToPackMultiple,
  sellThroughRatio,
  type CsvHistoryMetricRow,
  type CsvThresholdMetricRow,
} from "../src/core/metrics.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import type {
  InventoryRow,
  ProductRow,
  PurchaseAgg,
  SalesAgg,
  SalesPeriodAggRow,
  StockRow,
} from "../src/core/types.js";

// TESTING.md §3 golden cases — hand-calculated values hard-coded as is.
describe("golden cases (TESTING.md §3)", () => {
  it("60 sold in 30 days, end stock 40 → sell-through = 0.60", () => {
    expect(sellThroughRatio(60, 40)).toBeCloseTo(0.6, 10);
  });

  it("56 sold in 28 days → avg daily 2.0 / stock 15 → 7.5 days of cover → at risk against lead 7 + safety 3 = 10", () => {
    const avg = avgDailySales(56, 28);
    expect(avg).toBe(2.0);
    const cover = daysOfCover(15, avg);
    expect(cover).toBe(7.5);
    expect(isStockoutRisk(cover, 7, 3)).toBe(true);
  });

  it("target cover 21 days → suggested qty = ceil(21×2.0 − 15) = 27", () => {
    expect(reorderQty(2.0, 15, 21)).toBe(27);
  });

  it("0 sales + stock 20 → avg daily 0 → cover ∞ (null), not at risk, suggestion 0", () => {
    const avg = avgDailySales(0, 28);
    expect(avg).toBe(0);
    const cover = daysOfCover(20, avg);
    expect(cover).toBeNull();
    expect(isStockoutRisk(cover, 7, 3)).toBe(false);
    expect(reorderQty(avg, 20, 21)).toBe(0);
  });

  it("0 sales + stock 0 → sell-through null (new item / no stock marker)", () => {
    expect(sellThroughRatio(0, 0)).toBeNull();
  });

  it("refunds included (10 sold, −2 refunded) → aggregated as soldQty 8", () => {
    // querySalesAgg already returns 10 + (-2) = 8 summed (verified in T4) — here we check that the
    // value is used correctly through the pipeline.
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "Item", category: null, soldQtyRaw: "8" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "Item", inStockRaw: "40", updatedAt: new Date() },
    ];
    const [row] = computeSellThrough(salesAgg, stock);
    expect(row?.soldQty).toBe(8);
    expect(row?.sellThrough).toBeCloseTo(8 / 48, 10);
  });
});

describe("negative normalisation and warnings (SPEC §9)", () => {
  it("computeSellThrough: a negative net sold qty from excess refunds is clamped to 0 with a warning", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "Item", category: null, soldQtyRaw: "-3" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "Item", inStockRaw: "10", updatedAt: new Date() },
    ];
    const [row] = computeSellThrough(salesAgg, stock);
    expect(row?.soldQtyRaw).toBe(-3);
    expect(row?.soldQty).toBe(0);
    expect(row?.warnings.some((w) => w.includes("negative"))).toBe(true);
  });

  it("computeSellThrough: negative current stock is clamped to 0 with a warning, but the raw value is preserved", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "Item", category: null, soldQtyRaw: "10" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "Item", inStockRaw: "-5", updatedAt: new Date() },
    ];
    const [row] = computeSellThrough(salesAgg, stock);
    expect(row?.endStockRaw).toBe(-5);
    expect(row?.endStock).toBe(0);
    expect(row?.warnings.some((w) => w.includes("negative"))).toBe(true);
    expect(row?.sellThrough).toBe(1); // soldQty=10, endStock=0 → 10/10
  });

  it("computeReorderMetrics: negative stock/sold qty normalisation is reflected in daysOfCover and reorderQty", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "Item", category: null, soldQtyRaw: "-1" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "Item", inStockRaw: "-2", updatedAt: new Date() },
    ];
    const [row] = computeReorderMetrics(salesAgg, stock, { windowDays: 28 });
    expect(row?.soldQty).toBe(0);
    expect(row?.inStock).toBe(0);
    expect(row?.avgDailySales).toBe(0);
    expect(row?.daysOfCover).toBeNull();
    expect(row?.reorderQty).toBe(0);
    expect(row?.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe("computeSellThrough — array pipeline", () => {
  it("joins on (storeId, variantId); an item without current stock is treated as stock 0 with a warning", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "Item A", category: "cat", soldQtyRaw: "10" },
    ];
    const stock: StockRow[] = []; // no stock data
    const [row] = computeSellThrough(salesAgg, stock);
    expect(row?.endStock).toBe(0);
    expect(row?.warnings.some((w) => w.includes("No current stock data"))).toBe(true);
  });

  it("an item with current stock but 0 sales in the period is included with soldQty=0 (0 sales + stock 20 golden case)", () => {
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "Item A", inStockRaw: "20", updatedAt: new Date() },
    ];
    const [row] = computeSellThrough([], stock);
    expect(row?.soldQty).toBe(0);
    expect(row?.endStock).toBe(20);
    expect(row?.sellThrough).toBeCloseTo(0 / 20, 10);
  });

  it("with neither sales nor stock the result is empty", () => {
    expect(computeSellThrough([], [])).toEqual([]);
  });
});

describe("computeReorderMetrics — array pipeline", () => {
  it("includes an item with sales but no stock data (treated as stock 0)", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "Item A", category: "cat", soldQtyRaw: "28" },
    ];
    const [row] = computeReorderMetrics(salesAgg, [], { windowDays: 28 });
    expect(row?.avgDailySales).toBe(1);
    expect(row?.inStock).toBe(0);
  });

  it("includes an item with stock but no sales data (treated as 0 sales)", () => {
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "Item A", inStockRaw: "20", updatedAt: new Date() },
    ];
    const [row] = computeReorderMetrics([], stock, { windowDays: 28 });
    expect(row?.avgDailySales).toBe(0);
    expect(row?.daysOfCover).toBeNull();
    expect(row?.inStock).toBe(20);
  });

  it("option defaults — exactly DESIGN §3 (28/7/3/21)", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "Item", category: null, soldQtyRaw: "56" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "Item", inStockRaw: "15", updatedAt: new Date() },
    ];
    const [row] = computeReorderMetrics(salesAgg, stock);
    expect(row?.avgDailySales).toBe(2);
    expect(row?.daysOfCover).toBe(7.5);
    expect(row?.stockoutRisk).toBe(true);
    expect(row?.reorderQty).toBe(27);
  });
});

describe("rounding policy for fractional and large numeric values (TESTING §7)", () => {
  it("avg daily sales and days of cover are not rounded midway; only the reorder qty gets the final ceil", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "Item", category: null, soldQtyRaw: "65.7" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "Item", inStockRaw: "44.276", updatedAt: new Date() },
    ];
    const [row] = computeReorderMetrics(salesAgg, stock, { windowDays: 28, targetCoverDays: 21 });
    const expectedAvg = 65.7 / 28; // = 2.346428571...
    expect(row?.avgDailySales).toBe(expectedAvg);
    expect(row?.daysOfCover).toBe(44.276 / expectedAvg);

    const expectedReorderQty = Math.max(0, Math.ceil(21 * expectedAvg - 44.276));
    expect(row?.reorderQty).toBe(expectedReorderQty);
    expect(expectedReorderQty).toBe(5);

    // Had avgDailySales been rounded to 2 decimals midway (2.35), it would have crossed the ceil
    // boundary and produced 6 — it must actually be 5 (= evidence near the ceil boundary that there
    // is no intermediate rounding).
    const roundedAvg = Math.round(expectedAvg * 100) / 100;
    const reorderQtyIfRounded = Math.max(0, Math.ceil(21 * roundedAvg - 44.276));
    expect(reorderQtyIfRounded).toBe(6);
    expect(row?.reorderQty).not.toBe(reorderQtyIfRounded);
  });

  it("large numeric values (6+ digits) are handled without precision loss", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "Item", category: null, soldQtyRaw: "1234567.89" },
    ];
    const stock: StockRow[] = [
      {
        storeId: "s1",
        variantId: "v1",
        name: "Item",
        inStockRaw: "999999.5",
        updatedAt: new Date(),
      },
    ];
    const [row] = computeReorderMetrics(salesAgg, stock, { windowDays: 28, targetCoverDays: 21 });
    const expectedAvg = 1234567.89 / 28;
    expect(row?.avgDailySales).toBe(expectedAvg);
    expect(row?.reorderQty).toBe(Math.max(0, Math.ceil(21 * expectedAvg - 999999.5)));
  });
});

describe("calendarWindow — half-open period boundaries in the business timezone (Clock injected, DESIGN §11.3)", () => {
  it("Asia/Manila (UTC+8, no DST): today's midnight boundary is exact", () => {
    const clock = createFixedClock("2026-09-01T03:00:00Z"); // 09-01 11:00 Manila
    const { periodStart, periodEnd, timeZone } = calendarWindow(clock, 28, "Asia/Manila");
    expect(timeZone).toBe("Asia/Manila");
    expect(periodEnd.toISOString()).toBe("2026-08-31T16:00:00.000Z"); // Manila 09-01 00:00
    expect(periodStart.toISOString()).toBe("2026-08-03T16:00:00.000Z"); // 28 days earlier, Manila 08-04 00:00
  });

  it("month boundary: the calendar-day count is exact even when the window crosses a month (Manila, last 5 days)", () => {
    const clock = createFixedClock("2026-09-02T01:00:00Z"); // Manila 09-02 09:00
    const { periodStart, periodEnd } = calendarWindow(clock, 5, "Asia/Manila");
    expect(periodEnd.toISOString()).toBe("2026-09-01T16:00:00.000Z"); // Manila 09-02 00:00
    expect(periodStart.toISOString()).toBe("2026-08-27T16:00:00.000Z"); // Manila 08-28 00:00
    const diffDays = (periodEnd.getTime() - periodStart.getTime()) / 86_400_000;
    expect(diffDays).toBe(5);
  });

  it("midnight boundaries are exact even across a DST boundary (America/New_York, 2026-03-08 spring forward)", () => {
    // Request a 3-day window with "today" the day after DST starts — the transition day falls inside the window.
    const clock = createFixedClock("2026-03-09T12:00:00Z"); // NY 03-09 07:00 (EDT, UTC-4)
    const { periodStart, periodEnd } = calendarWindow(clock, 3, "America/New_York");
    expect(periodEnd.toISOString()).toBe("2026-03-09T04:00:00.000Z"); // NY 03-09 00:00 EDT (UTC-4)
    expect(periodStart.toISOString()).toBe("2026-03-06T05:00:00.000Z"); // NY 03-06 00:00 EST (UTC-5)
    // Because of the transition day (03-08) the actual elapsed time must be 71 hours, not exactly 72 (1 hour lost to the clock change).
    const diffHours = (periodEnd.getTime() - periodStart.getTime()) / 3_600_000;
    expect(diffHours).toBe(71);
  });

  it("the result is independent of the machine's local timezone (Clock is an absolute instant; the calculation depends only on the timeZone argument)", () => {
    const clock = createFixedClock("2026-09-01T03:00:00Z");
    const a = calendarWindow(clock, 7, "Asia/Manila");
    const b = calendarWindow(clock, 7, "Asia/Manila");
    expect(a.periodStart.toISOString()).toBe(b.periodStart.toISOString());
    expect(a.periodEnd.toISOString()).toBe(b.periodEnd.toISOString());
  });

  it("throws a clear error when windowDays is 0 or less", () => {
    const clock = createFixedClock("2026-09-01T00:00:00Z");
    expect(() => calendarWindow(clock, 0, "Asia/Manila")).toThrow(/windowDays/);
  });
});

describe("boundary validation", () => {
  it("avgDailySales: throws a clear error when windowDays<=0", () => {
    expect(() => avgDailySales(10, 0)).toThrow(/windowDays/);
    expect(() => avgDailySales(10, -1)).toThrow(/windowDays/);
  });

  it("an invalid numeric string throws an error stating the cause", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "Item", category: null, soldQtyRaw: "not-a-number" },
    ];
    expect(() => computeSellThrough(salesAgg, [])).toThrow(/valid number/);
  });
});

describe("computeCsvReorderMetrics (CSV/Excel channel, SPEC §12, TASKS T17)", () => {
  const PRODUCT_COLA: ProductRow = {
    variantId: "SKU-COLA",
    itemId: "SKU-COLA",
    name: "Cola 500ml",
    sku: "SKU-COLA",
    category: null,
    lowStockThreshold: "10",
  };
  const PRODUCT_CHIPS: ProductRow = {
    variantId: "SKU-CHIPS",
    itemId: "SKU-CHIPS",
    name: "Piattos",
    sku: "SKU-CHIPS",
    category: null,
    // no override — must use the global default.
  };
  const products = [PRODUCT_COLA, PRODUCT_CHIPS];

  it("items with sales history use the existing §2 approximations as is (no regression of the 28-day golden case)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-COLA", inStock: "15", updatedAt: new Date() },
    ];
    const salesPeriodAgg: SalesPeriodAggRow[] = [
      {
        storeId: "Main Store",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"), // 28 days
        soldQty: "56",
      },
    ];

    const [row] = computeCsvReorderMetrics(inventory, salesPeriodAgg, products, {
      defaultLowStockThreshold: 5,
    });

    expect(row?.mode).toBe("history");
    const historyRow = row as CsvHistoryMetricRow;
    // Same golden values as TESTING §3: 56 in 28 days → avg daily 2.0, stock 15 → 7.5 days of cover, at risk against lead 7 + safety 3 = 10.
    expect(historyRow.avgDailySales).toBe(2.0);
    expect(historyRow.daysOfCover).toBe(7.5);
    expect(historyRow.stockoutRisk).toBe(true);
    expect(historyRow.reorderQty).toBe(27); // ceil(21*2.0-15)
    expect(historyRow.sellThrough).toBeCloseTo(56 / (56 + 15), 10);
  });

  it("even when the CSV period length is not 28 days (35), avgDailySales is divided by the actual period", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-COLA", inStock: "50", updatedAt: new Date() },
    ];
    const salesPeriodAgg: SalesPeriodAggRow[] = [
      {
        storeId: "Main Store",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-07-01T00:00:00Z"),
        periodEnd: new Date("2026-08-05T00:00:00Z"), // 35 days
        soldQty: "105",
      },
    ];

    const [row] = computeCsvReorderMetrics(inventory, salesPeriodAgg, products, {
      defaultLowStockThreshold: 5,
    });
    const historyRow = row as CsvHistoryMetricRow;
    // Using the v0.1 default (28 days) as is would have given 105/28=3.75 — with the actual period (35 days) it must be 3.0.
    expect(historyRow.avgDailySales).toBe(3.0);
  });

  it("items with different period lengths mixed in one file are each computed with their own windowDays", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-COLA", inStock: "15", updatedAt: new Date() },
      { storeId: "South Branch", variantId: "SKU-CHIPS", inStock: "20", updatedAt: new Date() },
    ];
    const salesPeriodAgg: SalesPeriodAggRow[] = [
      {
        storeId: "Main Store",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"), // 28 days
        soldQty: "56",
      },
      {
        storeId: "South Branch",
        variantId: "SKU-CHIPS",
        periodStart: new Date("2026-07-01T00:00:00Z"),
        periodEnd: new Date("2026-08-05T00:00:00Z"), // 35 days
        soldQty: "105",
      },
    ];

    const rows = computeCsvReorderMetrics(inventory, salesPeriodAgg, products, {
      defaultLowStockThreshold: 5,
    }) as CsvHistoryMetricRow[];

    const cola = rows.find((r) => r.variantId === "SKU-COLA");
    const chips = rows.find((r) => r.variantId === "SKU-CHIPS");
    expect(cola?.avgDailySales).toBe(2.0); // 56/28
    expect(chips?.avgDailySales).toBe(3.0); // 105/35 — computed over 28 days it would have been 3.75.
  });

  it("items without sales history skip sell-through/reorder and are judged by threshold only (no silent 0 treatment)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-CHIPS", inStock: "2", updatedAt: new Date() },
    ];
    const [row] = computeCsvReorderMetrics(inventory, [], products, {
      defaultLowStockThreshold: 5,
    });

    expect(row?.mode).toBe("no_history");
    const thresholdRow = row as CsvThresholdMetricRow;
    // History-only fields (avgDailySales etc.) must be absent entirely — a different shape, not a "silent 0".
    expect(thresholdRow).not.toHaveProperty("avgDailySales");
    expect(thresholdRow).not.toHaveProperty("sellThrough");
  });

  it("threshold judgement: the per-item override (10) takes precedence over the global default (5)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-COLA", inStock: "8", updatedAt: new Date() }, // 8 < 10 (override)
    ];
    const [row] = computeCsvReorderMetrics(inventory, [], products, {
      defaultLowStockThreshold: 5, // 8 >= 5 — the global default alone would not have flagged it
    });
    const thresholdRow = row as CsvThresholdMetricRow;
    expect(thresholdRow.threshold).toBe(10);
    expect(thresholdRow.belowThreshold).toBe(true);
  });

  it("threshold judgement: without an override the global default is used", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-CHIPS", inStock: "3", updatedAt: new Date() },
    ];
    const [row] = computeCsvReorderMetrics(inventory, [], products, {
      defaultLowStockThreshold: 5,
    });
    const thresholdRow = row as CsvThresholdMetricRow;
    expect(thresholdRow.threshold).toBe(5);
    expect(thresholdRow.belowThreshold).toBe(true); // 3 < 5
  });

  it("belowThreshold=false when stock is at or above the threshold", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-CHIPS", inStock: "9", updatedAt: new Date() },
    ];
    const [row] = computeCsvReorderMetrics(inventory, [], products, {
      defaultLowStockThreshold: 5,
    });
    expect((row as CsvThresholdMetricRow).belowThreshold).toBe(false);
  });

  it("negative stock is clamped to 0 with a warning (also on the threshold fallback path)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-CHIPS", inStock: "-3", updatedAt: new Date() },
    ];
    const [row] = computeCsvReorderMetrics(inventory, [], products, {
      defaultLowStockThreshold: 5,
    });
    const thresholdRow = row as CsvThresholdMetricRow;
    expect(thresholdRow.inStock).toBe(0);
    expect(thresholdRow.warnings.some((w) => w.includes("negative"))).toBe(true);
  });
});

// SCM sheet integration stock reconciliation / traditional sell-through (SPEC §13) — the P001 golden
// numbers are taken as is from the real sample Google Sheet the user provided ("inbound/outbound"
// and "stock status" tabs, checked 2026-09-03): July receipts 30, outbound (sales) 21 (=8+13),
// current stock 9 on the stock status tab. Opening stock is 0 because that sheet's ledger starts on
// 2026-07-01.
describe("computeStockReconciliation (SPEC §13, real sample sheet golden cases)", () => {
  it("P001: traditional sell-through = 21/(0+30) = 0.7; ledger expected stock matches the counted stock (no discrepancy)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "HQ", variantId: "P001", inStock: "9", updatedAt: new Date() },
    ];
    const purchases: PurchaseAgg[] = [{ storeId: "HQ", variantId: "P001", receivedQtyRaw: "30" }];
    const sales: SalesAgg[] = [
      {
        storeId: "HQ",
        variantId: "P001",
        name: "Wireless Mouse",
        category: null,
        soldQtyRaw: "21",
      },
    ];

    const [row] = computeStockReconciliation(inventory, purchases, sales);

    expect(row?.sellThroughTraditional).toBeCloseTo(0.7, 10);
    expect(row?.expectedStock).toBe(9);
    expect(row?.actualStock).toBe(9);
    expect(row?.discrepancy).toBe(0);
    expect(row?.hasDiscrepancy).toBe(false);
    expect(row?.warnings).toEqual([]);
  });

  it("when the counted stock differs from the ledger expectation it shows up as discrepancy, hasDiscrepancy and a warning (opening stock and period confirmed)", () => {
    // The ledger expects 9 but the count is 7 — a discrepancy of 2 (theft/damage/error etc.). The
    // warning appears only when the opening stock is known (key present in openingStock) and the
    // periods are stated to overlap (006 DATA-006, TASKS T33) — the "opening stock / period
    // unknown" tests below verify the opposite case.
    const inventory: InventoryRow[] = [
      { storeId: "HQ", variantId: "P999", inStock: "7", updatedAt: new Date() },
    ];
    const purchases: PurchaseAgg[] = [{ storeId: "HQ", variantId: "P999", receivedQtyRaw: "30" }];
    const sales: SalesAgg[] = [
      { storeId: "HQ", variantId: "P999", name: "Test Product", category: null, soldQtyRaw: "21" },
    ];

    const [row] = computeStockReconciliation(inventory, purchases, sales, {
      openingStock: { "HQ:P999": 0 },
      periodsOverlap: true,
    });

    expect(row?.expectedStock).toBe(9);
    expect(row?.actualStock).toBe(7);
    expect(row?.discrepancy).toBe(-2);
    expect(row?.hasDiscrepancy).toBe(true);
    expect(row?.insufficientData).toBe(false);
    expect(row?.warnings.some((w) => w.includes("differs"))).toBe(true);
  });

  describe("insufficientData — no definitive warning when opening stock or period is unconfirmed (006 DATA-006, TASKS T33)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "HQ", variantId: "P999", inStock: "7", updatedAt: new Date() },
    ];
    const purchases: PurchaseAgg[] = [{ storeId: "HQ", variantId: "P999", receivedQtyRaw: "30" }];
    const sales: SalesAgg[] = [
      { storeId: "HQ", variantId: "P999", name: "Test Product", category: null, soldQtyRaw: "21" },
    ];

    it("without any openingStock (default) every row is insufficientData", () => {
      const [row] = computeStockReconciliation(inventory, purchases, sales);
      expect(row?.insufficientData).toBe(true);
      expect(row?.insufficientDataReasons.some((r) => r.includes("opening stock"))).toBe(true);
      // The discrepancy number itself is still computed for reference — not hidden completely.
      expect(row?.discrepancy).toBe(-2);
      // But no warning asserting a definitive cause such as "theft, damage or count error" is emitted.
      expect(row?.warnings.some((w) => w.includes("differs"))).toBe(false);
    });

    it("with the openingStock key present but periodsOverlap false it is insufficientData", () => {
      const [row] = computeStockReconciliation(inventory, purchases, sales, {
        openingStock: { "HQ:P999": 0 },
        periodsOverlap: false,
      });
      expect(row?.insufficientData).toBe(true);
      expect(row?.insufficientDataReasons.some((r) => r.includes("period"))).toBe(true);
      expect(row?.insufficientDataReasons.some((r) => r.includes("opening stock"))).toBe(false);
    });

    it("with the openingStock key present and periodsOverlap true it is not insufficientData", () => {
      const [row] = computeStockReconciliation(inventory, purchases, sales, {
        openingStock: { "HQ:P999": 0 },
        periodsOverlap: true,
      });
      expect(row?.insufficientData).toBe(false);
      expect(row?.insufficientDataReasons).toEqual([]);
    });

    it("omitting periodsOverlap (undefined) does not by itself make it insufficientData", () => {
      const [row] = computeStockReconciliation(inventory, purchases, sales, {
        openingStock: { "HQ:P999": 0 },
      });
      expect(row?.insufficientData).toBe(false);
    });
  });

  describe("periodsOverlap (pure function, 006 DATA-006)", () => {
    it("overlapping ranges are true", () => {
      expect(
        periodsOverlap(
          { start: new Date("2026-08-01"), end: new Date("2026-08-31") },
          { start: new Date("2026-08-15"), end: new Date("2026-09-15") },
        ),
      ).toBe(true);
    });

    it("ranges that exactly touch at the boundary count as overlapping (inclusive boundaries)", () => {
      expect(
        periodsOverlap(
          { start: new Date("2026-08-01"), end: new Date("2026-08-31") },
          { start: new Date("2026-08-31"), end: new Date("2026-09-15") },
        ),
      ).toBe(true);
    });

    it("completely separate ranges are false", () => {
      expect(
        periodsOverlap(
          { start: new Date("2026-07-01"), end: new Date("2026-07-31") },
          { start: new Date("2026-08-01"), end: new Date("2026-08-31") },
        ),
      ).toBe(false);
    });
  });

  it("an explicit opening stock (openingStock) is reflected in the traditional sell-through and expected stock", () => {
    const inventory: InventoryRow[] = [
      { storeId: "HQ", variantId: "P002", inStock: "35", updatedAt: new Date() },
    ];
    const purchases: PurchaseAgg[] = [{ storeId: "HQ", variantId: "P002", receivedQtyRaw: "20" }];
    const sales: SalesAgg[] = [
      {
        storeId: "HQ",
        variantId: "P002",
        name: "Silent Keyboard",
        category: null,
        soldQtyRaw: "5",
      },
    ];

    const [row] = computeStockReconciliation(inventory, purchases, sales, {
      openingStock: { "HQ:P002": 20 },
    });

    expect(row?.openingStock).toBe(20);
    expect(row?.sellThroughTraditional).toBeCloseTo(5 / 40, 10); // 5/(20+20)
    expect(row?.expectedStock).toBe(35); // 20+20-5
    expect(row?.discrepancy).toBe(0);
  });

  it("with both receipts and sales 0 (denominator 0) the traditional sell-through is null", () => {
    const inventory: InventoryRow[] = [
      { storeId: "HQ", variantId: "P005", inStock: "0", updatedAt: new Date() },
    ];
    const [row] = computeStockReconciliation(inventory, [], []);
    expect(row?.sellThroughTraditional).toBeNull();
    expect(row?.expectedStock).toBe(0);
    expect(row?.discrepancy).toBe(0);
  });

  it("without counted stock data, actualStock/discrepancy are null and a warning is left", () => {
    const purchases: PurchaseAgg[] = [{ storeId: "HQ", variantId: "P003", receivedQtyRaw: "15" }];
    const [row] = computeStockReconciliation([], purchases, []);
    expect(row?.actualStock).toBeNull();
    expect(row?.discrepancy).toBeNull();
    expect(row?.hasDiscrepancy).toBe(false); // null is not flagged as a discrepancy (distinct from "cannot reconcile").
    expect(row?.warnings.some((w) => w.includes("cannot reconcile"))).toBe(true);
  });

  it("when refunds exceed sales and net sold qty is negative, 0 is used with a warning", () => {
    const inventory: InventoryRow[] = [
      { storeId: "HQ", variantId: "P001", inStock: "5", updatedAt: new Date() },
    ];
    const sales: SalesAgg[] = [
      {
        storeId: "HQ",
        variantId: "P001",
        name: "Wireless Mouse",
        category: null,
        soldQtyRaw: "-3",
      },
    ];
    const [row] = computeStockReconciliation(inventory, [], sales);
    expect(row?.soldQtyRaw).toBe(-3);
    expect(row?.soldQty).toBe(0);
    expect(row?.warnings.some((w) => w.includes("Refunds"))).toBe(true);
  });
});

// Pack-multiple rounding (SPEC §14) — values taken as is from the real sample sheet the user provided
// (the pack size column of "product list" + the computed suggestion / final order qty / packs to
// order columns of "stock status", checked 2026-09-03). The sheet already pre-computes
// `final order qty = ⌈computed suggestion ÷ pack size⌉ × pack size`, so
// (computed suggestion, pack size) → (final order qty, packs) is used directly as the golden case.
describe("roundToPackMultiple (SPEC §14, real sample sheet golden cases)", () => {
  it.each([
    // [product code, computed suggestion, pack size, final order qty, packs to order]
    ["P001", 27, 24, 48, 2],
    ["P002", 3, 12, 12, 1],
    ["P003", 19, 10, 20, 2],
    ["P004", 11, 6, 12, 2],
    ["P005", 11, 4, 12, 3],
    ["P006", 3, 12, 12, 1],
    ["P007", 20, 20, 20, 1], // an exact multiple of the pack size — unchanged by rounding up.
    ["P008", 14, 10, 20, 2],
  ] as const)(
    "%s: suggested %d, pack size %d → final order qty %d (%d packs)",
    (_code, calcQty, packSize, expectedFinalQty, expectedPackCount) => {
      const result = roundToPackMultiple(calcQty, packSize);
      expect(result.finalOrderQty).toBe(expectedFinalQty);
      expect(result.packCount).toBe(expectedPackCount);
    },
  );

  it("without packSize (single units can be purchased) nothing is rounded and packCount is null", () => {
    expect(roundToPackMultiple(27, null)).toEqual({ finalOrderQty: 27, packCount: null });
    expect(roundToPackMultiple(27, undefined)).toEqual({ finalOrderQty: 27, packCount: null });
  });

  it("a suggestion of 0 means 0 packs — not rounded up to 1 pack even with a packSize", () => {
    expect(roundToPackMultiple(0, 24)).toEqual({ finalOrderQty: 0, packCount: 0 });
  });

  it("throws a clear error when packSize is 0 or less", () => {
    expect(() => roundToPackMultiple(10, 0)).toThrow(/packSize/);
    expect(() => roundToPackMultiple(10, -5)).toThrow(/packSize/);
  });
});

describe("applyPackRounding — wraps computeReorderMetrics results by joining the pack size", () => {
  it("rounds when ProductRow.packSize exists, otherwise leaves the original reorderQty as is", () => {
    const salesAgg: SalesAgg[] = [
      {
        storeId: "HQ",
        variantId: "P001",
        name: "Wireless Mouse",
        category: null,
        soldQtyRaw: "36",
      },
      {
        storeId: "HQ",
        variantId: "P002",
        name: "Silent Keyboard",
        category: null,
        soldQtyRaw: "0",
      },
    ];
    const stock: StockRow[] = [
      {
        storeId: "HQ",
        variantId: "P001",
        name: "Wireless Mouse",
        inStockRaw: "9",
        updatedAt: new Date(),
      },
      {
        storeId: "HQ",
        variantId: "P002",
        name: "Silent Keyboard",
        inStockRaw: "5",
        updatedAt: new Date(),
      },
    ];
    // With windowDays=1, avgDailySales equals soldQtyRaw, so with targetCoverDays=1
    // reorderQty = max(0, ceil(1*36 - 9)) = 27 — exactly the sheet's computed suggestion for P001.
    const rows = computeReorderMetrics(salesAgg, stock, { windowDays: 1, targetCoverDays: 1 });

    const products: ProductRow[] = [
      {
        variantId: "P001",
        itemId: "P001",
        name: "Wireless Mouse",
        sku: "P001",
        category: null,
        packSize: "24",
      },
      // P002 has no packSize — single-unit purchase.
      { variantId: "P002", itemId: "P002", name: "Silent Keyboard", sku: "P002", category: null },
    ];

    const rounded = applyPackRounding(rows, products);
    const p001 = rounded.find((r) => r.variantId === "P001");
    const p002 = rounded.find((r) => r.variantId === "P002");

    expect(p001?.reorderQty).toBe(27);
    expect(p001?.packSize).toBe(24);
    expect(p001).toMatchObject({ finalOrderQty: 48, packCount: 2 });

    expect(p002?.packSize).toBeNull();
    expect(p002?.packCount).toBeNull();
    expect(p002?.finalOrderQty).toBe(p002?.reorderQty); // no packSize, so unchanged.

    // The existing ReorderMetricRow fields are preserved as is (only wrapped, the original untouched).
    expect(p001?.avgDailySales).toBe(36);
    expect(p001?.stockoutRisk).toBe(rows.find((r) => r.variantId === "P001")?.stockoutRisk);
  });

  it("a variantId not in the Warehouse (absent from the products list) is treated as packSize null", () => {
    const salesAgg: SalesAgg[] = [
      {
        storeId: "HQ",
        variantId: "UNKNOWN",
        name: "Unregistered Product",
        category: null,
        soldQtyRaw: "10",
      },
    ];
    const rows = computeReorderMetrics(salesAgg, [], { windowDays: 28, targetCoverDays: 21 });
    const rounded = applyPackRounding(rows, []);
    expect(rounded[0]?.packSize).toBeNull();
    expect(rounded[0]?.packCount).toBeNull();
  });
});
