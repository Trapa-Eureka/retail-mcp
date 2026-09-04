#!/usr/bin/env node
/**
 * CSV/Excel folder-scan agent — branch mode + HQ consolidated mode (SPEC §12 "execution model",
 * "connection channel: folder watch only", "multi-store head-office consolidated view";
 * selected with CSV_MODE=branch|consolidated, default branch).
 *
 * **Branch mode** (`runFolderScan`): find the latest file in the watch folder → parse with T16
 * (stop here on validation failure, load nothing) → atomic upsert of
 * stores/products/inventory/salesPeriodAgg via Warehouse.transaction() → decide alert targets
 * with T17 (computeCsvReorderMetrics) → exit if 0, otherwise send for real only through the
 * SEND_MODE=live && --confirm double gate (guardrail 1) → refresh the snapshot CSV with T19 →
 * write agent_send_log.
 *
 * **HQ consolidated mode** (`runConsolidatedScan`): every file in the collect folder where branch
 * snapshots arrive (not only the latest one) is parsed → loaded → recorded in sync_state
 * independently — one branch file failing does not stop the others (partial-failure isolation,
 * TASKS T20).
 *
 * Same thin-orchestration principle as `agent/reorder.ts` — no LLM summary (a deterministic list
 * is enough for a low-stock alert; unlike the DESIGN §7 reorder report there is no LLM boundary
 * needed). Writes directly to the Warehouse without going through `LoyverseClient`/`syncAll()`
 * (TASKS T12 decision).
 *
 * Single-run cron entry point — register it the same way as the README's cron/launchd example
 * for agent:reorder.
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
import { enforceSameRunRetryPolicy } from "./sendRetryGate.js";
import { createSystemClock } from "../adapters/systemClock.js";
import {
  createWarehouseFromEnv,
  ensureNetworkMigrationsApplied,
} from "../adapters/warehouseFactory.js";

/** Default threshold used when ProductRow.lowStockThreshold has no override (SPEC §12). */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const DEFAULT_SNAPSHOT_FILE_NAME = "snapshot.csv";

// ── Finding inventory files in the folder (branch mode: latest one / HQ mode: all) ──────────

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
 * mtime descending, ties broken by full path descending (OPS-003, 006 review, TASKS T34) — mtime
 * alone can be exactly equal for several files (some filesystems have 1-second mtime resolution,
 * and files copied in a batch may land in the same second), and in that case the code used to
 * depend on the OS `readdir` order, so a different file could be picked on each run. Using the
 * file name as a secondary key means the same set of files always yields the same pick
 * (determinism) — the point is not to claim one value is "right", but to guarantee at least the
 * same answer every time.
 */
function sortByMtimeThenPathDesc<T extends { fullPath: string; mtimeMs: number }>(files: T[]): T[] {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || b.fullPath.localeCompare(a.fullPath));
}

async function findLatestInventoryFile(dir: string): Promise<string> {
  const files = await listInventoryFiles(dir);
  if (files.length === 0) {
    throw new Error(
      `${dir}: no inventory file found (.csv/.xlsx). Fill in a file following the fixed SPEC §12 template and put it in this folder.`,
    );
  }
  const sorted = sortByMtimeThenPathDesc(files);

  if (sorted.length > 1) {
    const tie = sorted[0]!.mtimeMs === sorted[1]!.mtimeMs;
    console.warn(
      `${dir} contains ${sorted.length} inventory files — only ` +
        `"${path.basename(sorted[0]!.fullPath)}" is used` +
        (tie
          ? ` (${sorted.filter((f) => f.mtimeMs === sorted[0]!.mtimeMs).length} of them have an ` +
            `identical modification time; picked deterministically by descending file name)`
          : " (the most recently modified)") +
        "; the rest are skipped.",
    );
  }
  return sorted[0]!.fullPath;
}

// ── Alert target decision (T17 result → human-readable list) ────────────────────────────────

