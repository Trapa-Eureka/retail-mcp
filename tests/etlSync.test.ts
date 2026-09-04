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

/** Wrapper that fails listReceipts on the second call (= after page 1 of 2 has been processed). */
function failOnSecondReceiptsCall(inner: LoyverseClient): LoyverseClient {
  let calls = 0;
  return {
    ...inner,
    listReceipts: (sinceISO, cursor) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("simulated network failure"));
      return inner.listReceipts(sinceISO, cursor);
    },
  };
}

describe("etl/sync — TESTING.md §4 ETL 4 items", () => {
  it("syncing the same fixture twice does not increase the stores/products/sales_lines/inventory_levels row counts (idempotent)", async () => {
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

  it("if receipts fail mid-page, the watermark is not updated and nothing is loaded, and a re-run safely resumes from the previous watermark", async () => {
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

    // Re-run — this time with the healthy client. stores/items were already loaded by the previous
    // run, so receipts must be attemptable even without including them in this syncAll call.
    const retry = await syncAll({ loyverseClient, warehouse, clock }, { resources: ["receipts"] });
    const retryReceipts = retry.resources.find((r) => r.resource === "receipts");
    expect(retryReceipts?.status).toBe("success");
    expect(await warehouse.getCursor("receipts")).not.toBeNull();
    expect(await count(db, "sales_lines")).toBeGreaterThan(0);
  });

  it("line_items of refund receipts are loaded with the sign flipped as negative qty", async () => {
    const { db, warehouse, loyverseClient, clock } = await setup();
    const receipts = await allReceipts(loyverseClient);
    const refund = receipts.find((r) => r.receipt_type === "REFUND" && r.cancelled_at === null);
    if (!refund) throw new Error("the fixture must contain a non-cancelled REFUND receipt");
    const firstLine = refund.line_items[0];
    if (!firstLine) throw new Error("the REFUND receipt must have line_items");

    await syncAll({ loyverseClient, warehouse, clock });

    const { rows } = await db.query<{ qty: string }>(
      "select qty from sales_lines where receipt_id = $1 and line_no = 0",
      [refund.receipt_number],
    );
    expect(Number(rows[0]?.qty)).toBe(-firstLine.quantity);
  });

  it("syncing twice leaves two distinct runs (run_id) in inventory_snapshots — distinguished by randomUUID even with a FixedClock", async () => {
    const { db, warehouse, loyverseClient, clock } = await setup();
    await syncAll({ loyverseClient, warehouse, clock });
    await syncAll({ loyverseClient, warehouse, clock });

    const { rows } = await db.query<{ count: string }>(
      "select count(distinct run_id)::text as count from inventory_snapshots",
    );
    expect(rows[0]?.count).toBe("2");
  });
});

describe("etl/sync — additional policies", () => {
  it("cancelled receipts are not loaded into sales_lines (SPEC §9)", async () => {
    const { db, warehouse, loyverseClient, clock } = await setup();
    const receipts = await allReceipts(loyverseClient);
    const cancelled = receipts.find((r) => r.cancelled_at !== null);
    if (!cancelled) throw new Error("the fixture must contain a cancelled receipt");

    await syncAll({ loyverseClient, warehouse, clock });

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from sales_lines where receipt_id = $1",
      [cancelled.receipt_number],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("an empty inventory response is treated as a sync error and leaves the existing stock untouched", async () => {
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

  it("if stores fail, receipts/inventory are not attempted because of the FK dependency and are reported as skipped", async () => {
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
    // items does not depend on stores, so it is still attempted independently.
    expect(result.resources.find((r) => r.resource === "items")?.status).toBe("success");
    // receipts/inventory reference stores and products via FK, so once stores failed they are not attempted.
    expect(result.resources.find((r) => r.resource === "receipts")?.status).toBe("skipped");
    expect(result.resources.find((r) => r.resource === "inventory")?.status).toBe("skipped");
  });

  it("receipts with identical updated_at spanning a page boundary are all loaded without omission", async () => {
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
      listStores: () => Promise.resolve([{ id: "s1", name: "Store" }]),
      listItems: () =>
        Promise.resolve({
          items: [
            {
              id: "i1",
              item_name: "Item",
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
        const pageSize = 1; // force the tied updated_at values across a page boundary
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

  it("an item with multiple variants is flattened into separate ProductRows, and category holds category_id as-is", async () => {
    const { db, warehouse, clock } = await setup();
    const client: LoyverseClient = {
      listStores: () => Promise.resolve([{ id: "s1", name: "Store" }]),
      listItems: () =>
        Promise.resolve({
          items: [
            {
              id: "i1",
              item_name: "T-shirt",
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
