/**
 * CSV/Excel 폴더 스캔 에이전트 — 지점 모드(SPEC §12 "실행 모델"·"연결 채널: 폴더 감시만").
 *
 * 흐름: 감시 폴더의 최신 파일 찾기 → T16으로 파싱(검증 실패 시 여기서 중단, 아무것도 적재하지
 * 않음) → Warehouse.transaction()으로 stores/products/inventory/salesPeriodAgg 원자적 upsert
 * → T17(computeCsvReorderMetrics)로 알림 대상 판정 → 0건이면 종료, 아니면 SEND_MODE=live &&
 * --confirm 이중 게이트로만 실제 발송(가드레일 1) → T19로 스냅샷 CSV 갱신 → agent_send_log 기록.
 *
 * `agent/reorder.ts`와 같은 얇은 오케스트레이션 원칙 — LLM 요약 없음(저재고 알림은 결정론
 * 목록이면 충분하다, DESIGN §7의 재주문 리포트와 달리 LLM 경계가 필요 없다). `LoyverseClient`/
 * `syncAll()`을 거치지 않고 Warehouse에 직접 쓴다(TASKS T12 결정).
 *
 * cron 1회 실행 진입점 — README의 cron/launchd 등록 예시(agent:reorder)와 같은 패턴으로 등록한다.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeCsvReorderMetrics, type CsvMetricsOptions } from "../core/metrics.js";
import { exportSnapshotCsv } from "../core/snapshotExport.js";
import type { AgentSendStatus, Clock, NotificationProvider, Warehouse } from "../core/types.js";
import { parseInventoryFile } from "../adapters/csvExcelParser.js";
import { createResendEmailProvider } from "../adapters/resendProvider.js";
import { createSystemClock } from "../adapters/systemClock.js";
import { createWarehouseFromEnv } from "../adapters/warehouseFactory.js";

/** ProductRow.lowStockThreshold override가 없을 때 쓰는 기본 임계치(SPEC §12). */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const DEFAULT_SNAPSHOT_FILE_NAME = "snapshot.csv";

// ── 감시 폴더에서 최신 파일 찾기 ──────────────────────────────────────────

async function findLatestInventoryFile(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const candidateNames = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => /\.(csv|xlsx)$/i.test(name));

  if (candidateNames.length === 0) {
    throw new Error(
      `${dir}에 .csv/.xlsx 재고 파일이 없습니다. SPEC §12 고정 템플릿에 맞춰 채운 파일을 이 폴더에 넣으세요.`,
    );
  }

  const withMtime = await Promise.all(
    candidateNames.map(async (name) => {
      const full = path.join(dir, name);
      const st = await stat(full);
      return { fullPath: full, mtimeMs: st.mtimeMs };
    }),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (withMtime.length > 1) {
    console.warn(
      `${dir}에 재고 파일이 ${withMtime.length}개 있습니다 — 가장 최근에 수정된 ` +
        `"${path.basename(withMtime[0]!.fullPath)}"만 사용하고 나머지는 건너뜁니다.`,
    );
  }
  return withMtime[0]!.fullPath;
}

// ── 알림 대상 판정 (T17 결과 → 사람이 읽는 목록) ────────────────────────────

export interface FolderScanAlertItem {
  storeId: string;
  variantId: string;
  name: string;
  mode: "history" | "no_history";
  inStock: number;
  reason: string;
}

function alertsFrom(metrics: ReturnType<typeof computeCsvReorderMetrics>): FolderScanAlertItem[] {
  const alerts: FolderScanAlertItem[] = [];
  for (const row of metrics) {
    if (row.mode === "history") {
      if (!row.stockoutRisk) continue;
      const cover = row.daysOfCover === null ? "∞" : row.daysOfCover.toFixed(1);
      alerts.push({
        storeId: row.storeId,
        variantId: row.variantId,
        name: row.name,
        mode: "history",
        inStock: row.inStock,
        reason: `품절 위험 — 재고커버 ${cover}일`,
      });
    } else {
      if (!row.belowThreshold) continue;
      alerts.push({
        storeId: row.storeId,
        variantId: row.variantId,
        name: row.name,
        mode: "no_history",
        inStock: row.inStock,
        reason: `재고 임계치(${row.threshold}) 미만 — 판매이력 없음`,
      });
    }
  }
  alerts.sort((a, b) => a.storeId.localeCompare(b.storeId) || a.name.localeCompare(b.name));
  return alerts;
}