export interface FolderScanAlertItem {
  storeId: string;
  variantId: string;
  name: string;
  mode: "history" | "no_history";
  inStock: number;
  reason: string;
  /**
   * Pack-size rounding (SPEC §14, TASKS T25) — only filled in history mode. no_history mode has
   * no sales history, so no reorder suggestion can be computed at all (T17 design).
   */
  reorderQty?: number;
  finalOrderQty?: number;
  packCount?: number | null;
}

function alertsFrom(
  metrics: ReturnType<typeof computeCsvReorderMetrics>,
  products: ProductRow[],
): FolderScanAlertItem[] {
  // Only history-mode rows are subject to pack rounding (no_history has no reorderQty at all, T17).
  const historyRows = metrics.filter((m): m is CsvHistoryMetricRow => m.mode === "history");
  const packRoundedByKey = new Map(
    applyPackRounding(historyRows, products).map((r) => [`${r.storeId}:${r.variantId}`, r]),
  );

  const alerts: FolderScanAlertItem[] = [];
  for (const row of metrics) {
    if (row.mode === "history") {
      if (!row.stockoutRisk) continue;
      const cover = row.daysOfCover === null ? "∞" : row.daysOfCover.toFixed(1);
      // applyPackRounding wrapped every historyRow 1:1, so this key always exists.
      const rounded = packRoundedByKey.get(`${row.storeId}:${row.variantId}`)!;
      const orderQtyText =
        rounded.packSize !== null && rounded.packCount !== null
          ? `, suggested ${rounded.reorderQty} → final order qty ${rounded.finalOrderQty} (${rounded.packCount} packs)`
          : `, suggested ${rounded.reorderQty}`;
      alerts.push({
        storeId: row.storeId,
        variantId: row.variantId,
        name: row.name,
        mode: "history",
        inStock: row.inStock,
        reason: `stockout risk — days of cover ${cover}${orderQtyText}`,
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
        reason: `below stock threshold (${row.threshold}) — no sales history`,
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
  const lines: string[] = [
    `Low stock alert — scanned at ${now.toISOString()} (source: ${sourceFile})`,
  ];

  const byStore = new Map<string, FolderScanAlertItem[]>();
  for (const a of alerts) {
    const list = byStore.get(a.storeId) ?? [];
    list.push(a);
    byStore.set(a.storeId, list);
  }
  for (const [storeId, items] of byStore) {
    lines.push("", `[Store: ${storeId}] (${items.length} items)`);
    for (const item of items) {
      lines.push(`- ${item.name} (stock ${item.inStock}): ${item.reason}`);
    }
  }

  if (reconciliation.length > 0) {
    lines.push("", `[Stock consistency warning] (${reconciliation.length} items, SPEC §16)`);
    for (const row of reconciliation) {
      lines.push(
        `- ${row.name}: expected stock from the receipts ledger ${row.expectedStock}, actual stock ` +
          `${row.actualStock} (difference ${row.discrepancy}) — check for theft, damage or count error.`,
      );
    }
  }

  // SCM processing status (006 DATA-006/007, TASKS T33) — a single summary line without per-SKU
  // noise. The point is that an SCM failure/uncertainty is not silently buried in an email that
  // looks like a "normal result".
  if (scmStatus.kind === "failed") {
    lines.push(
      "",
      `[SCM processing failed] ${scmStatus.error} — stock consistency verification was skipped for this scan.`,
    );
  } else if (scmStatus.kind === "ok" && scmStatus.insufficientData) {
    lines.push(
      "",
      `[SCM stock consistency note] ${scmStatus.receiptCount} receipt records were reflected, but this is ` +
        "not a confirmed reconciliation because opening stock is unverified or the receipt and sales periods do not match (006 DATA-006) — treat it as reference only.",
    );
  }

  return lines.join("\n");
}

function errorCodeOf(err: unknown): string {
  return err instanceof Error && err.name ? err.name : "UnknownError";
}

/** OPS-004 (007 review, TASKS T34) — the NotificationProvider signals "unknown whether it was
 * sent (unknown)" (e.g. a Resend timeout) with this name. It is recorded in `agent_send_log` as
 * `status: "unknown"`, distinct from `failed` (a definite failure) — no automatic retry; a person
 * checks. */
function isAmbiguousSendError(err: unknown): boolean {
  return err instanceof Error && err.name === "AmbiguousSendError";
}

// ── Absorbing manual SCM receipt exports (branch mode only, SPEC §16) ───────────────────────
//
// A real Google Sheets API integration is not adopted (2026-09-03 decision) — issuing a service
// account directly contradicts the principle that non-developer users get going with just
// npm install (SPEC §12), and a public-link CSV export exposes sensitive data such as purchase
// prices to the internet. Instead the precedent SPEC §12 already set — "export the ERP as
// CSV/Excel → feed it through the folder channel" — is applied to the SCM sheet as-is: the user
// exports the Google Sheet with "File > Download > CSV" into this folder, and the next scan reads
// it directly with T23's mapScmRowsToPurchaseReceipts (no new dependency or secret).

async function findLatestScmFile(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  const candidateNames = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => /\.csv$/i.test(name)); // XLSX is out of scope here (a Google Sheets export is naturally CSV).
  if (candidateNames.length === 0) return null;

  const withMtimes = await Promise.all(
    candidateNames.map(async (name) => {
      const full = path.join(dir, name);
      const st = await stat(full);
      return { fullPath: full, mtimeMs: st.mtimeMs };
    }),
  );
  // OPS-003 (006 review, TASKS T34) — same deterministic tie-break as findLatestInventoryFile above.
  const sorted = sortByMtimeThenPathDesc(withMtimes);
  if (sorted.length > 1) {
    const tie = sorted[0]!.mtimeMs === sorted[1]!.mtimeMs;
    console.warn(
      `${dir} contains ${sorted.length} SCM receipt files — only ` +
        `"${path.basename(sorted[0]!.fullPath)}" is used` +
        (tie
          ? ` (${sorted.filter((f) => f.mtimeMs === sorted[0]!.mtimeMs).length} of them have an ` +
            `identical modification time; picked deterministically by descending file name)`
          : " (the most recently modified)") +
        "; the rest are skipped.",
    );
  }
  return sorted[0]!.fullPath;
}

/** If this scan's inventory file has exactly one store, infer it automatically; if several, require it explicitly. */
function resolveScmStoreId(parsedStores: StoreRow[], explicit?: string): string {
  if (explicit) return explicit;
  if (parsedStores.length === 1) return parsedStores[0]!.id;
  throw new Error(
    `Cannot tell which store the SCM receipts file belongs to — this scan's inventory file has ` +
      `${parsedStores.length} stores (${parsedStores.map((s) => s.id).join(", ")}). ` +
      "Specify it explicitly with runFolderScan opts.scmReceiptsStoreId.",
  );
}

/**
 * Structured status of the SCM receipts pipeline (006 DATA-007, TASKS T33) — previously every
 * failure was swallowed into `console.warn` plus an empty array, so "no data" and "processing
 * failed" were indistinguishable (the finding: a user can miss an SCM failure when the low-stock
 * alert still arrives as a normal result). It is exposed as-is on `FolderScanResult` so the
 * status is visible from the dry-run output, the email and MCP queries alike.
 *
 * - `not_configured`: `scmReceiptsDir` itself was not given (exactly the previous behaviour, SPEC §16).
 * - `no_file`: the folder exists but has no CSV yet — a normal initial state.
 * - `failed`: folder access, parsing or DB load failed — the low-stock alert proceeds as usual,
 *   but stock consistency verification was skipped for this scan.
 * - `ok`: parsed and loaded. `insufficientData` is 006 DATA-006 — opening stock is unverified or
 *   the periods do not match, so this scan's stock reconciliation is reference only, not a
 *   confirmed result (filled after the reconciliation is computed — `ingestScmReceipts` itself
 *   does not know this value).
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
 * Finds the latest CSV in scmReceiptsDir, parses and loads it. **An SCM parse failure does not
 * block the branch scan's core mission (the low-stock alert)** — it only logs a warning and
 * continues with an empty result (treated the same as the normal case of a missing folder or no
 * file yet). Instead `status` tells the caller exactly what happened (006 DATA-007).
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
      `Cannot read the SCM receipts folder (${scmReceiptsDir}); this scan continues without receipt data: ${message}`,
    );
    return { receipts: [], status: { kind: "failed", error: message } };
  }
  if (!file) return { receipts: [], status: { kind: "no_file" } };

  try {
    // The SCM receipts CSV also goes through the size limit before parsing (SEC-003, TASKS T32) —
    // this function swallows failures, logs a warning and continues (see the doc above), so a
    // limit violation naturally takes the same "continue without receipt data" path in this catch.
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
      // insufficientData is only known after the reconciliation is computed — the caller
      // (runFolderScan) enriches this status.
      status: { kind: "ok", file, receiptCount: receipts.length, insufficientData: false },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `Failed to process the SCM receipts file (${file}); this scan continues without receipt data: ${message}`,
    );
    return { receipts: [], status: { kind: "failed", error: message } };
  }
}

/** Sums receipts for the same (storeId, variantId) — straight from this scan's file, no DB re-query (T17 pattern). */
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

/** Maps SalesPeriodAggRow[] (the sales history of this scan's inventory file) into the SalesAgg[]
 * shape computeStockReconciliation takes — same mapping as inside computeCsvReorderMetrics (T17). */
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
 * Decides whether the SCM receipt period (min–max receipt date) overlaps the sales data period
 * (min–max of period_start–period_end) (006 DATA-006, TASKS T33) — passed to
 * `computeStockReconciliation`'s `periodsOverlap` option. If either side is empty (a scan without
 * sales history, or 0 SCM receipts) there is no period to compare, so `undefined` is returned —
 * `computeStockReconciliation` does not decide insufficientData on this condition alone when
 * `periodsOverlap` is `undefined` (the unverified-opening-stock reason is always present anyway,
 * so the outcome does not change — but returning a forced false here would create a misleading
 * "periods do not overlap" reason, which we avoid).
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

// ── Orchestration ────────────────────────────────────────────────────────

export interface FolderScanDeps {
  warehouse: Warehouse;
  clock: Clock;
  notificationProvider: NotificationProvider;
}

export interface FolderScanOptions {
  /** Folder watched for inventory files. */
  watchDir: string;
  /** Folder the snapshot CSV is written to — must differ from watchDir (otherwise the next scan mistakes the snapshot for a source file). */
  snapshotDir: string;
  snapshotFileName?: string;
  defaultLowStockThreshold?: number;
  /** Default: randomUUID(). */
  runId?: string;
  /** Default: "dry_run". */
  sendMode?: "dry_run" | "live";
  /** Default: false. Sends for real only when both this and sendMode="live" are true (guardrail 1). */
  confirm?: boolean;
  /** Required for live sends. */
  recipient?: string;
  subject?: string;
  /**
   * Folder watched for SCM receipt CSVs (manual export from Google Sheets etc.) — optional
   * (SPEC §16). Without it, SCM receipt loading and stock consistency verification are skipped
   * (exactly the previous behaviour).
   */
  scmReceiptsDir?: string;
  /** Store the receipts in scmReceiptsDir are attributed to. May be omitted when this scan's inventory file has a single store. */
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
   * SCM receipts reconciliation result (SPEC §16) — empty when scmReceiptsDir is not set or this
   * scan had no SCM file. Contains **confirmed discrepancies only (hasDiscrepancy &&
   * !insufficientData)** (normal reconciliations and insufficientData rows are noise and are
   * excluded — see `scmStatus` for the insufficientData summary, 006 DATA-006).
   */
  reconciliation: StockReconciliationRow[];
  /** Structured status of the SCM receipts pipeline (006 DATA-007) — not_configured/no_file/failed/ok.
   * This field exposes the "SCM processing failed but the low-stock alert still arrives as a normal result" problem. */
  scmStatus: ScmStatus;
}

// ── Daily digest watermark (TASKS T31, DATA-003) ─────────────────────────
//
// "If the file has not changed, do not resend no matter how many times cron runs, but once a day
// (24 hours) guarantee one digest even with the same content" (SPEC §18, DESIGN §12.3) — not
// complete silence but a "once-a-day cap". `{contentHash, lastSentAt}` is stored as JSON in
// `sync_state` (existing table, free-form `resource` string) under the key
// `csv_branch_digest:<absolute watchDir>` — no new schema is added.

const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

interface DigestWatermark {
  contentHash: string;
  /** ISO — "the last time this channel was actually processed to the end" (regardless of sending, see below). */
  lastSentAt: string;
}

function digestResourceKey(watchDir: string): string {
  return `csv_branch_digest:${path.resolve(watchDir)}`;
}

/** A corrupt or malformed value is treated as "nothing stored" — the next run overwrites it. */
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
    // Returns null below.
  }
  return null;
}

