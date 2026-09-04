#!/usr/bin/env node
/**
 * Reorder suggestion agent (DESIGN.md §7).
 *
 * Flow: load opts → (optional) sync_now → reorderSuggestions (core, deterministic) → if 0
 * suggestions, only log and exit → assemble the report (per-branch tables) → 2-3 sentence wording
 * from the Summarizer (LLM; on failure continue with the table only) → provider.send only when
 * SEND_MODE=live && --confirm are both present, otherwise dry-run output → record in agent_send_log.
 *
 * `buildReorderReport()` is pure orchestration doing deterministic calculation only, so the T9
 * `reorder_suggestions` MCP tool reuses it as is (the same-core regression guard, docs/TASKS.md T9
 * dependency "T8 (to confirm core reuse)"). `runReorderAgent()` layers summary, sending and logging
 * on top. Only `main()` at the bottom of this file is the CLI entry point that assembles the real
 * adapters; all the logic lives in those two functions.
 */
import { randomUUID } from "node:crypto";
import { parseNamedArg } from "../core/cliArgs.js";
import { DEFAULT_STALE_THRESHOLD_HOURS, computeFreshness } from "../core/freshness.js";
import {
  DEFAULT_WINDOW_DAYS,
  applyPackRounding,
  calendarWindow,
  computeReorderMetrics,
  type ReorderOptions,
} from "../core/metrics.js";
import type {
  AgentSendStatus,
  Clock,
  NotificationProvider,
  ReorderLineItem,
  ReorderReport,
  ReorderStoreSection,
  Summarizer,
  Warehouse,
} from "../core/types.js";
import { createClaudeSummarizer } from "../adapters/claudeSummarizer.js";
import { createLoyverseClientFromEnv } from "../adapters/loyverseClient.js";
import { isMainModule } from "../adapters/mainModule.js";
import { createResendEmailProvider } from "../adapters/resendProvider.js";
import { logStructured } from "../adapters/structuredLog.js";
import { createSystemClock } from "../adapters/systemClock.js";
import {
  createWarehouseFromEnv,
  ensureNetworkMigrationsApplied,
} from "../adapters/warehouseFactory.js";
import { syncAll } from "../etl/sync.js";
import { enforceSameRunRetryPolicy } from "./sendRetryGate.js";

// ── Report assembly (deterministic, reused by T9) ─────────────────────────

export interface BuildReportOptions {
  /** Business timezone (e.g. Asia/Manila). No implicit default — the caller states it (CLAUDE.md). */
  businessTimezone: string;
  /** If given, only this store. A non-existent store_id throws an error stating the cause. */
  storeId?: string;
  windowDays?: number;
  leadTimeDays?: number;
  safetyDays?: number;
  targetCoverDays?: number;
  /** Default DEFAULT_STALE_THRESHOLD_HOURS (24). SPEC §9 stale warning threshold. */
  staleThresholdHours?: number;
}

export interface ReportDeps {
  warehouse: Warehouse;
  clock: Clock;
}

/** Total item count of report.stores = "suggestion count" (number of (store,variant) pairs with reorderQty>0). */
export function countSuggestions(report: ReorderReport): number {
  return report.stores.reduce((sum, s) => sum + s.items.length, 0);
}

/**
 * Computes the per-branch reorder suggestion tables. Only items with reorderQty>0 are included
 * (0 is not a "suggestion"). There is no logic beyond: query salesAgg/stock/stores →
 * core/metrics.computeReorderMetrics (pure calculation) → group by store into a ReorderReport —
 * the only external IO is the warehouse calls.
 */
