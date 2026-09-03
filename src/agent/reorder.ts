/**
 * 재주문 제안 에이전트 (DESIGN.md §7).
 *
 * 흐름: opts 로드 → (선택) sync_now → reorderSuggestions(core, 결정론) → 제안 0건이면 로그만
 * 남기고 종료 → 리포트 조립(지점별 표) → Summarizer로 문구 2~3문장(LLM, 실패해도 표만으로
 * 계속 진행) → SEND_MODE=live && --confirm 둘 다일 때만 provider.send, 아니면 dry-run 출력 →
 * agent_send_log 기록.
 *
 * `buildReorderReport()`는 결정론 계산만 하는 순수 오케스트레이션이라 T9의 `reorder_suggestions`
 * MCP 도구가 그대로 재사용한다(같은 core 경유 회귀 가드, docs/TASKS.md T9 의존성 "T8(코어
 * 재사용 확인용)"). `runReorderAgent()`가 그 위에 요약·발송·로깅을 얹는다. 이 파일 하단의
 * `main()`만 실제 어댑터를 조립하는 CLI 진입점이고, 로직은 전부 이 두 함수에 있다.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
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
import { createResendEmailProvider } from "../adapters/resendProvider.js";
import { createSystemClock } from "../adapters/systemClock.js";
import { createWarehouseFromEnv } from "../adapters/warehouseFactory.js";
import { syncAll } from "../etl/sync.js";

// ── 리포트 조립 (결정론, T9 재사용) ────────────────────────────────────────

export interface BuildReportOptions {
  /** 사업장 타임존(예: Asia/Manila). 암묵 기본값 없음 — 호출자가 명시한다(CLAUDE.md). */
  businessTimezone: string;
  /** 지정하면 이 매장만. 존재하지 않는 store_id면 원인이 담긴 에러를 던진다. */
  storeId?: string;
  windowDays?: number;
  leadTimeDays?: number;
  safetyDays?: number;
  targetCoverDays?: number;
  /** 기본값 DEFAULT_STALE_THRESHOLD_HOURS(24). SPEC §9 stale 경고 기준. */
  staleThresholdHours?: number;
}

export interface ReportDeps {
  warehouse: Warehouse;
  clock: Clock;
}

/** report.stores의 총 품목 수 = "제안 건수"(reorderQty>0인 (store,variant) 쌍의 수). */
export function countSuggestions(report: ReorderReport): number {
  return report.stores.reduce((sum, s) => sum + s.items.length, 0);
}

