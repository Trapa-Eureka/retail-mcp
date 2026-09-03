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

describe("pgWarehouse (PGlite)", () => {
  let db: PGlite;
  let warehouse: Warehouse;

  beforeEach(async () => {
    db = await createTestWarehouse();
    warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    await warehouse.upsertStores([STORE_MAIN, STORE_MAKATI]);
    await warehouse.upsertProducts([PRODUCT_COLA, PRODUCT_CHIPS]);
  });

  describe("upsert 멱등성", () => {
    it("upsertStores를 같은 id로 두 번 호출하면 갱신되고 행이 늘지 않는다", async () => {
      await warehouse.upsertStores([{ id: "store_main", name: "본점(개명)" }]);

      const { rows } = await db.query<{ count: string; name: string }>(
        "select count(*)::text as count, max(name) as name from stores where id = 'store_main'",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.name).toBe("본점(개명)");
    });

    it("upsertProducts로 packSize(포장수량, SPEC §14)를 저장·갱신할 수 있다", async () => {
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

    it("packSize를 안 주는(undefined) upsert는 이미 저장된 값을 지우지 않는다(coalesce)", async () => {
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: "24" }]);
      // 다른 채널(예: Loyverse 동기화)이 packSize 없이 다시 upsert해도 값이 유지돼야 한다.
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, name: "코카콜라 500ml(갱신)" }]);

      const { rows } = await db.query<{ pack_size: string | null; name: string }>(
        "select pack_size, name from products where variant_id = 'var_cola'",
      );
      expect(rows[0]?.pack_size).toBe("24");
      expect(rows[0]?.name).toBe("코카콜라 500ml(갱신)");
    });

    it("upsertSalesLines를 같은 PK로 두 번 호출하면 갱신되고 행이 늘지 않는다", async () => {
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

    it("upsertInventory를 같은 (store,variant)로 두 번 호출하면 갱신되고 행이 늘지 않는다", async () => {
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

    it("appendInventorySnapshot을 같은 (run_id,store,variant)로 두 번 호출하면 갱신되고 행이 늘지 않는다", async () => {
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

    it("appendInventorySnapshot은 존재하지 않는 매장/상품을 참조하면 거부한다 (FK)", async () => {
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

    it("upsertSalesPeriodAgg를 같은 (store,variant)로 두 번 호출하면 갱신되고 행이 늘지 않는다", async () => {
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

    it("upsertPurchaseReceipts를 같은 (store,variant,received_at)로 두 번 호출하면 갱신되고 행이 늘지 않는다", async () => {
      const row: PurchaseReceiptRow = {
        storeId: "store_main",
        variantId: "var_cola",
        receivedAt: new Date("2026-07-01"),
        receivedQty: "30",
        unitCost: "12000",
        currency: "KRW",
        vendor: "스마트유통",
      };
      await warehouse.upsertPurchaseReceipts([row]);
      await warehouse.upsertPurchaseReceipts([{ ...row, receivedQty: "99" }]);

      const { rows } = await db.query<{ count: string; received_qty: string }>(
        "select count(*)::text as count, max(received_qty) as received_qty from purchase_receipts where store_id = 'store_main' and variant_id = 'var_cola'",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.received_qty).toBe("99");
    });

    it("upsertPurchaseReceipts는 존재하지 않는 매장/상품을 참조하면 거부한다 (FK)", async () => {
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

    it("unit_cost만 있고 currency가 없으면(또는 반대) DB 제약으로 거부한다", async () => {
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

  describe("purchase_receipts / queryPurchaseAgg (SCM 시트 연동, SPEC §13)", () => {
    beforeEach(async () => {
      const rows: PurchaseReceiptRow[] = [
        {
          storeId: "store_main",
          variantId: "var_cola",
          receivedAt: new Date("2026-08-05"),
          receivedQty: "30",
          unitCost: "12000",
          currency: "KRW",
          vendor: "스마트유통",
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

    it("기간·매장 내 입고수량을 querySalesAgg와 대칭인 모양으로 합산해 반환한다", async () => {
      const result = await warehouse.queryPurchaseAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
      });
      expect(result).toEqual([
        { storeId: "store_main", variantId: "var_cola", receivedQtyRaw: "40" }, // 30+10
      ]);
    });

    it("매장 필터가 적용된다", async () => {
      const result = await warehouse.queryPurchaseAgg({
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
        storeId: "store_makati",
      });
      expect(result).toEqual([
        { storeId: "store_makati", variantId: "var_cola", receivedQtyRaw: "5" },
      ]);
    });

    it("질의 기간 밖의 입고는 제외한다", async () => {
      const result = await warehouse.queryPurchaseAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-10T00:00:00Z"), // 08-20 입고는 범위 밖
      });
      expect(result).toEqual([
        { storeId: "store_main", variantId: "var_cola", receivedQtyRaw: "30" },
      ]);
    });
  });

  describe("sales_period_agg (CSV/Excel 기간합계, TASKS T12)", () => {
    beforeEach(async () => {
      // CSV 스캔이 매장당 한 기간(2026-08-01 ~ 2026-08-29)으로 올린 기간합계.
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

    it("querySalesAgg와 동일한 SalesAgg 형태로 반환한다(core/metrics.ts가 그대로 소비 가능)", async () => {
      const result = await warehouse.querySalesPeriodAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-08-29T00:00:00Z"),
      });
      const cola = result.find((r) => r.variantId === "var_cola");
      expect(cola).toEqual({
        storeId: "store_main",
        variantId: "var_cola",
        name: "코카콜라 500ml",
        category: "음료",
        soldQtyRaw: "56",
      });
    });

    it("매장 필터가 적용된다", async () => {
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

    it("질의 기간이 저장된 기간과 전혀 겹치지 않으면 제외한다", async () => {
      const result = await warehouse.querySalesPeriodAgg({
        storeId: "store_main",
        periodStart: new Date("2026-01-01T00:00:00Z"),
        periodEnd: new Date("2026-02-01T00:00:00Z"),
      });
      expect(result).toHaveLength(0);
    });
  });

  describe("고정 집계 쿼리 — 골든 값", () => {
    beforeEach(async () => {
      const lines: SalesLineRow[] = [
        // store_main / var_cola: 기간 내 10 + 20 + 30 = 60
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
        // 기간 밖 — 집계에서 제외되어야 한다
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
        // 다른 매장 — store_main만 조회하면 제외되어야 한다
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
        // 환불 포함 — 원시 순판매량 그대로 합산(음수 정규화는 core/metrics.ts 몫)
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

    it("querySalesAgg: 기간·매장 필터 적용 시 골든 합계(60)와 일치한다", async () => {
      const result = await warehouse.querySalesAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      });

      const cola = result.find((r) => r.variantId === "var_cola");
      expect(cola?.soldQtyRaw).toBe("60");
      expect(cola?.name).toBe("코카콜라 500ml");
      expect(cola?.category).toBe("음료");
    });

    it("querySalesAgg: 환불 포함 원시 순판매량 = 10 + (-2) = 8", async () => {
      const result = await warehouse.querySalesAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      });

      const chips = result.find((r) => r.variantId === "var_chips");
      expect(chips?.soldQtyRaw).toBe("8");
    });

    it("querySalesAgg: category 필터가 적용된다", async () => {
      const result = await warehouse.querySalesAgg({
        category: "스낵",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      });
      expect(result.every((r) => r.category === "스낵")).toBe(true);
      expect(result.some((r) => r.variantId === "var_cola")).toBe(false);
    });

    it("querySalesAgg: 기간 밖(반개방 경계 밖)과 다른 매장은 제외된다", async () => {
      const result = await warehouse.querySalesAgg({
        storeId: "store_main",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      });
      const total = result
        .filter((r) => r.variantId === "var_cola")
        .reduce((sum, r) => sum + Number(r.soldQtyRaw), 0);
      expect(total).toBe(60); // 999(기간 밖)와 5(다른 매장)는 포함되지 않는다
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

    it("storeId로 필터링한다", async () => {
      const result = await warehouse.queryStock({ storeId: "store_main" });
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.storeId === "store_main")).toBe(true);
      const cola = result.find((r) => r.variantId === "var_cola");
      expect(cola?.inStockRaw).toBe("42");
      expect(cola?.updatedAt).toBeInstanceOf(Date);
    });

    it("variantIds로 필터링한다", async () => {
      const result = await warehouse.queryStock({ variantIds: ["var_cola"] });
      expect(result).toHaveLength(2); // store_main + store_makati의 var_cola
      expect(result.every((r) => r.variantId === "var_cola")).toBe(true);
    });

    it("필터 없이 호출하면 전부 반환한다", async () => {
      const result = await warehouse.queryStock({});
      expect(result).toHaveLength(3);
    });

    it("category로 필터링한다 — 판매 없이 재고만 있는 다른 카테고리 품목이 새지 않는다", async () => {
      // PRODUCT_COLA 카테고리="음료", PRODUCT_CHIPS 카테고리="스낵"(beforeEach 상단 상수).
      const result = await warehouse.queryStock({ storeId: "store_main", category: "음료" });
      expect(result).toHaveLength(1);
      expect(result[0]?.variantId).toBe("var_cola");
    });
  });

  describe("getCursor / setCursor", () => {
    it("설정 전에는 null을 반환한다", async () => {
      expect(await warehouse.getCursor("receipts")).toBeNull();
    });

    it("설정 후 그대로 조회된다 (watermark 왕복)", async () => {
      await warehouse.setCursor(
        "receipts",
        "2026-08-01T00:00:00Z",
        new Date("2026-09-01T00:00:00Z"),
      );
      expect(await warehouse.getCursor("receipts")).toBe("2026-08-01T00:00:00Z");

      // 재설정 시 갱신된다
      await warehouse.setCursor(
        "receipts",
        "2026-08-15T00:00:00Z",
        new Date("2026-09-02T00:00:00Z"),
      );
      expect(await warehouse.getCursor("receipts")).toBe("2026-08-15T00:00:00Z");
    });
  });

  describe("getSyncState (T9 sync_status 도구용)", () => {
    it("설정 전에는 빈 배열을 반환한다", async () => {
      expect(await warehouse.getSyncState()).toEqual([]);
    });

    it("리소스별 cursor+last_synced_at을 resource 오름차순으로 반환한다", async () => {
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

  describe("transaction — 원자적 커밋/롤백 (DESIGN §11.1)", () => {
    it("성공하면 data + watermark가 함께 커밋된다", async () => {
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

    it("중간에 실패하면 data와 watermark 둘 다 롤백된다", async () => {
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

      // 트랜잭션 전 상태(재고 upsert 없음, cursor 없음)로 남아 있어야 한다
      const stock = await warehouse.queryStock({ storeId: "store_main", variantIds: ["var_cola"] });
      expect(stock).toHaveLength(0);
      expect(await warehouse.getCursor("inventory")).toBeNull();
    });

    it("롤백 후에도 같은 warehouse로 정상적인 후속 쓰기를 할 수 있다", async () => {
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

  describe("logAgentSend — 예약 패턴 (DESIGN §11.5)", () => {
    it("sending으로 예약한 뒤 sent로 갱신하면 같은 행이 갱신되고 행이 늘지 않는다", async () => {
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
        subject: "재주문 제안",
        messageId: "msg-123",
      });

      const { rows } = await db.query<{ count: string; status: string; message_id: string }>(
        "select count(*)::text as count, max(status) as status, max(message_id) as message_id from agent_send_log where run_id = 'run-1'",
      );
      expect(rows[0]?.count).toBe("1");
      expect(rows[0]?.status).toBe("sent");
      expect(rows[0]?.message_id).toBe("msg-123");
    });

    it("no_suggestions 상태는 recipient/subject 없이도 기록된다", async () => {
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

    it("이미 sent인 run_id로 다시 sending을 예약하면 실패한다(이중 발송 방지)", async () => {
      const base = {
        runId: "run-3",
        sentAt: new Date("2026-09-01T07:00:00Z"),
        recipient: "owner@example.com",
        subject: "재주문 제안",
        suggestionCount: 2,
        messageId: null,
        dryRun: false,
        errorCode: null,
      };
      await warehouse.logAgentSend({ ...base, status: "sending" });
      await warehouse.logAgentSend({ ...base, status: "sent", messageId: "msg-1" });

      // 같은 run_id로 재발송을 시도하면(예: 재시도 스크립트 실수) 예약(INSERT)이 부분 유니크
      // 인덱스를 위반해 거부돼야 한다 — 이미 sent인 행을 sending으로 되돌리면 안 된다.
      await expect(warehouse.logAgentSend({ ...base, status: "sending" })).rejects.toThrow(
        /이미 발송 중이거나 발송 완료된 실행/,
      );

      const { rows } = await db.query<{ status: string; message_id: string }>(
        "select status, message_id from agent_send_log where run_id = 'run-3'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("sent");
      expect(rows[0]?.message_id).toBe("msg-1");
    });

    it("sending 예약 없이 sent/failed로 갱신하면 원인이 담긴 에러를 던진다", async () => {
      await expect(
        warehouse.logAgentSend({
          runId: "run-4",
          sentAt: new Date("2026-09-01T07:00:00Z"),
          status: "sent",
          recipient: "owner@example.com",
          subject: "재주문 제안",
          suggestionCount: 1,
          messageId: "msg-x",
          dryRun: false,
          errorCode: null,
        }),
      ).rejects.toThrow(/sending 예약 행이 없어/);
    });

    it("실패(failed) 후에는 같은 run_id로 새 sending 예약이 다시 가능하다(재시도)", async () => {
      const base = {
        runId: "run-5",
        sentAt: new Date("2026-09-01T07:00:00Z"),
        recipient: "owner@example.com",
        subject: "재주문 제안",
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

  describe("queryStores", () => {
    it("필터 없이 호출하면 모든 매장을 id 순으로 반환한다", async () => {
      const stores = await warehouse.queryStores();
      expect(stores).toEqual([
        { id: "store_main", name: "본점" },
        { id: "store_makati", name: "마카티점" },
      ]);
    });

    it("storeId를 주면 그 매장만 반환한다", async () => {
      expect(await warehouse.queryStores("store_makati")).toEqual([
        { id: "store_makati", name: "마카티점" },
      ]);
    });

    it("존재하지 않는 storeId면 빈 배열을 반환한다", async () => {
      expect(await warehouse.queryStores("store_nope")).toEqual([]);
    });
  });

  describe("queryProducts (SPEC §14/TASKS T25 — packSize 등 ProductRow 전체 필드 조회)", () => {
    beforeEach(async () => {
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: "24" }]);
    });

    it("variantIds를 생략하면 전체 상품을 variant_id 순으로 반환한다", async () => {
      const products = await warehouse.queryProducts();
      expect(products.map((p) => p.variantId)).toEqual(["var_chips", "var_cola"]);
      const cola = products.find((p) => p.variantId === "var_cola");
      expect(cola).toMatchObject({ name: "코카콜라 500ml", sku: "SKU-COLA", packSize: "24" });
    });

    it("variantIds를 주면 그 상품만 반환한다(packSize 없는 상품은 null)", async () => {
      const products = await warehouse.queryProducts(["var_chips"]);
      expect(products).toEqual([
        {
          variantId: "var_chips",
          itemId: "itm_chips",
          name: "Piattos",
          sku: "SKU-CHIPS",
          category: "스낵",
          lowStockThreshold: null,
          packSize: null,
        },
      ]);
    });

    it("빈 배열을 주면 빈 결과를 반환한다(전체 조회와 구분)", async () => {
      expect(await warehouse.queryProducts([])).toEqual([]);
    });
  });

  describe("읽기 전용 역할 분리", () => {
    beforeEach(async () => {
      await db.exec("create role app_readonly");
      await db.exec(
        "grant select on stores, products, sales_lines, inventory_levels, inventory_snapshots, sync_state, agent_send_log to app_readonly",
      );
    });

    it("읽기 전용 role로는 조회 도구 5종이 성공한다(T9 MCP 조회 도구 전부)", async () => {
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

    it("읽기 전용 role로는 쓰기가 실패한다", async () => {
      await db.exec("set role app_readonly");
      try {
        await expect(
          warehouse.upsertStores([{ id: "store_new", name: "신규매장" }]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          warehouse.setCursor("receipts", "wm", new Date("2026-09-01T00:00:00Z")),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec("reset role");
      }
    });
  });
});
