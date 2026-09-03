/**
 * CSV/Excel 폴더 스캔 에이전트 — 지점 모드 + 본사 통합 모드(SPEC §12 "실행 모델"·"연결 채널:
 * 폴더 감시만"·"다지점 헤드오피스 통합 조회", CSV_MODE=branch|consolidated로 선택, 기본 branch).
 *
 * **지점 모드**(`runFolderScan`): 감시 폴더의 최신 파일 찾기 → T16으로 파싱(검증 실패 시
 * 여기서 중단, 아무것도 적재하지 않음) → Warehouse.transaction()으로
 * stores/products/inventory/salesPeriodAgg 원자적 upsert → T17(computeCsvReorderMetrics)로
 * 알림 대상 판정 → 0건이면 종료, 아니면 SEND_MODE=live && --confirm 이중 게이트로만 실제
 * 발송(가드레일 1) → T19로 스냅샷 CSV 갱신 → agent_send_log 기록.
 *
 * **본사 통합 모드**(`runConsolidatedScan`): 지점 스냅샷이 모이는 수집 폴더의 파일을 전부(최신
 * 1개가 아니라) 각자 독립적으로 파싱→적재→sync_state 기록한다 — 한 지점 파일이 실패해도
 * 다른 지점 파일 처리는 계속된다(부분 실패 격리, TASKS T20).
 *
 * `agent/reorder.ts`와 같은 얇은 오케스트레이션 원칙 — LLM 요약 없음(저재고 알림은 결정론
 * 목록이면 충분하다, DESIGN §7의 재주문 리포트와 달리 LLM 경계가 필요 없다). `LoyverseClient`/
 * `syncAll()`을 거치지 않고 Warehouse에 직접 쓴다(TASKS T12 결정).
 *
 * cron 1회 실행 진입점 — README의 cron/launchd 등록 예시(agent:reorder)와 같은 패턴으로 등록한다.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseCsvText } from "csv-parse/sync";
import { parseNamedArg } from "../core/cliArgs.js";
import {
  applyPackRounding,
  computeCsvReorderMetrics,
  computeStockReconciliation,
  periodsOverlap,
  type CsvHistoryMetricRow,
  type CsvMetricsOptions,
  type StockReconciliationRow,
} from "../core/metrics.js";
import { mapScmRowsToPurchaseReceipts } from "../core/scmSchema.js";
import { exportSnapshotCsv } from "../core/snapshotExport.js";
import type {
  AgentSendStatus,
  Clock,
  NotificationProvider,
  ProductRow,
  PurchaseAgg,
  PurchaseReceiptRow,
  SalesAgg,
  SalesPeriodAggRow,
  StoreRow,
  Warehouse,
} from "../core/types.js";
import { writeFileAtomic } from "../adapters/atomicFile.js";
import { assertFileSizeWithinLimit } from "../adapters/fileLimits.js";
import { isMainModule } from "../adapters/mainModule.js";
import {
  decodeFileBytes,
  parseInventoryFile,
  type ParsedCsvExcelFile,
} from "../adapters/csvExcelParser.js";
import { createResendEmailProvider } from "../adapters/resendProvider.js";
import { logStructured } from "../adapters/structuredLog.js";
import { createSystemClock } from "../adapters/systemClock.js";
import { createWarehouseFromEnv } from "../adapters/warehouseFactory.js";

/** ProductRow.lowStockThreshold override가 없을 때 쓰는 기본 임계치(SPEC §12). */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const DEFAULT_SNAPSHOT_FILE_NAME = "snapshot.csv";

// ── 폴더에서 재고 파일 찾기 (지점 모드: 최신 1개 / 본사 모드: 전부) ──────────

interface InventoryFileEntry {
  fullPath: string;
  mtimeMs: number;
}

async function listInventoryFiles(dir: string): Promise<InventoryFileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const candidateNames = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => /\.(csv|xlsx)$/i.test(name));

  return Promise.all(
    candidateNames.map(async (name) => {
      const full = path.join(dir, name);
      const st = await stat(full);
      return { fullPath: full, mtimeMs: st.mtimeMs };
    }),
  );
}

/**
 * mtime 내림차순, 동률이면 전체 경로 내림차순(OPS-003, 006 검수, TASKS T34) — mtime만으로는
 * 여러 파일이 정확히 같은 값을 가질 수 있고(파일시스템에 따라 mtime 해상도가 1초 단위인
 * 경우도 있고, 배치로 복사한 파일들이 우연히 같은 초에 찍히기도 한다), 그 경우 이전엔 OS의
 * `readdir` 반환 순서에 그대로 의존해 실행마다 다른 파일이 선택될 수 있었다. 파일명을 2차
 * 키로 쓰면 같은 파일 집합에 대해 항상 같은 파일이 선택된다(결정론) — 어떤 값을 "옳다"고
 * 주장하는 게 아니라, 최소한 매번 같은 답이 나온다는 걸 보장하는 게 목적이다.
 */
function sortByMtimeThenPathDesc<T extends { fullPath: string; mtimeMs: number }>(files: T[]): T[] {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || b.fullPath.localeCompare(a.fullPath));
}

