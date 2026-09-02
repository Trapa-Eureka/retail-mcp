import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import { createMockNotificationProvider } from "../src/mocks/mockNotificationProvider.js";
import { createMockSummarizer } from "../src/mocks/mockSummarizer.js";
import {
  buildReorderReport,
  countSuggestions,
  renderReportText,
  runReorderAgent,
  type ReorderAgentDeps,
} from "../src/agent/reorder.js";
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

// FixedClock "지금" — Asia/Manila(UTC+8) 기준 오늘 자정 = 2026-08-31T16:00:00Z.
// 28일 창 = [2026-08-03T16:00:00Z, 2026-08-31T16:00:00Z).
const NOW_ISO = "2026-09-01T09:00:00Z";
const BUSINESS_TIMEZONE = "Asia/Manila";

async function seedSalesAndStock(warehouse: Warehouse): Promise<void> {
  // store_main / var_cola: 28일 창 내 56개 판매(=일평균 2), 재고 0 → 커버 0일, 제안량 42.
  const salesLine: SalesLineRow = {
    receiptId: "R-1",
    lineNo: 0,
    storeId: "store_main",
    variantId: "var_cola",
    qty: "56",
    gross: "2520",
    discount: "0",
    soldAt: new Date("2026-08-25T09:00:00Z"),
  };
  // store_makati / var_chips: 28일 창 내 28개 판매(=일평균 1), 재고 5 → 커버 5일, 제안량 16.
  const salesLine2: SalesLineRow = {
    receiptId: "R-2",
    lineNo: 0,
    storeId: "store_makati",
    variantId: "var_chips",
    qty: "28",
    gross: "560",
    discount: "0",
    soldAt: new Date("2026-08-20T09:00:00Z"),
  };
  await warehouse.upsertSalesLines([salesLine, salesLine2]);

  const stock: InventoryRow[] = [
    { storeId: "store_main", variantId: "var_cola", inStock: "0", updatedAt: new Date(NOW_ISO) },
    {
      storeId: "store_makati",
      variantId: "var_chips",
      inStock: "5",
      updatedAt: new Date(NOW_ISO),
    },
  ];
  await warehouse.upsertInventory(stock);
  await warehouse.setCursor("inventory", NOW_ISO, new Date(NOW_ISO));
  await warehouse.setCursor("receipts", NOW_ISO, new Date(NOW_ISO));
}