export async function buildReorderReport(
  deps: ReportDeps,
  opts: BuildReportOptions,
): Promise<ReorderReport> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const { periodStart, periodEnd } = calendarWindow(deps.clock, windowDays, opts.businessTimezone);

  const stores = await deps.warehouse.queryStores(opts.storeId);
  if (opts.storeId !== undefined && stores.length === 0) {
    throw new Error(
      `Unknown store_id: "${opts.storeId}". Check the registered store ids with the ` +
        "sync_status tool or in the stores table.",
    );
  }
  const storeNameById = new Map(stores.map((s) => [s.id, s.name]));

  const [salesAgg, stock] = await Promise.all([
    deps.warehouse.querySalesAgg({
      periodStart,
      periodEnd,
      ...(opts.storeId !== undefined ? { storeId: opts.storeId } : {}),
    }),
    deps.warehouse.queryStock(opts.storeId !== undefined ? { storeId: opts.storeId } : {}),
  ]);

  const metricsOpts: ReorderOptions = {
    windowDays,
    ...(opts.leadTimeDays !== undefined ? { leadTimeDays: opts.leadTimeDays } : {}),
    ...(opts.safetyDays !== undefined ? { safetyDays: opts.safetyDays } : {}),
    ...(opts.targetCoverDays !== undefined ? { targetCoverDays: opts.targetCoverDays } : {}),
  };
  const metrics = computeReorderMetrics(salesAgg, stock, metricsOpts);

  // Pack-multiple rounding (SPEC §14, TASKS T25) — the reorderQty() calculation itself is already
  // done above; this only wraps the result by joining ProductRow.packSize (computeReorderMetrics
  // is unchanged).
  const products = await deps.warehouse.queryProducts(metrics.map((row) => row.variantId));
  const packRounded = applyPackRounding(metrics, products);

  const warnings = new Set<string>();
  const itemsByStore = new Map<string, ReorderLineItem[]>();
  for (const row of packRounded) {
    for (const w of row.warnings) warnings.add(`[${row.storeId}:${row.variantId}] ${w}`);
    if (row.reorderQty <= 0) continue;
    const items = itemsByStore.get(row.storeId) ?? [];
    items.push({
      variantId: row.variantId,
      name: row.name,
      inStock: row.inStock,
      avgDailySales: row.avgDailySales,
      daysOfCover: row.daysOfCover,
      reorderQty: row.reorderQty,
      packSize: row.packSize,
      finalOrderQty: row.finalOrderQty,
      packCount: row.packCount,
    });
    itemsByStore.set(row.storeId, items);
  }

  const sections: ReorderStoreSection[] = [];
  for (const [storeId, items] of itemsByStore) {
    items.sort((a, b) => b.reorderQty - a.reorderQty || a.name.localeCompare(b.name));
    const storeName = storeNameById.get(storeId);
    if (storeName === undefined) {
      // Cannot normally happen given the FK (sales_lines/inventory_levels → stores), but
      // defensively keep the data rather than dropping it: show the store_id as the display name
      // and leave a warning.
      warnings.add(
        `Could not find a store name for store_id (${storeId}); its suggestions are shown under the id.`,
      );
    }
    sections.push({ storeId, storeName: storeName ?? storeId, items });
  }
  sections.sort((a, b) => a.storeId.localeCompare(b.storeId));

  // The report depends on both receipts (sales window) and inventory (current stock) — freshness is
  // judged by the older of the two (SPEC §9, core/freshness.ts shared with the T9 MCP query tools).
  const syncState = await deps.warehouse.getSyncState();
  const freshness = computeFreshness(
    syncState,
    ["receipts", "inventory"],
    deps.clock.now(),
    opts.staleThresholdHours ?? DEFAULT_STALE_THRESHOLD_HOURS,
  );
  for (const w of freshness.warnings) warnings.add(w);

  return {
    generatedAt: deps.clock.now(),
    timezone: opts.businessTimezone,
    dataLastSyncedAt: freshness.dataLastSyncedAt,
    stores: sections,
    warnings: [...warnings],
  };
}

// ── Report rendering (human-readable table — deterministic; the LLM wording is inserted separately) ──

function formatCover(daysOfCover: number | null): string {
  return daysOfCover === null ? "∞" : daysOfCover.toFixed(1);
}

