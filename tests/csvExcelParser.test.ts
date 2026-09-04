import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeFileBytes,
  mapRowsToDomain,
  parseInventoryFile,
} from "../src/adapters/csvExcelParser.js";
import { MAX_CELL_LENGTH, MAX_ROWS } from "../src/adapters/fileLimits.js";

const FIXTURES_DIR = "tests/fixtures/csvExcel";
const NOW = new Date("2026-09-03T00:00:00Z");

describe("decodeFileBytes", () => {
  it("detects a UTF-8 file as UTF-8", async () => {
    const bytes = await readFile(`${FIXTURES_DIR}/inventory-utf8.csv`);
    const { text, encoding } = decodeFileBytes(bytes);
    expect(encoding).toBe("utf-8");
    expect(text).toContain("Cola ½L");
  });

  it("detects an EUC-KR/CP949 file as euc-kr and decodes it correctly", async () => {
    const bytes = await readFile(`${FIXTURES_DIR}/inventory-euckr.csv`);
    const { text, encoding } = decodeFileBytes(bytes);
    expect(encoding).toBe("euc-kr");
    expect(text).toContain("Cola ½L");
  });

  it("throws an explicit error when it is neither (garbage bytes) (no silent mojibake)", () => {
    // A byte sequence that is valid neither as UTF-8 nor as EUC-KR.
    const garbage = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81]);
    expect(() => decodeFileBytes(garbage)).toThrow(/encoding/);
  });
});

describe("parseInventoryFile", () => {
  it("parses the UTF-8 CSV fixture", async () => {
    const result = await parseInventoryFile(`${FIXTURES_DIR}/inventory-utf8.csv`, NOW);
    expect(result.stores.map((s) => s.id).sort()).toEqual(["Main Store", "North Branch"]);
    expect(result.products.find((p) => p.variantId === "SKU-COLA")?.name).toBe("Cola ½L");
    expect(result.inventory).toHaveLength(3);
    // Main Store/SKU-COLA has sales history → present in salesPeriodAgg.
    expect(result.salesPeriodAgg).toEqual([
      {
        storeId: "Main Store",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-08-01"),
        periodEnd: new Date("2026-08-29"),
        soldQty: "56",
      },
    ]);
  });

  it("parses the EUC-KR/CP949 CSV fixture (same result as UTF-8)", async () => {
    const utf8Result = await parseInventoryFile(`${FIXTURES_DIR}/inventory-utf8.csv`, NOW);
    const eucKrResult = await parseInventoryFile(`${FIXTURES_DIR}/inventory-euckr.csv`, NOW);
    expect(eucKrResult).toEqual(utf8Result);
  });

  it("parses the XLSX fixture (native number/date cells)", async () => {
    const result = await parseInventoryFile(`${FIXTURES_DIR}/inventory.xlsx`, NOW);
    expect(result.stores.map((s) => s.id).sort()).toEqual(["Main Store", "North Branch"]);
    const cola = result.inventory.find(
      (r) => r.storeId === "Main Store" && r.variantId === "SKU-COLA",
    );
    expect(cola?.inStock).toBe("40");
    expect(result.salesPeriodAgg).toEqual([
      {
        storeId: "Main Store",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-08-01"),
        periodEnd: new Date("2026-08-29"),
        soldQty: "56",
      },
    ]);
  });

  it("explicitly rejects an unsupported extension", async () => {
    await expect(parseInventoryFile("inventory.txt", NOW)).rejects.toThrow(/Unsupported/);
  });
});