describe("재주문 에이전트 (agent/reorder.ts)", () => {
  let db: PGlite;
  let warehouse: Warehouse;
  let logSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(async () => {
    db = await createTestWarehouse();
    warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    await warehouse.upsertStores([STORE_MAIN, STORE_MAKATI]);
    await warehouse.upsertProducts([PRODUCT_COLA, PRODUCT_CHIPS]);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDeps(overrides: Partial<ReorderAgentDeps> = {}): ReorderAgentDeps {
    return {
      warehouse,
      clock: createFixedClock(NOW_ISO),
      notificationProvider: createMockNotificationProvider(),
      summarizer: createMockSummarizer(),
      ...overrides,
    };
  }

  describe("buildReorderReport", () => {
    it("존재하지 않는 store_id면 원인이 담긴 에러를 던진다", async () => {
      await expect(
        buildReorderReport(
          { warehouse, clock: createFixedClock(NOW_ISO) },
          { businessTimezone: BUSINESS_TIMEZONE, storeId: "store_nope" },
        ),
      ).rejects.toThrow(/존재하지 않는 store_id/);
    });

    it("매장별로 묶고 제안량 내림차순으로 정렬한다", async () => {
      await seedSalesAndStock(warehouse);
      const report = await buildReorderReport(
        { warehouse, clock: createFixedClock(NOW_ISO) },
        { businessTimezone: BUSINESS_TIMEZONE },
      );
      expect(report.stores).toEqual([
        {
          storeId: "store_main",
          storeName: "본점",
          items: [
            {
              variantId: "var_cola",
              name: "코카콜라 500ml",
              inStock: 0,
              avgDailySales: 2,
              daysOfCover: 0,
              reorderQty: 42,
            },
          ],
        },
        {
          storeId: "store_makati",
          storeName: "마카티점",
          items: [
            {
              variantId: "var_chips",
              name: "Piattos",
              inStock: 5,
              avgDailySales: 1,
              daysOfCover: 5,
              reorderQty: 16,
            },
          ],
        },
      ]);
      expect(report.dataLastSyncedAt).toEqual(new Date(NOW_ISO));
      expect(countSuggestions(report)).toBe(2);
    });
  });

  describe("제안 0건", () => {
    it("발송 0건, agent_send_log에 no_suggestions만 기록된다", async () => {
      const deps = makeDeps();
      const result = await runReorderAgent(deps, {
        businessTimezone: BUSINESS_TIMEZONE,
        sendMode: "live",
        confirm: true,
        recipient: "owner@example.com",
        runId: "run-empty",
      });

      expect(result.status).toBe("no_suggestions");
      expect(result.suggestionCount).toBe(0);
      expect(
        (deps.notificationProvider as ReturnType<typeof createMockNotificationProvider>).sent,
      ).toHaveLength(0);

      const { rows } = await db.query<{ status: string }>(
        "select status from agent_send_log where run_id = 'run-empty'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("no_suggestions");
    });
  });

  describe("SEND_MODE=dry_run", () => {
    it("provider 호출 0건, dry-run 출력(stdout)과 반환값에 표가 포함된다", async () => {
      await seedSalesAndStock(warehouse);
      const deps = makeDeps();
      const result = await runReorderAgent(deps, {
        businessTimezone: BUSINESS_TIMEZONE,
        sendMode: "dry_run",
        runId: "run-dry",
      });

      expect(result.status).toBe("dry_run");
      expect(result.sent).toBe(false);
      expect(
        (deps.notificationProvider as ReturnType<typeof createMockNotificationProvider>).sent,
      ).toHaveLength(0);
      expect(result.reportText).toContain("코카콜라 500ml");
      expect(result.reportText).toContain("본점");
      const loggedOutput = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(loggedOutput).toContain("코카콜라 500ml");

      const { rows } = await db.query<{ status: string; dry_run: boolean }>(
        "select status, dry_run from agent_send_log where run_id = 'run-dry'",
      );
      expect(rows[0]?.status).toBe("dry_run");
      expect(rows[0]?.dry_run).toBe(true);
    });
  });

  describe("이중 게이트 — SEND_MODE=live && --confirm", () => {
    it("live만으로는(confirm 없이) 발송하지 않는다", async () => {
      await seedSalesAndStock(warehouse);
      const deps = makeDeps();
      const result = await runReorderAgent(deps, {
        businessTimezone: BUSINESS_TIMEZONE,
        sendMode: "live",
        confirm: false,
        runId: "run-live-only",
      });
      expect(result.status).toBe("dry_run");
      expect(
        (deps.notificationProvider as ReturnType<typeof createMockNotificationProvider>).sent,
      ).toHaveLength(0);
    });

    it("confirm만으로는(SEND_MODE=dry_run) 발송하지 않는다", async () => {
      await seedSalesAndStock(warehouse);
      const deps = makeDeps();
      const result = await runReorderAgent(deps, {
        businessTimezone: BUSINESS_TIMEZONE,
        sendMode: "dry_run",
        confirm: true,
        runId: "run-confirm-only",
      });
      expect(result.status).toBe("dry_run");
      expect(
        (deps.notificationProvider as ReturnType<typeof createMockNotificationProvider>).sent,
      ).toHaveLength(0);
    });

    it("live와 confirm 둘 다일 때만 provider가 호출되고 sent로 기록된다", async () => {
      await seedSalesAndStock(warehouse);
      const deps = makeDeps();
      const result = await runReorderAgent(deps, {
        businessTimezone: BUSINESS_TIMEZONE,
        sendMode: "live",
        confirm: true,
        recipient: "owner@example.com",
        runId: "run-live-confirm",
      });

      expect(result.status).toBe("sent");
      expect(result.sent).toBe(true);
      const provider = deps.notificationProvider as ReturnType<
        typeof createMockNotificationProvider
      >;
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]?.to).toBe("owner@example.com");

      const { rows } = await db.query<{ status: string; dry_run: boolean; message_id: string }>(
        "select status, dry_run, message_id from agent_send_log where run_id = 'run-live-confirm'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("sent");
      expect(rows[0]?.dry_run).toBe(false);
      expect(rows[0]?.message_id).toBeTruthy();
    });

    it("recipient가 없으면 원인이 담긴 에러를 던진다", async () => {
      await seedSalesAndStock(warehouse);
      const deps = makeDeps();
      await expect(
        runReorderAgent(deps, {
          businessTimezone: BUSINESS_TIMEZONE,
          sendMode: "live",
          confirm: true,
          runId: "run-no-recipient",
        }),
      ).rejects.toThrow(/REPORT_RECIPIENT/);
    });
  });

  describe("Summarizer 실패", () => {
    it("요약 없이 표만으로 발송을 계속 진행한다", async () => {
      await seedSalesAndStock(warehouse);
      const deps = makeDeps({ summarizer: createMockSummarizer({ fail: true }) });
      const result = await runReorderAgent(deps, {
        businessTimezone: BUSINESS_TIMEZONE,
        sendMode: "live",
        confirm: true,
        recipient: "owner@example.com",
        runId: "run-summarizer-fail",
      });

      expect(result.summary).toBeNull();
      expect(result.status).toBe("sent");
      const provider = deps.notificationProvider as ReturnType<
        typeof createMockNotificationProvider
      >;
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]?.text).toContain("코카콜라 500ml");
    });
  });

  describe("이중 발송 방지 (같은 run_id 재시도)", () => {
    it("이미 sent인 run_id로 다시 실행하면 재발송하지 않고 에러를 던진다", async () => {
      await seedSalesAndStock(warehouse);
      const deps = makeDeps();
      const opts = {
        businessTimezone: BUSINESS_TIMEZONE,
        sendMode: "live" as const,
        confirm: true,
        recipient: "owner@example.com",
        runId: "run-dup",
      };

      const first = await runReorderAgent(deps, opts);
      expect(first.status).toBe("sent");

      await expect(runReorderAgent(deps, opts)).rejects.toThrow(
        /이미 발송 중이거나 발송 완료된 실행/,
      );

      const provider = deps.notificationProvider as ReturnType<
        typeof createMockNotificationProvider
      >;
      expect(provider.sent).toHaveLength(1); // 두 번째 실행에서는 provider.send()가 호출되지 않았다
    });
  });

  it("renderReportText는 매장·품목·경고를 사람이 읽는 형태로 담는다", async () => {
    await seedSalesAndStock(warehouse);
    const report = await buildReorderReport(
      { warehouse, clock: createFixedClock(NOW_ISO) },
      { businessTimezone: BUSINESS_TIMEZONE },
    );
    const text = renderReportText(report, "요약 문장입니다.");
    expect(text).toContain("요약 문장입니다.");
    expect(text).toContain("본점");
    expect(text).toContain("제안수량 42");
  });
});