function renderAlertText(alerts: FolderScanAlertItem[], sourceFile: string, now: Date): string {
  const lines: string[] = [`저재고 알림 — 스캔 시각 ${now.toISOString()} (원본: ${sourceFile})`];

  const byStore = new Map<string, FolderScanAlertItem[]>();
  for (const a of alerts) {
    const list = byStore.get(a.storeId) ?? [];
    list.push(a);
    byStore.set(a.storeId, list);
  }
  for (const [storeId, items] of byStore) {
    lines.push("", `[매장: ${storeId}] (${items.length}건)`);
    for (const item of items) {
      lines.push(`- ${item.name} (재고 ${item.inStock}): ${item.reason}`);
    }
  }
  return lines.join("\n");
}

function errorCodeOf(err: unknown): string {
  return err instanceof Error && err.name ? err.name : "UnknownError";
}

// ── 오케스트레이션 ───────────────────────────────────────────────────────

export interface FolderScanDeps {
  warehouse: Warehouse;
  clock: Clock;
  notificationProvider: NotificationProvider;
}

export interface FolderScanOptions {
  /** 재고 파일을 감시하는 폴더. */
  watchDir: string;
  /** 스냅샷 CSV를 쓸 폴더 — watchDir과 달라야 한다(같으면 다음 스캔이 스냅샷을 원본으로 오인한다). */
  snapshotDir: string;
  snapshotFileName?: string;
  defaultLowStockThreshold?: number;
  /** 기본값: randomUUID(). */
  runId?: string;
  /** 기본값: "dry_run". */
  sendMode?: "dry_run" | "live";
  /** 기본값: false. sendMode="live"와 둘 다 참일 때만 실제 발송한다(가드레일 1). */
  confirm?: boolean;
  /** live 발송 시 필수. */
  recipient?: string;
  subject?: string;
}

export interface FolderScanResult {
  runId: string;
  status: AgentSendStatus;
  sourceFile: string;
  scannedAt: Date;
  itemCount: number;
  alertCount: number;
  alerts: FolderScanAlertItem[];
  snapshotPath: string;
  sent: boolean;
  messageId: string | null;
}

/**
 * 폴더 스캔 1회를 전부 실행한다 — 파싱 → 적재(원자적) → 알림 판정 → (필요시) 발송 → 스냅샷 갱신
 * → 실행 로그. `provider.send()` 호출 전에 반드시 status='sending' 예약 행을 먼저 커밋해
 * 이중 발송을 막는다(DESIGN §11.5와 동일 패턴, agent/reorder.ts 참고).
 */
