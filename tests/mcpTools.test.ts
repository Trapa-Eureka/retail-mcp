import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import { buildReorderReport } from "../src/agent/reorder.js";
import {
  exploreSqlTool,
  inventoryStatusTool,
  reorderSuggestionsTool,
  sellThroughTool,
  stockoutRiskTool,
  syncNowTool,
  syncStatusTool,
  type QueryToolDeps,
} from "../src/mcp/tools.js";
import { AdvisoryLockBusyError } from "../src/adapters/advisoryLock.js";
import { createExploreSqlExecutor } from "../src/adapters/exploreSqlExecutor.js";
import type { LoyverseClient, LvStore, StoreRow, Warehouse } from "../src/core/types.js";

const STORE_MAIN: StoreRow = { id: "store_main", name: "Main Store" };
const STORE_MAKATI: StoreRow = { id: "store_makati", name: "Makati Branch" };
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

// FixedClock "now" — today's midnight in Asia/Manila (UTC+8) = 2026-08-31T16:00:00Z.
const NOW_ISO = "2026-09-01T09:00:00Z";
const BUSINESS_TIMEZONE = "Asia/Manila";

describe("MCP tools (src/mcp/tools.ts)", () => {
  let db: PGlite;
  let warehouse: Warehouse;
  let deps: QueryToolDeps;

  beforeEach(async () => {
    db = await createTestWarehouse();
    warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    await warehouse.upsertStores([STORE_MAIN, STORE_MAKATI]);
    await warehouse.upsertProducts([PRODUCT_COLA, PRODUCT_CHIPS]);
    deps = { warehouse, clock: createFixedClock(NOW_ISO), businessTimezone: BUSINESS_TIMEZONE };
  });

  describe("sell_through", () => {
    it("matches the golden case values and includes the approximate-formula note (60 sold in 30 days, ending stock 40 → 0.60)", async () => {
      await warehouse.upsertSalesLines([
        {
          receiptId: "R-1",
          lineNo: 0,
          storeId: "store_main",
          variantId: "var_cola",
          qty: "60",
          gross: "2700",
          discount: "0",
          soldAt: new Date("2026-08-15T09:00:00Z"),
        },
      ]);
      await warehouse.upsertInventory([
        {
          storeId: "store_main",
          variantId: "var_cola",
          inStock: "40",
          updatedAt: new Date(NOW_ISO),
        },
      ]);

      const result = await sellThroughTool(deps, {
        periodDays: 30,
        order: "desc",
        top: 20,
      });

      const row = result.rows.find((r) => r.variant_id === "var_cola");
      expect(row?.sold_qty).toBe(60);
      expect(row?.end_stock).toBe(40);
      expect(row?.sell_through).toBeCloseTo(0.6, 10);
      expect(result.note).toMatch(/Approximate formula/);
      expect(result.meta.timezone).toBe(BUSINESS_TIMEZONE);
      expect(result.meta.filters["period_days"]).toBe(30);
    });

    it("the category filter does not leak stock of another category with no sales (regression)", async () => {
      // Only var_cola (Beverages) has sales/stock; var_chips (Snacks) has stock only.
      await warehouse.upsertInventory([
        {
          storeId: "store_main",
          variantId: "var_cola",
          inStock: "10",
          updatedAt: new Date(NOW_ISO),
        },
        {
          storeId: "store_main",
          variantId: "var_chips",
          inStock: "5",
          updatedAt: new Date(NOW_ISO),
        },
      ]);

      const result = await sellThroughTool(deps, {
        category: "Beverages",
        periodDays: 30,
        order: "desc",
        top: 20,
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.variant_id).toBe("var_cola");
    });

    it("throws an error carrying the cause for a non-existent store_id", async () => {
      await expect(
        sellThroughTool(deps, { storeId: "store_nope", periodDays: 30, order: "desc", top: 20 }),
      ).rejects.toThrow(/Unknown store_id/);
    });

    it("applies the store_id filter exactly", async () => {
      await warehouse.upsertInventory([
        {
          storeId: "store_main",
          variantId: "var_cola",
          inStock: "10",
          updatedAt: new Date(NOW_ISO),
        },
        {
          storeId: "store_makati",
          variantId: "var_cola",
          inStock: "20",
          updatedAt: new Date(NOW_ISO),
        },
      ]);
      const result = await sellThroughTool(deps, {
        storeId: "store_main",
        periodDays: 30,
        order: "desc",
        top: 20,
      });
      expect(result.rows.every((r) => r.store_id === "store_main")).toBe(true);
    });
  });

  describe("freshness (stale) warnings — SPEC §9, TESTING §7", () => {
    it("with no sync history at all, data_last_synced_at=null and a never-synced warning is attached", async () => {
      // beforeEach seeds only stores/products and does not touch sync_state.
      const result = await sellThroughTool(deps, { periodDays: 30, order: "desc", top: 20 });
      expect(result.meta.data_last_synced_at).toBeNull();
      expect(result.meta.warnings.some((w) => /never been synced/.test(w))).toBe(true);
    });

    it("attaches a stale warning when the last sync is older than the threshold", async () => {
      const oldSyncAt = new Date("2026-08-01T00:00:00Z"); // 31 days before NOW_ISO (9/1)
      await warehouse.setCursor("receipts", oldSyncAt.toISOString(), oldSyncAt);
      await warehouse.setCursor("inventory", oldSyncAt.toISOString(), oldSyncAt);

      const staleDeps: QueryToolDeps = { ...deps, staleThresholdHours: 1 };
      const result = await sellThroughTool(staleDeps, { periodDays: 30, order: "desc", top: 20 });
      expect(result.meta.data_last_synced_at).toBe(oldSyncAt.toISOString());
      expect(result.meta.warnings.some((w) => /may be stale/.test(w))).toBe(true);
    });

    it("reorder_suggestions (buildReorderReport shared with the agent report) emits the same stale warning", async () => {
      const oldSyncAt = new Date("2026-08-01T00:00:00Z");
      await warehouse.setCursor("receipts", oldSyncAt.toISOString(), oldSyncAt);
      await warehouse.setCursor("inventory", oldSyncAt.toISOString(), oldSyncAt);

      const staleDeps: QueryToolDeps = { ...deps, staleThresholdHours: 1 };
      const report = await reorderSuggestionsTool(staleDeps, {
        targetDaysCover: 21,
        leadTimeDays: 7,
      });
      expect(report.dataLastSyncedAt).toEqual(oldSyncAt);
      expect(report.warnings.some((w) => /may be stale/.test(w))).toBe(true);
    });
  });

  describe("inventory_status", () => {
    it("returns current stock and days of cover", async () => {
      await warehouse.upsertSalesLines([
        {
          receiptId: "R-1",
          lineNo: 0,
          storeId: "store_main",
          variantId: "var_cola",
          qty: "56",
          gross: "2520",
          discount: "0",
          soldAt: new Date("2026-08-25T09:00:00Z"),
        },
      ]);
      await warehouse.upsertInventory([
        {
          storeId: "store_main",
          variantId: "var_cola",
          inStock: "15",
          updatedAt: new Date(NOW_ISO),
        },
      ]);
      const result = await inventoryStatusTool(deps, {});
      const row = result.rows.find((r) => r.variant_id === "var_cola");
      expect(row?.in_stock).toBe(15);
      expect(row?.avg_daily_sales).toBe(2);
      expect(row?.days_of_cover).toBe(7.5);
    });

    it("filtering by below_days_cover excludes items with ∞ (null) cover", async () => {
      await warehouse.upsertInventory([
        {
          storeId: "store_main",
          variantId: "var_cola",
          inStock: "5",
          updatedAt: new Date(NOW_ISO),
        },
      ]);
      const result = await inventoryStatusTool(deps, { belowDaysCover: 100 });
      expect(result.rows).toHaveLength(0); // no sales → avgDaily 0 → daysOfCover null (∞)
    });
  });

  describe("stockout_risk", () => {
    it("returns only at-risk items and includes the expected stockout date", async () => {
      await warehouse.upsertSalesLines([
        {
          receiptId: "R-1",
          lineNo: 0,
          storeId: "store_main",
          variantId: "var_cola",
          qty: "56",
          gross: "2520",
          discount: "0",
          soldAt: new Date("2026-08-25T09:00:00Z"),
        },
      ]);
      // Daily average 2, stock 5 → 2.5 days of cover < 7+3=10 → at risk.
      await warehouse.upsertInventory([
        {
          storeId: "store_main",
          variantId: "var_cola",
          inStock: "5",
          updatedAt: new Date(NOW_ISO),
        },
      ]);
      const result = await stockoutRiskTool(deps, { leadTimeDays: 7, safetyDays: 3 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.variant_id).toBe("var_cola");
      expect(result.rows[0]?.expected_stockout_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("reorder_suggestions — identical to the agent (TESTING §4 regression guard)", () => {
    it("is exactly equal to the result of calling buildReorderReport() directly", async () => {
      await warehouse.upsertSalesLines([
        {
          receiptId: "R-1",
          lineNo: 0,
          storeId: "store_main",
          variantId: "var_cola",
          qty: "56",
          gross: "2520",
          discount: "0",
          soldAt: new Date("2026-08-25T09:00:00Z"),
        },
      ]);
      await warehouse.upsertInventory([
        {
          storeId: "store_main",
          variantId: "var_cola",
          inStock: "0",
          updatedAt: new Date(NOW_ISO),
        },
      ]);
      await warehouse.setCursor("receipts", NOW_ISO, new Date(NOW_ISO));
      await warehouse.setCursor("inventory", NOW_ISO, new Date(NOW_ISO));

      const viaTool = await reorderSuggestionsTool(deps, {
        targetDaysCover: 21,
        leadTimeDays: 7,
      });
      const viaAgentCore = await buildReorderReport(
        { warehouse, clock: createFixedClock(NOW_ISO) },
        { businessTimezone: BUSINESS_TIMEZONE, targetCoverDays: 21, leadTimeDays: 7 },
      );

      expect(viaTool).toEqual(viaAgentCore);
      expect(viaTool.stores[0]?.items[0]?.reorderQty).toBe(42);
    });
  });

  describe("sync_status", () => {
    it("returns the cursor and last sync time per resource", async () => {
      await warehouse.setCursor("inventory", "wm-inv", new Date("2026-09-01T06:00:00Z"));
      const result = await syncStatusTool({ warehouse, clock: createFixedClock(NOW_ISO) });
      const inv = result.resources.find((r) => r.resource === "inventory");
      expect(inv?.cursor).toBe("wm-inv");
      expect(inv?.last_synced_at).toBe("2026-09-01T06:00:00.000Z");
    });
  });

  describe("sync_now", () => {
    function fakeLoyverseClient(): LoyverseClient {
      const stores: LvStore[] = [{ id: "store_main", name: "Main Store" }];
      return {
        listStores: () => Promise.resolve(stores),
        listItems: () => Promise.resolve({ items: [], cursor: null }),
        listReceipts: () => Promise.resolve({ items: [], cursor: null }),
        listInventory: () =>
          Promise.resolve({
            items: [
              {
                store_id: "store_main",
                variant_id: "var_cola",
                in_stock: 3,
                updated_at: NOW_ISO,
              },
            ],
            cursor: null,
          }),
      };
    }

    it("returns run_id and per-resource results on a successful run", async () => {
      const runExclusively = async <T>(fn: () => Promise<T>): Promise<T> => fn();
      const result = await syncNowTool(
        {
          loyverseClient: fakeLoyverseClient(),
          warehouse,
          clock: createFixedClock(NOW_ISO),
          runExclusively,
        },
        {},
      );
      expect(result.ok).toBe(true);
      expect(result.resources.map((r) => r.resource)).toEqual([
        "stores",
        "items",
        "receipts",
        "inventory",
      ]);
    });

    it("propagates AdvisoryLockBusyError when runExclusively rejects (another run in progress)", async () => {
      const runExclusively = <T>(): Promise<T> => Promise.reject(new AdvisoryLockBusyError(1));
      await expect(
        syncNowTool(
          {
            loyverseClient: fakeLoyverseClient(),
            warehouse,
            clock: createFixedClock(NOW_ISO),
            runExclusively,
          },
          {},
        ),
      ).rejects.toThrow(AdvisoryLockBusyError);
    });
  });

  describe("explore_sql (TASKS T27, guardrail 4 exception — thin assembly layer)", () => {
    it("passes the input to executor.execute as-is and returns the result as-is", async () => {
      const calls: Array<[string, unknown]> = [];
      const executor = {
        execute: (sql: string, opts?: unknown) => {
          calls.push([sql, opts]);
          return Promise.resolve({
            columns: ["id"],
            rows: [{ id: "store_main" }],
            rowCount: 1,
            truncated: false,
            timeoutMs: 5000,
          });
        },
      };
      const result = await exploreSqlTool(
        { executor },
        { sql: "select id from stores", limit: 10, timeoutMs: 1000 },
      );
      expect(calls).toEqual([["select id from stores", { limit: 10, timeoutMs: 1000 }]]);
      expect(result.rows).toEqual([{ id: "store_main" }]);
    });

    it("does not pass undefined fields to the executor when limit/timeoutMs are omitted", async () => {
      const calls: unknown[] = [];
      const executor = {
        execute: (_sql: string, opts?: unknown) => {
          calls.push(opts);
          return Promise.resolve({
            columns: [],
            rows: [],
            rowCount: 0,
            truncated: false,
            timeoutMs: 5000,
          });
        },
      };
      await exploreSqlTool({ executor }, { sql: "select 1" });
      expect(calls).toEqual([{}]);
    });

    it("runs the golden case against the real warehouse (full path: validation → READ ONLY execution)", async () => {
      const executor = createExploreSqlExecutor(createPgliteConnectionProvider(db));
      const result = await exploreSqlTool(
        { executor },
        { sql: "select id, name from stores order by id" },
      );
      expect(result.rows).toEqual([
        { id: "store_main", name: "Main Store" },
        { id: "store_makati", name: "Makati Branch" },
      ]);
    });
  });
});