describe("parseInventoryFile — size/row-count/cell-length limits (SEC-003, TASKS T32)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-csvexcel-limits-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("CSV — rejects a row count over the limit before domain validation", async () => {
    const header = "store,product,sku,stock_qty\n";
    const rows = Array.from(
      { length: MAX_ROWS + 1 },
      (_, i) => `Main Store,Product ${i},SKU-${i},1`,
    ).join("\n");
    const p = join(dir, "too-many-rows.csv");
    await writeFile(p, header + rows + "\n", "utf8");
    await expect(parseInventoryFile(p, NOW)).rejects.toThrow(/rows.*limit|limit.*rows/);
  });

  it("CSV — rejects a cell value longer than the limit", async () => {
    const p = join(dir, "long-cell.csv");
    const longValue = "x".repeat(MAX_CELL_LENGTH + 1);
    await writeFile(p, `store,product,sku,stock_qty\nMain Store,${longValue},SKU-1,1\n`, "utf8");
    await expect(parseInventoryFile(p, NOW)).rejects.toThrow(/Cell value is too long/);
  });

  it("XLSX — rejects a bulk of rows over the limit (buffered check — see the residual risk in the csvExcelParser.ts doc)", async () => {
    const p = join(dir, "too-many-rows.xlsx");
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: p });
    const sheet = writer.addWorksheet("Sheet1");
    sheet.addRow(["store", "product", "sku", "stock_qty"]).commit();
    for (let i = 0; i < MAX_ROWS + 1; i++) {
      sheet.addRow(["Main Store", `Product ${i}`, `SKU-${i}`, 1]).commit();
    }
    sheet.commit();
    await writer.commit();

    await expect(parseInventoryFile(p, NOW)).rejects.toThrow(/rows.*limit|limit.*rows/);
  });

  it("XLSX — rejects a cell value longer than the limit", async () => {
    const p = join(dir, "long-cell.xlsx");
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: p });
    const sheet = writer.addWorksheet("Sheet1");
    sheet.addRow(["store", "product", "sku", "stock_qty"]).commit();
    sheet.addRow(["Main Store", "x".repeat(MAX_CELL_LENGTH + 1), "SKU-1", 1]).commit();
    sheet.commit();
    await writer.commit();

    await expect(parseInventoryFile(p, NOW)).rejects.toThrow(/Cell value is too long/);
  });

  it("XLSX — a column that is present but has an empty cell is parsed as an explicit clear (null) just like CSV (006 DATA-005, TASKS T33)", async () => {
    // ExcelJS's eachCell({includeEmpty:false}) skips empty cells entirely — without header
    // pre-seeding this could not be told apart from "column not in file" (see the
    // parseExcelFile doc).
    const p = join(dir, "blank-optional-cell.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["store", "product", "sku", "stock_qty", "low_stock_threshold", "pack_size"]);
    sheet.addRow(["Main Store", "Cola 500ml", "SKU-COLA", 40, null, null]); // Column present but cell empty.
    await workbook.xlsx.writeFile(p);

    const result = await parseInventoryFile(p, NOW);
    expect(result.products[0]?.lowStockThreshold).toBeNull();
    expect(result.products[0]?.packSize).toBeNull();
  });
});

