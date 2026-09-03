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

// TESTING.md §3 골든 케이스 — 손계산 값을 그대로 하드코딩한다.
describe("골든 케이스 (TESTING.md §3)", () => {
  it("30일 판매 60개, 기말재고 40 → 셀스루 = 0.60", () => {
    expect(sellThroughRatio(60, 40)).toBeCloseTo(0.6, 10);
  });

  it("28일 판매 56개 → 일평균 2.0 / 재고 15 → 커버 7.5일 → 리드7+안전3=10 기준 위험", () => {
    const avg = avgDailySales(56, 28);
    expect(avg).toBe(2.0);
    const cover = daysOfCover(15, avg);
    expect(cover).toBe(7.5);
    expect(isStockoutRisk(cover, 7, 3)).toBe(true);
  });

  it("목표커버 21일 → 제안량 = ceil(21×2.0 − 15) = 27", () => {
    expect(reorderQty(2.0, 15, 21)).toBe(27);
  });

  it("판매 0 + 재고 20 → 일평균 0 → 커버 ∞(null) 표기, 위험 아님, 제안 0", () => {
    const avg = avgDailySales(0, 28);
    expect(avg).toBe(0);
    const cover = daysOfCover(20, avg);
    expect(cover).toBeNull();
    expect(isStockoutRisk(cover, 7, 3)).toBe(false);
    expect(reorderQty(avg, 20, 21)).toBe(0);
  });

  it("판매 0 + 재고 0 → 셀스루 null (신규/무재고 구분 표기)", () => {
    expect(sellThroughRatio(0, 0)).toBeNull();
  });

  it("환불 포함(판매 10, 환불 −2) → soldQty 8로 집계된다", () => {
    // querySalesAgg가 이미 10 + (-2) = 8로 합산해 돌려준다(T4에서 검증) — 여기서는 그 값이
    // 파이프라인을 거쳐 올바르게 쓰이는지 확인한다.
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "품목", category: null, soldQtyRaw: "8" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "품목", inStockRaw: "40", updatedAt: new Date() },
    ];
    const [row] = computeSellThrough(salesAgg, stock);
    expect(row?.soldQty).toBe(8);
    expect(row?.sellThrough).toBeCloseTo(8 / 48, 10);
  });
});

describe("음수 정규화와 경고 (SPEC §9)", () => {
  it("computeSellThrough: 환불 초과로 음수 순판매량이면 0으로 clamp하고 경고를 붙인다", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "품목", category: null, soldQtyRaw: "-3" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "품목", inStockRaw: "10", updatedAt: new Date() },
    ];
    const [row] = computeSellThrough(salesAgg, stock);
    expect(row?.soldQtyRaw).toBe(-3);
    expect(row?.soldQty).toBe(0);
    expect(row?.warnings.some((w) => w.includes("음수"))).toBe(true);
  });

  it("computeSellThrough: 음수 현재고는 0으로 clamp하고 경고를 붙이되 원시값은 보존한다", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "품목", category: null, soldQtyRaw: "10" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "품목", inStockRaw: "-5", updatedAt: new Date() },
    ];
    const [row] = computeSellThrough(salesAgg, stock);
    expect(row?.endStockRaw).toBe(-5);
    expect(row?.endStock).toBe(0);
    expect(row?.warnings.some((w) => w.includes("음수"))).toBe(true);
    expect(row?.sellThrough).toBe(1); // soldQty=10, endStock=0 → 10/10
  });

  it("computeReorderMetrics: 음수 재고/판매량 정규화가 daysOfCover·reorderQty에 반영된다", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "품목", category: null, soldQtyRaw: "-1" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "품목", inStockRaw: "-2", updatedAt: new Date() },
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