async function findLatestInventoryFile(dir: string): Promise<string> {
  const files = await listInventoryFiles(dir);
  if (files.length === 0) {
    throw new Error(
      `${dir}에 .csv/.xlsx 재고 파일이 없습니다. SPEC §12 고정 템플릿에 맞춰 채운 파일을 이 폴더에 넣으세요.`,
    );
  }
  const sorted = sortByMtimeThenPathDesc(files);

  if (sorted.length > 1) {
    const tie = sorted[0]!.mtimeMs === sorted[1]!.mtimeMs;
    console.warn(
      `${dir}에 재고 파일이 ${sorted.length}개 있습니다 — ` +
        (tie
          ? `그중 ${sorted.filter((f) => f.mtimeMs === sorted[0]!.mtimeMs).length}개는 수정 ` +
            `시각이 동일해(파일명 역순으로 결정론적으로 골랐습니다) `
          : "가장 최근에 수정된 ") +
        `"${path.basename(sorted[0]!.fullPath)}"만 사용하고 나머지는 건너뜁니다.`,
    );
  }
  return sorted[0]!.fullPath;
}

// ── 알림 대상 판정 (T17 결과 → 사람이 읽는 목록) ────────────────────────────

export interface FolderScanAlertItem {
  storeId: string;
  variantId: string;
  name: string;
  mode: "history" | "no_history";
  inStock: number;
  reason: string;
  /**
   * 팩 단위 반올림(SPEC §14, TASKS T25) — history 모드에서만 채워진다. no_history 모드는
   * 판매이력이 없어 재주문 제안량 자체를 계산할 수 없다(T17 설계).
   */
  reorderQty?: number;
  finalOrderQty?: number;
  packCount?: number | null;
}