/**
 * Pure decision — if there is no stored watermark or the content differs (= this scan is genuinely
 * new information), always process. If the content is the same, only check whether a day has
 * passed since the last processing.
 */
function shouldSkipAsUnchanged(
  stored: DigestWatermark | null,
  currentHash: string,
  now: Date,
): boolean {
  if (stored === null || stored.contentHash !== currentHash) return false;
  return now.getTime() - new Date(stored.lastSentAt).getTime() < DIGEST_WINDOW_MS;
}

/** Computing the digest hash also reads the whole source inventory file — since it is called
 * before `parseInventoryFile` does the same check (see the runFolderScan order), the size limit
 * (SEC-003, TASKS T32) has to be checked here too so a huge file does not eat memory already at
 * the hashing step. */
async function computeFileContentHash(filePath: string): Promise<string> {
  await assertFileSizeWithinLimit(filePath);
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The watermark is refreshed only when the email was actually sent successfully (`sent`) —
 * `no_suggestions`/`dry_run` send no email in the first place, so they are unrelated to the digest
 * decision (not called), and on `failed` (send failure) it is **deliberately not called** — so
 * that the next cron run, even with the same content, sees "not sent successfully yet" and
 * retries immediately (the daily cap does not suppress failures).
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
 * Builds the arguments for `Warehouse.deactivateMissingCsvRows()` from `parsed` (the whole file
 * validated and converted by T16) (TASKS T31, DATA-002) — `storeIds` is the store scope this file
 * claims to be authoritative for, `presentInventory`/`presentSales` are the (store, SKU) keys
 * actually present in this scan.
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
 * Runs one full folder scan — parse → load (atomic) → alert decision → send (if needed) →
 * snapshot refresh → run log. A status='sending' reservation row is always committed before
 * `provider.send()` is called, to prevent double sends (same pattern as DESIGN §11.5, see
 * agent/reorder.ts).
 */
export async function runFolderScan(
  deps: FolderScanDeps,
  opts: FolderScanOptions,
): Promise<FolderScanResult> {
  if (path.resolve(opts.watchDir) === path.resolve(opts.snapshotDir)) {
    throw new Error(
      "watchDir and snapshotDir are the same folder — writing the snapshot file into the watch folder " +
        "lets the next scan mistake that snapshot for a new source file. Set CSV_SNAPSHOT_DIR to a " +
        "folder different from CSV_WATCH_DIR.",
    );
  }

  const runId = opts.runId ?? randomUUID();
  const sendMode = opts.sendMode ?? "dry_run";
  const confirm = opts.confirm ?? false;
  const willSend = sendMode === "live" && confirm;
  const now = deps.clock.now();

  const sourceFile = await findLatestInventoryFile(opts.watchDir);

  // Only the ingredients for the daily digest decision (TASKS T31, DATA-003) are prepared here —
  // the actual suppression decision is made only "at the moment a send is really attempted" (the
  // willSend branch below). dry_run and no_suggestions send no email in the first place, so they
  // are unrelated to this decision — for repeated runs (manual testing etc.) showing the same
  // report again every time is actually the natural behaviour here.
  const contentHash = await computeFileContentHash(sourceFile);
  const digestResource = digestResourceKey(opts.watchDir);
  const storedWatermark = parseDigestWatermark(await deps.warehouse.getCursor(digestResource));

  const parsed = await parseInventoryFile(sourceFile, now);

  // Only data that already parsed successfully reaches this point — on failure the line above
  // threw and nothing is loaded ("stop with a clear error, no partial load", TASKS T18). The load
  // itself is wrapped in a single transaction so a mid-way failure rolls everything back.
  await deps.warehouse.transaction(async (tx) => {
    await tx.upsertStores(parsed.stores);
    await tx.upsertProducts(parsed.products);
    await tx.upsertInventory(parsed.inventory);
    await tx.upsertSalesPeriodAgg(parsed.salesPeriodAgg);
    // tombstone (TASKS T31, DATA-002) — this file is the authoritative scan for the parsed.stores
    // scope. It must commit/roll back together with the upserts in the same transaction so no
    // partial state like "loaded, but tombstones not applied" can occur.
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

  // SCM receipts absorption + stock consistency verification (SPEC §16) — when scmReceiptsDir is
  // not set or this scan has no SCM file (or parsing fails), reconciliation is simply an empty
  // array. An SCM processing failure does not block the alert decision/send above
  // (ingestScmReceipts itself swallows failures) — instead it stays in the result as scmStatus
  // (006 DATA-007).
  let reconciliation: StockReconciliationRow[] = [];
  let scmStatus: ScmStatus = { kind: "not_configured" };
  if (opts.scmReceiptsDir) {
    const scmStoreId = resolveScmStoreId(parsed.stores, opts.scmReceiptsStoreId);
    const outcome = await ingestScmReceipts(opts.scmReceiptsDir, scmStoreId, deps.warehouse);
    scmStatus = outcome.status;
    if (outcome.receipts.length > 0) {
      const purchases = aggregatePurchases(outcome.receipts);
      const sales = salesAggFromCsv(parsed.salesPeriodAgg, parsed.products);
      // With openingStock omitted (there is no onboarding stock-count input flow yet — SPEC §16)
      // every row is marked insufficientData (006 DATA-006, TASKS T33) — intended behaviour. Once
      // a stock-count input exists, pass the real value here.
      const periodsOverlapResult = computePeriodsOverlap(parsed.salesPeriodAgg, outcome.receipts);
      const allReconciliation = computeStockReconciliation(parsed.inventory, purchases, sales, {
        ...(periodsOverlapResult !== undefined ? { periodsOverlap: periodsOverlapResult } : {}),
      });
      // Keep only confirmed discrepancies as alert targets (reconciliation) — exposing every
      // insufficientData row too would be per-SKU noise on every scan, so instead a single
      // scmStatus.insufficientData summary line says "reference only, not confirmed" (see
      // renderAlertText below).
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
  // atomic write (TASKS T31, DATA-004) — snapshotDir may be a shared folder that is also HQ's
  // CSV_COLLECT_DIR (SPEC §12 "multi-store head-office consolidated view"), so neither a
  // concurrent HQ scan reading mid-write nor this process dying leaves a truncated CSV to be seen.
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
    ...(alerts.length > 0 ? [`${alerts.length} low stock`] : []),
    ...(reconciliation.length > 0 ? [`${reconciliation.length} stock consistency warning(s)`] : []),
  ];
  const subject = opts.subject ?? `Alert — ${subjectParts.join(", ")}`;

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

  // Daily digest cap (TASKS T31, DATA-003) — from here on a send is really attempted
  // (willSend=true and there are issues). If the file content equals the last actual send and a
  // day has not passed, the same email is not sent again — but the alerts/reconciliation this scan
  // actually computed are still returned in the result (so the caller can see what was suppressed).
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
      "REPORT_RECIPIENT is not set. Add the email address that should receive the report to REPORT_RECIPIENT in .env.",
    );
  }
  const recipient = opts.recipient;

  // SR2-MAIL-003 — same as agent/reorder.ts: a same-run_id retry is allowed only within the
  // provider's dedupe retention window, and rows stuck in sending are closed as unknown before
  // reserving (see sendRetryGate.ts).
  await enforceSameRunRetryPolicy(deps, { runId, now, recipient });

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
      // OPS-004 — runId is used as-is as the idempotency key (see the resendProvider.ts docs). Even
      // if a person retries with the same runId (e.g. after checking status="unknown"), no
      // duplicate is actually sent.
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
      // OPS-004 — a failure where it is "unknown whether it was sent", such as a timeout, is
      // recorded as unknown, distinct from failed (persistDigestWatermark is not called either —
      // like the existing failure path, the next run must be able to retry immediately).
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

// ── HQ consolidated mode (SPEC §12 "multi-store head-office consolidated view", TASKS T20) ─────
//
// Scans the "collect folder" where branch snapshots (T19 exportSnapshotCsv output) arrive — unlike
// branch mode it processes every file in the folder per branch, not "the latest one". Snapshots
// already use the same fixed template as T15/T16, so the parser is reused as-is. If one file
// (branch) fails mid-parse, loading of the other files (other branches) continues — a partial
// failure does not block the whole run.
//
// A processing record is left in sync_state per file (resource="csv_branch:<file name>") — the
// watermark is committed only after that file was fully parsed and loaded successfully, in the
// same transaction (the CLAUDE.md implementation-notes principle, kept per branch). Since every
// scan re-upserts the full state of the inventory snapshot anyway (idempotent), this watermark is
// for visibility of "when that branch was last successfully reflected", not for incremental skips.

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
  /** Collect folder where branch snapshots arrive. */
  collectDir: string;
}

/**
 * Processes every branch snapshot file in the collect folder. Each file has its own failure
 * isolation scope covering parse → load → sync_state record — one file failing does not stop the
 * processing of the remaining files.
 */
export async function runConsolidatedScan(
  deps: ConsolidatedScanDeps,
  opts: ConsolidatedScanOptions,
): Promise<ConsolidatedScanResult> {
  const files = await listInventoryFiles(opts.collectDir);
  if (files.length === 0) {
    throw new Error(
      `${opts.collectDir} has no branch snapshot file (.csv/.xlsx) — move the snapshots exported by ` +
        "the branch instances into this folder.",
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
        // tombstone (TASKS T31, DATA-002) — this single branch snapshot file is the authoritative
        // boundary of that branch (DESIGN §12.2). As long as its storeIds do not overlap with other
        // branch files (normally there is no reason they would — each branch exports only its own
        // stores) they do not affect each other.
        await tx.deactivateMissingCsvRows(deactivateParamsFrom(parsed));
        // The load and the watermark are tied into the same transaction — both commit only when
        // this callback succeeds to the end, and both roll back on failure.
        await tx.setCursor(resource, now.toISOString(), now);
      });
      results.push({ file: fileName, status: "success", itemCount: parsed.inventory.length });
    } catch (err) {
      // Record only this file as failed and continue — this file's own transaction rolled back so
      // there is no partial load, and the other branch files' loads/watermarks are unaffected.
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

// ── CLI entry point (assembly only) ───────────────────────────────────────

function parseSendMode(): "dry_run" | "live" {
  const raw = process.env["SEND_MODE"] ?? "dry_run";
  if (raw !== "dry_run" && raw !== "live") {
    throw new Error(
      `Invalid SEND_MODE value: "${raw}". Only "dry_run" or "live" is allowed (check .env).`,
    );
  }
  return raw;
}

function parseCsvMode(): "branch" | "consolidated" {
  const raw = process.env["CSV_MODE"] ?? "branch";
  if (raw !== "branch" && raw !== "consolidated") {
    throw new Error(
      `Invalid CSV_MODE value: "${raw}". Only "branch" (branch, default) or "consolidated"` +
        " (HQ consolidated) is allowed (check .env).",
    );
  }
  return raw;
}

async function runBranchMain(clock: Clock, handle: { warehouse: Warehouse }): Promise<void> {
  const watchDir = process.env["CSV_WATCH_DIR"];
  if (!watchDir) {
    throw new Error(
      "CSV_WATCH_DIR is not set. Add the path of the inventory file folder to watch to CSV_WATCH_DIR in .env.",
    );
  }
  const snapshotDir = process.env["CSV_SNAPSHOT_DIR"];
  if (!snapshotDir) {
    throw new Error(
      "CSV_SNAPSHOT_DIR is not set. Add the path of the folder to store snapshots in to CSV_SNAPSHOT_DIR " +
        "in .env (it must be a folder different from CSV_WATCH_DIR).",
    );
  }
  const thresholdRaw = process.env["CSV_DEFAULT_LOW_STOCK_THRESHOLD"];
  const defaultLowStockThreshold = thresholdRaw !== undefined ? Number(thresholdRaw) : undefined;
  if (defaultLowStockThreshold !== undefined && !Number.isFinite(defaultLowStockThreshold)) {
    throw new Error(
      `Invalid CSV_DEFAULT_LOW_STOCK_THRESHOLD value: "${thresholdRaw}". Specify a number or remove it from .env.`,
    );
  }

  const confirm = process.argv.includes("--confirm");
  const sendMode = parseSendMode();
  // --run-id=<value> (SR2-MAIL-001, second adversarial review response) — same reason as
  // agent/reorder.ts. If not given, falls back to randomUUID() as before (see runFolderScan).
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
      // SCM receipts (optional, SPEC §16) — without it runFolderScan runs exactly as before.
      ...(process.env["SCM_RECEIPTS_DIR"]
        ? { scmReceiptsDir: process.env["SCM_RECEIPTS_DIR"] }
        : {}),
      ...(process.env["SCM_RECEIPTS_STORE_ID"]
        ? { scmReceiptsStoreId: process.env["SCM_RECEIPTS_STORE_ID"] }
        : {}),
    },
  );
  console.log(
    `Folder scan completed (branch) — run_id=${result.runId}, status=${result.status}, ` +
      `${result.alertCount} alert(s), ${result.reconciliation.length} stock consistency warning(s), ` +
      `send ${result.sent ? "done" : "skipped"}. Snapshot: ${result.snapshotPath}`,
  );
  // OPS-005 — in addition to the human-readable line above, leave one parseable line.
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
      "CSV_COLLECT_DIR is not set. Add the path of the collect folder where branch snapshots arrive to " +
        "CSV_COLLECT_DIR in .env (CSV_MODE=consolidated only).",
    );
  }

  const result = await runConsolidatedScan({ warehouse: handle.warehouse, clock }, { collectDir });
  const failed = result.files.filter((f) => f.status === "failed");
  console.log(
    `Folder scan completed (HQ consolidated) — ${result.files.length} branch file(s): ` +
      `${result.files.length - failed.length} succeeded, ${failed.length} failed.`,
  );
  for (const f of failed) {
    console.error(`  failed: ${f.file} — ${f.error}`);
  }
  // OPS-005 — HQ consolidated mode processes files independently, so it has no single runId
  // concept by nature (see the docs above) — a new correlation id for this batch run is created
  // for logging only.
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

  // Without DATABASE_URL, start on embedded PGlite (T14, SPEC §12).
  const handle = await createWarehouseFromEnv();
  try {
    // SR2-REL-001 (second adversarial review) — on the network Postgres (DATABASE_URL) path, if the
    // schema is missing or only partially applied, stop right here with clear guidance instead of
    // a raw Postgres error. The embedded PGlite path is already auto-migrated, so this is a no-op.
    await ensureNetworkMigrationsApplied(handle);

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
