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
              // PRODUCT_COLA/PRODUCT_CHIPS 둘 다 packSize를 안 줬다 — 낱개 매입 취급.
              packSize: null,
              finalOrderQty: 42,
              packCount: null,
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
              packSize: null,
              finalOrderQty: 16,
              packCount: null,
            },
          ],
        },
      ]);
      expect(report.dataLastSyncedAt).toEqual(new Date(NOW_ISO));
      expect(countSuggestions(report)).toBe(2);
    });

    it("packSize(포장수량, SPEC §14/TASKS T25)가 있으면 최종 발주량을 팩 배수로 올린다", async () => {
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: "24" }]); // 제안량 42 → 2팩=48
      await seedSalesAndStock(warehouse);
      const report = await buildReorderReport(
        { warehouse, clock: createFixedClock(NOW_ISO) },
        { businessTimezone: BUSINESS_TIMEZONE, storeId: "store_main" },
      );
      const cola = report.stores[0]?.items[0];
      expect(cola?.reorderQty).toBe(42);
      expect(cola?.packSize).toBe(24);
      expect(cola?.finalOrderQty).toBe(48);
      expect(cola?.packCount).toBe(2);
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

  describe("같은 run_id 재시도 — provider dedupe TTL 상태 머신(2차 적대적 검수 SR2-MAIL-003)", () => {
    // NOW_ISO(2026-09-01T09:00:00Z) 기준으로 계산 — 고정 문자열을 쓰면 NOW_ISO가 바뀔 때 TTL
    // 안/밖 판정이 조용히 뒤집힌다(folderScan.test.ts와 같은 이유).
    const HOUR = 60 * 60 * 1000;
    const RETRY_1H_LATER = new Date(new Date(NOW_ISO).getTime() + 1 * HOUR).toISOString();
    const RETRY_25H_LATER = new Date(new Date(NOW_ISO).getTime() + 25 * HOUR).toISOString();
    const liveOpts = {
      businessTimezone: BUSINESS_TIMEZONE,
      sendMode: "live" as const,
      confirm: true,
      recipient: "owner@example.com",
    };
    // 실제 resendProvider.ts가 응답 유실 시 던지는 것과 같은 모양(.name)의 provider. dedupeTtlMs는
    // 실 Resend와 같이 24시간으로 선언한다(unknown을 남기는 역할만 하고 실제 send는 항상 실패).
    const ambiguousProvider = {
      channel: "email" as const,
      dedupeTtlMs: 24 * 60 * 60 * 1000,
      send: () => {
        const err = new Error("Resend 요청이 타임아웃됐습니다(시뮬레이션).");
        err.name = "AmbiguousSendError";
        return Promise.reject(err);
      },
    };

    async function statusesOf(
      runId: string,
    ): Promise<{ status: string; error_code: string | null }[]> {
      const { rows } = await db.query<{ status: string; error_code: string | null }>(
        "select status, error_code from agent_send_log where run_id = $1 order by id asc",
        [runId],
      );
      return rows;
    }

    it("unknown 뒤 TTL 안(1시간 뒤)의 같은 run_id 재시도는 허용되고 실제로 발송된다", async () => {
      await seedSalesAndStock(warehouse);
      const opts = { ...liveOpts, runId: "run-retry-ok" };

      await expect(
        runReorderAgent(makeDeps({ notificationProvider: ambiguousProvider }), opts),
      ).rejects.toThrow(/타임아웃/);
      expect(await statusesOf("run-retry-ok")).toEqual([
        { status: "unknown", error_code: "AmbiguousSendError" },
      ]);

      const provider = createMockNotificationProvider();
      const retried = await runReorderAgent(
        makeDeps({ clock: createFixedClock(RETRY_1H_LATER), notificationProvider: provider }),
        opts,
      );
      expect(retried.status).toBe("sent");
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]?.idempotencyKey).toBe("run-retry-ok"); // 같은 키 → provider가 dedupe
      expect(await statusesOf("run-retry-ok")).toEqual([
        { status: "unknown", error_code: "AmbiguousSendError" },
        { status: "sent", error_code: null },
      ]);
    });

    it("unknown 뒤 TTL이 지난(25시간 뒤) 같은 run_id 재시도는 SendRetryRefusedError로 거부되고 provider는 호출되지 않는다", async () => {
      await seedSalesAndStock(warehouse);
      const opts = { ...liveOpts, runId: "run-retry-late" };

      await expect(
        runReorderAgent(makeDeps({ notificationProvider: ambiguousProvider }), opts),
      ).rejects.toThrow(/타임아웃/);

      const provider = createMockNotificationProvider();
      await expect(
        runReorderAgent(
          makeDeps({ clock: createFixedClock(RETRY_25H_LATER), notificationProvider: provider }),
          opts,
        ),
      ).rejects.toMatchObject({
        name: "SendRetryRefusedError",
        message: expect.stringMatching(/보존 기간.*지났습니다.*--run-id 없이/s) as unknown,
      });
      expect(provider.sent).toHaveLength(0);
      // 로그는 그대로 — 새 sending 예약이 만들어지지 않았다.
      expect(await statusesOf("run-retry-late")).toEqual([
        { status: "unknown", error_code: "AmbiguousSendError" },
      ]);
    });

    it("sending에 멈춘 행(크래시 흉내)은 TTL 안 재시도에서 unknown(stale_sending)으로 마감된 뒤 새 예약으로 발송된다", async () => {
      await seedSalesAndStock(warehouse);
      // 이전 실행이 예약만 하고 죽은 상황 — sending 행만 남아 있다.
      await warehouse.logAgentSend({
        runId: "run-stale",
        sentAt: new Date(NOW_ISO),
        status: "sending",
        recipient: "owner@example.com",
        subject: "s",
        suggestionCount: 2,
        messageId: null,
        dryRun: false,
        errorCode: null,
      });

      const provider = createMockNotificationProvider();
      const retried = await runReorderAgent(
        makeDeps({ clock: createFixedClock(RETRY_1H_LATER), notificationProvider: provider }),
        { ...liveOpts, runId: "run-stale" },
      );
      expect(retried.status).toBe("sent");
      expect(provider.sent).toHaveLength(1);
      expect(await statusesOf("run-stale")).toEqual([
        { status: "unknown", error_code: "stale_sending" },
        { status: "sent", error_code: null },
      ]);
      // stale 마감의 sent_at은 원래 예약 시각을 유지한다(TTL 기준 시각 보존).
      const { rows } = await db.query<{ sent_at: string | Date }>(
        "select sent_at from agent_send_log where run_id = 'run-stale' and status = 'unknown'",
      );
      expect(new Date(rows[0]!.sent_at).toISOString()).toBe(new Date(NOW_ISO).toISOString());
    });

    it("sending에 멈춘 행이 TTL을 지났으면 마감하지 않고 거부한다 — 행은 sending 그대로 남는다", async () => {
      await seedSalesAndStock(warehouse);
      await warehouse.logAgentSend({
        runId: "run-stale-late",
        sentAt: new Date(NOW_ISO),
        status: "sending",
        recipient: "owner@example.com",
        subject: "s",
        suggestionCount: 2,
        messageId: null,
        dryRun: false,
        errorCode: null,
      });

      const provider = createMockNotificationProvider();
      await expect(
        runReorderAgent(
          makeDeps({ clock: createFixedClock(RETRY_25H_LATER), notificationProvider: provider }),
          { ...liveOpts, runId: "run-stale-late" },
        ),
      ).rejects.toMatchObject({
        name: "SendRetryRefusedError",
        message: expect.stringContaining("프로세스가 결과를 기록하지 못했습니다") as unknown,
      });
      expect(provider.sent).toHaveLength(0);
      expect(await statusesOf("run-stale-late")).toEqual([{ status: "sending", error_code: null }]);
    });

    it("provider가 dedupe를 지원하지 않으면(dedupeTtlMs 없음) unknown 뒤 같은 run_id 재시도는 즉시 거부된다", async () => {
      await seedSalesAndStock(warehouse);
      const opts = { ...liveOpts, runId: "run-no-dedupe" };
      await expect(
        runReorderAgent(makeDeps({ notificationProvider: ambiguousProvider }), opts),
      ).rejects.toThrow(/타임아웃/);

      const noDedupeProvider = createMockNotificationProvider({ dedupeTtlMs: null });
      expect(noDedupeProvider.dedupeTtlMs).toBeUndefined();
      await expect(
        runReorderAgent(
          makeDeps({
            clock: createFixedClock(RETRY_1H_LATER),
            notificationProvider: noDedupeProvider,
          }),
          opts,
        ),
      ).rejects.toThrow(/중복 방지를 지원하지 않아/);
      expect(noDedupeProvider.sent).toHaveLength(0);
    });

    it("회귀: failed(확실한 실패) 뒤 같은 run_id 재시도는 TTL과 무관하게 허용된다", async () => {
      await seedSalesAndStock(warehouse);
      const opts = { ...liveOpts, runId: "run-after-failed" };
      await expect(
        runReorderAgent(
          makeDeps({
            notificationProvider: createMockNotificationProvider({
              failFor: ["owner@example.com"],
            }),
          }),
          opts,
        ),
      ).rejects.toThrow(/failFor/);
      expect(await statusesOf("run-after-failed")).toEqual([
        { status: "failed", error_code: "Error" },
      ]);

      const provider = createMockNotificationProvider();
      const retried = await runReorderAgent(
        makeDeps({ clock: createFixedClock(RETRY_25H_LATER), notificationProvider: provider }),
        opts,
      );
      expect(retried.status).toBe("sent");
      expect(provider.sent).toHaveLength(1);
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