function alertsFrom(
  metrics: ReturnType<typeof computeCsvReorderMetrics>,
  products: ProductRow[],
): FolderScanAlertItem[] {
  // history 모드 행만 팩 단위 반올림 대상이다(no_history는 reorderQty 자체가 없다, T17).
  const historyRows = metrics.filter((m): m is CsvHistoryMetricRow => m.mode === "history");
  const packRoundedByKey = new Map(
    applyPackRounding(historyRows, products).map((r) => [`${r.storeId}:${r.variantId}`, r]),
  );

  const alerts: FolderScanAlertItem[] = [];
  for (const row of metrics) {
    if (row.mode === "history") {
      if (!row.stockoutRisk) continue;
      const cover = row.daysOfCover === null ? "∞" : row.daysOfCover.toFixed(1);
      // applyPackRounding은 historyRows 전체를 1:1로 감쌌으므로 이 키는 항상 존재한다.
      const rounded = packRoundedByKey.get(`${row.storeId}:${row.variantId}`)!;
      const orderQtyText =
        rounded.packSize !== null && rounded.packCount !== null
          ? `, 제안수량 ${rounded.reorderQty} → 최종 발주량 ${rounded.finalOrderQty}(${rounded.packCount}팩)`
          : `, 제안수량 ${rounded.reorderQty}`;
      alerts.push({
        storeId: row.storeId,
        variantId: row.variantId,
        name: row.name,
        mode: "history",
        inStock: row.inStock,
        reason: `품절 위험 — 재고커버 ${cover}일${orderQtyText}`,
        reorderQty: rounded.reorderQty,
        finalOrderQty: rounded.finalOrderQty,
        packCount: rounded.packCount,
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

function renderAlertText(
  alerts: FolderScanAlertItem[],
  reconciliation: StockReconciliationRow[],
  scmStatus: ScmStatus,
  sourceFile: string,
  now: Date,
): string {
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

  if (reconciliation.length > 0) {
    lines.push("", `[재고 정합성 경고] (${reconciliation.length}건, SPEC §16)`);
    for (const row of reconciliation) {
      lines.push(
        `- ${row.name}: 입고 원장 기준 예상재고 ${row.expectedStock}, 실제 재고 ` +
          `${row.actualStock} (차이 ${row.discrepancy}) — 도난·파손·실사오차 확인 필요.`,
      );
    }
  }

  // SCM 처리 상태(006 DATA-006/007, TASKS T33) — SKU별 노이즈 없이 한 줄 요약만 남긴다.
  // "정상 결과"로 보이는 이메일에 SCM 실패/불확실이 조용히 묻히지 않게 하는 게 목적이다.
  if (scmStatus.kind === "failed") {
    lines.push(
      "",
      `[SCM 처리 실패] ${scmStatus.error} — 이번 스캔은 재고 정합성 검증을 건너뛰었습니다.`,
    );
  } else if (scmStatus.kind === "ok" && scmStatus.insufficientData) {
    lines.push(
      "",
      `[SCM 재고 정합성 참고] 입고 실적 ${scmStatus.receiptCount}건을 반영했지만 기초재고 ` +
        "미확인 또는 입고·판매 기간 불일치로 확정 대사가 아닙니다(006 DATA-006) — 참고용으로만 보세요.",
    );
  }

  return lines.join("\n");
}

function errorCodeOf(err: unknown): string {
  return err instanceof Error && err.name ? err.name : "UnknownError";
}

/** OPS-004(007 검수, TASKS T34) — NotificationProvider가 "발송됐는지 알 수 없음"(예: Resend
 * 타임아웃)을 이 이름으로 알린다. `failed`(확실한 실패)와 구분해 `agent_send_log`에
 * `status: "unknown"`으로 남긴다 — 자동 재시도는 하지 않고 사람이 확인하게 한다. */
function isAmbiguousSendError(err: unknown): boolean {
  return err instanceof Error && err.name === "AmbiguousSendError";
}

// ── SCM 입고 실적 수동 내보내기 흡수 (지점 모드 전용, SPEC §16) ─────────────
//
// 실 Google Sheets API 연동은 채택하지 않는다(2026-09-03 결정) — 서비스 계정 발급은
// 비개발자 사용자에게 npm install만으로 쓰게 한다는 원칙(SPEC §12)에 정면으로 배치되고,
// 공개 링크 CSV export는 매입단가 등 민감 정보를 인터넷에 노출한다. 대신 SPEC §12가 이미
// 정한 "ERP는 CSV/Excel로 내보내기 → 폴더 채널로 투입" 선례를 SCM 시트에도 그대로 적용한다
// — 사용자가 구글시트를 "파일 > 다운로드 > CSV"로 내보내 이 폴더에 두면, 다음 스캔이
// T23의 mapScmRowsToPurchaseReceipts로 그대로 읽는다(새 의존성·시크릿 없음).

async function findLatestScmFile(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  const candidateNames = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => /\.csv$/i.test(name)); // XLSX는 이번 스코프 밖(구글시트 내보내기는 CSV가 자연스럽다).
  if (candidateNames.length === 0) return null;

  const withMtimes = await Promise.all(
    candidateNames.map(async (name) => {
      const full = path.join(dir, name);
      const st = await stat(full);
      return { fullPath: full, mtimeMs: st.mtimeMs };
    }),
  );
  // OPS-003(006 검수, TASKS T34) — 위 findLatestInventoryFile과 같은 결정론적 tie-break.
  const sorted = sortByMtimeThenPathDesc(withMtimes);
  if (sorted.length > 1) {
    const tie = sorted[0]!.mtimeMs === sorted[1]!.mtimeMs;
    console.warn(
      `${dir}에 SCM 입고 파일이 ${sorted.length}개 있습니다 — ` +
        (tie
          ? `그중 ${sorted.filter((f) => f.mtimeMs === sorted[0]!.mtimeMs).length}개는 수정 ` +
            `시각이 동일해(파일명 역순으로 결정론적으로 골랐습니다) `
          : "가장 최근에 수정된 ") +
        `"${path.basename(sorted[0]!.fullPath)}"만 사용하고 나머지는 건너뜁니다.`,
    );
  }
  return sorted[0]!.fullPath;
}

/** 이번 스캔의 재고 파일에 매장이 정확히 하나면 그 매장으로 자동 추론하고, 여럿이면 명시를 요구한다. */
function resolveScmStoreId(parsedStores: StoreRow[], explicit?: string): string {
  if (explicit) return explicit;
  if (parsedStores.length === 1) return parsedStores[0]!.id;
  throw new Error(
    `SCM 입고 파일을 어느 매장에 연결할지 알 수 없습니다 — 이번 스캔의 재고 파일에 매장이 ` +
      `${parsedStores.length}개 있습니다(${parsedStores.map((s) => s.id).join(", ")}). ` +
      "runFolderScan opts.scmReceiptsStoreId로 명시하세요.",
  );
}

/**
 * SCM 입고 파이프라인의 구조화된 상태(006 DATA-007, TASKS T33) — 예전엔 실패를 전부
 * `console.warn` 후 빈 배열로 삼켜 "데이터 없음"과 "처리 실패"가 구분되지 않았다(SCM 처리가
 * 실패해도 저재고 알림이 정상 결과로 오면 사용자가 놓칠 수 있다는 지적). `FolderScanResult`에
 * 그대로 노출해 dry-run 출력·이메일·MCP 조회 어디서든 이 상태를 볼 수 있게 한다.
 *
 * - `not_configured`: `scmReceiptsDir` 자체를 안 줌(기존 동작과 완전히 동일, SPEC §16).
 * - `no_file`: 폴더는 있지만 아직 CSV가 없음 — 정상적인 초기 상태.
 * - `failed`: 폴더 접근·파싱·DB 적재 중 하나라도 실패 — 저재고 알림은 그대로 진행되지만
 *   재고 정합성 검증은 이번 스캔에서 건너뛰었다는 뜻이다.
 * - `ok`: 파싱·적재까지 성공. `insufficientData`는 006 DATA-006 — 기초재고 미확인/기간
 *   불일치로 이번 스캔의 재고 정합성 대사가 참고용일 뿐 확정 결과가 아니라는 뜻이다
 *   (reconciliation 계산 이후에 채워진다 — `ingestScmReceipts` 자체는 이 값을 모른다).
 */
export type ScmStatus =
  | { kind: "not_configured" }
  | { kind: "no_file" }
  | { kind: "failed"; error: string }
  | { kind: "ok"; file: string; receiptCount: number; insufficientData: boolean };

interface ScmIngestOutcome {
  receipts: PurchaseReceiptRow[];
  status: ScmStatus;
}

/**
 * scmReceiptsDir에서 최신 CSV를 찾아 파싱·적재한다. **SCM 파싱 실패는 지점 스캔의 핵심
 * 임무(저재고 알림)를 막지 않는다** — 경고만 남기고 빈 결과로 계속 진행한다(폴더가 없거나
 * 파일이 아직 없는 정상적인 경우와 같은 취급). 대신 `status`로 무슨 일이 있었는지 호출자에게
 * 그대로 알린다(006 DATA-007).
 */
async function ingestScmReceipts(
  scmReceiptsDir: string,
  storeId: string,
  warehouse: Warehouse,
): Promise<ScmIngestOutcome> {
  let file: string | null;
  try {
    file = await findLatestScmFile(scmReceiptsDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `SCM 입고 폴더(${scmReceiptsDir})를 읽을 수 없어 이번 스캔은 입고 데이터 없이 계속합니다: ${message}`,
    );
    return { receipts: [], status: { kind: "failed", error: message } };
  }
  if (!file) return { receipts: [], status: { kind: "no_file" } };

  try {
    // SCM 입고 CSV도 파싱 전 크기 상한을 거친다(SEC-003, TASKS T32) — 이 함수는 실패를
    // 삼켜 경고만 남기고 계속 진행하므로(위 doc 참고), 상한 위반도 같은 catch에서 자연히
    // "이번 스캔은 입고 데이터 없이 계속" 경로로 처리된다.
    await assertFileSizeWithinLimit(file);
    const bytes = await readFile(file);
    const { text } = decodeFileBytes(bytes);
    const rawRows = parseCsvText(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as unknown[];
    const receipts = mapScmRowsToPurchaseReceipts(rawRows, storeId);
    await warehouse.upsertPurchaseReceipts(receipts);
    return {
      receipts,
      // insufficientData는 reconciliation 계산 이후에나 알 수 있다 — 호출자(runFolderScan)가
      // 이 status를 보강한다.
      status: { kind: "ok", file, receiptCount: receipts.length, insufficientData: false },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `SCM 입고 파일(${file}) 처리 실패 — 이번 스캔은 입고 데이터 없이 계속합니다: ${message}`,
    );
    return { receipts: [], status: { kind: "failed", error: message } };
  }
}

/** 같은 (storeId,variantId)의 입고를 합산한다 — DB 재조회 없이 이번 스캔 파일 그대로(T17 패턴). */
function aggregatePurchases(receipts: PurchaseReceiptRow[]): PurchaseAgg[] {
  const totalsByKey = new Map<string, { storeId: string; variantId: string; qty: number }>();
  for (const r of receipts) {
    const key = `${r.storeId}:${r.variantId}`;
    const existing = totalsByKey.get(key);
    const qty = Number(r.receivedQty);
    if (existing) existing.qty += qty;
    else totalsByKey.set(key, { storeId: r.storeId, variantId: r.variantId, qty });
  }
  return [...totalsByKey.values()].map((v) => ({
    storeId: v.storeId,
    variantId: v.variantId,
    receivedQtyRaw: String(v.qty),
  }));
}

/** SalesPeriodAggRow[](이번 스캔 재고 파일의 판매이력)를 computeStockReconciliation이 받는
 * SalesAgg[] 모양으로 옮긴다 — computeCsvReorderMetrics 내부와 같은 매핑(T17). */
function salesAggFromCsv(salesPeriodAgg: SalesPeriodAggRow[], products: ProductRow[]): SalesAgg[] {
  const productByVariant = new Map(products.map((p) => [p.variantId, p]));
  return salesPeriodAgg.map((s) => {
    const p = productByVariant.get(s.variantId);
    return {
      storeId: s.storeId,
      variantId: s.variantId,
      name: p?.name ?? s.variantId,
      category: p?.category ?? null,
      soldQtyRaw: s.soldQty,
    };
  });
}

/**
 * SCM 입고 실적 기간(입고 날짜 최소~최대)과 판매 데이터 기간(판매기간시작일~종료일 최소~최대)이
 * 겹치는지 판정한다(006 DATA-006, TASKS T33) — `computeStockReconciliation`의
 * `periodsOverlap` 옵션에 넘긴다. 둘 중 하나라도 비어 있으면(판매이력 없는 스캔, SCM 입고
 * 0건) 비교할 기간 자체가 없어 `undefined`를 반환한다 — `computeStockReconciliation`은
 * `periodsOverlap`이 `undefined`면 이 조건만으로 insufficientData를 판정하지 않는다(기초재고
 * 미확인 쪽 이유가 어차피 항상 있기 때문에 결과적으로 달라지지 않는다 — 하지만 여기서 억지로
 * false를 반환해 "기간이 안 겹친다"고 오해할 만한 이유를 만들지 않는다).
 */
function computePeriodsOverlap(
  salesPeriodAgg: SalesPeriodAggRow[],
  receipts: PurchaseReceiptRow[],
): boolean | undefined {
  if (salesPeriodAgg.length === 0 || receipts.length === 0) return undefined;
  const salesStartMs = Math.min(...salesPeriodAgg.map((s) => s.periodStart.getTime()));
  const salesEndMs = Math.max(...salesPeriodAgg.map((s) => s.periodEnd.getTime()));
  const receiptTimesMs = receipts.map((r) => r.receivedAt.getTime());
  const receiptStartMs = Math.min(...receiptTimesMs);
  const receiptEndMs = Math.max(...receiptTimesMs);
  return periodsOverlap(
    { start: new Date(salesStartMs), end: new Date(salesEndMs) },
    { start: new Date(receiptStartMs), end: new Date(receiptEndMs) },
  );
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
  /**
   * SCM 입고 실적 CSV(구글시트 등에서 수동 내보내기)를 감시할 폴더 — 선택(SPEC §16). 없으면
   * SCM 입고 적재·재고 정합성 검증을 건너뛴다(기존 동작과 완전히 동일).
   */
  scmReceiptsDir?: string;
  /** scmReceiptsDir의 입고를 귀속시킬 매장. 이번 스캔 재고 파일에 매장이 하나뿐이면 생략 가능. */
  scmReceiptsStoreId?: string;
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
  /**
   * SCM 입고 실적 대사 결과(SPEC §16) — scmReceiptsDir 미설정이거나 이번 스캔에 SCM 파일이
   * 없으면 빈 배열. **확정 불일치(hasDiscrepancy && !insufficientData)만** 담는다(정상 대사와
   * insufficientData 행은 노이즈라 제외 — insufficientData 여부 요약은 `scmStatus` 참고,
   * 006 DATA-006).
   */
  reconciliation: StockReconciliationRow[];
  /** SCM 입고 파이프라인의 구조화된 상태(006 DATA-007) — not_configured/no_file/failed/ok.
   * "SCM 처리가 실패해도 저재고 알림은 정상 결과로 온다"는 문제를 이 필드로 노출한다. */
  scmStatus: ScmStatus;
}

// ── 일일 다이제스트 watermark (TASKS T31, DATA-003) ─────────────────────────
//
// "파일이 안 바뀌었으면 cron이 몇 번을 돌아도 재발송하지 않되, 하루(24시간)가 지나면
// 같은 내용이라도 다이제스트 1회는 보장한다"(SPEC §18, DESIGN §12.3) — 완전 무음이 아니라
// "일 1회 상한"이다. `sync_state`(기존 테이블, `resource` 자유 문자열)에
// `csv_branch_digest:<watchDir 절대경로>` 키로 `{contentHash, lastSentAt}`를 JSON으로 저장한다
// — 새 스키마를 추가하지 않는다.

const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

interface DigestWatermark {
  contentHash: string;
  /** ISO — "마지막으로 이 채널을 실제로 끝까지 처리한 시각"(발송 여부와 무관, 아래 참고). */
  lastSentAt: string;
}

function digestResourceKey(watchDir: string): string {
  return `csv_branch_digest:${path.resolve(watchDir)}`;
}

/** 손상되거나 형식이 안 맞는 값은 "저장된 게 없다"로 취급한다 — 다음 처리가 새로 덮어쓴다. */
function parseDigestWatermark(raw: string | null): DigestWatermark | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { contentHash?: unknown }).contentHash === "string" &&
      typeof (parsed as { lastSentAt?: unknown }).lastSentAt === "string"
    ) {
      return parsed as DigestWatermark;
    }
  } catch {
    // 아래에서 null 반환.
  }
  return null;
}

/**
 * 순수 판정 함수 — 저장된 워터마크가 없거나 내용이 다르면(=이번 스캔이 진짜 새 정보다)
 * 항상 처리한다. 내용이 같으면 마지막 처리로부터 하루가 지났는지만 본다.
 */
function shouldSkipAsUnchanged(
  stored: DigestWatermark | null,
  currentHash: string,
  now: Date,
): boolean {
  if (stored === null || stored.contentHash !== currentHash) return false;
  return now.getTime() - new Date(stored.lastSentAt).getTime() < DIGEST_WINDOW_MS;
}

/** 다이제스트 해시 계산도 원본 재고 파일을 통째로 읽는다 — `parseInventoryFile`이 같은
 * 검사를 하기 전에 먼저 호출되므로(runFolderScan 순서 참고), 크기 상한(SEC-003, TASKS T32)을
 * 여기서도 확인해야 대형 파일이 해시 계산 단계에서부터 메모리를 잡아먹지 않는다. */
async function computeFileContentHash(filePath: string): Promise<string> {
  await assertFileSizeWithinLimit(filePath);
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 실제로 이메일을 성공적으로 보낸 시점(`sent`)에만 워터마크를 갱신한다 — `no_suggestions`/
 * `dry_run`은 애초에 이메일을 안 보내니 다이제스트 판정과 무관하고(호출하지 않는다),
 * `failed`(발송 실패)에서도 **의도적으로 호출하지 않는다** — 다음 cron 실행이 같은 내용이라도
 * "아직 성공적으로 보내지 못했다"고 보고 즉시 재시도하게 하기 위해서다(하루 상한은 실패까지
 * 억제하지 않는다).
 */
async function persistDigestWatermark(
  warehouse: Warehouse,
  digestResource: string,
  contentHash: string,
  now: Date,
): Promise<void> {
  const watermark: DigestWatermark = { contentHash, lastSentAt: now.toISOString() };
  await warehouse.setCursor(digestResource, JSON.stringify(watermark), now);
}

/**
 * `parsed`(T16이 검증·변환한 파일 전체)로부터 `Warehouse.deactivateMissingCsvRows()`의
 * 인자를 만든다(TASKS T31, DATA-002) — `storeIds`는 이 파일이 authoritative하다고 주장하는
 * 매장 범위, `presentInventory`/`presentSales`는 실제로 이번 스캔에 있었던 (매장,SKU) 키다.
 */
function deactivateParamsFrom(parsed: ParsedCsvExcelFile): {
  storeIds: string[];
  presentInventory: { storeId: string; variantId: string }[];
  presentSales: { storeId: string; variantId: string }[];
} {
  return {
    storeIds: parsed.stores.map((s) => s.id),
    presentInventory: parsed.inventory.map((r) => ({ storeId: r.storeId, variantId: r.variantId })),
    presentSales: parsed.salesPeriodAgg.map((r) => ({
      storeId: r.storeId,
      variantId: r.variantId,
    })),
  };
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

  // 일일 다이제스트 판정(TASKS T31, DATA-003)에 쓸 재료만 여기서 준비한다 — 실제 억제
  // 판단은 "정말 발송을 시도하려는 시점"에서만 한다(아래 willSend 분기). dry_run·
  // no_suggestions는 애초에 이메일을 보내지 않으니 이 판정과 무관하다 — 반복 실행(수동
  // 테스트 등)에서 매번 같은 리포트를 다시 보여주는 게 여기서는 오히려 자연스럽다.
  const contentHash = await computeFileContentHash(sourceFile);
  const digestResource = digestResourceKey(opts.watchDir);
  const storedWatermark = parseDigestWatermark(await deps.warehouse.getCursor(digestResource));

  const parsed = await parseInventoryFile(sourceFile, now);

  // 파싱이 이미 끝나 성공한 데이터만 여기 온다 — 실패했으면 위 줄에서 던져서 아무것도
  // 적재되지 않는다("부분 적재 없이 명확한 에러로 중단", TASKS T18). 적재 자체도 하나의
  // 트랜잭션으로 묶어 중간 실패 시 전부 롤백된다.
  await deps.warehouse.transaction(async (tx) => {
    await tx.upsertStores(parsed.stores);
    await tx.upsertProducts(parsed.products);
    await tx.upsertInventory(parsed.inventory);
    await tx.upsertSalesPeriodAgg(parsed.salesPeriodAgg);
    // tombstone(TASKS T31, DATA-002) — 이 파일이 parsed.stores 범위의 authoritative 스캔이다.
    // 같은 트랜잭션 안에서 upsert와 함께 커밋/롤백돼야 "적재는 됐는데 tombstone은 반영 안
    // 됨" 같은 부분 상태가 안 나온다.
    await tx.deactivateMissingCsvRows(deactivateParamsFrom(parsed));
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
  const alerts = alertsFrom(metrics, parsed.products);

  // SCM 입고 실적 흡수 + 재고 정합성 검증(SPEC §16) — scmReceiptsDir 미설정이거나 이번
  // 스캔에 SCM 파일이 없으면(또는 파싱 실패해도) reconciliation은 그냥 빈 배열이다. SCM
  // 처리 실패가 위 alerts 판정·발송을 막지 않는다(ingestScmReceipts 자체가 실패를 삼킨다) —
  // 대신 scmStatus로 결과에 그대로 남는다(006 DATA-007).
  let reconciliation: StockReconciliationRow[] = [];
  let scmStatus: ScmStatus = { kind: "not_configured" };
  if (opts.scmReceiptsDir) {
    const scmStoreId = resolveScmStoreId(parsed.stores, opts.scmReceiptsStoreId);
    const outcome = await ingestScmReceipts(opts.scmReceiptsDir, scmStoreId, deps.warehouse);
    scmStatus = outcome.status;
    if (outcome.receipts.length > 0) {
      const purchases = aggregatePurchases(outcome.receipts);
      const sales = salesAggFromCsv(parsed.salesPeriodAgg, parsed.products);
      // openingStock을 생략하면(온보딩 실사값 입력 흐름이 아직 없다 — SPEC §16) 모든 행이
      // insufficientData로 표시된다(006 DATA-006, TASKS T33) — 의도된 동작이다. 실사값
      // 입력이 생기면 여기서 실제 값을 채워 넘긴다.
      const periodsOverlapResult = computePeriodsOverlap(parsed.salesPeriodAgg, outcome.receipts);
      const allReconciliation = computeStockReconciliation(parsed.inventory, purchases, sales, {
        ...(periodsOverlapResult !== undefined ? { periodsOverlap: periodsOverlapResult } : {}),
      });
      // 확정 불일치만 알림 대상(reconciliation)에 남긴다 — insufficientData 행까지 전부
      // 노출하면 매 스캔 SKU별 노이즈가 되므로, 대신 scmStatus.insufficientData 한 줄
      // 요약으로 "참고용일 뿐 확정 아님"을 알린다(아래 renderAlertText).
      reconciliation = allReconciliation.filter((r) => r.hasDiscrepancy && !r.insufficientData);
      if (scmStatus.kind === "ok") {
        scmStatus = {
          ...scmStatus,
          insufficientData: allReconciliation.some((r) => r.insufficientData),
        };
      }
    }
  }

  const snapshotFileName = opts.snapshotFileName ?? DEFAULT_SNAPSHOT_FILE_NAME;
  const snapshotPath = path.join(opts.snapshotDir, snapshotFileName);
  await mkdir(opts.snapshotDir, { recursive: true });
  // atomic write(TASKS T31, DATA-004) — snapshotDir가 본사의 CSV_COLLECT_DIR과 같은 공유
  // 폴더일 수 있어(SPEC §12 "다지점 헤드오피스 통합 조회"), 쓰는 도중 본사 스캔이 동시에
  // 읽거나 이 프로세스가 죽어도 잘린 CSV를 보지 않는다.
  await writeFileAtomic(snapshotPath, exportSnapshotCsv(parsed));

  const itemCount = parsed.inventory.length;
  const issueCount = alerts.length + reconciliation.length;

  if (issueCount === 0) {
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
      reconciliation: [],
      scmStatus,
    };
  }

  const reportText = renderAlertText(alerts, reconciliation, scmStatus, sourceFile, now);
  const subjectParts = [
    ...(alerts.length > 0 ? [`저재고 ${alerts.length}건`] : []),
    ...(reconciliation.length > 0 ? [`재고 정합성 경고 ${reconciliation.length}건`] : []),
  ];
  const subject = opts.subject ?? `알림 — ${subjectParts.join(", ")}`;

  if (!willSend) {
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: now,
      status: "dry_run",
      recipient: opts.recipient ?? null,
      subject,
      suggestionCount: issueCount,
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
      reconciliation,
      scmStatus,
    };
  }

  // 일일 다이제스트 상한(TASKS T31, DATA-003) — 여기부터는 실제로 발송을 시도하는
  // 경로다(willSend=true, 이슈도 있음). 파일 내용이 마지막 실제 발송 시점과 같고 하루가
  // 안 지났으면 같은 이메일을 또 보내지 않는다 — 그래도 이번 스캔이 실제로 계산한 alerts/
  // reconciliation은 결과에 그대로 담아 돌려준다(무슨 내용이 억제됐는지 호출자가 알 수 있게).
  if (shouldSkipAsUnchanged(storedWatermark, contentHash, now)) {
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: now,
      status: "unchanged",
      recipient: opts.recipient ?? null,
      subject,
      suggestionCount: issueCount,
      messageId: null,
      dryRun: false,
      errorCode: null,
    });
    return {
      runId,
      status: "unchanged",
      sourceFile,
      scannedAt: now,
      itemCount,
      alertCount: alerts.length,
      alerts,
      snapshotPath,
      sent: false,
      messageId: null,
      reconciliation,
      scmStatus,
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
    suggestionCount: issueCount,
    messageId: null,
    dryRun: false,
    errorCode: null,
  });

  try {
    const sendResult = await deps.notificationProvider.send({
      to: recipient,
      subject,
      text: reportText,
      // OPS-004 — runId를 그대로 idempotency key로 쓴다(resendProvider.ts 문서 참고). 같은
      // runId로 사람이 재시도해도(예: status="unknown" 확인 후) 실제로는 중복 발송되지 않는다.
      idempotencyKey: runId,
    });
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: now,
      status: "sent",
      recipient,
      subject,
      suggestionCount: issueCount,
      messageId: sendResult.messageId,
      dryRun: false,
      errorCode: null,
    });
    await persistDigestWatermark(deps.warehouse, digestResource, contentHash, now);
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
      reconciliation,
      scmStatus,
    };
  } catch (err) {
    await deps.warehouse.logAgentSend({
      runId,
      sentAt: now,
      // OPS-004 — 타임아웃처럼 "발송됐는지 알 수 없는" 실패는 failed와 구분해 unknown으로
      // 남긴다(persistDigestWatermark도 호출하지 않는다 — 기존 실패 경로와 동일하게 다음
      // 실행이 즉시 재시도할 수 있어야 한다).
      status: isAmbiguousSendError(err) ? "unknown" : "failed",
      recipient,
      subject,
      suggestionCount: issueCount,
      messageId: null,
      dryRun: false,
      errorCode: errorCodeOf(err),
    });
    throw err;
  }
}

