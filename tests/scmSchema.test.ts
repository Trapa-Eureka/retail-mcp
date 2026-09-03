import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import {
  mapScmRowsToPurchaseReceipts,
  parseScmReceiptRow,
  scmReceiptRowSchema,
} from "../src/core/scmSchema.js";

const VALID_INBOUND_ROW = {
  일자: "2026-07-01",
  구분: "입고",
  상품코드: "P001",
  상품명: "무선 마우스",
  수량: "30",
  단가: "12000",
  거래처: "스마트유통",
};

describe("scmReceiptRowSchema / parseScmReceiptRow", () => {
  it("정상 입고 행을 파싱한다", () => {
    const row = parseScmReceiptRow(VALID_INBOUND_ROW);
    expect(row.구분).toBe("입고");
    expect(row.상품코드).toBe("P001");
    expect(row.수량).toBe(30);
    expect(row.일자).toEqual(new Date("2026-07-01"));
  });

  it("단가·거래처는 선택 컬럼이다", () => {
    const row = parseScmReceiptRow({
      일자: "2026-07-01",
      구분: "출고",
      상품코드: "P001",
      상품명: "무선 마우스",
      수량: "8",
    });
    expect(row.단가).toBeUndefined();
    expect(row.거래처).toBeUndefined();
  });

  it.each(["일자", "구분", "상품코드", "상품명", "수량"])(
    "%s가 비어 있으면 원인을 담은 에러를 던진다",
    (field) => {
      const raw = { ...VALID_INBOUND_ROW, [field]: "" };
      expect(() => parseScmReceiptRow(raw)).toThrow(new RegExp(field));
    },
  );

  it("구분이 입고/출고가 아니면 거부한다", () => {
    expect(() => parseScmReceiptRow({ ...VALID_INBOUND_ROW, 구분: "반품" })).toThrow(/구분/);
  });

  it("수량이 0 이하이면 거부한다", () => {
    expect(() => parseScmReceiptRow({ ...VALID_INBOUND_ROW, 수량: "0" })).toThrow(/수량/);
    expect(() => parseScmReceiptRow({ ...VALID_INBOUND_ROW, 수량: "-5" })).toThrow(/수량/);
  });

  it("정의되지 않은 컬럼(금액·비고·월)은 조용히 무시한다", () => {
    const raw = { ...VALID_INBOUND_ROW, 금액: "360000원", 비고: "초기 입고", 월: "2026-07" };
    expect(() => parseScmReceiptRow(raw)).not.toThrow();
    expect(scmReceiptRowSchema.parse(raw)).not.toHaveProperty("금액");
  });
});

describe("mapScmRowsToPurchaseReceipts", () => {
  it("구분=입고 행만 반영하고 출고는 건너뛴다", () => {
    const receipts = mapScmRowsToPurchaseReceipts(
      [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, 일자: "2026-07-04", 구분: "출고" }],
      "본사",
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      storeId: "본사",
      variantId: "P001",
      receivedQty: "30",
      unitCost: "12000",
      currency: "KRW",
      vendor: "스마트유통",
    });
    expect(receipts[0]?.receivedAt).toEqual(new Date("2026-07-01"));
  });

  it("단가가 없으면 unitCost/currency 둘 다 null이다", () => {
    const receipts = mapScmRowsToPurchaseReceipts(
      [{ ...VALID_INBOUND_ROW, 단가: undefined }],
      "본사",
    );
    expect(receipts[0]?.unitCost).toBeNull();
    expect(receipts[0]?.currency).toBeNull();
  });

  it("잘못된 행이 섞여 있으면 몇 번째 행인지 알려주는 에러를 던진다", () => {
    expect(() =>
      mapScmRowsToPurchaseReceipts(
        [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, 수량: "0" }],
        "본사",
      ),
    ).toThrow(/2번째 행/);
  });

  it("실제 샘플 시트 스냅샷(tests/fixtures/scm/sample-receipts.csv)을 끝까지 파싱한다", async () => {
    const content = await readFile("tests/fixtures/scm/sample-receipts.csv", "utf8");
    const rawRows = parse(content, { columns: true, skip_empty_lines: true }) as unknown[];
    const receipts = mapScmRowsToPurchaseReceipts(rawRows, "본사");

    // 원본 12행 중 "구분=입고"는 6건뿐 — 나머지 6건(출고)은 걸러진다.
    expect(receipts).toHaveLength(6);
    expect(receipts.map((r) => r.variantId).sort()).toEqual([
      "P001",
      "P002",
      "P003",
      "P004",
      "P006",
      "P007",
    ]);

    const p001 = receipts.find((r) => r.variantId === "P001");
    expect(p001).toMatchObject({ receivedQty: "30", vendor: "스마트유통" });
  });

  describe("동일 매장·SKU·날짜 복수 입고 합산(006 DATA-008, TASKS T33)", () => {
    it("같은 날짜 두 건은 축소 없이 수량이 합산된다", () => {
      const receipts = mapScmRowsToPurchaseReceipts(
        [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, 수량: "15", 거래처: "다른거래처" }],
        "본사",
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.receivedQty).toBe("45");
    });

    it("합산 대상이 아닌 감사용 필드(단가·거래처)는 마지막 행 값을 남긴다", () => {
      const receipts = mapScmRowsToPurchaseReceipts(
        [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, 수량: "15", 거래처: "다른거래처" }],
        "본사",
      );
      expect(receipts[0]?.vendor).toBe("다른거래처");
    });

    it("매장이 다르면(같은 SKU·날짜) 합산하지 않는다 — PK 단위와 정확히 같다", () => {
      const receiptsA = mapScmRowsToPurchaseReceipts([VALID_INBOUND_ROW], "본사A");
      const receiptsB = mapScmRowsToPurchaseReceipts([VALID_INBOUND_ROW], "본사B");
      expect(receiptsA[0]?.storeId).toBe("본사A");
      expect(receiptsB[0]?.storeId).toBe("본사B");
      // 두 매장을 한 배치로 합쳐도 서로 합산되지 않아야 한다.
      const merged = mapScmRowsToPurchaseReceipts(
        [{ ...VALID_INBOUND_ROW }, { ...VALID_INBOUND_ROW }],
        "본사",
      );
      expect(merged).toHaveLength(1); // 같은 매장이면 합산.
      const differentDates = mapScmRowsToPurchaseReceipts(
        [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, 일자: "2026-07-02" }],
        "본사",
      );
      expect(differentDates).toHaveLength(2); // 날짜가 다르면 합산하지 않는다.
      expect(differentDates.map((r) => r.receivedQty)).toEqual(["30", "30"]);
    });

    it("같은 날짜 SKU가 3건 이상이어도 전부 합산된다", () => {
      const receipts = mapScmRowsToPurchaseReceipts(
        [
          VALID_INBOUND_ROW,
          { ...VALID_INBOUND_ROW, 수량: "10" },
          { ...VALID_INBOUND_ROW, 수량: "5" },
        ],
        "본사",
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.receivedQty).toBe("45");
    });

    it("서로 다른 SKU는 독립적으로 처리된다(합산이 SKU를 건너뛰지 않음)", () => {
      const receipts = mapScmRowsToPurchaseReceipts(
        [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, 상품코드: "P002", 수량: "8" }],
        "본사",
      );
      expect(receipts).toHaveLength(2);
      expect(receipts.find((r) => r.variantId === "P001")?.receivedQty).toBe("30");
      expect(receipts.find((r) => r.variantId === "P002")?.receivedQty).toBe("8");
    });
  });
});