/** Without packSize (single-unit purchase) only the computed qty; with it, "27 → final order qty 48 (2 packs, 24 per pack)". */
function formatOrderQty(item: ReorderLineItem): string {
  if (item.packSize === null || item.packCount === null) return `${item.reorderQty}`;
  return `${item.reorderQty} → final order qty ${item.finalOrderQty} (${item.packCount} packs, ${item.packSize} per pack)`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderReportText(report: ReorderReport, summary: string | null): string {
  const lines: string[] = [
    `Reorder suggestions — generated at ${report.generatedAt.toISOString()} (timezone: ${report.timezone})`,
    `Data last synced: ${report.dataLastSyncedAt ? report.dataLastSyncedAt.toISOString() : "not available"}`,
  ];
  if (summary) {
    lines.push("", summary);
  }
  if (report.stores.length === 0) {
    lines.push("", "No items need reordering.");
  }
  for (const store of report.stores) {
    lines.push("", `[Store: ${store.storeName}] (${store.items.length} item(s))`);
    for (const item of store.items) {
      lines.push(
        `- ${item.name}: in stock ${item.inStock}, avg daily sales ${item.avgDailySales.toFixed(2)}, ` +
          `days of cover ${formatCover(item.daysOfCover)}, suggested qty ${formatOrderQty(item)}`,
      );
    }
  }
  if (report.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

export function renderReportHtml(report: ReorderReport, summary: string | null): string {
  const parts: string[] = [
    `<p>Generated at ${escapeHtml(report.generatedAt.toISOString())} (timezone: ${escapeHtml(report.timezone)})<br/>`,
    `Data last synced: ${escapeHtml(report.dataLastSyncedAt ? report.dataLastSyncedAt.toISOString() : "not available")}</p>`,
  ];
  if (summary) parts.push(`<p>${escapeHtml(summary)}</p>`);
  for (const store of report.stores) {
    parts.push(
      `<h3>${escapeHtml(store.storeName)}</h3><table><tr>` +
        "<th>Item</th><th>In stock</th><th>Avg daily sales</th><th>Days of cover</th><th>Suggested qty</th></tr>",
    );
    for (const item of store.items) {
      parts.push(
        `<tr><td>${escapeHtml(item.name)}</td><td>${item.inStock}</td>` +
          `<td>${item.avgDailySales.toFixed(2)}</td><td>${formatCover(item.daysOfCover)}</td>` +
          `<td>${escapeHtml(formatOrderQty(item))}</td></tr>`,
      );
    }
    parts.push("</table>");
  }
  if (report.warnings.length > 0) {
    parts.push(
      `<p>Warnings:</p><ul>${report.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`,
    );
  }
  return parts.join("");
}

// ── Send orchestration ────────────────────────────────────────────────────

export interface ReorderAgentDeps extends ReportDeps {
  notificationProvider: NotificationProvider;
  summarizer: Summarizer;
}

export interface ReorderAgentOptions extends BuildReportOptions {
  /** Default: randomUUID(). Reusing the same run_id on a retry lets the duplicate-send reservation block it. */
  runId?: string;
  /** Default: "dry_run". */
  sendMode?: "dry_run" | "live";
  /** Default: false. A real send happens only when this and sendMode="live" are both true (guardrail 1). */
  confirm?: boolean;
  /** Required for a live send. May be omitted for dry-run. */
  recipient?: string;
  subject?: string;
}

export interface ReorderAgentResult {
  runId: string;
  status: AgentSendStatus;
  suggestionCount: number;
  report: ReorderReport;
  /** LLM summary wording. null when the Summarizer failed (continue with the table only, DESIGN §7). */
  summary: string | null;
  /** The full human-readable body (table+summary) — the dry-run output and the real send body use the same text. */
  reportText: string;
  sent: boolean;
  messageId: string | null;
}

function errorCodeOf(err: unknown): string {
  return err instanceof Error && err.name ? err.name : "UnknownError";
}

/** OPS-004 (007 review, TASKS T34) — the same judgement as agent/folderScan.ts. */
function isAmbiguousSendError(err: unknown): boolean {
  return err instanceof Error && err.name === "AmbiguousSendError";
}

/**
 * Runs the whole DESIGN §7 flow (summary → double-gated send → logging). An LLM (summarizer)
 * failure does not block the send — it continues with the table only. For a real send
 * (SEND_MODE=live && confirm) the status='sending' reservation row is always committed **before**
 * calling provider.send() (DESIGN §11.5).
 */
export async function runReorderAgent(
  deps: ReorderAgentDeps,
  opts: ReorderAgentOptions,
): Promise<ReorderAgentResult> {
  const runId = opts.runId ?? randomUUID();
  const sendMode = opts.sendMode ?? "dry_run";
  const confirm = opts.confirm ?? false;
  const willSend = sendMode === "live" && confirm; // double gate — neither alone sends

  const report = await buildReorderReport(deps, opts);
  const suggestionCount = countSuggestions(report);

  if (suggestionCount === 0) {
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: deps.clock.now(),
      status: "no_suggestions",
      recipient: null,
      subject: null,
      suggestionCount: 0,
      messageId: null,
      dryRun: !willSend,
      errorCode: null,
    });
    return {
      runId,
      status: "no_suggestions",
      suggestionCount: 0,
      report,
      summary: null,
      reportText: renderReportText(report, null),
      sent: false,
      messageId: null,
    };
  }

  let summary: string | null;
  try {
    summary = await deps.summarizer.summarize(report);
  } catch (err) {
    summary = null;
    console.error(
      "Summary (LLM) generation failed; continuing with the table only, without a summary:",
      err instanceof Error ? err.message : String(err),
    );
  }

  const reportText = renderReportText(report, summary);
  const subject =
    opts.subject ??
    `Reorder suggestions — ${suggestionCount} item(s), ${report.stores.length} store(s)`;

  if (!willSend) {
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: deps.clock.now(),
      status: "dry_run",
      recipient: opts.recipient ?? null,
      subject,
      suggestionCount,
      messageId: null,
      dryRun: true,
      errorCode: null,
    });
    console.log(reportText);
    return {
      runId,
      status: "dry_run",
      suggestionCount,
      report,
      summary,
      reportText,
      sent: false,
      messageId: null,
    };
  }

  if (!opts.recipient) {
    throw new Error(
      "REPORT_RECIPIENT is not set. Add the email address that should receive the report to REPORT_RECIPIENT in .env.",
    );
  }
  const recipient = opts.recipient;

  // SR2-MAIL-003 — a same-run_id retry (a human passing --run-id explicitly) is allowed only within
  // the provider's Idempotency-Key retention period. If it has passed, refuse here (duplicate-send
  // risk); if within, close the row stuck in sending as unknown so the reservation below is not
  // blocked. With a new run_id nothing happens.
  await enforceSameRunRetryPolicy(deps, { runId, now: deps.clock.now(), recipient });

  // Reservation: commit the 'sending' row before calling send(). If the run_id is already
  // sending/sent this fails with a unique violation and blocks the re-send (DESIGN §11.5,
  // pgWarehouse.logAgentSend).
  await deps.warehouse.logAgentSend({
    runId,
    sentAt: deps.clock.now(),
    status: "sending",
    recipient,
    subject,
    suggestionCount,
    messageId: null,
    dryRun: false,
    errorCode: null,
  });

  try {
    const result = await deps.notificationProvider.send({
      to: recipient,
      subject,
      text: reportText,
      html: renderReportHtml(report, summary),
      // OPS-004 — same as folderScan.ts: runId is used as the idempotency key so a human retrying
      // with the same runId does not cause a duplicate send (see resendProvider.ts docs).
      idempotencyKey: runId,
    });
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: deps.clock.now(),
      status: "sent",
      recipient,
      subject,
      suggestionCount,
      messageId: result.messageId,
      dryRun: false,
      errorCode: null,
    });
    return {
      runId,
      status: "sent",
      suggestionCount,
      report,
      summary,
      reportText,
      sent: true,
      messageId: result.messageId,
    };
  } catch (err) {
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: deps.clock.now(),
      status: isAmbiguousSendError(err) ? "unknown" : "failed",
      recipient,
      subject,
      suggestionCount,
      messageId: null,
      dryRun: false,
      errorCode: errorCodeOf(err),
    });
    throw err;
  }
}