describe("computeSellThrough — 배열 파이프라인", () => {
  it("(storeId, variantId)로 조인하고, 현재고 없는 품목은 재고 0으로 처리하며 경고를 남긴다", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "품목A", category: "cat", soldQtyRaw: "10" },
    ];
    const stock: StockRow[] = []; // 재고 데이터 없음
    const [row] = computeSellThrough(salesAgg, stock);
    expect(row?.endStock).toBe(0);
    expect(row?.warnings.some((w) => w.includes("현재고 데이터가 없어"))).toBe(true);
  });

  it("기간 내 판매가 0건이어도 현재고가 있으면 soldQty=0으로 포함된다 (판매0+재고20 골든 케이스)", () => {
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "품목A", inStockRaw: "20", updatedAt: new Date() },
    ];
    const [row] = computeSellThrough([], stock);
    expect(row?.soldQty).toBe(0);
    expect(row?.endStock).toBe(20);
    expect(row?.sellThrough).toBeCloseTo(0 / 20, 10);
  });

  it("판매도 재고도 없으면 결과가 비어 있다", () => {
    expect(computeSellThrough([], [])).toEqual([]);
  });
});

describe("computeReorderMetrics — 배열 파이프라인", () => {
  it("판매만 있고 재고 데이터가 없는 품목도 포함한다(재고 0으로 처리)", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "품목A", category: "cat", soldQtyRaw: "28" },
    ];
    const [row] = computeReorderMetrics(salesAgg, [], { windowDays: 28 });
    expect(row?.avgDailySales).toBe(1);
    expect(row?.inStock).toBe(0);
  });

  it("재고만 있고 판매 데이터가 없는 품목도 포함한다(판매 0으로 처리)", () => {
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "품목A", inStockRaw: "20", updatedAt: new Date() },
    ];
    const [row] = computeReorderMetrics([], stock, { windowDays: 28 });
    expect(row?.avgDailySales).toBe(0);
    expect(row?.daysOfCover).toBeNull();
    expect(row?.inStock).toBe(20);
  });

  it("옵션 기본값 — DESIGN §3 그대로(28/7/3/21)", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "품목", category: null, soldQtyRaw: "56" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "품목", inStockRaw: "15", updatedAt: new Date() },
    ];
    const [row] = computeReorderMetrics(salesAgg, stock);
    expect(row?.avgDailySales).toBe(2);
    expect(row?.daysOfCover).toBe(7.5);
    expect(row?.stockoutRisk).toBe(true);
    expect(row?.reorderQty).toBe(27);
  });
});

