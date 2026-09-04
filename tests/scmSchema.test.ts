import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import {
  mapScmRowsToPurchaseReceipts,
  parseScmReceiptRow,
  scmReceiptRowSchema,
} from "../src/core/scmSchema.js";

const VALID_INBOUND_ROW = {
  date: "2026-07-01",
  type: "inbound",
  sku: "P001",
  product: "Wireless Mouse",
  qty: "30",
  unit_price: "12000",
  vendor: "Smart Distribution",
};

describe("scmReceiptRowSchema / parseScmReceiptRow", () => {
  it("parses a valid inbound row", () => {
    const row = parseScmReceiptRow(VALID_INBOUND_ROW);
    expect(row.type).toBe("inbound");
    expect(row.sku).toBe("P001");
    expect(row.qty).toBe(30);
    expect(row.date).toEqual(new Date("2026-07-01"));
  });

  it("unit_price and vendor are optional columns", () => {
    const row = parseScmReceiptRow({
      date: "2026-07-01",
      type: "outbound",
      sku: "P001",
      product: "Wireless Mouse",
      qty: "8",
    });
    expect(row.unit_price).toBeUndefined();
    expect(row.vendor).toBeUndefined();
  });

  it.each(["date", "type", "sku", "product", "qty"])(
    "throws an error naming the cause when %s is empty",
    (field) => {
      const raw = { ...VALID_INBOUND_ROW, [field]: "" };
      expect(() => parseScmReceiptRow(raw)).toThrow(new RegExp(field));
    },
  );

  it("rejects a type other than inbound/outbound", () => {
    expect(() => parseScmReceiptRow({ ...VALID_INBOUND_ROW, type: "return" })).toThrow(/type/);
  });

  it("rejects qty of 0 or less", () => {
    expect(() => parseScmReceiptRow({ ...VALID_INBOUND_ROW, qty: "0" })).toThrow(/qty/);
    expect(() => parseScmReceiptRow({ ...VALID_INBOUND_ROW, qty: "-5" })).toThrow(/qty/);
  });

  it("silently ignores undefined columns (amount, note, month)", () => {
    const raw = {
      ...VALID_INBOUND_ROW,
      amount: "360000 KRW",
      note: "initial stock",
      month: "2026-07",
    };
    expect(() => parseScmReceiptRow(raw)).not.toThrow();
    expect(scmReceiptRowSchema.parse(raw)).not.toHaveProperty("amount");
  });
});

describe("mapScmRowsToPurchaseReceipts", () => {
  it("applies only type=inbound rows and skips outbound", () => {
    const receipts = mapScmRowsToPurchaseReceipts(
      [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, date: "2026-07-04", type: "outbound" }],
      "HQ",
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      storeId: "HQ",
      variantId: "P001",
      receivedQty: "30",
      unitCost: "12000",
      currency: "KRW",
      vendor: "Smart Distribution",
    });
    expect(receipts[0]?.receivedAt).toEqual(new Date("2026-07-01"));
  });

  it("sets both unitCost and currency to null when unit_price is absent", () => {
    const receipts = mapScmRowsToPurchaseReceipts(
      [{ ...VALID_INBOUND_ROW, unit_price: undefined }],
      "HQ",
    );
    expect(receipts[0]?.unitCost).toBeNull();
    expect(receipts[0]?.currency).toBeNull();
  });

  it("throws an error saying which row when an invalid row is mixed in", () => {
    expect(() =>
      mapScmRowsToPurchaseReceipts([VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, qty: "0" }], "HQ"),
    ).toThrow(/row 2/);
  });

  it("parses the real sample sheet snapshot (tests/fixtures/scm/sample-receipts.csv) to the end", async () => {
    const content = await readFile("tests/fixtures/scm/sample-receipts.csv", "utf8");
    const rawRows = parse(content, { columns: true, skip_empty_lines: true }) as unknown[];
    const receipts = mapScmRowsToPurchaseReceipts(rawRows, "HQ");

    // Of the 12 source rows only 6 are "type=inbound" — the other 6 (outbound) are filtered out.
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
    expect(p001).toMatchObject({ receivedQty: "30", vendor: "Smart Distribution" });
  });

  describe("summing multiple receipts for the same store, SKU and date (006 DATA-008, TASKS T33)", () => {
    it("sums the quantities of two rows on the same date without loss", () => {
      const receipts = mapScmRowsToPurchaseReceipts(
        [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, qty: "15", vendor: "Other Vendor" }],
        "HQ",
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.receivedQty).toBe("45");
    });

    it("keeps the last row's values for non-additive audit fields (unit_price, vendor)", () => {
      const receipts = mapScmRowsToPurchaseReceipts(
        [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, qty: "15", vendor: "Other Vendor" }],
        "HQ",
      );
      expect(receipts[0]?.vendor).toBe("Other Vendor");
    });

    it("does not sum across different stores (same SKU and date) — exactly the PK granularity", () => {
      const receiptsA = mapScmRowsToPurchaseReceipts([VALID_INBOUND_ROW], "HQ-A");
      const receiptsB = mapScmRowsToPurchaseReceipts([VALID_INBOUND_ROW], "HQ-B");
      expect(receiptsA[0]?.storeId).toBe("HQ-A");
      expect(receiptsB[0]?.storeId).toBe("HQ-B");
      // Even when two stores are merged into one batch, they must not be summed together.
      const merged = mapScmRowsToPurchaseReceipts(
        [{ ...VALID_INBOUND_ROW }, { ...VALID_INBOUND_ROW }],
        "HQ",
      );
      expect(merged).toHaveLength(1); // Same store, so summed.
      const differentDates = mapScmRowsToPurchaseReceipts(
        [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, date: "2026-07-02" }],
        "HQ",
      );
      expect(differentDates).toHaveLength(2); // Different dates are not summed.
      expect(differentDates.map((r) => r.receivedQty)).toEqual(["30", "30"]);
    });

    it("sums all of 3 or more rows for the same SKU on the same date", () => {
      const receipts = mapScmRowsToPurchaseReceipts(
        [
          VALID_INBOUND_ROW,
          { ...VALID_INBOUND_ROW, qty: "10" },
          { ...VALID_INBOUND_ROW, qty: "5" },
        ],
        "HQ",
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.receivedQty).toBe("45");
    });

    it("handles different SKUs independently (summing does not cross SKUs)", () => {
      const receipts = mapScmRowsToPurchaseReceipts(
        [VALID_INBOUND_ROW, { ...VALID_INBOUND_ROW, sku: "P002", qty: "8" }],
        "HQ",
      );
      expect(receipts).toHaveLength(2);
      expect(receipts.find((r) => r.variantId === "P001")?.receivedQty).toBe("30");
      expect(receipts.find((r) => r.variantId === "P002")?.receivedQty).toBe("8");
    });
  });
});
