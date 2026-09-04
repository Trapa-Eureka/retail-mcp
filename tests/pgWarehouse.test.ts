import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import type {
  InventoryRow,
  PurchaseReceiptRow,
  SalesLineRow,
  SalesPeriodAggRow,
  StoreRow,
  Warehouse,
} from "../src/core/types.js";

const STORE_MAIN: StoreRow = { id: "store_main", name: "Main Store" };
const STORE_MAKATI: StoreRow = { id: "store_makati", name: "South Branch" };
const PRODUCT_COLA = {
  variantId: "var_cola",
  itemId: "itm_cola",
  name: "Cola 500ml",
  sku: "SKU-COLA",
  category: "Beverages",
};
const PRODUCT_CHIPS = {
  variantId: "var_chips",
  itemId: "itm_chips",
  name: "Piattos",
  sku: "SKU-CHIPS",
  category: "Snacks",
};

describe("pgWarehouse (PGlite)", () => {
  let db: PGlite;
  let warehouse: Warehouse;

  beforeEach(async () => {
    db = await createTestWarehouse();
    warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    await warehouse.upsertStores([STORE_MAIN, STORE_MAKATI]);
    await warehouse.upsertProducts([PRODUCT_COLA, PRODUCT_CHIPS]);
  });

  describe("upsert idempotency", () => {
    it("calling upsertStores twice with the same id updates and does not add rows", async () => {
      await warehouse.upsertStores([{ id: "store_main", name: "Main Store (renamed)" }]);

      const { rows } = await db.query<{ count: string; name: string }>(
        "select count(*)::text as count, max(name) as name from stores where id = 'store_main'",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.name).toBe("Main Store (renamed)");
    });

    it("can store and update packSize (pack size, SPEC §14) via upsertProducts", async () => {
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: "24" }]);
      const { rows } = await db.query<{ pack_size: string | null }>(
        "select pack_size from products where variant_id = 'var_cola'",
      );
      expect(rows[0]?.pack_size).toBe("24");

      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: "12" }]);
      const after = await db.query<{ pack_size: string | null }>(
        "select pack_size from products where variant_id = 'var_cola'",
      );
      expect(after.rows[0]?.pack_size).toBe("12");
    });

    it("an upsert without packSize (undefined) does not clear the already stored value (coalesce)", async () => {
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: "24" }]);
      // The value must survive even if another channel (e.g. Loyverse sync) upserts again without packSize.
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, name: "Cola 500ml (updated)" }]);

      const { rows } = await db.query<{ pack_size: string | null; name: string }>(
        "select pack_size, name from products where variant_id = 'var_cola'",
      );
      expect(rows[0]?.pack_size).toBe("24");
      expect(rows[0]?.name).toBe("Cola 500ml (updated)");
    });
  });

  describe("upsertProducts — explicit clear of nullable fields (006 DATA-005, TASKS T33)", () => {
    it("an upsert with packSize null clears the already stored value (unlike undefined)", async () => {
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: "24" }]);
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: null }]);

      const { rows } = await db.query<{ pack_size: string | null }>(
        "select pack_size from products where variant_id = 'var_cola'",
      );
      expect(rows[0]?.pack_size).toBeNull();
    });

    it("an upsert with lowStockThreshold null clears the already stored value", async () => {
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, lowStockThreshold: "10" }]);
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, lowStockThreshold: null }]);

      const { rows } = await db.query<{ low_stock_threshold: string | null }>(
        "select low_stock_threshold from products where variant_id = 'var_cola'",
      );
      expect(rows[0]?.low_stock_threshold).toBeNull();
    });

    it("even when a SKU clears packSize (null) in a batch, other fields this upsert does not touch (threshold) stay as they are", async () => {
      await warehouse.upsertProducts([
        { ...PRODUCT_COLA, lowStockThreshold: "10", packSize: "24" },
      ]);
      // This upsert batch only carries information about packSize (null=clear) — threshold is
      // undefined, so it is left alone.
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: null }]);

      const { rows } = await db.query<{
        pack_size: string | null;
        low_stock_threshold: string | null;
      }>("select pack_size, low_stock_threshold from products where variant_id = 'var_cola'");
      expect(rows[0]?.pack_size).toBeNull();
      expect(rows[0]?.low_stock_threshold).toBe("10");
    });

    it("multiple rows in a batch handling different SKUs are each applied precisely (the batch decision is per field, not per row)", async () => {
      await warehouse.upsertProducts([
        { ...PRODUCT_COLA, packSize: "24" },
        { ...PRODUCT_CHIPS, packSize: "12" },
      ]);
      // In the same batch COLA clears the value and CHIPS gives a new one — the batch decision
      // ("is there at least one row with any information about this field") is true, so both
      // rows must be overwritten with excluded.pack_size (whether null or a value).
      await warehouse.upsertProducts([
        { ...PRODUCT_COLA, packSize: null },
        { ...PRODUCT_CHIPS, packSize: "6" },
      ]);

      const { rows } = await db.query<{ variant_id: string; pack_size: string | null }>(
        "select variant_id, pack_size from products order by variant_id",
      );
      const byId = Object.fromEntries(rows.map((r) => [r.variant_id, r.pack_size]));
      expect(byId["var_cola"]).toBeNull();
      expect(byId["var_chips"]).toBe("6");
    });

    it("calling upsertSalesLines twice with the same PK updates and does not add rows", async () => {
      const line: SalesLineRow = {
        receiptId: "R-1",
        lineNo: 1,
        storeId: "store_main",
        variantId: "var_cola",
        qty: "10",
        gross: "450",
        discount: "0",
        soldAt: new Date("2026-08-01T09:00:00Z"),
      };
      await warehouse.upsertSalesLines([line]);
      await warehouse.upsertSalesLines([{ ...line, qty: "99" }]);

      const { rows } = await db.query<{ count: string; qty: string }>(
        "select count(*)::text as count, max(qty) as qty from sales_lines where receipt_id = 'R-1' and line_no = 1",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.qty).toBe("99");
    });

    it("calling upsertInventory twice with the same (store,variant) updates and does not add rows", async () => {
      const row: InventoryRow = {
        storeId: "store_main",
        variantId: "var_cola",
        inStock: "40",
        updatedAt: new Date("2026-09-01T00:00:00Z"),
      };
      await warehouse.upsertInventory([row]);
      await warehouse.upsertInventory([{ ...row, inStock: "5" }]);

      const { rows } = await db.query<{ count: string; in_stock: string }>(
        "select count(*)::text as count, max(in_stock) as in_stock from inventory_levels where store_id = 'store_main' and variant_id = 'var_cola'",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.in_stock).toBe("5");
    });

    it("calling appendInventorySnapshot twice with the same (run_id,store,variant) updates and does not add rows", async () => {
      const row: InventoryRow = {
        storeId: "store_main",
        variantId: "var_cola",
        inStock: "40",
        updatedAt: new Date("2026-09-01T00:00:00Z"),
      };
      const at = new Date("2026-09-01T00:00:00Z");
      await warehouse.appendInventorySnapshot("run1", at, [row]);
      await warehouse.appendInventorySnapshot("run1", at, [{ ...row, inStock: "7" }]);

      const { rows } = await db.query<{ count: string; in_stock: string }>(
        "select count(*)::text as count, max(in_stock) as in_stock from inventory_snapshots where run_id = 'run1'",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.in_stock).toBe("7");
    });

    it("appendInventorySnapshot rejects references to a non-existent store/product (FK)", async () => {
      await expect(
        warehouse.appendInventorySnapshot("run1", new Date(), [
          {
            storeId: "no_such_store",
            variantId: "no_such_variant",
            inStock: "1",
            updatedAt: new Date(),
          },
        ]),
      ).rejects.toThrow();
    });

    it("calling upsertSalesPeriodAgg twice with the same (store,variant) updates and does not add rows", async () => {
      const row: SalesPeriodAggRow = {
        storeId: "store_main",
        variantId: "var_cola",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
        soldQty: "60",
      };
      await warehouse.upsertSalesPeriodAgg([row]);
      await warehouse.upsertSalesPeriodAgg([{ ...row, soldQty: "99" }]);

      const { rows } = await db.query<{ count: string; sold_qty: string }>(
        "select count(*)::text as count, max(sold_qty) as sold_qty from sales_period_agg where store_id = 'store_main' and variant_id = 'var_cola'",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.sold_qty).toBe("99");
    });

    it("calling upsertPurchaseReceipts twice with the same (store,variant,received_at) updates and does not add rows", async () => {
      const row: PurchaseReceiptRow = {
        storeId: "store_main",
        variantId: "var_cola",
        receivedAt: new Date("2026-07-01"),
        receivedQty: "30",
        unitCost: "12000",
        currency: "KRW",
        vendor: "Smart Distribution",
      };
      await warehouse.upsertPurchaseReceipts([row]);
      await warehouse.upsertPurchaseReceipts([{ ...row, receivedQty: "99" }]);

      const { rows } = await db.query<{ count: string; received_qty: string }>(
        "select count(*)::text as count, max(received_qty) as received_qty from purchase_receipts where store_id = 'store_main' and variant_id = 'var_cola'",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.received_qty).toBe("99");
    });

    it("upsertPurchaseReceipts rejects references to a non-existent store/product (FK)", async () => {
      await expect(
        warehouse.upsertPurchaseReceipts([
          {
            storeId: "no_such_store",
            variantId: "no_such_variant",
            receivedAt: new Date("2026-07-01"),
            receivedQty: "1",
          },
        ]),
      ).rejects.toThrow();
    });

    it("rejects via DB constraint when only unit_cost is present without currency (or vice versa)", async () => {
      await expect(
        warehouse.upsertPurchaseReceipts([
          {
            storeId: "store_main",
            variantId: "var_cola",
            receivedAt: new Date("2026-07-01"),
            receivedQty: "1",
            unitCost: "12000",
            currency: null,
          },
        ]),
      ).rejects.toThrow();
    });
  });

  describe("purchase_receipts / queryPurchaseAgg (SCM sheet integration, SPEC §13)", () => {
    beforeEach(async () => {
      const rows: PurchaseReceiptRow[] = [
        {
          storeId: "store_main",
          variantId: "var_cola",
          receivedAt: new Date("2026-08-05"),
          receivedQty: "30",
          unitCost: "12000",
          currency: "KRW",
          vendor: "Smart Distribution",
        },
        {
          storeId: "store_main",
          variantId: "var_cola",
          receivedAt: new Date("2026-08-20"),
          receivedQty: "10",
        },
        {
          storeId: "store_makati",
          variantId: "var_cola",
          receivedAt: new Date("2026-08-05"),
          receivedQty: "5",
        },
      ];
      await warehouse.upsertPurchaseReceipts(rows);
    });

    it("returns the received quantity within the period and store summed in a shape symmetric with querySalesAgg", async () => {
      const result = await warehouse.queryPurchaseAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
      });
      expect(result).toEqual([
        { storeId: "store_main", variantId: "var_cola", receivedQtyRaw: "40" }, // 30+10
      ]);
    });

    it("applies the store filter", async () => {
      const result = await warehouse.queryPurchaseAgg({
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
        storeId: "store_makati",
      });
      expect(result).toEqual([
        { storeId: "store_makati", variantId: "var_cola", receivedQtyRaw: "5" },
      ]);
    });

    it("excludes receipts outside the queried period", async () => {
      const result = await warehouse.queryPurchaseAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-10T00:00:00Z"), // the 08-20 receipt is out of range
      });
      expect(result).toEqual([
        { storeId: "store_main", variantId: "var_cola", receivedQtyRaw: "30" },
      ]);
    });
  });

  describe("sales_period_agg (CSV/Excel period totals, TASKS T12)", () => {
    beforeEach(async () => {
      // Period totals uploaded by the CSV scan as one period per store (2026-08-01 ~ 2026-08-29).
      const rows: SalesPeriodAggRow[] = [
        {
          storeId: "store_main",
          variantId: "var_cola",
          periodStart: new Date("2026-08-01T00:00:00Z"),
          periodEnd: new Date("2026-08-29T00:00:00Z"),
          soldQty: "56",
        },
        {
          storeId: "store_main",
          variantId: "var_chips",
          periodStart: new Date("2026-08-01T00:00:00Z"),
          periodEnd: new Date("2026-08-29T00:00:00Z"),
          soldQty: "12",
        },
        {
          storeId: "store_makati",
          variantId: "var_cola",
          periodStart: new Date("2026-08-01T00:00:00Z"),
          periodEnd: new Date("2026-08-29T00:00:00Z"),
          soldQty: "8",
        },
      ];
      await warehouse.upsertSalesPeriodAgg(rows);
    });

    it("returns the same SalesAgg shape as querySalesAgg (core/metrics.ts can consume it as-is)", async () => {
      const result = await warehouse.querySalesPeriodAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
      });
      const cola = result.find((r) => r.variantId === "var_cola");
      expect(cola).toEqual({
        storeId: "store_main",
        variantId: "var_cola",
        name: "Cola 500ml",
        category: "Beverages",
        soldQtyRaw: "56",
      });
    });

    it("applies the store filter", async () => {
      const result = await warehouse.querySalesPeriodAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
      });
      expect(result.every((r) => r.storeId === "store_main")).toBe(true);
      expect(result.some((r) => r.variantId === "var_cola" && r.storeId === "store_makati")).toBe(
        false,
      );
    });

    it("excludes rows whose stored period does not overlap the queried period at all", async () => {
      const result = await warehouse.querySalesPeriodAgg({
        storeId: "store_main",
        periodStart: new Date("2026-01-01T00:00:00Z"),
        periodEnd: new Date("2026-02-01T00:00:00Z"),
      });
      expect(result).toHaveLength(0);
    });
  });

  describe("fixed aggregate queries — golden values", () => {
    beforeEach(async () => {
      const lines: SalesLineRow[] = [
        // store_main / var_cola: within the period 10 + 20 + 30 = 60
        {
          receiptId: "R-1",
          lineNo: 1,
          storeId: "store_main",
          variantId: "var_cola",
          qty: "10",
          gross: "450",
          discount: "0",
          soldAt: new Date("2026-08-01T09:00:00Z"),
        },
        {
          receiptId: "R-2",
          lineNo: 1,
          storeId: "store_main",
          variantId: "var_cola",
          qty: "20",
          gross: "900",
          discount: "0",
          soldAt: new Date("2026-08-10T09:00:00Z"),
        },
        {
          receiptId: "R-3",
          lineNo: 1,
          storeId: "store_main",
          variantId: "var_cola",
          qty: "30",
          gross: "1350",
          discount: "0",
          soldAt: new Date("2026-08-20T09:00:00Z"),
        },
        // Outside the period — must be excluded from the aggregate
        {
          receiptId: "R-4",
          lineNo: 1,
          storeId: "store_main",
          variantId: "var_cola",
          qty: "999",
          gross: "1",
          discount: "0",
          soldAt: new Date("2026-06-01T00:00:00Z"),
        },
        // Another store — must be excluded when querying only store_main
        {
          receiptId: "R-5",
          lineNo: 1,
          storeId: "store_makati",
          variantId: "var_cola",
          qty: "5",
          gross: "225",
          discount: "0",
          soldAt: new Date("2026-08-05T09:00:00Z"),
        },
        // Includes a refund — raw net sales summed as-is (negative normalisation is core/metrics.ts's job)
        {
          receiptId: "R-6",
          lineNo: 1,
          storeId: "store_main",
          variantId: "var_chips",
          qty: "10",
          gross: "550",
          discount: "0",
          soldAt: new Date("2026-08-02T09:00:00Z"),
        },
        {
          receiptId: "R-7",
          lineNo: 1,
          storeId: "store_main",
          variantId: "var_chips",
          qty: "-2",
          gross: "-110",
          discount: "0",
          soldAt: new Date("2026-08-03T09:00:00Z"),
        },
      ];
      await warehouse.upsertSalesLines(lines);
    });

    it("querySalesAgg: matches the golden total (60) with period and store filters applied", async () => {
      const result = await warehouse.querySalesAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      });

      const cola = result.find((r) => r.variantId === "var_cola");
      expect(cola?.soldQtyRaw).toBe("60");
      expect(cola?.name).toBe("Cola 500ml");
      expect(cola?.category).toBe("Beverages");
    });

    it("querySalesAgg: raw net sales including the refund = 10 + (-2) = 8", async () => {
      const result = await warehouse.querySalesAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      });

      const chips = result.find((r) => r.variantId === "var_chips");
      expect(chips?.soldQtyRaw).toBe("8");
    });

    it("querySalesAgg: applies the category filter", async () => {
      const result = await warehouse.querySalesAgg({
        category: "Snacks",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      });
      expect(result.every((r) => r.category === "Snacks")).toBe(true);
      expect(result.some((r) => r.variantId === "var_cola")).toBe(false);
    });

    it("querySalesAgg: excludes rows outside the period (outside the half-open boundary) and other stores", async () => {
      const result = await warehouse.querySalesAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      });
      const total = result
        .filter((r) => r.variantId === "var_cola")
        .reduce((sum, r) => sum + Number(r.soldQtyRaw), 0);
      expect(total).toBe(60); // 999 (outside the period) and 5 (another store) are not included
    });
  });

  describe("queryStock", () => {
    beforeEach(async () => {
      await warehouse.upsertInventory([
        {
          storeId: "store_main",
          variantId: "var_cola",
          inStock: "42",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
        {
          storeId: "store_main",
          variantId: "var_chips",
          inStock: "0",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
        {
          storeId: "store_makati",
          variantId: "var_cola",
          inStock: "10",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
      ]);
    });

    it("filters by storeId", async () => {
      const result = await warehouse.queryStock({ storeId: "store_main" });
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.storeId === "store_main")).toBe(true);
      const cola = result.find((r) => r.variantId === "var_cola");
      expect(cola?.inStockRaw).toBe("42");
      expect(cola?.updatedAt).toBeInstanceOf(Date);
    });

    it("filters by variantIds", async () => {
      const result = await warehouse.queryStock({ variantIds: ["var_cola"] });
      expect(result).toHaveLength(2); // var_cola of store_main + store_makati
      expect(result.every((r) => r.variantId === "var_cola")).toBe(true);
    });

    it("returns everything when called without filters", async () => {
      const result = await warehouse.queryStock({});
      expect(result).toHaveLength(3);
    });

    it("filters by category — items of another category with stock but no sales do not leak", async () => {
      // PRODUCT_COLA category="Beverages", PRODUCT_CHIPS category="Snacks" (constants at the top, above beforeEach).
      const result = await warehouse.queryStock({ storeId: "store_main", category: "Beverages" });
      expect(result).toHaveLength(1);
      expect(result[0]?.variantId).toBe("var_cola");
    });
  });

  describe("getCursor / setCursor", () => {
    it("returns null before it is set", async () => {
      expect(await warehouse.getCursor("receipts")).toBeNull();
    });

    it("reads back as-is after being set (watermark round trip)", async () => {
      await warehouse.setCursor(
        "receipts",
        "2026-08-01T00:00:00Z",
        new Date("2026-09-01T00:00:00Z"),
      );
      expect(await warehouse.getCursor("receipts")).toBe("2026-08-01T00:00:00Z");

      // Updated when set again
      await warehouse.setCursor(
        "receipts",
        "2026-08-15T00:00:00Z",
        new Date("2026-09-02T00:00:00Z"),
      );
      expect(await warehouse.getCursor("receipts")).toBe("2026-08-15T00:00:00Z");
    });
  });

  describe("getSyncState (for the T9 sync_status tool)", () => {
    it("returns an empty array before anything is set", async () => {
      expect(await warehouse.getSyncState()).toEqual([]);
    });

    it("returns cursor+last_synced_at per resource in ascending resource order", async () => {
      await warehouse.setCursor("inventory", "wm-inv", new Date("2026-09-01T06:00:00Z"));
      await warehouse.setCursor(
        "receipts",
        "2026-08-30T00:00:00Z",
        new Date("2026-09-01T05:00:00Z"),
      );

      const state = await warehouse.getSyncState();
      expect(state).toEqual([
        {
          resource: "inventory",
          cursor: "wm-inv",
          lastSyncedAt: new Date("2026-09-01T06:00:00Z"),
        },
        {
          resource: "receipts",
          cursor: "2026-08-30T00:00:00Z",
          lastSyncedAt: new Date("2026-09-01T05:00:00Z"),
        },
      ]);
    });
  });

  describe("transaction — atomic commit/rollback (DESIGN §11.1)", () => {
    it("commits data + watermark together on success", async () => {
      await warehouse.transaction(async (tx) => {
        await tx.upsertInventory([
          {
            storeId: "store_main",
            variantId: "var_cola",
            inStock: "77",
            updatedAt: new Date("2026-09-01T00:00:00Z"),
          },
        ]);
        await tx.setCursor("inventory", "wm-committed", new Date("2026-09-01T00:00:00Z"));
      });

      const stock = await warehouse.queryStock({ storeId: "store_main", variantIds: ["var_cola"] });
      expect(stock[0]?.inStockRaw).toBe("77");
      expect(await warehouse.getCursor("inventory")).toBe("wm-committed");
    });

    it("rolls back both data and watermark on a failure midway", async () => {
      await expect(
        warehouse.transaction(async (tx) => {
          await tx.upsertInventory([
            {
              storeId: "store_main",
              variantId: "var_cola",
              inStock: "999",
              updatedAt: new Date("2026-09-01T00:00:00Z"),
            },
          ]);
          await tx.setCursor(
            "inventory",
            "wm-should-not-persist",
            new Date("2026-09-01T00:00:00Z"),
          );
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      // Must remain in the pre-transaction state (no inventory upsert, no cursor)
      const stock = await warehouse.queryStock({ storeId: "store_main", variantIds: ["var_cola"] });
      expect(stock).toHaveLength(0);
      expect(await warehouse.getCursor("inventory")).toBeNull();
    });

    it("can perform normal follow-up writes on the same warehouse after the rollback", async () => {
      await expect(
        warehouse.transaction(async (tx) => {
          await tx.setCursor("receipts", "wm-fail", new Date());
          throw new Error("boom");
        }),
      ).rejects.toThrow();

      await warehouse.setCursor("receipts", "wm-ok", new Date("2026-09-01T00:00:00Z"));
      expect(await warehouse.getCursor("receipts")).toBe("wm-ok");
    });
  });

  describe("logAgentSend — reservation pattern (DESIGN §11.5)", () => {
    it("reserving with sending then updating to sent updates the same row and does not add rows", async () => {
      const base = {
        runId: "run-1",
        sentAt: new Date("2026-09-01T07:00:00Z"),
        recipient: null,
        subject: null,
        suggestionCount: 3,
        messageId: null,
        dryRun: false,
        errorCode: null,
      };
      await warehouse.logAgentSend({ ...base, status: "sending" });
      await warehouse.logAgentSend({
        ...base,
        status: "sent",
        recipient: "owner@example.com",
        subject: "Reorder suggestion",
        messageId: "msg-123",
      });

      const { rows } = await db.query<{ count: string; status: string; message_id: string }>(
        "select count(*)::text as count, max(status) as status, max(message_id) as message_id from agent_send_log where run_id = 'run-1'",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.status).toBe("sent");
      expect(rows[0]?.message_id).toBe("msg-123");
    });

    it("reserving with sending then updating to unknown updates the same row and does not add rows (OPS-004, TASKS T34)", async () => {
      const base = {
        runId: "run-unknown",
        sentAt: new Date("2026-09-01T07:00:00Z"),
        recipient: "owner@example.com",
        subject: "Low stock alert",
        suggestionCount: 2,
        messageId: null,
        dryRun: false,
        errorCode: null,
      };
      await warehouse.logAgentSend({ ...base, status: "sending" });
      await warehouse.logAgentSend({ ...base, status: "unknown", errorCode: "AmbiguousSendError" });

      const { rows } = await db.query<{ count: string; status: string; error_code: string }>(
        "select count(*)::text as count, max(status) as status, max(error_code) as error_code " +
          "from agent_send_log where run_id = 'run-unknown'",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.status).toBe("unknown");
      expect(rows[0]?.error_code).toBe("AmbiguousSendError");
    });

    it("the no_suggestions status is recorded even without recipient/subject", async () => {
      await warehouse.logAgentSend({
        runId: "run-2",
        sentAt: new Date("2026-09-01T07:00:00Z"),
        status: "no_suggestions",
        recipient: null,
        subject: null,
        suggestionCount: 0,
        messageId: null,
        dryRun: true,
        errorCode: null,
      });

      const { rows } = await db.query<{ status: string }>(
        "select status from agent_send_log where run_id = 'run-2'",
      );
      expect(rows[0]?.status).toBe("no_suggestions");
    });

    it("reserving sending again for an already sent run_id fails (double-send prevention)", async () => {
      const base = {
        runId: "run-3",
        sentAt: new Date("2026-09-01T07:00:00Z"),
        recipient: "owner@example.com",
        subject: "Reorder suggestion",
        suggestionCount: 2,
        messageId: null,
        dryRun: false,
        errorCode: null,
      };
      await warehouse.logAgentSend({ ...base, status: "sending" });
      await warehouse.logAgentSend({ ...base, status: "sent", messageId: "msg-1" });

      // A resend attempt with the same run_id (e.g. a retry script mistake) must be rejected because
      // the reservation (INSERT) violates the partial unique index — an already sent row must not be reverted to sending.
      await expect(warehouse.logAgentSend({ ...base, status: "sending" })).rejects.toThrow(
        /already sending or has already been sent/,
      );

      const { rows } = await db.query<{ status: string; message_id: string }>(
        "select status, message_id from agent_send_log where run_id = 'run-3'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("sent");
      expect(rows[0]?.message_id).toBe("msg-1");
    });

    it("updating to sent/failed without a sending reservation throws an error carrying the cause", async () => {
      await expect(
        warehouse.logAgentSend({
          runId: "run-4",
          sentAt: new Date("2026-09-01T07:00:00Z"),
          status: "sent",
          recipient: "owner@example.com",
          subject: "Reorder suggestion",
          suggestionCount: 1,
          messageId: "msg-x",
          dryRun: false,
          errorCode: null,
        }),
      ).rejects.toThrow(/No sending reservation row/);
    });

    it("after failed, a new sending reservation is possible again with the same run_id (retry)", async () => {
      const base = {
        runId: "run-5",
        sentAt: new Date("2026-09-01T07:00:00Z"),
        recipient: "owner@example.com",
        subject: "Reorder suggestion",
        suggestionCount: 1,
        messageId: null,
        dryRun: false,
      };
      await warehouse.logAgentSend({ ...base, status: "sending", errorCode: null });
      await warehouse.logAgentSend({ ...base, status: "failed", errorCode: "SendError" });

      await expect(
        warehouse.logAgentSend({ ...base, status: "sending", errorCode: null }),
      ).resolves.toBeUndefined();

      const { rows } = await db.query<{ count: string }>(
        "select count(*)::text as count from agent_send_log where run_id = 'run-5' and status = 'sending'",
      );
      expect(rows[0]?.count).toBe("1");
    });
  });

  describe("listAgentSendAttempts / markStaleSendingUnknown — input for the same-run_id retry policy (SR2-MAIL-003)", () => {
    const base = {
      runId: "run-attempts",
      recipient: "owner@example.com",
      subject: "s",
      suggestionCount: 1,
      messageId: null,
      dryRun: false,
      errorCode: null,
    };

    it("listAgentSendAttempts returns only that run_id's rows in record order and gives sent_at as a Date", async () => {
      await warehouse.logAgentSend({
        ...base,
        sentAt: new Date("2026-09-01T07:00:00Z"),
        status: "sending",
      });
      await warehouse.logAgentSend({
        ...base,
        sentAt: new Date("2026-09-01T07:00:30Z"),
        status: "unknown",
        errorCode: "AmbiguousSendError",
      });
      await warehouse.logAgentSend({
        ...base,
        runId: "run-other",
        sentAt: new Date("2026-09-01T08:00:00Z"),
        status: "dry_run",
      });

      const attempts = await warehouse.listAgentSendAttempts("run-attempts");
      expect(attempts).toHaveLength(1); // one row, because the sending reservation row was updated to unknown
      expect(attempts[0]).toMatchObject({
        runId: "run-attempts",
        status: "unknown",
        errorCode: "AmbiguousSendError",
        recipient: "owner@example.com",
        suggestionCount: 1,
        dryRun: false,
      });
      expect(attempts[0]?.sentAt).toBeInstanceOf(Date);
      expect(attempts[0]?.sentAt.toISOString()).toBe("2026-09-01T07:00:30.000Z");
      expect(await warehouse.listAgentSendAttempts("run-none")).toEqual([]);
    });

    it("markStaleSendingUnknown changes only sending rows to unknown (stale_sending) and keeps sent_at", async () => {
      await warehouse.logAgentSend({
        ...base,
        runId: "run-stale",
        sentAt: new Date("2026-09-01T07:00:00Z"),
        status: "sending",
      });
      await warehouse.logAgentSend({
        ...base,
        runId: "run-stale",
        sentAt: new Date("2026-09-01T06:00:00Z"),
        status: "dry_run",
      });

      expect(await warehouse.markStaleSendingUnknown("run-stale")).toBe(1);
      expect(await warehouse.markStaleSendingUnknown("run-stale")).toBe(0); // nothing to target the second time

      const attempts = await warehouse.listAgentSendAttempts("run-stale");
      expect(attempts.map((a) => [a.status, a.errorCode, a.sentAt.toISOString()])).toEqual([
        ["unknown", "stale_sending", "2026-09-01T07:00:00.000Z"],
        ["dry_run", null, "2026-09-01T06:00:00.000Z"],
      ]);

      // After closing, a new sending reservation is possible with the same run_id (no longer covered by the partial unique index).
      await warehouse.logAgentSend({
        ...base,
        runId: "run-stale",
        sentAt: new Date("2026-09-01T08:00:00Z"),
        status: "sending",
      });
      expect((await warehouse.listAgentSendAttempts("run-stale")).map((a) => a.status)).toEqual([
        "unknown",
        "dry_run",
        "sending",
      ]);
    });
  });

  describe("deleteOldInventorySnapshots / deleteOldAgentSendLog — retention policy (007 OPS-005, TASKS T34)", () => {
    it("agent_send_log — deletes only rows older than before and keeps recent rows", async () => {
      await warehouse.logAgentSend({
        runId: "run-old",
        sentAt: new Date("2026-01-01T00:00:00Z"),
        status: "no_suggestions",
        recipient: null,
        subject: null,
        suggestionCount: 0,
        messageId: null,
        dryRun: true,
        errorCode: null,
      });
      await warehouse.logAgentSend({
        runId: "run-recent",
        sentAt: new Date("2026-09-01T00:00:00Z"),
        status: "no_suggestions",
        recipient: null,
        subject: null,
        suggestionCount: 0,
        messageId: null,
        dryRun: true,
        errorCode: null,
      });

      const deleted = await warehouse.deleteOldAgentSendLog(new Date("2026-06-01T00:00:00Z"));
      expect(deleted).toBe(1);

      const { rows } = await db.query<{ run_id: string }>("select run_id from agent_send_log");
      expect(rows.map((r) => r.run_id)).toEqual(["run-recent"]);
    });

    it("agent_send_log — with dryRun deletes nothing and only counts the target rows", async () => {
      await warehouse.logAgentSend({
        runId: "run-old",
        sentAt: new Date("2026-01-01T00:00:00Z"),
        status: "no_suggestions",
        recipient: null,
        subject: null,
        suggestionCount: 0,
        messageId: null,
        dryRun: true,
        errorCode: null,
      });

      const count = await warehouse.deleteOldAgentSendLog(new Date("2026-06-01T00:00:00Z"), {
        dryRun: true,
      });
      expect(count).toBe(1);

      const { rows } = await db.query<{ count: string }>(
        "select count(*)::text as count from agent_send_log",
      );
      expect(rows[0]?.count).toBe("1"); // Still there — not deleted.
    });

    it("inventory_snapshots — deletes only rows older than before and keeps recent rows", async () => {
      await warehouse.appendInventorySnapshot("run-old", new Date("2026-01-01T00:00:00Z"), [
        { storeId: "store_main", variantId: "var_cola", inStock: "10", updatedAt: new Date() },
      ]);
      await warehouse.appendInventorySnapshot("run-recent", new Date("2026-09-01T00:00:00Z"), [
        { storeId: "store_main", variantId: "var_cola", inStock: "8", updatedAt: new Date() },
      ]);

      const deleted = await warehouse.deleteOldInventorySnapshots(new Date("2026-06-01T00:00:00Z"));
      expect(deleted).toBe(1);

      const { rows } = await db.query<{ run_id: string }>("select run_id from inventory_snapshots");
      expect(rows.map((r) => r.run_id)).toEqual(["run-recent"]);
    });

    it("inventory_snapshots — with dryRun deletes nothing and only counts the target rows", async () => {
      await warehouse.appendInventorySnapshot("run-old", new Date("2026-01-01T00:00:00Z"), [
        { storeId: "store_main", variantId: "var_cola", inStock: "10", updatedAt: new Date() },
      ]);

      const count = await warehouse.deleteOldInventorySnapshots(new Date("2026-06-01T00:00:00Z"), {
        dryRun: true,
      });
      expect(count).toBe(1);

      const { rows } = await db.query<{ count: string }>(
        "select count(*)::text as count from inventory_snapshots",
      );
      expect(rows[0]?.count).toBe("1");
    });
  });

  describe("queryStores", () => {
    it("returns all stores in id order when called without a filter", async () => {
      const stores = await warehouse.queryStores();
      expect(stores).toEqual([
        { id: "store_main", name: "Main Store" },
        { id: "store_makati", name: "South Branch" },
      ]);
    });

    it("returns only that store when storeId is given", async () => {
      expect(await warehouse.queryStores("store_makati")).toEqual([
        { id: "store_makati", name: "South Branch" },
      ]);
    });

    it("returns an empty array for a non-existent storeId", async () => {
      expect(await warehouse.queryStores("store_nope")).toEqual([]);
    });
  });

  describe("queryProducts (SPEC §14/TASKS T25 — reads all ProductRow fields including packSize)", () => {
    beforeEach(async () => {
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: "24" }]);
    });

    it("returns all products in variant_id order when variantIds is omitted", async () => {
      const products = await warehouse.queryProducts();
      expect(products.map((p) => p.variantId)).toEqual(["var_chips", "var_cola"]);
      const cola = products.find((p) => p.variantId === "var_cola");
      expect(cola).toMatchObject({ name: "Cola 500ml", sku: "SKU-COLA", packSize: "24" });
    });

    it("returns only those products when variantIds is given (null for products without packSize)", async () => {
      const products = await warehouse.queryProducts(["var_chips"]);
      expect(products).toEqual([
        {
          variantId: "var_chips",
          itemId: "itm_chips",
          name: "Piattos",
          sku: "SKU-CHIPS",
          category: "Snacks",
          lowStockThreshold: null,
          packSize: null,
        },
      ]);
    });

    it("returns an empty result for an empty array (distinct from querying everything)", async () => {
      expect(await warehouse.queryProducts([])).toEqual([]);
    });
  });

  describe("deactivateMissingCsvRows — tombstone (TASKS T31, DATA-002)", () => {
    beforeEach(async () => {
      await warehouse.upsertInventory([
        { storeId: "store_main", variantId: "var_cola", inStock: "40", updatedAt: new Date() },
        { storeId: "store_main", variantId: "var_chips", inStock: "2", updatedAt: new Date() },
        { storeId: "store_makati", variantId: "var_cola", inStock: "8", updatedAt: new Date() },
      ]);
      await warehouse.upsertSalesPeriodAgg([
        {
          storeId: "store_main",
          variantId: "var_cola",
          periodStart: new Date("2026-08-01T00:00:00Z"),
          periodEnd: new Date("2026-08-29T00:00:00Z"),
          soldQty: "56",
        },
        {
          storeId: "store_main",
          variantId: "var_chips",
          periodStart: new Date("2026-08-01T00:00:00Z"),
          periodEnd: new Date("2026-08-29T00:00:00Z"),
          soldQty: "5",
        },
      ]);
    });

    it("(store,SKU) pairs absent from this scan are deactivated and drop out of the default queryStock/querySalesPeriodAgg results", async () => {
      // Assume a store_main scan where var_chips is no longer in this file.
      await warehouse.deactivateMissingCsvRows({
        storeIds: ["store_main"],
        presentInventory: [{ storeId: "store_main", variantId: "var_cola" }],
        presentSales: [{ storeId: "store_main", variantId: "var_cola" }],
      });

      const stock = await warehouse.queryStock({ storeId: "store_main" });
      expect(stock.map((s) => s.variantId).sort()).toEqual(["var_cola"]);

      const sales = await warehouse.querySalesPeriodAgg({
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
      });
      expect(sales.map((s) => s.variantId)).toEqual(["var_cola"]);
    });

    it("not a physical delete — deactivated rows remain in the DB as they are", async () => {
      await warehouse.deactivateMissingCsvRows({
        storeIds: ["store_main"],
        presentInventory: [{ storeId: "store_main", variantId: "var_cola" }],
        presentSales: [],
      });

      const { rows } = await db.query<{ count: string }>(
        "select count(*)::text as count from inventory_levels where store_id = 'store_main' and variant_id = 'var_chips'",
      );
      expect(rows[0]?.count).toBe("1");
    });

    it("the normal upsert path automatically reactivates when it reappears in the file", async () => {
      await warehouse.deactivateMissingCsvRows({
        storeIds: ["store_main"],
        presentInventory: [{ storeId: "store_main", variantId: "var_cola" }],
        presentSales: [],
      });
      expect(await warehouse.queryStock({ storeId: "store_main" })).toHaveLength(1);

      await warehouse.upsertInventory([
        { storeId: "store_main", variantId: "var_chips", inStock: "3", updatedAt: new Date() },
      ]);

      const stock = await warehouse.queryStock({ storeId: "store_main" });
      expect(stock.map((s) => s.variantId).sort()).toEqual(["var_chips", "var_cola"]);
    });

    it("does not touch other stores' data outside the storeIds range (per-branch independence in HQ consolidated mode)", async () => {
      await warehouse.deactivateMissingCsvRows({
        storeIds: ["store_main"],
        presentInventory: [], // Assume the extreme case that store_main has nothing at all
        presentSales: [],
      });

      // store_makati's var_cola is outside the storeIds range, so it must stay active.
      const makatiStock = await warehouse.queryStock({ storeId: "store_makati" });
      expect(makatiStock.map((s) => s.variantId)).toEqual(["var_cola"]);
    });

    it("when presentSales is empty, all of that store's existing sales_period_agg rows are deactivated (this scan authoritatively reports no sales history)", async () => {
      await warehouse.deactivateMissingCsvRows({
        storeIds: ["store_main"],
        presentInventory: [
          { storeId: "store_main", variantId: "var_cola" },
          { storeId: "store_main", variantId: "var_chips" },
        ],
        presentSales: [],
      });

      const sales = await warehouse.querySalesPeriodAgg({
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
      });
      expect(sales).toEqual([]);
      // inventory is still active (stock was in this scan) — distinguished from only sales disappearing.
      expect(await warehouse.queryStock({ storeId: "store_main" })).toHaveLength(2);
    });

    it("touches nothing when storeIds is an empty array", async () => {
      await warehouse.deactivateMissingCsvRows({
        storeIds: [],
        presentInventory: [],
        presentSales: [],
      });
      const stock = await warehouse.queryStock({ storeId: "store_main" });
      expect(stock.map((s) => s.variantId).sort()).toEqual(["var_chips", "var_cola"]);
    });
  });

  describe("read-only role separation", () => {
    beforeEach(async () => {
      await db.exec("create role app_readonly");
      await db.exec(
        "grant select on stores, products, sales_lines, inventory_levels, inventory_snapshots, sync_state, agent_send_log to app_readonly",
      );
    });

    it("the 5 query tools succeed with the read-only role (all T9 MCP query tools)", async () => {
      await db.exec("set role app_readonly");
      try {
        await expect(warehouse.queryStock({})).resolves.toBeDefined();
        await expect(
          warehouse.querySalesAgg({
            periodStart: new Date("2026-01-01T00:00:00Z"),
            periodEnd: new Date("2026-12-31T00:00:00Z"),
          }),
        ).resolves.toBeDefined();
        await expect(warehouse.getCursor("receipts")).resolves.toBeNull();
        await expect(warehouse.queryStores()).resolves.toBeDefined();
        await expect(warehouse.getSyncState()).resolves.toBeDefined();
      } finally {
        await db.exec("reset role");
      }
    });

    it("writes fail with the read-only role", async () => {
      await db.exec("set role app_readonly");
      try {
        await expect(
          warehouse.upsertStores([{ id: "store_new", name: "New Store" }]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          warehouse.setCursor("receipts", "wm", new Date("2026-09-01T00:00:00Z")),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec("reset role");
      }
    });

    it("explore_sql (TASKS T27) also works normally with the read-only role", async () => {
      const { createExploreSqlExecutor } = await import("../src/adapters/exploreSqlExecutor.js");
      const executor = createExploreSqlExecutor(createPgliteConnectionProvider(db));
      await db.exec("set role app_readonly");
      try {
        await expect(executor.execute("select * from stores")).resolves.toMatchObject({
          rowCount: 2,
        });
      } finally {
        await db.exec("reset role");
      }
    });
  });
});