describe("소수·큰 numeric 값의 반올림 정책 (TESTING §7)", () => {
  it("일평균판매·재고커버일수는 중간에 반올림하지 않고, 재주문량만 최종 ceil을 적용한다", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "품목", category: null, soldQtyRaw: "65.7" },
    ];
    const stock: StockRow[] = [
      { storeId: "s1", variantId: "v1", name: "품목", inStockRaw: "44.276", updatedAt: new Date() },
    ];
    const [row] = computeReorderMetrics(salesAgg, stock, { windowDays: 28, targetCoverDays: 21 });
    const expectedAvg = 65.7 / 28; // = 2.346428571...
    expect(row?.avgDailySales).toBe(expectedAvg);
    expect(row?.daysOfCover).toBe(44.276 / expectedAvg);

    const expectedReorderQty = Math.max(0, Math.ceil(21 * expectedAvg - 44.276));
    expect(row?.reorderQty).toBe(expectedReorderQty);
    expect(expectedReorderQty).toBe(5);

    // avgDailySales를 중간에 소수 2자리로 반올림했다면(2.35) ceil 경계를 넘어 6이 나왔을
    // 것이다 — 실제로는 5여야 한다(=중간 반올림이 없다는 증거를 ceil 경계 근처에서 확인).
    const roundedAvg = Math.round(expectedAvg * 100) / 100;
    const reorderQtyIfRounded = Math.max(0, Math.ceil(21 * roundedAvg - 44.276));
    expect(reorderQtyIfRounded).toBe(6);
    expect(row?.reorderQty).not.toBe(reorderQtyIfRounded);
  });

  it("큰 numeric 값(6자리 이상)도 정밀도 손실 없이 처리한다", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "품목", category: null, soldQtyRaw: "1234567.89" },
    ];
    const stock: StockRow[] = [
      {
        storeId: "s1",
        variantId: "v1",
        name: "품목",
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

describe("calendarWindow — 사업장 타임존 반개방 기간 경계 (Clock 주입, DESIGN §11.3)", () => {
  it("Asia/Manila(UTC+8, DST 없음): 오늘 자정 경계가 정확하다", () => {
    const clock = createFixedClock("2026-09-01T03:00:00Z"); // Manila 기준 09-01 11:00
    const { periodStart, periodEnd, timeZone } = calendarWindow(clock, 28, "Asia/Manila");
    expect(timeZone).toBe("Asia/Manila");
    expect(periodEnd.toISOString()).toBe("2026-08-31T16:00:00.000Z"); // Manila 09-01 00:00
    expect(periodStart.toISOString()).toBe("2026-08-03T16:00:00.000Z"); // 28일 전, Manila 08-04 00:00
  });

  it("월말 경계: 창이 월을 넘어가도 달력일 수가 정확하다 (Manila, 최근 5일)", () => {
    const clock = createFixedClock("2026-09-02T01:00:00Z"); // Manila 09-02 09:00
    const { periodStart, periodEnd } = calendarWindow(clock, 5, "Asia/Manila");
    expect(periodEnd.toISOString()).toBe("2026-09-01T16:00:00.000Z"); // Manila 09-02 00:00
    expect(periodStart.toISOString()).toBe("2026-08-27T16:00:00.000Z"); // Manila 08-28 00:00
    const diffDays = (periodEnd.getTime() - periodStart.getTime()) / 86_400_000;
    expect(diffDays).toBe(5);
  });

  it("DST 경계(America/New_York, 2026-03-08 봄철 시간 변경)에도 자정 경계가 정확하다", () => {
    // DST 시작 다음날 "오늘"을 기준으로 최근 3일 창을 요청 — 창 안에 전환일이 걸린다.
    const clock = createFixedClock("2026-03-09T12:00:00Z"); // NY 기준 03-09 07:00(EDT, UTC-4)
    const { periodStart, periodEnd } = calendarWindow(clock, 3, "America/New_York");
    expect(periodEnd.toISOString()).toBe("2026-03-09T04:00:00.000Z"); // NY 03-09 00:00 EDT(UTC-4)
    expect(periodStart.toISOString()).toBe("2026-03-06T05:00:00.000Z"); // NY 03-06 00:00 EST(UTC-5)
    // 전환일(03-08)이 있어 실제 경과 시간은 정확히 72시간이 아니라 71시간(시간 변경 1시간 손실)이어야 한다.
    const diffHours = (periodEnd.getTime() - periodStart.getTime()) / 3_600_000;
    expect(diffHours).toBe(71);
  });

  it("머신 로컬 타임존과 무관하게 결과가 같다 (Clock은 절대시각, 계산은 timeZone 인자로만 결정)", () => {
    const clock = createFixedClock("2026-09-01T03:00:00Z");
    const a = calendarWindow(clock, 7, "Asia/Manila");
    const b = calendarWindow(clock, 7, "Asia/Manila");
    expect(a.periodStart.toISOString()).toBe(b.periodStart.toISOString());
    expect(a.periodEnd.toISOString()).toBe(b.periodEnd.toISOString());
  });

  it("windowDays가 0 이하면 명확한 에러를 던진다", () => {
    const clock = createFixedClock("2026-09-01T00:00:00Z");
    expect(() => calendarWindow(clock, 0, "Asia/Manila")).toThrow(/windowDays/);
  });
});

describe("경계값 유효성 검증", () => {
  it("avgDailySales: windowDays<=0이면 명확한 에러를 던진다", () => {
    expect(() => avgDailySales(10, 0)).toThrow(/windowDays/);
    expect(() => avgDailySales(10, -1)).toThrow(/windowDays/);
  });

  it("잘못된 numeric 문자열은 원인이 담긴 에러를 던진다", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "s1", variantId: "v1", name: "품목", category: null, soldQtyRaw: "not-a-number" },
    ];
    expect(() => computeSellThrough(salesAgg, [])).toThrow(/유효한 숫자/);
  });
});