// ── CLI entry point (assembly only — the logic is in the two functions above) ──────────

function parseSendMode(): "dry_run" | "live" {
  const raw = process.env["SEND_MODE"] ?? "dry_run";
  if (raw !== "dry_run" && raw !== "live") {
    throw new Error(
      `Invalid SEND_MODE value: "${raw}". Only "dry_run" or "live" is allowed (check .env).`,
    );
  }
  return raw;
}

async function main(): Promise<void> {
  const businessTimezone = process.env["BUSINESS_TIMEZONE"];
  if (!businessTimezone) {
    throw new Error(
      "BUSINESS_TIMEZONE is not set. Example: Asia/Manila. Add it to BUSINESS_TIMEZONE in .env.",
    );
  }

  const confirm = process.argv.includes("--confirm");
  const shouldSync = process.argv.includes("--sync");
  // --run-id=<value> (SR2-MAIL-001, second adversarial review) — the CLI previously had no such
  // flag at all, so every run produced a fresh run_id via randomUUID(). The "re-run with the same
  // run_id" documented in the README for a human retrying after a Resend timeout left status
  // 'unknown' ("unknown whether it was sent") was therefore actually impossible — the retry used a
  // new Idempotency-Key and risked a duplicate send. When not given it falls back to randomUUID()
  // as before (see runReorderAgent).
  const runId = parseNamedArg(process.argv, "run-id");
  const sendMode = parseSendMode();
  const clock = createSystemClock();

  // Without DATABASE_URL, start on embedded PGlite (T14, SPEC §12) — so a non-developer operator
  // can use it with just npm install, without a Neon account.
  const handle = await createWarehouseFromEnv();
  const warehouse = handle.warehouse;
  try {
    // SR2-REL-001 (second adversarial review) — on the network Postgres (DATABASE_URL) path, if the
    // schema is missing or only partially applied, stop right here with clear guidance instead of a
    // raw Postgres error. The embedded PGlite path is already auto-migrated, so this is a no-op.
    await ensureNetworkMigrationsApplied(handle);

    if (shouldSync) {
      const syncResult = await syncAll(
        { loyverseClient: createLoyverseClientFromEnv(), warehouse, clock },
        {},
      );
      if (!syncResult.ok) {
        const failed = syncResult.resources.filter((r) => r.status !== "success");
        console.error(
          "Some resources failed or were skipped during --sync — continuing to compute " +
            `suggestions from the existing data anyway: ${failed.map((r) => `${r.resource}=${r.status}`).join(", ")}`,
        );
      }
    }

    const result = await runReorderAgent(
      {
        warehouse,
        clock,
        notificationProvider: createResendEmailProvider(),
        summarizer: createClaudeSummarizer(),
      },
      {
        businessTimezone,
        sendMode,
        confirm,
        ...(runId !== undefined ? { runId } : {}),
        ...(process.env["REPORT_RECIPIENT"] ? { recipient: process.env["REPORT_RECIPIENT"] } : {}),
      },
    );

    console.log(
      `Reorder agent run complete — run_id=${result.runId}, status=${result.status}, ` +
        `${result.suggestionCount} suggestion(s), send ${result.sent ? "done" : "skipped"}.`,
    );
    // OPS-005 (007 review, TASKS T34) — alongside the human-readable line above, leave one
    // machine-parseable line.
    logStructured({
      event: "reorder_agent_completed",
      runId: result.runId,
      status: result.status,
      suggestionCount: result.suggestionCount,
      sent: result.sent,
    });
  } finally {
    await handle.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