describe("mapRowsToDomain", () => {
  const BASE_ROW = {
    store: "Main Store",
    product: "Cola 500ml",
    sku: "SKU-COLA",
    stock_qty: "40",
  };

  it("explicitly rejects an empty file (no rows)", () => {
    expect(() => mapRowsToDomain([], NOW)).toThrow(/no data rows/);
  });

  it("collects row validation failures into a single error (no partial processing)", () => {
    const rows = [{ ...BASE_ROW, stock_qty: "40" }, { product: "missing store" }];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(/1 row error/);
  });

  it("rejects a duplicate (store, sku) within the same file", () => {
    const rows = [BASE_ROW, BASE_ROW];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(/duplicated/);
  });

  it("rejects the same sku appearing with a different product name", () => {
    const rows = [BASE_ROW, { ...BASE_ROW, store: "North Branch", product: "Cola 1.5L" }];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(
      /product name that differs from an earlier row/,
    );
  });

  it("rejects the same sku appearing with a different low_stock_threshold", () => {
    const rows = [
      { ...BASE_ROW, low_stock_threshold: "10" },
      { ...BASE_ROW, store: "North Branch", low_stock_threshold: "5" },
    ];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(
      /low_stock_threshold that differs from an earlier row/,
    );
  });

  it("reflects a consistent low_stock_threshold in products", () => {
    const rows = [
      { ...BASE_ROW, low_stock_threshold: "10" },
      { ...BASE_ROW, store: "North Branch", low_stock_threshold: "10" },
    ];
    const result = mapRowsToDomain(rows, NOW);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.lowStockThreshold).toBe("10");
  });

  it("rejects the same sku appearing with a different pack_size (SPEC §14)", () => {
    const rows = [
      { ...BASE_ROW, pack_size: "24" },
      { ...BASE_ROW, store: "North Branch", pack_size: "12" },
    ];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(/pack_size that differs from an earlier row/);
  });

  it("reflects pack_size in products when consistent (or when omitted in both)", () => {
    const withPackSize = mapRowsToDomain(
      [
        { ...BASE_ROW, pack_size: "24" },
        { ...BASE_ROW, store: "North Branch", pack_size: "24" },
      ],
      NOW,
    );
    expect(withPackSize.products[0]?.packSize).toBe("24");

    // BASE_ROW has no pack_size column at all — that is "no information" (undefined), not
    // "cleared" (null) (006 DATA-005, TASKS T33). For the column-present-but-cell-empty case
    // see the describe below.
    const withoutPackSize = mapRowsToDomain([BASE_ROW], NOW);
    expect(withoutPackSize.products[0]?.packSize).toBeUndefined();
  });

  it("does not put rows without sales history into salesPeriodAgg (threshold fallback candidates)", () => {
    const result = mapRowsToDomain([BASE_ROW], NOW);
    expect(result.salesPeriodAgg).toEqual([]);
    expect(result.inventory).toEqual([
      { storeId: "Main Store", variantId: "SKU-COLA", inStock: "40", updatedAt: NOW },
    ]);
  });

  it("uses the caller-provided now as inventory updatedAt (Clock injection)", () => {
    const customNow = new Date("2020-01-01T00:00:00Z");
    const result = mapRowsToDomain([BASE_ROW], customNow);
    expect(result.inventory[0]?.updatedAt).toBe(customNow);
  });
});

describe("mapRowsToDomain — nullable field clear contract (006 DATA-005, TASKS T33)", () => {
  const BASE_ROW = {
    store: "Main Store",
    product: "Cola 500ml",
    sku: "SKU-COLA",
    stock_qty: "40",
  };

  it("is undefined when the column itself is absent (no information — backward compatible, existing value kept)", () => {
    const result = mapRowsToDomain([BASE_ROW], NOW);
    expect(result.products[0]?.lowStockThreshold).toBeUndefined();
    expect(result.products[0]?.packSize).toBeUndefined();
  });

  it("is null when the column is present but the cell is empty (explicitly cleared)", () => {
    const result = mapRowsToDomain([{ ...BASE_ROW, low_stock_threshold: "", pack_size: "" }], NOW);
    expect(result.products[0]?.lowStockThreshold).toBeNull();
    expect(result.products[0]?.packSize).toBeNull();
  });

  it("is the value when the column is present and has a value", () => {
    const result = mapRowsToDomain(
      [{ ...BASE_ROW, low_stock_threshold: "10", pack_size: "24" }],
      NOW,
    );
    expect(result.products[0]?.lowStockThreshold).toBe("10");
    expect(result.products[0]?.packSize).toBe("24");
  });

  it("rejects as a mismatch when one of two rows for the same sku has the column absent (undefined) and the other has a value", () => {
    const rows = [
      { ...BASE_ROW, low_stock_threshold: "10" },
      { ...BASE_ROW, store: "North Branch" }, // Column absent — undefined
    ];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(/column absent/);
  });

  it("rejects as a mismatch when one of two rows for the same sku is explicitly cleared (null) and the other has a value", () => {
    const rows = [
      { ...BASE_ROW, low_stock_threshold: "10" },
      { ...BASE_ROW, store: "North Branch", low_stock_threshold: "" },
    ];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(/empty \(explicitly cleared\)/);
  });
});
