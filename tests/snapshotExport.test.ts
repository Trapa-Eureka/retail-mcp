import { parse as parseCsvText } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { parseCsvRow } from "../src/core/csvSchema.js";
import { mapRowsToDomain } from "../src/adapters/csvExcelParser.js";
import { exportSnapshotCsv } from "../src/core/snapshotExport.js";
import type { InventoryRow, ProductRow, SalesPeriodAggRow } from "../src/core/types.js";

const NOW = new Date("2026-09-03T00:00:00Z");

describe("exportSnapshotCsv", () => {
  it("serializes with the fixed template header and column order", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-COLA", inStock: "40", updatedAt: NOW },
    ];
    const products: ProductRow[] = [
      {
        variantId: "SKU-COLA",
        itemId: "SKU-COLA",
        name: "Cola 500ml",
        sku: "SKU-COLA",
        category: null,
        lowStockThreshold: "10",
        packSize: "24",
      },
    ];
    const salesPeriodAgg: SalesPeriodAggRow[] = [
      {
        storeId: "Main Store",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
        soldQty: "56",
      },
    ];

    const csv = exportSnapshotCsv({ inventory, products, salesPeriodAgg });
    const [header, dataLine] = csv.trim().split("\n");
    expect(header).toBe(
      "store,product,sku,stock_qty,sales_qty,period_start,period_end,low_stock_threshold,pack_size",
    );
    expect(dataLine).toBe("Main Store,Cola 500ml,SKU-COLA,40,56,2026-08-01,2026-08-29,10,24");
  });

  it("leaves the sales-related columns blank for items without sales history (does not silently write 0)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-CHIPS", inStock: "2", updatedAt: NOW },
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
    expect(dataLine).toBe("Main Store,Piattos,SKU-CHIPS,2,,,,,");
  });

  it("includes pack_size in the exported CSV (006 DATA-001 response, TASKS T31)", () => {
    const inventory: InventoryRow[] = [
      { storeId: "Main Store", variantId: "SKU-COLA", inStock: "40", updatedAt: NOW },
    ];
    const products: ProductRow[] = [
      {
        variantId: "SKU-COLA",
        itemId: "SKU-COLA",
        name: "Cola 500ml",
        sku: "SKU-COLA",
        category: null,
        packSize: "24",
      },
    ];
    const csv = exportSnapshotCsv({ inventory, products, salesPeriodAgg: [] });
    expect(csv).toContain("24");
  });

  it("includes the store name in the exported CSV", () => {
    const inventory: InventoryRow[] = [
      { storeId: "North Branch", variantId: "SKU-COLA", inStock: "8", updatedAt: NOW },
    ];
    const products: ProductRow[] = [
      {
        variantId: "SKU-COLA",
        itemId: "SKU-COLA",
        name: "Cola 500ml",
        sku: "SKU-COLA",
        category: null,
      },
    ];
    const csv = exportSnapshotCsv({ inventory, products, salesPeriodAgg: [] });
    expect(csv).toContain("North Branch");
  });

  it("escapes store, product and sku that start with a formula prefix (=/+/-/@) (005 SEC-004, TASKS T32)", () => {
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
    // csv-stringify only wraps a value in double quotes when it contains a comma, double quote
    // or newline — the escaped values themselves ("'=..." etc.) contain none, so they come out
    // unquoted.
    expect(dataLine).toBe("'=SUM(A1),'@HYPERLINK(A1),'+SKU-EVIL,1,,,,,");
  });
});

