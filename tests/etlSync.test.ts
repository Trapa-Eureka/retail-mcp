import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import { createFixtureLoyverseClient } from "../src/mocks/fixtureLoyverseClient.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import { syncAll } from "../src/etl/sync.js";
import type { LoyverseClient, LvReceipt } from "../src/core/types.js";

async function setup() {
  const db = await createTestWarehouse();
  const warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
  const loyverseClient = await createFixtureLoyverseClient({ receiptsPageSize: 50 });
  const clock = createFixedClock("2026-09-01T00:00:00.000Z");
  return { db, warehouse, loyverseClient, clock };
}

async function count(db: PGlite, table: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `select count(*)::text as count from ${table}`,
  );
  return Number(rows[0]?.count ?? "0");
}

async function allReceipts(client: LoyverseClient): Promise<LvReceipt[]> {
  const out: LvReceipt[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listReceipts("1970-01-01T00:00:00.000Z", cursor);
    out.push(...page.items);
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return out;
}

/** listReceipts를 두 번째 호출(=2페이지 중 1페이지 처리 후)에서 실패시키는 래퍼. */
function failOnSecondReceiptsCall(inner: LoyverseClient): LoyverseClient {
  let calls = 0;
  return {
    ...inner,
    listReceipts: (sinceISO, cursor) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("시뮬레이션된 네트워크 실패"));
      return inner.listReceipts(sinceISO, cursor);
    },
  };
}

describe("etl/sync — TESTING.md §4 ETL 4항목", () => {
  it("동일 픽스처로 2회 동기화해도 stores/products/sales_lines/inventory_levels 행 수가 늘지 않는다 (멱등)", async () => {
    const { db, warehouse, loyverseClient, clock } = await setup();

    const first = await syncAll({ loyverseClient, warehouse, clock });
    expect(first.ok).toBe(true);
    const after1 = {
      stores: await count(db, "stores"),
      products: await count(db, "products"),
      sales_lines: await count(db, "sales_lines"),
      inventory_levels: await count(db, "inventory_levels"),
    };
    expect(after1.sales_lines).toBeGreaterThan(0);

    const second = await syncAll({ loyverseClient, warehouse, clock });
    expect(second.ok).toBe(true);
    expect(await count(db, "stores")).toBe(after1.stores);
    expect(await count(db, "products")).toBe(after1.products);
    expect(await count(db, "sales_lines")).toBe(after1.sales_lines);
    expect(await count(db, "inventory_levels")).toBe(after1.inventory_levels);
  });

  it("receipts가 페이지 처리 중 실패하면 watermark가 갱신되지 않고 아무 것도 적재되지 않으며, 재실행 시 이전 watermark부터 안전하게 재개한다", async () => {
    const { db, warehouse, loyverseClient, clock } = await setup();
    const failing = failOnSecondReceiptsCall(loyverseClient);

    const result = await syncAll(
      { loyverseClient: failing, warehouse, clock },
      { resources: ["stores", "items", "receipts"] },
    );
    const receiptsResult = result.resources.find((r) => r.resource === "receipts");
    expect(receiptsResult?.status).toBe("failed");
    expect(await warehouse.getCursor("receipts")).toBeNull();
    expect(await count(db, "sales_lines")).toBe(0);

    // 재실행 — 이번엔 정상 클라이언트. stores/items는 이전 실행에서 이미 적재돼 있으므로
    // 이번 syncAll 호출에 포함하지 않아도 receipts를 시도할 수 있어야 한다.
    const retry = await syncAll({ loyverseClient, warehouse, clock }, { resources: ["receipts"] });
    const retryReceipts = retry.resources.find((r) => r.resource === "receipts");
    expect(retryReceipts?.status).toBe("success");
    expect(await warehouse.getCursor("receipts")).not.toBeNull();
    expect(await count(db, "sales_lines")).toBeGreaterThan(0);
  });

  it("환불 영수증의 line_items는 부호가 반전되어 음수 qty로 적재된다", async () => {
    const { db, warehouse, loyverseClient, clock } = await setup();
    const receipts = await allReceipts(loyverseClient);
    const refund = receipts.find((r) => r.receipt_type === "REFUND" && r.cancelled_at === null);
    if (!refund) throw new Error("fixture에 취소되지 않은 REFUND 영수증이 있어야 한다");
    const firstLine = refund.line_items[0];
    if (!firstLine) throw new Error("REFUND 영수증에 line_items가 있어야 한다");

    await syncAll({ loyverseClient, warehouse, clock });

    const { rows } = await db.query<{ qty: string }>(
      "select qty from sales_lines where receipt_id = $1 and line_no = 0",
      [refund.receipt_number],
    );
    expect(Number(rows[0]?.qty)).toBe(-firstLine.quantity);
  });

  it("2회 동기화하면 inventory_snapshots에 서로 다른 두 실행(run_id)이 남는다 — FixedClock이라도 randomUUID로 구분", async () => {
    const { db, warehouse, loyverseClient, clock } = await setup();
    await syncAll({ loyverseClient, warehouse, clock });
    await syncAll({ loyverseClient, warehouse, clock });

    const { rows } = await db.query<{ count: string }>(
      "select count(distinct run_id)::text as count from inventory_snapshots",
    );
    expect(rows[0]?.count).toBe("2");
  });
});