export async function runFolderScan(
  deps: FolderScanDeps,
  opts: FolderScanOptions,
): Promise<FolderScanResult> {
  if (path.resolve(opts.watchDir) === path.resolve(opts.snapshotDir)) {
    throw new Error(
      "watchDir과 snapshotDir이 같은 폴더입니다 — 스냅샷 파일을 감시 폴더에 쓰면 다음 스캔이 " +
        "그 스냅샷을 새 원본 파일로 잘못 읽을 수 있습니다. CSV_SNAPSHOT_DIR을 CSV_WATCH_DIR과 " +
        "다른 폴더로 지정하세요.",
    );
  }

  const runId = opts.runId ?? randomUUID();
  const sendMode = opts.sendMode ?? "dry_run";
  const confirm = opts.confirm ?? false;
  const willSend = sendMode === "live" && confirm;
  const now = deps.clock.now();

  const sourceFile = await findLatestInventoryFile(opts.watchDir);
  const parsed = await parseInventoryFile(sourceFile, now);

  // 파싱이 이미 끝나 성공한 데이터만 여기 온다 — 실패했으면 위 줄에서 던져서 아무것도
  // 적재되지 않는다("부분 적재 없이 명확한 에러로 중단", TASKS T18). 적재 자체도 하나의
  // 트랜잭션으로 묶어 중간 실패 시 전부 롤백된다.
  await deps.warehouse.transaction(async (tx) => {
    await tx.upsertStores(parsed.stores);
    await tx.upsertProducts(parsed.products);
    await tx.upsertInventory(parsed.inventory);
    await tx.upsertSalesPeriodAgg(parsed.salesPeriodAgg);
  });

  const metricsOpts: CsvMetricsOptions = {
    defaultLowStockThreshold: opts.defaultLowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD,
  };
  const metrics = computeCsvReorderMetrics(
    parsed.inventory,
    parsed.salesPeriodAgg,
    parsed.products,
    metricsOpts,
  );
  const alerts = alertsFrom(metrics);

  const snapshotFileName = opts.snapshotFileName ?? DEFAULT_SNAPSHOT_FILE_NAME;
  const snapshotPath = path.join(opts.snapshotDir, snapshotFileName);
  await mkdir(opts.snapshotDir, { recursive: true });
  await writeFile(snapshotPath, exportSnapshotCsv(parsed), "utf8");

  const itemCount = parsed.inventory.length;

  if (alerts.length === 0) {
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: now,
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
      sourceFile,
      scannedAt: now,
      itemCount,
      alertCount: 0,
      alerts: [],
      snapshotPath,
      sent: false,
      messageId: null,
    };
  }

  const reportText = renderAlertText(alerts, sourceFile, now);
  const subject = opts.subject ?? `저재고 알림 — ${alerts.length}건`;

  if (!willSend) {
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: now,
      status: "dry_run",
      recipient: opts.recipient ?? null,
      subject,
      suggestionCount: alerts.length,
      messageId: null,
      dryRun: true,
      errorCode: null,
    });
    console.log(reportText);
    return {
      runId,
      status: "dry_run",
      sourceFile,
      scannedAt: now,
      itemCount,
      alertCount: alerts.length,
      alerts,
      snapshotPath,
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

  await deps.warehouse.logAgentSend({
    runId,
    sentAt: now,
    status: "sending",
    recipient,
    subject,
    suggestionCount: alerts.length,
    messageId: null,
    dryRun: false,
    errorCode: null,
  });

  try {
    const sendResult = await deps.notificationProvider.send({
      to: recipient,
      subject,
      text: reportText,
    });
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: now,
      status: "sent",
      recipient,
      subject,
      suggestionCount: alerts.length,
      messageId: sendResult.messageId,
      dryRun: false,
      errorCode: null,
    });
    return {
      runId,
      status: "sent",
      sourceFile,
      scannedAt: now,
      itemCount,
      alertCount: alerts.length,
      alerts,
      snapshotPath,
      sent: true,
      messageId: sendResult.messageId,
    };
  } catch (err) {
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: now,
      status: "failed",
      recipient,
      subject,
      suggestionCount: alerts.length,
      messageId: null,
      dryRun: false,
      errorCode: errorCodeOf(err),
    });
    throw err;
  }
}

// ── CLI 진입점 (조립만) ───────────────────────────────────────────────────

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
  const watchDir = process.env["CSV_WATCH_DIR"];
  if (!watchDir) {
    throw new Error(
      "CSV_WATCH_DIR이 없습니다. 감시할 재고 파일 폴더 경로를 .env의 CSV_WATCH_DIR에 추가하세요.",
    );
  }
  const snapshotDir = process.env["CSV_SNAPSHOT_DIR"];
  if (!snapshotDir) {
    throw new Error(
      "CSV_SNAPSHOT_DIR이 없습니다. 스냅샷을 저장할 폴더 경로를 .env의 CSV_SNAPSHOT_DIR에 " +
        "추가하세요(CSV_WATCH_DIR과 다른 폴더여야 합니다).",
    );
  }
  const thresholdRaw = process.env["CSV_DEFAULT_LOW_STOCK_THRESHOLD"];
  const defaultLowStockThreshold = thresholdRaw !== undefined ? Number(thresholdRaw) : undefined;
  if (defaultLowStockThreshold !== undefined && !Number.isFinite(defaultLowStockThreshold)) {
    throw new Error(
      `CSV_DEFAULT_LOW_STOCK_THRESHOLD 값이 올바르지 않습니다: "${thresholdRaw}". 숫자를 지정하거나 .env에서 지우세요.`,
    );
  }

  const confirm = process.argv.includes("--confirm");
  const sendMode = parseSendMode();
  const clock = createSystemClock();

  // DATABASE_URL이 없으면 임베디드 PGlite로 기동한다(T14, SPEC §12).
  const handle = await createWarehouseFromEnv();
  try {
    const result = await runFolderScan(
      {
        warehouse: handle.warehouse,
        clock,
        notificationProvider: createResendEmailProvider(),
      },
      {
        watchDir,
        snapshotDir,
        sendMode,
        confirm,
        ...(defaultLowStockThreshold !== undefined ? { defaultLowStockThreshold } : {}),
        ...(process.env["REPORT_RECIPIENT"] ? { recipient: process.env["REPORT_RECIPIENT"] } : {}),
      },
    );
    console.log(
      `폴더 스캔 완료 — run_id=${result.runId}, status=${result.status}, ` +
        `알림 ${result.alertCount}건, 발송 ${result.sent ? "완료" : "안 함"}. 스냅샷: ${result.snapshotPath}`,
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
