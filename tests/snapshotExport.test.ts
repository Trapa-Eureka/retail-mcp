import { parse as parseCsvText } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { parseCsvRow } from "../src/core/csvSchema.js";
import { mapRowsToDomain } from "../src/adapters/csvExcelParser.js";
import { exportSnapshotCsv } from "../src/core/snapshotExport.js";
import type { InventoryRow, ProductRow, SalesPeriodAggRow } from "../src/core/types.js";

const NOW = new Date("2026-09-03T00:00:00Z");

describe("exportSnapshotCsv", () => {
  it("고정 템플릿 헤더·열 순서로 직렬화한다", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본점", variantId: "SKU-COLA", inStock: "40", updatedAt: NOW },
    ];
    const products: ProductRow[] = [
      {
        variantId: "SKU-COLA",
        itemId: "SKU-COLA",
        name: "코카콜라 500ml",
        sku: "SKU-COLA",
        category: null,
        lowStockThreshold: "10",
      },
    ];
    const salesPeriodAgg: SalesPeriodAggRow[] = [
      {
        storeId: "본점",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
        soldQty: "56",
      },
    ];

    const csv = exportSnapshotCsv({ inventory, products, salesPeriodAgg });
    const [header, dataLine] = csv.trim().split("\n");
    expect(header).toBe(
      "매장명,상품명,SKU,재고수량,판매수량,판매기간시작일,판매기간종료일,저재고임계치",
    );
    expect(dataLine).toBe("본점,코카콜라 500ml,SKU-COLA,40,56,2026-08-01,2026-08-29,10");
  });

  it("판매이력 없는 품목은 판매 관련 컬럼이 빈칸이다(조용히 0을 쓰지 않는다)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "본점", variantId: "SKU-CHIPS", inStock: "2", updatedAt: NOW },
    ];
    const products: ProductRow[] = [
      {
        variantId: "SKU-CHIPS",
        itemId: "SKU-CHIPS",
        name: "Piattos",
        sku: "SKU-CHIPS",
        category: null,
      },
    ];

    const csv = exportSnapshotCsv({ inventory, products, salesPeriodAgg: [] });
    const [, dataLine] = csv.trim().split("\n");
    expect(dataLine).toBe("본점,Piattos,SKU-CHIPS,2,,,,");
  });

  it("매장명이 exported CSV에 포함된다", () => {
    const inventory: InventoryRow[] = [
      { storeId: "마카티점", variantId: "SKU-COLA", inStock: "8", updatedAt: NOW },
    ];
    const products: ProductRow[] = [
      {
        variantId: "SKU-COLA",
        itemId: "SKU-COLA",
        name: "코카콜라 500ml",
        sku: "SKU-COLA",
        category: null,
      },
    ];
    const csv = exportSnapshotCsv({ inventory, products, salesPeriodAgg: [] });
    expect(csv).toContain("마카티점");
  });
});

describe("왕복 테스트 — export → T15/T16으로 재파싱하면 원 데이터와 일치", () => {
  it("판매이력 있는 행과 없는 행이 섞여 있어도 왕복 후 동일한 도메인 데이터가 나온다", () => {
    const rawRows = [
      {
        매장명: "본점",
        상품명: "코카콜라 500ml",
        SKU: "SKU-COLA",
        재고수량: "40",
        판매수량: "56",
        판매기간시작일: "2026-08-01",
        판매기간종료일: "2026-08-29",
        저재고임계치: "10",
      },
      {
        매장명: "본점",
        상품명: "Piattos",
        SKU: "SKU-CHIPS",
        재고수량: "2",
      },
      {
        매장명: "마카티점",
        상품명: "코카콜라 500ml",
        SKU: "SKU-COLA",
        재고수량: "8",
        저재고임계치: "10", // 같은 SKU-COLA는 같은 임계치여야 한다(T16 일관성 검증).
      },
    ];

    // 1) T15로 검증 → 2) T16으로 도메인 변환(= "처리된 재고 데이터").
    const original = mapRowsToDomain(rawRows, NOW);

    // 3) T19로 스냅샷 CSV 직렬화.
    const csv = exportSnapshotCsv(original);

    // 4) 다시 CSV 텍스트로 파싱(T16이 실제 파일을 읽을 때와 동일한 csv-parse 경로) → 5) T16으로 재변환.
    const reparsedRawRows = parseCsvText(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as unknown[];
    const roundTripped = mapRowsToDomain(reparsedRawRows, NOW);

    expect(roundTripped).toEqual(original);
  });

  it("행 하나만 있어도 T15 스키마로 재파싱 가능하다(csvRowSchema와 정확히 호환)", () => {
    const raw = {
      매장명: "본점",
      상품명: "코카콜라 500ml",
      SKU: "SKU-COLA",
      재고수량: "40",
      판매수량: "56",
      판매기간시작일: "2026-08-01",
      판매기간종료일: "2026-08-29",
    };
    const original = mapRowsToDomain([raw], NOW);
    const csv = exportSnapshotCsv(original);
    const [reparsedRaw] = parseCsvText(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as unknown[];

    // T15의 parseCsvRow가 export 결과를 그대로 받아들이는지 직접 확인.
    const row = parseCsvRow(reparsedRaw);
    expect(row.매장명).toBe("본점");
    expect(row.판매수량).toBe(56);
    expect(row.판매기간시작일).toEqual(new Date("2026-08-01"));
    expect(row.판매기간종료일).toEqual(new Date("2026-08-29"));
  });
});
