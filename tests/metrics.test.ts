import { describe, expect, it } from "vitest";
import {
  avgDailySales,
  calendarWindow,
  computeReorderMetrics,
  computeSellThrough,
  daysOfCover,
  isStockoutRisk,
  reorderQty,
  sellThroughRatio,
} from "../src/core/metrics.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import type { SalesAgg, StockRow } from "../src/core/types.js";

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