describe("round trip — export → re-parse with T15/T16 matches the original data", () => {
  it("yields identical domain data after the round trip even with a mix of rows with and without sales history", () => {
    const rawRows = [
      {
        store: "Main Store",
        product: "Cola 500ml",
        sku: "SKU-COLA",
        stock_qty: "40",
        sales_qty: "56",
        period_start: "2026-08-01",
        period_end: "2026-08-29",
        low_stock_threshold: "10",
        pack_size: "24",
      },
      {
        store: "Main Store",
        product: "Piattos",
        sku: "SKU-CHIPS",
        stock_qty: "2",
      },
      {
        store: "North Branch",
        product: "Cola 500ml",
        sku: "SKU-COLA",
        stock_qty: "8",
        low_stock_threshold: "10", // The same SKU-COLA must have the same threshold (T16 consistency check).
        pack_size: "24", // For the same reason pack_size must be identical for SKU-COLA in every row.
      },
    ];

    // 1) validate with T15 → 2) convert to domain with T16 (= "processed inventory data").
    const original = mapRowsToDomain(rawRows, NOW);

    // 3) serialize the snapshot CSV with T19.
    const csv = exportSnapshotCsv(original);

    // 4) parse back into CSV text (the same csv-parse path T16 uses when reading a real file) → 5) reconvert with T16.
    const reparsedRawRows = parseCsvText(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as unknown[];
    const roundTripped = mapRowsToDomain(reparsedRawRows, NOW);

    // SEC-004/DATA-005 interaction: the snapshot fixed template (T31 COLUMNS) always includes
    // the low_stock_threshold and pack_size columns — values whose column was absent in the
    // original (undefined, "no information") are normalized on re-import to "column present
    // but cell empty" (null, explicitly cleared). A snapshot is always a complete point-in-time
    // image, so this reinterpretation is intended (006 DATA-005, TASKS T33) — hence only
    // products is compared with that normalization applied and everything else must match
    // exactly.
    expect(roundTripped.stores).toEqual(original.stores);
    expect(roundTripped.inventory).toEqual(original.inventory);
    expect(roundTripped.salesPeriodAgg).toEqual(original.salesPeriodAgg);
    expect(roundTripped.products).toEqual(
      original.products.map((p) => ({
        ...p,
        lowStockThreshold: p.lowStockThreshold ?? null,
        packSize: p.packSize ?? null,
      })),
    );
  });

  it("restores store, product and sku starting with a formula prefix to their original values after the round trip (SEC-004, TASKS T32)", () => {
    const rawRows = [
      {
        store: "=SUM(A1)",
        product: "+HYPERLINK(evil.com)",
        sku: "@cmd|'/c calc'",
        stock_qty: "5",
      },
    ];

    const original = mapRowsToDomain(rawRows, NOW);
    // The export escapes, so even when a person opens this CSV directly in Excel/Sheets it is not executed as a formula.
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

    // After the round trip it must match the original domain data exactly, without the escape prefix (machine re-import path).
    // lowStockThreshold/packSize were undefined because the original had no such column, but
    // the fixed-template export always includes those columns, so on re-import they are
    // normalized to null (explicitly cleared) — 006 DATA-005, TASKS T33, same reason as the
    // other round-trip test above.
    expect(roundTripped).toEqual({
      ...original,
      products: original.products.map((p) => ({
        ...p,
        lowStockThreshold: p.lowStockThreshold ?? null,
        packSize: p.packSize ?? null,
      })),
    });
    expect(roundTripped.stores[0]?.id).toBe("=SUM(A1)");
    expect(roundTripped.products[0]?.name).toBe("+HYPERLINK(evil.com)");
  });

  it("can be re-parsed with the T15 schema even with a single row (exactly compatible with csvRowSchema)", () => {
    const raw = {
      store: "Main Store",
      product: "Cola 500ml",
      sku: "SKU-COLA",
      stock_qty: "40",
      sales_qty: "56",
      period_start: "2026-08-01",
      period_end: "2026-08-29",
    };
    const original = mapRowsToDomain([raw], NOW);
    const csv = exportSnapshotCsv(original);
    const [reparsedRaw] = parseCsvText(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as unknown[];

    // Check directly that T15's parseCsvRow accepts the export output as is.
    const row = parseCsvRow(reparsedRaw);
    expect(row.store).toBe("Main Store");
    expect(row.sales_qty).toBe(56);
    expect(row.period_start).toEqual(new Date("2026-08-01"));
    expect(row.period_end).toEqual(new Date("2026-08-29"));
  });
});
