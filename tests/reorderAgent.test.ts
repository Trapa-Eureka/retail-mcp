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

const STORE_MAIN: StoreRow = { id: "store_main", name: "Main Store" };
const STORE_MAKATI: StoreRow = { id: "store_makati", name: "South Branch" };
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
// 28-day window = [2026-08-03T16:00:00Z, 2026-08-31T16:00:00Z).
const NOW_ISO = "2026-09-01T09:00:00Z";
const BUSINESS_TIMEZONE = "Asia/Manila";

async function seedSalesAndStock(warehouse: Warehouse): Promise<void> {
  // store_main / var_cola: 56 sold in the 28-day window (= avg daily 2), stock 0 → 0 days of cover, suggestion 42.
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
  // store_makati / var_chips: 28 sold in the 28-day window (= avg daily 1), stock 5 → 5 days of cover, suggestion 16.
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

describe("reorder agent (agent/reorder.ts)", () => {
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
    it("throws an error stating the cause for a non-existent store_id", async () => {
      await expect(
        buildReorderReport(
          { warehouse, clock: createFixedClock(NOW_ISO) },
          { businessTimezone: BUSINESS_TIMEZONE, storeId: "store_nope" },
        ),
      ).rejects.toThrow(/Unknown store_id/);
    });

    it("groups by store and sorts by suggested qty descending", async () => {
      await seedSalesAndStock(warehouse);
      const report = await buildReorderReport(
        { warehouse, clock: createFixedClock(NOW_ISO) },
        { businessTimezone: BUSINESS_TIMEZONE },
      );
      expect(report.stores).toEqual([
        {
          storeId: "store_main",
          storeName: "Main Store",
          items: [
            {
              variantId: "var_cola",
              name: "Cola 500ml",
              inStock: 0,
              avgDailySales: 2,
              daysOfCover: 0,
              reorderQty: 42,
              // Neither PRODUCT_COLA nor PRODUCT_CHIPS was given a packSize — treated as single-unit purchase.
              packSize: null,
              finalOrderQty: 42,
              packCount: null,
            },
          ],
        },
        {
          storeId: "store_makati",
          storeName: "South Branch",
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

    it("with a packSize (SPEC §14/TASKS T25) the final order qty is rounded up to a pack multiple", async () => {
      await warehouse.upsertProducts([{ ...PRODUCT_COLA, packSize: "24" }]); // suggestion 42 → 2 packs = 48
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

  describe("0 suggestions", () => {
    it("sends nothing; only no_suggestions is recorded in agent_send_log", async () => {
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
    it("0 provider calls; the dry-run output (stdout) and the return value contain the table", async () => {
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
      expect(result.reportText).toContain("Cola 500ml");
      expect(result.reportText).toContain("Main Store");
      const loggedOutput = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(loggedOutput).toContain("Cola 500ml");

      const { rows } = await db.query<{ status: string; dry_run: boolean }>(
        "select status, dry_run from agent_send_log where run_id = 'run-dry'",
      );
      expect(rows[0]?.status).toBe("dry_run");
      expect(rows[0]?.dry_run).toBe(true);
    });
  });

  describe("double gate — SEND_MODE=live && --confirm", () => {
    it("live alone (without confirm) does not send", async () => {
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

    it("confirm alone (SEND_MODE=dry_run) does not send", async () => {
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

    it("only with both live and confirm is the provider called and sent recorded", async () => {
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

    it("throws an error stating the cause when recipient is missing", async () => {
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

  describe("Summarizer failure", () => {
    it("continues the send with the table only, without a summary", async () => {
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
      expect(provider.sent[0]?.text).toContain("Cola 500ml");
    });
  });

  describe("duplicate-send prevention (same run_id retry)", () => {
    it("re-running with an already sent run_id does not re-send and throws an error", async () => {
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

      await expect(runReorderAgent(deps, opts)).rejects.toThrow(/run_id.*already/);

      const provider = deps.notificationProvider as ReturnType<
        typeof createMockNotificationProvider
      >;
      expect(provider.sent).toHaveLength(1); // provider.send() was not called on the second run
    });
  });

  describe("same run_id retry — provider dedupe TTL state machine (second adversarial review SR2-MAIL-003)", () => {
    // Computed relative to NOW_ISO (2026-09-01T09:00:00Z) — with fixed strings the inside/outside
    // TTL judgement would silently flip if NOW_ISO changed (same reason as folderScan.test.ts).
    const HOUR = 60 * 60 * 1000;
    const RETRY_1H_LATER = new Date(new Date(NOW_ISO).getTime() + 1 * HOUR).toISOString();
    const RETRY_25H_LATER = new Date(new Date(NOW_ISO).getTime() + 25 * HOUR).toISOString();
    const liveOpts = {
      businessTimezone: BUSINESS_TIMEZONE,
      sendMode: "live" as const,
      confirm: true,
      recipient: "owner@example.com",
    };
    // A provider throwing the same shape (.name) the real resendProvider.ts throws on a lost
    // response. dedupeTtlMs is declared as 24 hours like real Resend (its only role is to leave an
    // unknown; the actual send always fails).
    const ambiguousProvider = {
      channel: "email" as const,
      dedupeTtlMs: 24 * 60 * 60 * 1000,
      send: () => {
        const err = new Error("The Resend request timed out (simulated).");
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

    it("a same-run_id retry within the TTL (1 hour later) after unknown is allowed and actually sends", async () => {
      await seedSalesAndStock(warehouse);
      const opts = { ...liveOpts, runId: "run-retry-ok" };

      await expect(
        runReorderAgent(makeDeps({ notificationProvider: ambiguousProvider }), opts),
      ).rejects.toThrow(/timed out/);
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
      expect(provider.sent[0]?.idempotencyKey).toBe("run-retry-ok"); // same key → the provider dedupes
      expect(await statusesOf("run-retry-ok")).toEqual([
        { status: "unknown", error_code: "AmbiguousSendError" },
        { status: "sent", error_code: null },
      ]);
    });

    it("a same-run_id retry after the TTL (25 hours later) after unknown is refused with SendRetryRefusedError and the provider is not called", async () => {
      await seedSalesAndStock(warehouse);
      const opts = { ...liveOpts, runId: "run-retry-late" };

      await expect(
        runReorderAgent(makeDeps({ notificationProvider: ambiguousProvider }), opts),
      ).rejects.toThrow(/timed out/);

      const provider = createMockNotificationProvider();
      await expect(
        runReorderAgent(
          makeDeps({ clock: createFixedClock(RETRY_25H_LATER), notificationProvider: provider }),
          opts,
        ),
      ).rejects.toMatchObject({
        name: "SendRetryRefusedError",
        message: expect.stringMatching(
          /retention window.*has passed.*without --run-id/s,
        ) as unknown,
      });
      expect(provider.sent).toHaveLength(0);
      // The log is unchanged — no new sending reservation was created.
      expect(await statusesOf("run-retry-late")).toEqual([
        { status: "unknown", error_code: "AmbiguousSendError" },
      ]);
    });

    it("a row stuck in sending (simulated crash) is closed as unknown (stale_sending) on a within-TTL retry, then sent under a new reservation", async () => {
      await seedSalesAndStock(warehouse);
      // The previous run reserved and died — only the sending row remains.
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
      // The stale closure keeps the original reservation time as sent_at (preserving the TTL anchor).
      const { rows } = await db.query<{ sent_at: string | Date }>(
        "select sent_at from agent_send_log where run_id = 'run-stale' and status = 'unknown'",
      );
      expect(new Date(rows[0]!.sent_at).toISOString()).toBe(new Date(NOW_ISO).toISOString());
    });

    it("a row stuck in sending past the TTL is refused without being closed — the row stays sending", async () => {
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
        message: expect.stringMatching(/process .*record/) as unknown,
      });
      expect(provider.sent).toHaveLength(0);
      expect(await statusesOf("run-stale-late")).toEqual([{ status: "sending", error_code: null }]);
    });

    it("when the provider does not support dedupe (no dedupeTtlMs), a same-run_id retry after unknown is refused immediately", async () => {
      await seedSalesAndStock(warehouse);
      const opts = { ...liveOpts, runId: "run-no-dedupe" };
      await expect(
        runReorderAgent(makeDeps({ notificationProvider: ambiguousProvider }), opts),
      ).rejects.toThrow(/timed out/);

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
      ).rejects.toThrow(/does not support/);
      expect(noDedupeProvider.sent).toHaveLength(0);
    });

    it("regression: a same-run_id retry after failed (definite failure) is allowed regardless of the TTL", async () => {
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

  it("renderReportText contains stores, items and warnings in human-readable form", async () => {
    await seedSalesAndStock(warehouse);
    const report = await buildReorderReport(
      { warehouse, clock: createFixedClock(NOW_ISO) },
      { businessTimezone: BUSINESS_TIMEZONE },
    );
    const text = renderReportText(report, "This is the summary sentence.");
    expect(text).toContain("This is the summary sentence.");
    expect(text).toContain("Main Store");
    expect(text).toContain("suggested qty 42");
  });
});