describe("computeCsvReorderMetrics (CSV/Excel 채널, SPEC §12, TASKS T17)", () => {
  const PRODUCT_COLA: ProductRow = {
    variantId: "SKU-COLA",
    itemId: "SKU-COLA",
    name: "코카콜라 500ml",
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
    // override 없음 — 전역 기본값을 써야 한다.
  };
  const products = [PRODUCT_COLA, PRODUCT_CHIPS];

  it("판매이력 있는 품목은 기존 §2 근사식 그대로다(28일 골든 케이스 회귀 없음)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본점", variantId: "SKU-COLA", inStock: "15", updatedAt: new Date() },
    ];
    const salesPeriodAgg: SalesPeriodAggRow[] = [
      {
        storeId: "본점",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"), // 28일
        soldQty: "56",
      },
    ];

    const [row] = computeCsvReorderMetrics(inventory, salesPeriodAgg, products, {
      defaultLowStockThreshold: 5,
    });

    expect(row?.mode).toBe("history");
    const historyRow = row as CsvHistoryMetricRow;
    // TESTING §3와 같은 골든 값: 28일 56개 → 일평균 2.0, 재고 15 → 커버 7.5일, 리드7+안전3=10 위험.
    expect(historyRow.avgDailySales).toBe(2.0);
    expect(historyRow.daysOfCover).toBe(7.5);
    expect(historyRow.stockoutRisk).toBe(true);
    expect(historyRow.reorderQty).toBe(27); // ceil(21*2.0-15)
    expect(historyRow.sellThrough).toBeCloseTo(56 / (56 + 15), 10);
  });

  it("CSV 기간 길이가 28일이 아니어도(35일) 실제 기간으로 avgDailySales가 정확히 나뉜다", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본점", variantId: "SKU-COLA", inStock: "50", updatedAt: new Date() },
    ];
    const salesPeriodAgg: SalesPeriodAggRow[] = [
      {
        storeId: "본점",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-07-01T00:00:00Z"),
        periodEnd: new Date("2026-08-05T00:00:00Z"), // 35일
        soldQty: "105",
      },
    ];

    const [row] = computeCsvReorderMetrics(inventory, salesPeriodAgg, products, {
      defaultLowStockThreshold: 5,
    });
    const historyRow = row as CsvHistoryMetricRow;
    // v0.1 기본값(28일)을 그대로 썼다면 105/28=3.75가 나왔을 것 — 실제 기간(35일)로는 3.0이어야 한다.
    expect(historyRow.avgDailySales).toBe(3.0);
  });

  it("한 파일 안에 기간 길이가 다른 품목이 섞여 있어도 각자 맞는 windowDays로 계산된다", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본점", variantId: "SKU-COLA", inStock: "15", updatedAt: new Date() },
      { storeId: "마카티점", variantId: "SKU-CHIPS", inStock: "20", updatedAt: new Date() },
    ];
    const salesPeriodAgg: SalesPeriodAggRow[] = [
      {
        storeId: "본점",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"), // 28일
        soldQty: "56",
      },
      {
        storeId: "마카티점",
        variantId: "SKU-CHIPS",
        periodStart: new Date("2026-07-01T00:00:00Z"),
        periodEnd: new Date("2026-08-05T00:00:00Z"), // 35일
        soldQty: "105",
      },
    ];

    const rows = computeCsvReorderMetrics(inventory, salesPeriodAgg, products, {
      defaultLowStockThreshold: 5,
    }) as CsvHistoryMetricRow[];

    const cola = rows.find((r) => r.variantId === "SKU-COLA");
    const chips = rows.find((r) => r.variantId === "SKU-CHIPS");
    expect(cola?.avgDailySales).toBe(2.0); // 56/28
    expect(chips?.avgDailySales).toBe(3.0); // 105/35 — 28일로 계산됐으면 3.75가 됐을 것.
  });

  it("판매이력 없는 품목은 셀스루/재주문을 건너뛰고 임계치로만 판정한다(조용히 0 처리 안 함)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본점", variantId: "SKU-CHIPS", inStock: "2", updatedAt: new Date() },
    ];
    const [row] = computeCsvReorderMetrics(inventory, [], products, {
      defaultLowStockThreshold: 5,
    });

    expect(row?.mode).toBe("no_history");
    const thresholdRow = row as CsvThresholdMetricRow;
    // history 전용 필드(avgDailySales 등)가 아예 없어야 한다 — "조용히 0"이 아니라 다른 모양.
    expect(thresholdRow).not.toHaveProperty("avgDailySales");
    expect(thresholdRow).not.toHaveProperty("sellThrough");
  });

  it("임계치 판정: 품목별 override(10)가 전역 기본값(5)보다 우선한다", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본점", variantId: "SKU-COLA", inStock: "8", updatedAt: new Date() }, // 8 < 10(override)
    ];
    const [row] = computeCsvReorderMetrics(inventory, [], products, {
      defaultLowStockThreshold: 5, // 8 >= 5 였다면 전역 기본값만으론 안 걸렸을 값
    });
    const thresholdRow = row as CsvThresholdMetricRow;
    expect(thresholdRow.threshold).toBe(10);
    expect(thresholdRow.belowThreshold).toBe(true);
  });

  it("임계치 판정: override가 없으면 전역 기본값을 쓴다", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본점", variantId: "SKU-CHIPS", inStock: "3", updatedAt: new Date() },
    ];
    const [row] = computeCsvReorderMetrics(inventory, [], products, {
      defaultLowStockThreshold: 5,
    });
    const thresholdRow = row as CsvThresholdMetricRow;
    expect(thresholdRow.threshold).toBe(5);
    expect(thresholdRow.belowThreshold).toBe(true); // 3 < 5
  });

  it("재고가 임계치 이상이면 belowThreshold=false다", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본점", variantId: "SKU-CHIPS", inStock: "9", updatedAt: new Date() },
    ];
    const [row] = computeCsvReorderMetrics(inventory, [], products, {
      defaultLowStockThreshold: 5,
    });
    expect((row as CsvThresholdMetricRow).belowThreshold).toBe(false);
  });

  it("음수 재고는 0으로 clamp하고 경고를 남긴다(임계치 폴백 경로에서도)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본점", variantId: "SKU-CHIPS", inStock: "-3", updatedAt: new Date() },
    ];
    const [row] = computeCsvReorderMetrics(inventory, [], products, {
      defaultLowStockThreshold: 5,
    });
    const thresholdRow = row as CsvThresholdMetricRow;
    expect(thresholdRow.inStock).toBe(0);
    expect(thresholdRow.warnings.some((w) => w.includes("음수"))).toBe(true);
  });
});