describe("etl/sync — 추가 정책", () => {
  it("취소된 영수증은 sales_lines에 적재되지 않는다 (SPEC §9)", async () => {
    const { db, warehouse, loyverseClient, clock } = await setup();
    const receipts = await allReceipts(loyverseClient);
    const cancelled = receipts.find((r) => r.cancelled_at !== null);
    if (!cancelled) throw new Error("fixture에 취소된 영수증이 있어야 한다");

    await syncAll({ loyverseClient, warehouse, clock });

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from sales_lines where receipt_id = $1",
      [cancelled.receipt_number],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("inventory 응답이 비어 있으면 동기화 오류로 처리하고 기존 재고를 건드리지 않는다", async () => {
    const { db, warehouse, loyverseClient, clock } = await setup();
    await syncAll({ loyverseClient, warehouse, clock });
    const before = await count(db, "inventory_levels");
    expect(before).toBeGreaterThan(0);

    const emptyInventoryClient: LoyverseClient = {
      ...loyverseClient,
      listInventory: () => Promise.resolve({ items: [], cursor: null }),
    };
    const result = await syncAll(
      { loyverseClient: emptyInventoryClient, warehouse, clock },
      { resources: ["inventory"] },
    );
    const r = result.resources.find((x) => x.resource === "inventory");
    expect(r?.status).toBe("failed");
    expect(await count(db, "inventory_levels")).toBe(before);
  });

  it("stores가 실패하면 receipts/inventory는 FK 의존 때문에 시도하지 않고 skipped로 보고한다", async () => {
    const { warehouse, clock } = await setup();
    const failingStoresClient: LoyverseClient = {
      listStores: () => Promise.reject(new Error("boom")),
      listItems: () => Promise.resolve({ items: [], cursor: null }),
      listReceipts: () => Promise.resolve({ items: [], cursor: null }),
      listInventory: () => Promise.resolve({ items: [], cursor: null }),
    };
    const result = await syncAll({ loyverseClient: failingStoresClient, warehouse, clock });

    expect(result.ok).toBe(false);
    expect(result.resources.find((r) => r.resource === "stores")?.status).toBe("failed");
    // items는 stores에 의존하지 않으므로 독립적으로 계속 시도된다.
    expect(result.resources.find((r) => r.resource === "items")?.status).toBe("success");
    // receipts/inventory는 stores·products를 FK로 참조하므로, stores가 실패한 이상 시도하지 않는다.
    expect(result.resources.find((r) => r.resource === "receipts")?.status).toBe("skipped");
    expect(result.resources.find((r) => r.resource === "inventory")?.status).toBe("skipped");
  });

  it("동일 updated_at 영수증이 페이지 경계에 걸쳐도 누락 없이 전부 적재된다", async () => {
    const { warehouse, db, clock } = await setup();
    const tiedReceipts: LvReceipt[] = [
      {
        receipt_number: "R1",
        store_id: "s1",
        receipt_type: "SALE",
        refund_for: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        receipt_date: "2026-01-01T00:00:00.000Z",
        cancelled_at: null,
        line_items: [
          {
            variant_id: "v1",
            item_id: "i1",
            quantity: 1,
            gross_total_money: 10,
            total_discount: 0,
          },
        ],
      },
      {
        receipt_number: "R2",
        store_id: "s1",
        receipt_type: "SALE",
        refund_for: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        receipt_date: "2026-01-01T00:00:00.000Z",
        cancelled_at: null,
        line_items: [
          {
            variant_id: "v1",
            item_id: "i1",
            quantity: 2,
            gross_total_money: 20,
            total_discount: 0,
          },
        ],
      },
    ];
    const client: LoyverseClient = {
      listStores: () => Promise.resolve([{ id: "s1", name: "매장" }]),
      listItems: () =>
        Promise.resolve({
          items: [
            {
              id: "i1",
              item_name: "품목",
              category_id: null,
              variants: [{ variant_id: "v1", sku: null }],
            },
          ],
          cursor: null,
        }),
      listReceipts: (sinceISO, cursor) => {
        const filtered = tiedReceipts
          .filter((r) => r.updated_at >= sinceISO)
          .sort((a, b) => a.receipt_number.localeCompare(b.receipt_number));
        const offset = cursor ? Number(cursor) : 0;
        const pageSize = 1; // 동률 updated_at을 페이지 경계에 강제로 걸치게 한다
        const items = filtered.slice(offset, offset + pageSize);
        const nextCursor = offset + pageSize < filtered.length ? String(offset + pageSize) : null;
        return Promise.resolve({ items, cursor: nextCursor });
      },
      listInventory: () =>
        Promise.resolve({
          items: [
            {
              variant_id: "v1",
              store_id: "s1",
              in_stock: 5,
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          cursor: null,
        }),
    };

    const result = await syncAll({ loyverseClient: client, warehouse, clock });
    expect(result.ok).toBe(true);
    expect(await count(db, "sales_lines")).toBe(2);
  });

  it("품목 variants가 여러 개면 각각 별도 ProductRow로 평탄화되고, category는 category_id를 그대로 담는다", async () => {
    const { db, warehouse, clock } = await setup();
    const client: LoyverseClient = {
      listStores: () => Promise.resolve([{ id: "s1", name: "매장" }]),
      listItems: () =>
        Promise.resolve({
          items: [
            {
              id: "i1",
              item_name: "티셔츠",
              category_id: "cat_apparel",
              variants: [
                { variant_id: "v1-s", sku: "TS-S" },
                { variant_id: "v1-m", sku: "TS-M" },
              ],
            },
          ],
          cursor: null,
        }),
      listReceipts: () => Promise.resolve({ items: [], cursor: null }),
      listInventory: () =>
        Promise.resolve({
          items: [
            {
              variant_id: "v1-s",
              store_id: "s1",
              in_stock: 1,
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          cursor: null,
        }),
    };

    await syncAll({ loyverseClient: client, warehouse, clock }, { resources: ["stores", "items"] });

    const { rows } = await db.query<{ variant_id: string; category: string | null }>(
      "select variant_id, category from products order by variant_id",
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.variant_id)).toEqual(["v1-m", "v1-s"]);
    expect(rows.every((r) => r.category === "cat_apparel")).toBe(true);
  });
});