/**
 * 지점별 재주문 제안 표를 계산한다. reorderQty>0인 품목만 포함한다(0건은 "제안"이 아니다).
 * salesAgg/stock/stores 조회 → core/metrics.computeReorderMetrics(순수 계산) → 매장별로 묶어
 * ReorderReport로 조립하는 순서 외에 다른 로직은 없다 — 외부 IO는 warehouse 호출뿐이다.
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
      `존재하지 않는 store_id입니다: "${opts.storeId}". sync_status 도구나 stores 테이블에서 ` +
        "등록된 매장 id를 확인하세요.",
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

  // 팩 단위 반올림(SPEC §14, TASKS T25) — reorderQty() 계산 자체는 위에서 이미 끝났고, 그
  // 결과를 ProductRow.packSize와 조인해 감싸기만 한다(computeReorderMetrics는 무변경).
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
      // FK(sales_lines/inventory_levels → stores) 상 정상적으로는 나올 수 없지만, 방어적으로
      // 데이터를 누락시키지 않고 store_id를 표시명으로 대체한 채 경고를 남긴다.
      warnings.add(`매장 이름을 찾지 못한 store_id(${storeId})의 제안을 id로 표시했습니다.`);
    }
    sections.push({ storeId, storeName: storeName ?? storeId, items });
  }
  sections.sort((a, b) => a.storeId.localeCompare(b.storeId));

  // 리포트는 receipts(판매 창)와 inventory(현재고) 둘 다에 의존한다 — 신선도는 둘 중 더 오래된
  // 쪽 기준(SPEC §9, core/freshness.ts를 T9의 MCP 조회 도구와 공유).
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

// ── 리포트 렌더링 (사람이 읽는 표 — 결정론, LLM 문구는 별도 삽입) ─────────────

function formatCover(daysOfCover: number | null): string {
  return daysOfCover === null ? "∞" : daysOfCover.toFixed(1);
}

/** packSize가 없으면(낱개 매입) 계산량만, 있으면 "27개 → 최종 발주량 48개(2팩)"까지 표시한다. */
function formatOrderQty(item: ReorderLineItem): string {
  if (item.packSize === null || item.packCount === null) return `${item.reorderQty}`;
  return `${item.reorderQty} → 최종 발주량 ${item.finalOrderQty}(${item.packCount}팩, 팩당 ${item.packSize}개)`;
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
    `재주문 제안 — 생성 시각 ${report.generatedAt.toISOString()} (기준 타임존: ${report.timezone})`,
    `데이터 마지막 동기화: ${report.dataLastSyncedAt ? report.dataLastSyncedAt.toISOString() : "정보 없음"}`,
  ];
  if (summary) {
    lines.push("", summary);
  }
  if (report.stores.length === 0) {
    lines.push("", "재주문이 필요한 품목이 없습니다.");
  }
  for (const store of report.stores) {
    lines.push("", `[매장: ${store.storeName}] (품목 ${store.items.length}건)`);
    for (const item of store.items) {
      lines.push(
        `- ${item.name}: 현재고 ${item.inStock}, 일평균판매 ${item.avgDailySales.toFixed(2)}, ` +
          `재고커버 ${formatCover(item.daysOfCover)}일, 제안수량 ${formatOrderQty(item)}`,
      );
    }
  }
  if (report.warnings.length > 0) {
    lines.push("", "경고:");
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

export function renderReportHtml(report: ReorderReport, summary: string | null): string {
  const parts: string[] = [
    `<p>생성 시각 ${escapeHtml(report.generatedAt.toISOString())} (기준 타임존: ${escapeHtml(report.timezone)})<br/>`,
    `데이터 마지막 동기화: ${escapeHtml(report.dataLastSyncedAt ? report.dataLastSyncedAt.toISOString() : "정보 없음")}</p>`,
  ];
  if (summary) parts.push(`<p>${escapeHtml(summary)}</p>`);
  for (const store of report.stores) {
    parts.push(
      `<h3>${escapeHtml(store.storeName)}</h3><table><tr>` +
        "<th>품목</th><th>현재고</th><th>일평균판매</th><th>재고커버(일)</th><th>제안수량</th></tr>",
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
      `<p>경고:</p><ul>${report.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`,
    );
  }
  return parts.join("");
}

// ── 발송 오케스트레이션 ───────────────────────────────────────────────────

export interface ReorderAgentDeps extends ReportDeps {
  notificationProvider: NotificationProvider;
  summarizer: Summarizer;
}

export interface ReorderAgentOptions extends BuildReportOptions {
  /** 기본값: randomUUID(). 재시도에 같은 run_id를 쓰면 이중 발송 방지 예약이 이를 막는다. */
  runId?: string;
  /** 기본값: "dry_run". */
  sendMode?: "dry_run" | "live";
  /** 기본값: false. sendMode="live"와 둘 다 참일 때만 실제 발송한다(가드레일 1). */
  confirm?: boolean;
  /** live 발송 시 필수. dry-run에는 없어도 된다. */
  recipient?: string;
  subject?: string;
}

export interface ReorderAgentResult {
  runId: string;
  status: AgentSendStatus;
  suggestionCount: number;
  report: ReorderReport;
  /** LLM 요약 문구. Summarizer 실패 시 null(표만으로 계속 진행, DESIGN §7). */
  summary: string | null;
  /** 사람이 읽는 전체 본문(표+요약) — dry-run 출력과 실제 발송 본문이 같은 텍스트를 쓴다. */
  reportText: string;
  sent: boolean;
  messageId: string | null;
}

function errorCodeOf(err: unknown): string {
  return err instanceof Error && err.name ? err.name : "UnknownError";
}

/**
 * DESIGN §7 흐름 전체(요약 → 이중 게이트 발송 → 로깅)를 실행한다. LLM(summarizer) 실패는
 * 발송을 막지 않는다 — 표만으로 계속 진행한다. 실제 발송(SEND_MODE=live && confirm)에서는
 * provider.send() 호출 **전에** 반드시 status='sending' 예약 행을 먼저 커밋한다(DESIGN §11.5).
 */
export async function runReorderAgent(
  deps: ReorderAgentDeps,
  opts: ReorderAgentOptions,
): Promise<ReorderAgentResult> {
  const runId = opts.runId ?? randomUUID();
  const sendMode = opts.sendMode ?? "dry_run";
  const confirm = opts.confirm ?? false;
  const willSend = sendMode === "live" && confirm; // 이중 게이트 — 한쪽만으로는 발송 안 됨

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
      "요약(LLM) 생성에 실패해 요약 없이 표만으로 계속 진행합니다:",
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
      "REPORT_RECIPIENT이 없습니다. 발송받을 이메일 주소를 .env의 REPORT_RECIPIENT에 추가하세요.",
    );
  }
  const recipient = opts.recipient;

  // 예약: send() 호출 전에 'sending' 행을 먼저 커밋한다. run_id가 이미 sending/sent면 여기서
  // unique violation으로 실패해 재발송을 막는다(DESIGN §11.5, pgWarehouse.logAgentSend).
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
      status: "failed",
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

