import { describe, expect, it } from "vitest";
import { parseCsvRow, salesHistoryModeOf, csvRowSchema } from "../src/core/csvSchema.js";

const BASE = {
  매장명: "본점",
  상품명: "코카콜라 500ml",
  SKU: "SKU-COLA",
  재고수량: "40",
};

describe("csvRowSchema / parseCsvRow", () => {
  describe("필수 컬럼", () => {
    it("매장명/상품명/SKU/재고수량이 모두 있으면 통과한다", () => {
      const row = parseCsvRow(BASE);
      expect(row).toEqual({ ...BASE, 재고수량: 40 });
    });

    it.each(["매장명", "상품명", "SKU", "재고수량"] as const)(
      "%s가 없으면 원인이 담긴 에러를 던진다",
      (key) => {
        const rest = { ...BASE };
        delete rest[key];
        expect(() => parseCsvRow(rest)).toThrow(new RegExp(key));
      },
    );

    it.each(["매장명", "상품명", "SKU", "재고수량"])(
      "%s가 빈 문자열이어도(칸만 비움) 누락으로 취급해 거부한다",
      (key) => {
        expect(() => parseCsvRow({ ...BASE, [key]: "" })).toThrow();
      },
    );

    it("재고수량이 숫자가 아니면 거부한다", () => {
      expect(() => parseCsvRow({ ...BASE, 재고수량: "많음" })).toThrow(/재고수량/);
    });

    it("재고수량이 음수면 거부한다", () => {
      expect(() => parseCsvRow({ ...BASE, 재고수량: "-1" })).toThrow(/재고수량/);
    });

    it("재고수량 0은 유효하다(빈 값과 구분)", () => {
      const row = parseCsvRow({ ...BASE, 재고수량: "0" });
      expect(row.재고수량).toBe(0);
    });
  });

  describe("판매수량·기간 불일치", () => {
    it("판매수량만 있고 기간이 없으면 거부한다", () => {
      expect(() => parseCsvRow({ ...BASE, 판매수량: "10" })).toThrow(/판매기간/);
    });

    it("판매수량과 시작일만 있고 종료일이 없으면 거부한다", () => {
      expect(() => parseCsvRow({ ...BASE, 판매수량: "10", 판매기간시작일: "2026-08-01" })).toThrow(
        /판매기간/,
      );
    });

    it("기간만 있고 판매수량이 없으면 거부한다", () => {
      expect(() =>
        parseCsvRow({
          ...BASE,
          판매기간시작일: "2026-08-01",
          판매기간종료일: "2026-08-29",
        }),
      ).toThrow(/판매수량/);
    });

    it("시작일이 종료일보다 늦으면 거부한다", () => {
      expect(() =>
        parseCsvRow({
          ...BASE,
          판매수량: "10",
          판매기간시작일: "2026-08-29",
          판매기간종료일: "2026-08-01",
        }),
      ).toThrow(/판매기간종료일/);
    });

    it("판매수량+유효한 기간이 모두 있으면 통과한다", () => {
      const row = parseCsvRow({
        ...BASE,
        판매수량: "56",
        판매기간시작일: "2026-08-01",
        판매기간종료일: "2026-08-29",
      });
      expect(row.판매수량).toBe(56);
      expect(row.판매기간시작일).toBeInstanceOf(Date);
      expect(row.판매기간종료일).toBeInstanceOf(Date);
    });
  });

  describe("단가/통화", () => {
    it("단가만 있고 통화가 없으면 거부한다(SPEC §9)", () => {
      expect(() => parseCsvRow({ ...BASE, 단가: "50" })).toThrow(/통화/);
    });

    it("통화 코드가 3글자가 아니면 거부한다", () => {
      expect(() => parseCsvRow({ ...BASE, 단가: "50", 통화: "필리핀페소" })).toThrow(/통화/);
    });

    it("단가+통화가 모두 있으면 통과하고 통화는 대문자로 정규화된다", () => {
      const row = parseCsvRow({ ...BASE, 단가: "50", 통화: "php" });
      expect(row.단가).toBe(50);
      expect(row.통화).toBe("PHP");
    });
  });

  describe("저재고임계치", () => {
    it("생략하면 undefined다(전역 기본값은 T17에서 적용)", () => {
      const row = parseCsvRow(BASE);
      expect(row.저재고임계치).toBeUndefined();
    });

    it("있으면 숫자로 파싱된다", () => {
      const row = parseCsvRow({ ...BASE, 저재고임계치: "5" });
      expect(row.저재고임계치).toBe(5);
    });
  });

  describe("포장수량 (SPEC §14 팩 단위 반올림)", () => {
    it("생략하면 undefined다(낱개 매입 가능한 품목으로 취급)", () => {
      const row = parseCsvRow(BASE);
      expect(row.포장수량).toBeUndefined();
    });

    it("있으면 숫자로 파싱된다", () => {
      const row = parseCsvRow({ ...BASE, 포장수량: "24" });
      expect(row.포장수량).toBe(24);
    });

    it("0 이하이면 거부한다", () => {
      expect(() => parseCsvRow({ ...BASE, 포장수량: "0" })).toThrow(/포장수량/);
      expect(() => parseCsvRow({ ...BASE, 포장수량: "-1" })).toThrow(/포장수량/);
    });
  });

  describe("csvRowSchema (safeParse 직접 사용도 가능)", () => {
    it("실패 시 issues에 path가 채워진다", () => {
      const result = csvRowSchema.safeParse({ ...BASE, 매장명: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toContain("매장명");
      }
    });
  });
});

describe("salesHistoryModeOf", () => {
  it("판매수량이 없으면 no_history다", () => {
    const row = parseCsvRow(BASE);
    expect(salesHistoryModeOf(row)).toBe("no_history");
  });

  it("판매수량+기간이 있으면 history다", () => {
    const row = parseCsvRow({
      ...BASE,
      판매수량: "56",
      판매기간시작일: "2026-08-01",
      판매기간종료일: "2026-08-29",
    });
    expect(salesHistoryModeOf(row)).toBe("history");
  });

  it("판매수량이 0이어도(팔린 적 없음, 값 자체는 있음) history다", () => {
    const row = parseCsvRow({
      ...BASE,
      판매수량: "0",
      판매기간시작일: "2026-08-01",
      판매기간종료일: "2026-08-29",
    });
    expect(salesHistoryModeOf(row)).toBe("history");
  });
});
