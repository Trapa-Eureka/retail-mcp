import { describe, expect, it } from "vitest";
import { parseCsvRow, salesHistoryModeOf, csvRowSchema } from "../src/core/csvSchema.js";

const BASE = {
  store: "Main Store",
  product: "Cola 500ml",
  sku: "SKU-COLA",
  stock_qty: "40",
};

describe("csvRowSchema / parseCsvRow", () => {
  describe("required columns", () => {
    it("passes when store/product/sku/stock_qty are all present", () => {
      const row = parseCsvRow(BASE);
      expect(row).toEqual({ ...BASE, stock_qty: 40 });
    });

    it.each(["store", "product", "sku", "stock_qty"] as const)(
      "throws an error naming the cause when %s is missing",
      (key) => {
        const rest = { ...BASE };
        delete rest[key];
        expect(() => parseCsvRow(rest)).toThrow(new RegExp(key));
      },
    );

    it.each(["store", "product", "sku", "stock_qty"])(
      "rejects %s as missing even when it is an empty string (cell left blank)",
      (key) => {
        expect(() => parseCsvRow({ ...BASE, [key]: "" })).toThrow();
      },
    );

    it("rejects a non-numeric stock_qty", () => {
      expect(() => parseCsvRow({ ...BASE, stock_qty: "lots" })).toThrow(/stock_qty/);
    });

    it("rejects a negative stock_qty", () => {
      expect(() => parseCsvRow({ ...BASE, stock_qty: "-1" })).toThrow(/stock_qty/);
    });

    it("accepts stock_qty 0 (distinct from a blank value)", () => {
      const row = parseCsvRow({ ...BASE, stock_qty: "0" });
      expect(row.stock_qty).toBe(0);
    });
  });

  describe("sales_qty / period mismatch", () => {
    it("rejects sales_qty without a period", () => {
      expect(() => parseCsvRow({ ...BASE, sales_qty: "10" })).toThrow(/period_/);
    });

    it("rejects sales_qty with only period_start and no period_end", () => {
      expect(() => parseCsvRow({ ...BASE, sales_qty: "10", period_start: "2026-08-01" })).toThrow(
        /period_/,
      );
    });

    it("rejects a period without sales_qty", () => {
      expect(() =>
        parseCsvRow({
          ...BASE,
          period_start: "2026-08-01",
          period_end: "2026-08-29",
        }),
      ).toThrow(/sales_qty/);
    });

    it("rejects period_start later than period_end", () => {
      expect(() =>
        parseCsvRow({
          ...BASE,
          sales_qty: "10",
          period_start: "2026-08-29",
          period_end: "2026-08-01",
        }),
      ).toThrow(/period_end/);
    });

    it("passes when sales_qty and a valid period are all present", () => {
      const row = parseCsvRow({
        ...BASE,
        sales_qty: "56",
        period_start: "2026-08-01",
        period_end: "2026-08-29",
      });
      expect(row.sales_qty).toBe(56);
      expect(row.period_start).toBeInstanceOf(Date);
      expect(row.period_end).toBeInstanceOf(Date);
    });
  });

  describe("unit_price/currency", () => {
    it("rejects unit_price without currency (SPEC §9)", () => {
      expect(() => parseCsvRow({ ...BASE, unit_price: "50" })).toThrow(/currency/);
    });

    it("rejects a currency code that is not 3 letters", () => {
      expect(() => parseCsvRow({ ...BASE, unit_price: "50", currency: "Philippine peso" })).toThrow(
        /currency/,
      );
    });

    it("passes when unit_price and currency are both present and normalizes currency to upper case", () => {
      const row = parseCsvRow({ ...BASE, unit_price: "50", currency: "php" });
      expect(row.unit_price).toBe(50);
      expect(row.currency).toBe("PHP");
    });
  });

  describe("low_stock_threshold", () => {
    it("is undefined when omitted (the global default is applied in T17)", () => {
      const row = parseCsvRow(BASE);
      expect(row.low_stock_threshold).toBeUndefined();
    });

    it("is parsed as a number when present", () => {
      const row = parseCsvRow({ ...BASE, low_stock_threshold: "5" });
      expect(row.low_stock_threshold).toBe(5);
    });
  });

  describe("pack_size (SPEC §14 pack-unit rounding)", () => {
    it("is undefined when omitted (treated as an item that can be bought individually)", () => {
      const row = parseCsvRow(BASE);
      expect(row.pack_size).toBeUndefined();
    });

    it("is parsed as a number when present", () => {
      const row = parseCsvRow({ ...BASE, pack_size: "24" });
      expect(row.pack_size).toBe(24);
    });

    it("rejects 0 or less", () => {
      expect(() => parseCsvRow({ ...BASE, pack_size: "0" })).toThrow(/pack_size/);
      expect(() => parseCsvRow({ ...BASE, pack_size: "-1" })).toThrow(/pack_size/);
    });
  });

  describe("csvRowSchema (safeParse can also be used directly)", () => {
    it("fills the path in issues on failure", () => {
      const result = csvRowSchema.safeParse({ ...BASE, store: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toContain("store");
      }
    });
  });
});

describe("salesHistoryModeOf", () => {
  it("is no_history without sales_qty", () => {
    const row = parseCsvRow(BASE);
    expect(salesHistoryModeOf(row)).toBe("no_history");
  });

  it("is history with sales_qty and a period", () => {
    const row = parseCsvRow({
      ...BASE,
      sales_qty: "56",
      period_start: "2026-08-01",
      period_end: "2026-08-29",
    });
    expect(salesHistoryModeOf(row)).toBe("history");
  });

  it("is history even when sales_qty is 0 (never sold, but the value itself is present)", () => {
    const row = parseCsvRow({
      ...BASE,
      sales_qty: "0",
      period_start: "2026-08-01",
      period_end: "2026-08-29",
    });
    expect(salesHistoryModeOf(row)).toBe("history");
  });
});