// ── CLI 진입점 (조립만 — 로직은 위 두 함수에 있다) ──────────────────────────

function parseSendMode(): "dry_run" | "live" {
  const raw = process.env["SEND_MODE"] ?? "dry_run";
  if (raw !== "dry_run" && raw !== "live") {
    throw new Error(
      `SEND_MODE 값이 올바르지 않습니다: "${raw}". "dry_run" 또는 "live"만 허용합니다(.env 확인).`,
    );
  }
  return raw;
}

async function main(): Promise<void> {
  const businessTimezone = process.env["BUSINESS_TIMEZONE"];
  if (!businessTimezone) {
    throw new Error(
      "BUSINESS_TIMEZONE이 없습니다. 예: Asia/Manila. .env의 BUSINESS_TIMEZONE에 추가하세요.",
    );
  }

  const confirm = process.argv.includes("--confirm");
  const shouldSync = process.argv.includes("--sync");
  const sendMode = parseSendMode();
  const clock = createSystemClock();

  // DATABASE_URL이 없으면 임베디드 PGlite로 기동한다(T14, SPEC §12) — Neon 계정 없이도
  // 비개발자 운영자가 npm install만으로 쓸 수 있게 하기 위해서다.
  const handle = await createWarehouseFromEnv();
  const warehouse = handle.warehouse;
  try {
    if (shouldSync) {
      const syncResult = await syncAll(
        { loyverseClient: createLoyverseClientFromEnv(), warehouse, clock },
        {},
      );
      if (!syncResult.ok) {
        const failed = syncResult.resources.filter((r) => r.status !== "success");
        console.error(
          "--sync 동기화 중 일부 리소스가 실패/건너뜀 처리됐습니다 — 그래도 기존 데이터로 " +
            `제안을 계속 계산합니다: ${failed.map((r) => `${r.resource}=${r.status}`).join(", ")}`,
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
        ...(process.env["REPORT_RECIPIENT"] ? { recipient: process.env["REPORT_RECIPIENT"] } : {}),
      },
    );

    console.log(
      `재주문 에이전트 실행 완료 — run_id=${result.runId}, status=${result.status}, ` +
        `제안 ${result.suggestionCount}건, 발송 ${result.sent ? "완료" : "안 함"}.`,
    );
  } finally {
    await handle.close();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