// SCM 시트 연동 재고 정합성/정통 셀스루 (SPEC §13) — P001 골든 숫자는 사용자가 제공한 실제
// 샘플 구글시트("입출고내역"·"재고현황" 탭, 2026-09-03 확인)에서 그대로 가져왔다: 7월 입고
// 30, 출고(판매) 21(=8+13), 재고현황 탭의 현재재고 9. 기초재고는 그 시트의 원장이 2026-07-01
// 부터 시작하므로 0으로 둔다.
describe("computeStockReconciliation (SPEC §13, 실제 샘플 시트 골든 케이스)", () => {
  it("P001: 정통 셀스루 = 21/(0+30) = 0.7, 원장 예상재고와 실사재고가 일치(불일치 없음)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본사", variantId: "P001", inStock: "9", updatedAt: new Date() },
    ];
    const purchases: PurchaseAgg[] = [{ storeId: "본사", variantId: "P001", receivedQtyRaw: "30" }];
    const sales: SalesAgg[] = [
      { storeId: "본사", variantId: "P001", name: "무선 마우스", category: null, soldQtyRaw: "21" },
    ];

    const [row] = computeStockReconciliation(inventory, purchases, sales);

    expect(row?.sellThroughTraditional).toBeCloseTo(0.7, 10);
    expect(row?.expectedStock).toBe(9);
    expect(row?.actualStock).toBe(9);
    expect(row?.discrepancy).toBe(0);
    expect(row?.hasDiscrepancy).toBe(false);
    expect(row?.warnings).toEqual([]);
  });

  it("실사 재고가 원장 예상치와 다르면 discrepancy·hasDiscrepancy·경고로 드러난다", () => {
    // 원장상 예상재고는 P001과 동일하게 9여야 하지만, 실사는 7 — 도난/파손/오차 등 2개 불일치.
    const inventory: InventoryRow[] = [
      { storeId: "본사", variantId: "P999", inStock: "7", updatedAt: new Date() },
    ];
    const purchases: PurchaseAgg[] = [{ storeId: "본사", variantId: "P999", receivedQtyRaw: "30" }];
    const sales: SalesAgg[] = [
      { storeId: "본사", variantId: "P999", name: "테스트 상품", category: null, soldQtyRaw: "21" },
    ];

    const [row] = computeStockReconciliation(inventory, purchases, sales);

    expect(row?.expectedStock).toBe(9);
    expect(row?.actualStock).toBe(7);
    expect(row?.discrepancy).toBe(-2);
    expect(row?.hasDiscrepancy).toBe(true);
    expect(row?.warnings.some((w) => w.includes("다릅니다"))).toBe(true);
  });

  it("기초재고를 명시하면(openingStock) 정통 셀스루·예상재고 계산에 반영된다", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본사", variantId: "P002", inStock: "35", updatedAt: new Date() },
    ];
    const purchases: PurchaseAgg[] = [{ storeId: "본사", variantId: "P002", receivedQtyRaw: "20" }];
    const sales: SalesAgg[] = [
      {
        storeId: "본사",
        variantId: "P002",
        name: "저소음 키보드",
        category: null,
        soldQtyRaw: "5",
      },
    ];

    const [row] = computeStockReconciliation(inventory, purchases, sales, {
      openingStock: { "본사:P002": 20 },
    });

    expect(row?.openingStock).toBe(20);
    expect(row?.sellThroughTraditional).toBeCloseTo(5 / 40, 10); // 5/(20+20)
    expect(row?.expectedStock).toBe(35); // 20+20-5
    expect(row?.discrepancy).toBe(0);
  });

  it("입고·판매 둘 다 0이면(분모 0) 정통 셀스루는 null이다", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본사", variantId: "P005", inStock: "0", updatedAt: new Date() },
    ];
    const [row] = computeStockReconciliation(inventory, [], []);
    expect(row?.sellThroughTraditional).toBeNull();
    expect(row?.expectedStock).toBe(0);
    expect(row?.discrepancy).toBe(0);
  });

  it("실사 재고 데이터가 없으면 actualStock/discrepancy는 null이고 경고를 남긴다", () => {
    const purchases: PurchaseAgg[] = [{ storeId: "본사", variantId: "P003", receivedQtyRaw: "15" }];
    const [row] = computeStockReconciliation([], purchases, []);
    expect(row?.actualStock).toBeNull();
    expect(row?.discrepancy).toBeNull();
    expect(row?.hasDiscrepancy).toBe(false); // null은 불일치로 표시하지 않는다(대사 불가와 구분).
    expect(row?.warnings.some((w) => w.includes("대사할 수 없습니다"))).toBe(true);
  });

  it("환불이 판매를 초과해 순판매량이 음수면 0으로 계산하고 경고를 남긴다", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본사", variantId: "P001", inStock: "5", updatedAt: new Date() },
    ];
    const sales: SalesAgg[] = [
      { storeId: "본사", variantId: "P001", name: "무선 마우스", category: null, soldQtyRaw: "-3" },
    ];
    const [row] = computeStockReconciliation(inventory, [], sales);
    expect(row?.soldQtyRaw).toBe(-3);
    expect(row?.soldQty).toBe(0);
    expect(row?.warnings.some((w) => w.includes("환불"))).toBe(true);
  });
});