// ── 본사 통합 모드 (SPEC §12 "다지점 헤드오피스 통합 조회", TASKS T20) ─────────
//
// 지점 스냅샷(T19 exportSnapshotCsv 산출물)이 모이는 "수집 폴더"를 스캔한다 — 지점 모드처럼
// "최신 파일 1개"가 아니라 폴더 안의 파일 전부를 지점별로 처리한다. 스냅샷은 이미 T15/T16과
// 같은 고정 템플릿이라 파서를 그대로 재사용한다. 한 파일(지점)이 파싱 중간에 실패해도 다른
// 파일(다른 지점)의 적재는 계속 진행한다 — 부분 실패가 전체를 막지 않는다.
//
// 파일별로 sync_state에 처리 이력을 남긴다(resource="csv_branch:<파일명>") — 그 파일이
// 끝까지 성공 파싱·적재된 뒤에만, 같은 트랜잭션 안에서 watermark를 커밋한다(CLAUDE.md 구현
// 해석 보충 원칙을 지점 단위로 지킴). 재고 스냅샷 자체는 매 스캔이 전체 상태를 다시
// upsert하므로(멱등), 이 watermark는 "언제 그 지점이 마지막으로 성공 반영됐는지" 가시성을
// 위한 것이지 증분 스킵 용도가 아니다.

