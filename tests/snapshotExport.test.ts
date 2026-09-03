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
        packSize: "24",
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
      "매장명,상품명,SKU,재고수량,판매수량,판매기간시작일,판매기간종료일,저재고임계치,포장수량",
    );
    expect(dataLine).toBe("본점,코카콜라 500ml,SKU-COLA,40,56,2026-08-01,2026-08-29,10,24");
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
    expect(dataLine).toBe("본점,Piattos,SKU-CHIPS,2,,,,,");
  });

  it("포장수량(팩사이즈)이 exported CSV에 포함된다(006 DATA-001 대응, TASKS T31)", () => {
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
        packSize: "24",
      },
    ];
    const csv = exportSnapshotCsv({ inventory, products, salesPeriodAgg: [] });
    expect(csv).toContain("24");
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

  it("매장명·상품명·SKU가 수식 접두사(=/+/-/@)로 시작하면 escape한다(005 SEC-004, TASKS T32)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "=SUM(A1)", variantId: "+SKU-EVIL", inStock: "1", updatedAt: NOW },
    ];
    const products: ProductRow[] = [
      {
        variantId: "+SKU-EVIL",
        itemId: "+SKU-EVIL",
        name: "@HYPERLINK(A1)",
        sku: "+SKU-EVIL",
        category: null,
      },
    ];
    const csv = exportSnapshotCsv({ inventory, products, salesPeriodAgg: [] });
    const [, dataLine] = csv.trim().split("\n");
    // csv-stringify는 값에 콤마·큰따옴표·개행이 있을 때만 큰따옴표로 감싼다 — escape된 값
    // 자체("'=..." 등)엔 그런 문자가 없어 quoting 없이 그대로 나온다.
    expect(dataLine).toBe("'=SUM(A1),'@HYPERLINK(A1),'+SKU-EVIL,1,,,,,");
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
        포장수량: "24",
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
        포장수량: "24", // 같은 이유로 포장수량도 SKU-COLA는 모든 행에서 동일해야 한다.
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

  it("수식 접두사로 시작하는 매장명·상품명·SKU도 왕복 후 원래 값 그대로 복원된다(SEC-004, TASKS T32)", () => {
    const rawRows = [
      {
        매장명: "=SUM(A1)",
        상품명: "+HYPERLINK(evil.com)",
        SKU: "@cmd|'/c calc'",
        재고수량: "5",
      },
    ];

    const original = mapRowsToDomain(rawRows, NOW);
    // export가 escape하므로 사람이 이 CSV를 Excel/Sheets로 직접 열어도 수식으로 실행되지 않는다.
    const csv = exportSnapshotCsv(original);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain("'+HYPERLINK(evil.com)");
    expect(csv).toContain("'@cmd");

    const reparsedRawRows = parseCsvText(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as unknown[];
    const roundTripped = mapRowsToDomain(reparsedRawRows, NOW);

    // 왕복 후 escape 접두사 없이 원래 도메인 데이터와 완전히 일치해야 한다(machine 재수입 경로).
    expect(roundTripped).toEqual(original);
    expect(roundTripped.stores[0]?.id).toBe("=SUM(A1)");
    expect(roundTripped.products[0]?.name).toBe("+HYPERLINK(evil.com)");
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