// 팩 단위 반올림(SPEC §14) — 사용자가 제공한 실제 샘플 시트("상품목록"의 포장수량(팩사이즈)
// 컬럼 + "재고현황"의 계산 제안량/최종 발주량/발주 팩수 컬럼, 2026-09-03 확인)의 값을 그대로
// 가져왔다. 시트가 이미 `최종 발주량 = ⌈계산 제안량÷포장수량⌉×포장수량`을 미리 계산해뒀으므로,
// (계산 제안량, 포장수량) → (최종 발주량, 발주 팩수) 그대로를 golden case로 쓴다.
describe("roundToPackMultiple (SPEC §14, 실제 샘플 시트 골든 케이스)", () => {
  it.each([
    // [상품코드, 계산 제안량, 포장수량, 최종 발주량, 발주 팩수]
    ["P001", 27, 24, 48, 2],
    ["P002", 3, 12, 12, 1],
    ["P003", 19, 10, 20, 2],
    ["P004", 11, 6, 12, 2],
    ["P005", 11, 4, 12, 3],
    ["P006", 3, 12, 12, 1],
    ["P007", 20, 20, 20, 1], // 포장수량의 정확한 배수 — 올림해도 그대로.
    ["P008", 14, 10, 20, 2],
  ] as const)(
    "%s: 제안량 %d개, 포장수량 %d → 최종 발주량 %d(%d팩)",
    (_code, calcQty, packSize, expectedFinalQty, expectedPackCount) => {
      const result = roundToPackMultiple(calcQty, packSize);
      expect(result.finalOrderQty).toBe(expectedFinalQty);
      expect(result.packCount).toBe(expectedPackCount);
    },
  );

  it("packSize가 없으면(낱개 매입 가능) 반올림하지 않고 packCount는 null이다", () => {
    expect(roundToPackMultiple(27, null)).toEqual({ finalOrderQty: 27, packCount: null });
    expect(roundToPackMultiple(27, undefined)).toEqual({ finalOrderQty: 27, packCount: null });
  });

  it("제안량이 0이면 팩도 0개 — packSize가 있어도 1팩으로 반올림하지 않는다", () => {
    expect(roundToPackMultiple(0, 24)).toEqual({ finalOrderQty: 0, packCount: 0 });
  });

  it("packSize가 0 이하면 명확한 에러를 던진다", () => {
    expect(() => roundToPackMultiple(10, 0)).toThrow(/packSize/);
    expect(() => roundToPackMultiple(10, -5)).toThrow(/packSize/);
  });
});

