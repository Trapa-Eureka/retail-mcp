import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import type { InventoryRow, SalesLineRow, StoreRow, Warehouse } from "../src/core/types.js";

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
  });

  describe("읽기 전용 역할 분리", () => {
    beforeEach(async () => {
      await db.exec("create role app_readonly");
      await db.exec(
        "grant select on stores, products, sales_lines, inventory_levels, inventory_snapshots, sync_state, agent_send_log to app_readonly",
      );
    });

    it("읽기 전용 role로는 조회 도구 3종이 성공한다", async () => {
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
