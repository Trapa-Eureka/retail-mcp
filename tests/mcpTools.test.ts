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

const STORE_MAIN: StoreRow = { id: "store_main", name: "본점" };
const STORE_MAKATI: StoreRow = { id: "store_makati", name: "마카티점" };
const PRODUCT_COLA = {
  variantId: "var_cola",
  itemId: "itm_cola",
  name: "코카콜라 500ml",
  sku: "SKU-COLA",
  category: "음료",
};
const PRODUCT_CHIPS = {
  variantId: "var_chips",
  itemId: "itm_chips",
  name: "Piattos",
  sku: "SKU-CHIPS",
  category: "스낵",
};

// FixedClock "지금" — Asia/Manila(UTC+8) 기준 오늘 자정 = 2026-08-31T16:00:00Z.
const NOW_ISO = "2026-09-01T09:00:00Z";
const BUSINESS_TIMEZONE = "Asia/Manila";

describe("MCP 도구 (src/mcp/tools.ts)", () => {
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
    it("골든 케이스 값과 일치하고 근사식 각주를 포함한다 (30일 판매 60개, 기말재고 40 → 0.60)", async () => {
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
      expect(result.note).toMatch(/근사식/);
      expect(result.meta.timezone).toBe(BUSINESS_TIMEZONE);
      expect(result.meta.filters["period_days"]).toBe(30);
    });

    it("category 필터가 판매 없는 다른 카테고리 재고를 새지 않게 한다(회귀)", async () => {
      // var_cola(음료)만 판매/재고 있고, var_chips(스낵)는 재고만 있음.
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
        category: "음료",
        periodDays: 30,
        order: "desc",
        top: 20,
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.variant_id).toBe("var_cola");
    });

    it("존재하지 않는 store_id면 원인이 담긴 에러를 던진다", async () => {
      await expect(
        sellThroughTool(deps, { storeId: "store_nope", periodDays: 30, order: "desc", top: 20 }),
      ).rejects.toThrow(/존재하지 않는 store_id/);
    });

    it("store_id 필터가 정확히 적용된다", async () => {
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

  describe("신선도(stale) 경고 — SPEC §9, TESTING §7", () => {
    it("동기화 이력이 전혀 없으면 data_last_synced_at=null이고 미동기화 경고가 붙는다", async () => {
      // beforeEach에서 stores/products만 seed하고 sync_state는 건드리지 않는다.
      const result = await sellThroughTool(deps, { periodDays: 30, order: "desc", top: 20 });
      expect(result.meta.data_last_synced_at).toBeNull();
      expect(result.meta.warnings.some((w) => w.includes("한 번도 동기화되지"))).toBe(true);
    });

    it("임계값을 넘겨 오래된 동기화면 stale 경고가 붙는다", async () => {
      const oldSyncAt = new Date("2026-08-01T00:00:00Z"); // NOW_ISO(9/1)로부터 31일 전
      await warehouse.setCursor("receipts", oldSyncAt.toISOString(), oldSyncAt);
      await warehouse.setCursor("inventory", oldSyncAt.toISOString(), oldSyncAt);

      const staleDeps: QueryToolDeps = { ...deps, staleThresholdHours: 1 };
      const result = await sellThroughTool(staleDeps, { periodDays: 30, order: "desc", top: 20 });
      expect(result.meta.data_last_synced_at).toBe(oldSyncAt.toISOString());
      expect(result.meta.warnings.some((w) => w.includes("stale 상태일 수 있습니다"))).toBe(true);
    });

    it("reorder_suggestions(에이전트 리포트와 공유하는 buildReorderReport)도 같은 stale 경고를 낸다", async () => {
      const oldSyncAt = new Date("2026-08-01T00:00:00Z");
      await warehouse.setCursor("receipts", oldSyncAt.toISOString(), oldSyncAt);
      await warehouse.setCursor("inventory", oldSyncAt.toISOString(), oldSyncAt);

      const staleDeps: QueryToolDeps = { ...deps, staleThresholdHours: 1 };
      const report = await reorderSuggestionsTool(staleDeps, {
        targetDaysCover: 21,
        leadTimeDays: 7,
      });
      expect(report.dataLastSyncedAt).toEqual(oldSyncAt);
      expect(report.warnings.some((w) => w.includes("stale 상태일 수 있습니다"))).toBe(true);
    });
  });

  describe("inventory_status", () => {
    it("현재고와 재고커버일수를 반환한다", async () => {
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

    it("below_days_cover로 필터링하면 ∞(null) 커버 품목은 제외된다", async () => {
      await warehouse.upsertInventory([
        {
          storeId: "store_main",
          variantId: "var_cola",
          inStock: "5",
          updatedAt: new Date(NOW_ISO),
        },
      ]);
      const result = await inventoryStatusTool(deps, { belowDaysCover: 100 });
      expect(result.rows).toHaveLength(0); // 판매 없음 → avgDaily 0 → daysOfCover null(∞)
    });
  });

  describe("stockout_risk", () => {
    it("위험 품목만 반환하고 예상 소진일을 포함한다", async () => {
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
      // 일평균 2, 재고 5 → 커버 2.5일 < 7+3=10 → 위험.
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

  describe("reorder_suggestions — 에이전트와 완전 동일 (TESTING §4 회귀 가드)", () => {
    it("buildReorderReport()를 직접 호출한 결과와 완전히 같다", async () => {
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
    it("리소스별 커서와 마지막 동기화 시각을 반환한다", async () => {
      await warehouse.setCursor("inventory", "wm-inv", new Date("2026-09-01T06:00:00Z"));
      const result = await syncStatusTool({ warehouse, clock: createFixedClock(NOW_ISO) });
      const inv = result.resources.find((r) => r.resource === "inventory");
      expect(inv?.cursor).toBe("wm-inv");
      expect(inv?.last_synced_at).toBe("2026-09-01T06:00:00.000Z");
    });
  });

  describe("sync_now", () => {
    function fakeLoyverseClient(): LoyverseClient {
      const stores: LvStore[] = [{ id: "store_main", name: "본점" }];
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

    it("정상 실행되면 run_id와 리소스별 결과를 반환한다", async () => {
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

    it("runExclusively가 거부하면(다른 실행 중) AdvisoryLockBusyError가 전파된다", async () => {
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

  describe("explore_sql (TASKS T27, 가드레일 4 예외 — 얇은 조립 계층)", () => {
    it("input을 그대로 executor.execute에 넘기고 결과를 그대로 반환한다", async () => {
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

    it("limit/timeoutMs를 생략하면 executor에 undefined 필드를 안 넘긴다", async () => {
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

    it("실제 웨어하우스 대상으로 골든 케이스를 실행한다(검증→READ ONLY 실행 전체 경로)", async () => {
      const executor = createExploreSqlExecutor(createPgliteConnectionProvider(db));
      const result = await exploreSqlTool(
        { executor },
        { sql: "select id, name from stores order by id" },
      );
      expect(result.rows).toEqual([
        { id: "store_main", name: "본점" },
        { id: "store_makati", name: "마카티점" },
      ]);
    });
  });
});