export interface ConsolidatedFileResult {
  file: string;
  status: "success" | "failed";
  itemCount: number;
  error?: string;
}

export interface ConsolidatedScanResult {
  scannedAt: Date;
  files: ConsolidatedFileResult[];
  ok: boolean;
}

export interface ConsolidatedScanDeps {
  warehouse: Warehouse;
  clock: Clock;
}

export interface ConsolidatedScanOptions {
  /** 지점 스냅샷이 모이는 수집 폴더. */
  collectDir: string;
}

/**
 * 수집 폴더의 지점 스냅샷 파일을 전부 처리한다. 각 파일은 독립적으로 파싱→적재→sync_state
 * 기록까지 자체 실패 격리 범위를 갖는다 — 한 파일이 실패해도 나머지 파일 처리는 계속된다.
 */
export async function runConsolidatedScan(
  deps: ConsolidatedScanDeps,
  opts: ConsolidatedScanOptions,
): Promise<ConsolidatedScanResult> {
  const files = await listInventoryFiles(opts.collectDir);
  if (files.length === 0) {
    throw new Error(
      `${opts.collectDir}에 지점 스냅샷 파일(.csv/.xlsx)이 없습니다 — 지점 인스턴스가 내보낸 ` +
        "스냅샷을 이 폴더로 옮겨주세요.",
    );
  }

  const now = deps.clock.now();
  const results: ConsolidatedFileResult[] = [];

  for (const { fullPath } of files) {
    const fileName = path.basename(fullPath);
    const resource = `csv_branch:${fileName}`;
    try {
      const parsed = await parseInventoryFile(fullPath, now);
      await deps.warehouse.transaction(async (tx) => {
        await tx.upsertStores(parsed.stores);
        await tx.upsertProducts(parsed.products);
        await tx.upsertInventory(parsed.inventory);
        await tx.upsertSalesPeriodAgg(parsed.salesPeriodAgg);
        // tombstone(TASKS T31, DATA-002) — 이 지점 스냅샷 파일 하나가 그 지점의 authoritative
        // 경계다(DESIGN §12.2). 다른 지점 파일의 storeIds와 겹치지 않는 한(정상적으로는 겹칠
        // 이유가 없다 — 지점마다 자기 매장만 내보낸다) 서로 영향을 주지 않는다.
        await tx.deactivateMissingCsvRows(deactivateParamsFrom(parsed));
        // 적재와 watermark를 같은 트랜잭션에 묶는다 — 이 콜백이 끝까지 성공했을 때만 둘 다
        // 커밋되고, 실패하면 둘 다 롤백된다.
        await tx.setCursor(resource, now.toISOString(), now);
      });
      results.push({ file: fileName, status: "success", itemCount: parsed.inventory.length });
    } catch (err) {
      // 이 파일만 실패로 기록하고 계속 진행한다 — 이 파일의 트랜잭션 자체가 롤백돼 부분
      // 적재는 없고, 다른 지점 파일의 적재·watermark에는 전혀 영향이 없다.
      results.push({
        file: fileName,
        status: "failed",
        itemCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scannedAt: now, files: results, ok: results.every((r) => r.status === "success") };
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

function parseCsvMode(): "branch" | "consolidated" {
  const raw = process.env["CSV_MODE"] ?? "branch";
  if (raw !== "branch" && raw !== "consolidated") {
    throw new Error(
      `CSV_MODE 값이 올바르지 않습니다: "${raw}". "branch"(지점, 기본값) 또는 "consolidated"` +
        "(본사 통합)만 허용합니다(.env 확인).",
    );
  }
  return raw;
}

async function runBranchMain(clock: Clock, handle: { warehouse: Warehouse }): Promise<void> {
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
  // --run-id=<값>(SR2-MAIL-001, 2차 적대적 검수 대응) — agent/reorder.ts와 동일한 이유.
  // 지정하지 않으면 기존처럼 randomUUID()로 폴백한다(runFolderScan 참고).
  const runId = parseNamedArg(process.argv, "run-id");

  const result = await runFolderScan(
    { warehouse: handle.warehouse, clock, notificationProvider: createResendEmailProvider() },
    {
      watchDir,
      snapshotDir,
      sendMode,
      confirm,
      ...(runId !== undefined ? { runId } : {}),
      ...(defaultLowStockThreshold !== undefined ? { defaultLowStockThreshold } : {}),
      ...(process.env["REPORT_RECIPIENT"] ? { recipient: process.env["REPORT_RECIPIENT"] } : {}),
      // SCM 입고 실적(선택, SPEC §16) — 없으면 runFolderScan이 기존 동작과 완전히 동일하게 돈다.
      ...(process.env["SCM_RECEIPTS_DIR"]
        ? { scmReceiptsDir: process.env["SCM_RECEIPTS_DIR"] }
        : {}),
      ...(process.env["SCM_RECEIPTS_STORE_ID"]
        ? { scmReceiptsStoreId: process.env["SCM_RECEIPTS_STORE_ID"] }
        : {}),
    },
  );
  console.log(
    `폴더 스캔 완료(지점) — run_id=${result.runId}, status=${result.status}, ` +
      `알림 ${result.alertCount}건, 재고 정합성 경고 ${result.reconciliation.length}건, ` +
      `발송 ${result.sent ? "완료" : "안 함"}. 스냅샷: ${result.snapshotPath}`,
  );
  // OPS-005 — 위 사람이 읽는 줄과 별개로, 파싱 가능한 한 줄을 추가로 남긴다.
  logStructured({
    event: "folder_scan_completed",
    runId: result.runId,
    status: result.status,
    itemCount: result.itemCount,
    alertCount: result.alertCount,
    reconciliationCount: result.reconciliation.length,
    scmStatus: result.scmStatus.kind,
    sent: result.sent,
  });
}

async function runConsolidatedMain(clock: Clock, handle: { warehouse: Warehouse }): Promise<void> {
  const collectDir = process.env["CSV_COLLECT_DIR"];
  if (!collectDir) {
    throw new Error(
      "CSV_COLLECT_DIR이 없습니다. 지점 스냅샷이 모이는 수집 폴더 경로를 .env의 " +
        "CSV_COLLECT_DIR에 추가하세요(CSV_MODE=consolidated 전용).",
    );
  }

  const result = await runConsolidatedScan({ warehouse: handle.warehouse, clock }, { collectDir });
  const failed = result.files.filter((f) => f.status === "failed");
  console.log(
    `폴더 스캔 완료(본사 통합) — 지점 파일 ${result.files.length}개 중 성공 ` +
      `${result.files.length - failed.length}개, 실패 ${failed.length}개.`,
  );
  for (const f of failed) {
    console.error(`  실패: ${f.file} — ${f.error}`);
  }
  // OPS-005 — 본사 통합 모드는 파일별 독립 처리라 원래 하나의 runId 개념이 없다(위 문서
  // 참고) — 이 배치 실행 자체를 가리키는 상관관계 id를 로그용으로 새로 만든다.
  logStructured({
    event: "consolidated_scan_completed",
    runId: randomUUID(),
    status: result.ok ? "success" : "failed",
    fileCount: result.files.length,
    failedCount: failed.length,
  });
}

async function main(): Promise<void> {
  const clock = createSystemClock();
  const mode = parseCsvMode();

  // DATABASE_URL이 없으면 임베디드 PGlite로 기동한다(T14, SPEC §12).
  const handle = await createWarehouseFromEnv();
  try {
    if (mode === "consolidated") {
      await runConsolidatedMain(clock, handle);
    } else {
      await runBranchMain(clock, handle);
    }
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