describe("applyPackRounding — computeReorderMetrics 결과에 포장수량을 조인해 감싼다", () => {
  it("ProductRow.packSize가 있으면 반올림하고, 없으면 원래 reorderQty를 그대로 둔다", () => {
    const salesAgg: SalesAgg[] = [
      { storeId: "본사", variantId: "P001", name: "무선 마우스", category: null, soldQtyRaw: "36" },
      {
        storeId: "본사",
        variantId: "P002",
        name: "저소음 키보드",
        category: null,
        soldQtyRaw: "0",
      },
    ];
    const stock: StockRow[] = [
      {
        storeId: "본사",
        variantId: "P001",
        name: "무선 마우스",
        inStockRaw: "9",
        updatedAt: new Date(),
      },
      {
        storeId: "본사",
        variantId: "P002",
        name: "저소음 키보드",
        inStockRaw: "5",
        updatedAt: new Date(),
      },
    ];
    // windowDays=1로 두면 avgDailySales=soldQtyRaw 그대로라, targetCoverDays=1일 때
    // reorderQty = max(0, ceil(1*36 - 9)) = 27 — 시트의 P001 계산 제안량과 정확히 같다.
    const rows = computeReorderMetrics(salesAgg, stock, { windowDays: 1, targetCoverDays: 1 });

    const products: ProductRow[] = [
      {
        variantId: "P001",
        itemId: "P001",
        name: "무선 마우스",
        sku: "P001",
        category: null,
        packSize: "24",
      },
      // P002는 packSize 없음 — 낱개 매입.
      { variantId: "P002", itemId: "P002", name: "저소음 키보드", sku: "P002", category: null },
    ];

    const rounded = applyPackRounding(rows, products);
    const p001 = rounded.find((r) => r.variantId === "P001");
    const p002 = rounded.find((r) => r.variantId === "P002");

    expect(p001?.reorderQty).toBe(27);
    expect(p001?.packSize).toBe(24);
    expect(p001).toMatchObject({ finalOrderQty: 48, packCount: 2 });

    expect(p002?.packSize).toBeNull();
    expect(p002?.packCount).toBeNull();
    expect(p002?.finalOrderQty).toBe(p002?.reorderQty); // packSize 없으니 그대로.

    // ReorderMetricRow의 기존 필드도 그대로 보존된다(감싸기만 했지 원본을 바꾸지 않았다).
    expect(p001?.avgDailySales).toBe(36);
    expect(p001?.stockoutRisk).toBe(rows.find((r) => r.variantId === "P001")?.stockoutRisk);
  });

  it("Warehouse에 없는(products 목록에 없는) variantId는 packSize null로 처리한다", () => {
    const salesAgg: SalesAgg[] = [
      {
        storeId: "본사",
        variantId: "UNKNOWN",
        name: "미등록 상품",
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
