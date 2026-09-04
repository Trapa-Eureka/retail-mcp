/**
 * Performance guard (TESTING.md §4 "performance guard"): loading 50,000 sales lines via ETL
 * plus computing reorder_suggestions (= buildReorderReport()) must take less than BUDGET_MS in
 * total (on PGlite). fixtures/loyverse/*.json are too small for this purpose, so a synthetic
 * (in-memory) LoyverseClient used only here generates 50,000 receipt lines.
 */
import { describe, expect, it } from "vitest";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import { syncAll } from "../src/etl/sync.js";
import { buildReorderReport } from "../src/agent/reorder.js";
import type { LoyverseClient, LvItem, LvReceipt, LvStore } from "../src/core/types.js";

const STORE_ID = "store_perf";
const PRODUCT_COUNT = 50;

/**
 * Locally this is always around ~2s (with plenty of headroom even generously), but on GitHub
 * Actions shared runners exceeding 5s due to noise was a repeatedly observed pattern, not an
 * occasional flake (measured while responding to the second adversarial review:
 * 5015/5042/5117/5165/5300/5392/5463/6567/6947ms — all of them also appeared in the plain
 * `test` job without `--coverage`, TASKS). 5000ms was too tight for the CI environment — raised
 * to 10s, a clear margin above the observed worst case (6947ms). It is still 5x the normal local
 * run (~2s), so a real O(n²)-type regression is still caught.
 */
const BUDGET_MS = 10_000;

function makeSyntheticLoyverseClient(
  now: Date,
  totalLines: number,
  pageSize: number,
): LoyverseClient {
  const stores: LvStore[] = [{ id: STORE_ID, name: "Perf Test Store" }];
  const items: LvItem[] = Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
    id: `itm_${i}`,
    item_name: `Product ${i}`,
    category_id: null,
    variants: [{ variant_id: `var_${i}`, sku: `SKU-${i}` }],
  }));

  const receipts: LvReceipt[] = [];
  for (let i = 0; i < totalLines; i++) {
    // Spread evenly across the last 28-day window — so daysOfCover/avgDailySales actually get values.
    const dayOffset = i % 28;
    const soldAt = new Date(now.getTime() - dayOffset * 86_400_000 - (i % 3600) * 1000);
    const iso = soldAt.toISOString();
    receipts.push({
      receipt_number: `R-PERF-${i}`,
      store_id: STORE_ID,
      receipt_type: "SALE",
      refund_for: null,
      created_at: iso,
      updated_at: iso,
      receipt_date: iso,
      cancelled_at: null,
      line_items: [
        {
          variant_id: `var_${i % PRODUCT_COUNT}`,
          item_id: `itm_${i % PRODUCT_COUNT}`,
          quantity: 1,
          gross_total_money: 100,
          total_discount: 0,
        },
      ],
    });
  }

  return {
    listStores: () => Promise.resolve(stores),
    listItems: () => Promise.resolve({ items, cursor: null }),
    listReceipts: (sinceISO, cursor) => {
      const start = cursor !== undefined ? Number(cursor) : 0;
      const end = Math.min(start + pageSize, receipts.length);
      const page = receipts.slice(start, end).filter((r) => r.updated_at >= sinceISO);
      return Promise.resolve({ items: page, cursor: end < receipts.length ? String(end) : null });
    },
    listInventory: () =>
      Promise.resolve({
        items: Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
          store_id: STORE_ID,
          variant_id: `var_${i}`,
          in_stock: 100,
          updated_at: now.toISOString(),
        })),
        cursor: null,
      }),
  };
}

describe("performance guard — 50,000 sales lines (TESTING §4)", () => {
  it("ETL load + reorder_suggestions computation takes less than BUDGET_MS in total (on PGlite)", async () => {
    const db = await createTestWarehouse();
    const warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    const clock = createFixedClock("2026-09-01T00:00:00.000Z");
    const loyverseClient = makeSyntheticLoyverseClient(clock.now(), 50_000, 5000);

    const startedAt = Date.now();
    const syncResult = await syncAll({ loyverseClient, warehouse, clock }, {});
    const report = await buildReorderReport(
      { warehouse, clock },
      { businessTimezone: "Asia/Manila" },
    );
    const elapsedMs = Date.now() - startedAt;

    expect(syncResult.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);

    // Also verify that 50,000 rows were actually loaded so the performance figure stays meaningful.
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from sales_lines",
    );
    expect(Number(rows[0]?.count)).toBe(50_000);
    expect(report.stores.length).toBeGreaterThan(0);
  });
});
