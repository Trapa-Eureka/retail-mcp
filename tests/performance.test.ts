/**
 * 성능 가드 (TESTING.md §4 "성능 가드"): 판매 라인 50,000행을 ETL로 적재하고
 * reorder_suggestions(=buildReorderReport())까지 계산한 합계가 5초 미만이어야 한다
 * (PGlite 기준). fixtures/loyverse/*.json은 규모가 작아 이 목적에 맞지 않으므로,
 * 여기서만 쓰는 합성(in-memory) LoyverseClient로 50,000개 영수증 라인을 생성한다.
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

function makeSyntheticLoyverseClient(
  now: Date,
  totalLines: number,
  pageSize: number,
): LoyverseClient {
  const stores: LvStore[] = [{ id: STORE_ID, name: "성능테스트매장" }];
  const items: LvItem[] = Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
    id: `itm_${i}`,
    item_name: `상품${i}`,
    category_id: null,
    variants: [{ variant_id: `var_${i}`, sku: `SKU-${i}` }],
  }));

  const receipts: LvReceipt[] = [];
  for (let i = 0; i < totalLines; i++) {
    // 최근 28일 창 안에 고르게 분산 — daysOfCover/avgDailySales 계산이 실제로 값을 갖게 한다.
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

describe("성능 가드 — 판매 라인 50,000행 (TESTING §4)", () => {
  it("ETL 적재 + reorder_suggestions 계산 합계가 5초 미만이다 (PGlite 기준)", async () => {
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
    expect(elapsedMs).toBeLessThan(5000);

    // 성능 수치가 무의미해지지 않도록 실제로 50,000행이 적재됐는지도 확인한다.
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from sales_lines",
    );
    expect(Number(rows[0]?.count)).toBe(50_000);
    expect(report.stores.length).toBeGreaterThan(0);
  });
});
