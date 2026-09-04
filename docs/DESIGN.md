# DESIGN — retail-mcp v0.1

This document is the source of truth for the implementation. If the code differs from it, fix the code to match the document; a design change starts with editing the document.

## 1. Architecture

```
                    Claude Code / Desktop            cron (e.g. Mon 07:00)
                          │ (MCP stdio)                    │
                          ▼                                ▼
                    src/server.ts                   src/agent/reorder.ts
                    (registers 6 tools only)        (orchestration only)
                          │                                │
                          └────────────┬───────────────────┘
                                       ▼
                             core/metrics.ts  ← both paths use the same functions
                             core/etl transforms (pure)
                                       │
        ┌──────────────┬───────────────┼─────────────────┬──────────────┐
        ▼              ▼               ▼                 ▼              ▼
  LoyverseClient   Warehouse      NotificationProvider  Summarizer   Clock
  adapters/        adapters/      (sheet_mcp port:      (Claude API   │
  loyverseClient   pgWarehouse     resendProvider)       summary only) │
  mocks/fixture    tests: PGlite   mocks/mock            mocks/fixed  mocks/fixed
```

Principle: `core/` contains only interfaces and pure computation. The MCP server and the agent are assembly layers and hold no logic. Because both entry points use the same core, "the number seen through a tool = the number in the report" is guaranteed structurally.

## 2. Warehouse schema (migrations/001_init.sql)

```sql
create table stores (
  id text primary key, name text not null
);
create table products (           -- flattened to Loyverse variant granularity
  variant_id text primary key, item_id text not null,
  name text not null, sku text, category text
);
create table sales_lines (        -- one row per receipt line
  receipt_id text not null, line_no int not null,
  store_id text not null references stores(id),
  variant_id text not null references products(variant_id),
  qty numeric not null,           -- refunds are negative
  gross numeric not null, discount numeric not null default 0,
  sold_at timestamptz not null,
  primary key (receipt_id, line_no)
);
create index on sales_lines (store_id, variant_id, sold_at);
create table inventory_levels (   -- current stock (kept latest via upsert)
  store_id text not null references stores(id),
  variant_id text not null references products(variant_id),
  in_stock numeric not null, updated_at timestamptz not null,
  primary key (store_id, variant_id)
);
create table inventory_snapshots ( -- appended on every sync: the starting point of the time series
  snapped_at timestamptz not null,
  store_id text not null, variant_id text not null, in_stock numeric not null,
  primary key (snapped_at, store_id, variant_id)
);
create table sync_state (
  resource text primary key,       -- receipts | items | inventory | stores
  cursor text, last_synced_at timestamptz
);
create table agent_send_log (
  id bigserial primary key, sent_at timestamptz not null,
  recipient text not null, subject text not null,
  suggestion_count int not null, message_id text, dry_run boolean not null
);
```

## 3. Metric formulas (core/metrics.ts — must be identical to SPEC §2)

```
sellThrough(v, period)    = soldQty / (soldQty + endStock)        // soldQty+endStock=0 → null (shown as new/no stock)
avgDailySales(v, window N) = soldQty over the last N days / N     // default N=28, calendar days
daysOfCover(v)            = inStock / avgDailySales                // avg=0 → shown as Infinity
stockoutRisk(v)           = daysOfCover < leadTime + safetyDays    // default 7 + 3
reorderQty(v)             = max(0, ceil(targetCover*avgDaily - inStock))  // default targetCover=21
```

All pure functions: `(rows: SalesAgg[], stock: StockRow[], opts) → MetricRow[]`. No DB access; Date is injected via `Clock`.

## 4. Core interfaces (core/types.ts)

```ts
export interface LoyverseClient {
  listStores(): Promise<LvStore[]>;
  listItems(cursor?: string): Promise<Page<LvItem>>;
  listReceipts(sinceISO: string, cursor?: string): Promise<Page<LvReceipt>>;
  listInventory(cursor?: string): Promise<Page<LvInventoryLevel>>;
}
export interface Warehouse {
  // Commits one resource's data upsert + watermark update as a single transaction (§11.1).
  // If an exception is thrown inside fn, every write made through the tx fn used is rolled back.
  // The implementation (T4) must provide real BEGIN/COMMIT/ROLLBACK.
  transaction<T>(fn: (tx: Warehouse) => Promise<T>): Promise<T>;
  upsertStores(rows: StoreRow[]): Promise<void>;
  upsertProducts(rows: ProductRow[]): Promise<void>;
  upsertSalesLines(rows: SalesLineRow[]): Promise<void>;      // updates on PK conflict (idempotent)
  upsertInventory(rows: InventoryRow[]): Promise<void>;
  appendInventorySnapshot(runId: string, at: Date, rows: InventoryRow[]): Promise<void>;
  getCursor(resource: string): Promise<string | null>;        // reads sync_state.cursor (=watermark)
  setCursor(resource: string, watermark: string, at: Date): Promise<void>;
  getSyncState(): Promise<SyncStateRow[]>;                    // cursor+last_synced_at for all resources (added in T9)
  querySalesAgg(q: SalesAggQuery): Promise<SalesAgg[]>;       // fixed parameterized SQL
  queryStock(q: StockQuery): Promise<StockRow[]>;
  queryStores(storeId?: string): Promise<StoreRow[]>;         // store-name lookup (added in T8) — for reports/filter validation
  logAgentSend(e: AgentSendEntry): Promise<void>;
}
export interface NotificationProvider {  // same signature as sheet_mcp (ported)
  readonly channel: "email"; send(msg: OutboundMessage): Promise<SendResult>;
}
export interface Summarizer {            // LLM boundary — wording only
  summarize(input: ReorderReport): Promise<string>;  // 2–3 sentences; the prompt forbids generating numbers
}
export interface Clock { now(): Date }
```

## 5. ETL (src/etl/sync.ts)

1. `stores` → `items` (variants flattened) → `receipts` (incremental: `sinceISO = cursor`, decomposed into lines, refunds as negative qty) → `inventory` (full upsert + snapshot append)
2. Cursor: for receipts, store the last `created_at` (or the cursor given by the API) in `sync_state`. **Re-runs are idempotent**: PK upsert on every table.
3. Pagination and rate limiting: pages are processed sequentially; exponential backoff on 429. On partial failure the cursor for that resource is not updated, so the next run retries it.
4. No LLM involvement — the whole process is deterministic.

## 6. MCP tools (src/server.ts, zod schemas)

| Tool | Input (defaults) | Returns |
|---|---|---|
| `sell_through` | store_id?, category?, period_days=30, order=asc\|desc(default fixed in T9: desc), top=20 | Per-item approximate sell-through table (with a footnote on the approximation formula) |
| `inventory_status` | store_id?, below_days_cover? | Current stock + days of cover |
| `stockout_risk` | store_id?, lead_time_days=7, safety_days=3 | At-risk items + projected stockout date (today + days of cover, YYYY-MM-DD) |
| `reorder_suggestions` | store_id?, target_days_cover=21, lead_time_days=7 | Suggested quantity table — **same function as the agent** (calls `buildReorderReport()` from `agent/reorder.ts` directly) |
| `sync_now` | resources?=[all] | Summary of the sync run — for concurrent calls only one runs under an advisory lock, the rest fail immediately |
| `sync_status` | — | Cursor and last sync time per resource |

Query tools are read-only and use fixed queries only. Free-form SQL is v0.2 (`explore_sql`, predicated on a read-only role).

**Implementation correction (T9)**: added a `category` filter to `queryStock` in `sell_through` — when filtering
by category, items from other categories that had stock but no sales leaked into the joined result of
`computeSellThrough` as `category: null` and neutralized the filter; this prevents that defect (`StockQuery.category`,
`core/types.ts`). Added `Warehouse.getSyncState()` (cursor+last_synced_at for all resources), used by
`sync_status` and the freshness check (`core/freshness.ts`).

## 7. Reorder agent (src/agent/reorder.ts)

```
load opts → sync_now (optional: --sync flag) → reorderSuggestions(core)
→ if 0 suggestions, log only and exit (no send)
→ assemble report: per-branch table (item · current stock · days of cover · suggested qty) = deterministic
→ Summarizer.summarize(table data) = 2–3 sentences of LLM wording (inserted below the table)
→ provider.send only when SEND_MODE=live && --confirm, otherwise dry-run output
→ write agent_send_log
```

If the LLM fails, send with the table only and no summary (the summary is an add-on; it never blocks the send).

## 8. Environment variables (committed as .env.example)

```
DATABASE_URL=            # Neon/Supabase Postgres
LOYVERSE_API_TOKEN=
SEND_MODE=dry_run        # dry_run | live
RESEND_API_KEY=
MAIL_FROM=
REPORT_RECIPIENT=
ANTHROPIC_API_KEY=       # summary only
```

## 9. Connecting to Claude Code

```bash
claude mcp add retail-mcp --scope project -- npx tsx src/server.ts
```

`.mcp.json` is committed to the repo; secrets go in .env/the shell environment. Verify the connection with `/mcp` inside Claude Code.

## 10. Directory layout (target)

```
retail-mcp/
  CLAUDE.md  README.md  .mcp.json  .env.example
  docs/  migrations/  fixtures/loyverse/  scripts/smoke.ts
  src/{core,etl,adapters,mocks,agent,mcp}/  src/server.ts   # mcp/ = logic for the 6 MCP tools (T9); server.ts only registers them
  tests/
```

## 11. Design clarifications (mandatory for implementation)

### 11.1 Incremental sync and atomicity

- Separate the external API's page token (`pageCursor`) from the next run's incremental starting point (`watermark`). `sync_state.cursor` stores **only the watermark of a completed resource**, never a page token.
- Process all pages of one resource inside staging/a transaction, and commit the data upsert and the watermark update in the same transaction. If a page fails midway, roll back that resource's data and watermark, then retry from the previous watermark. This atomicity is expressed as `Warehouse.transaction(fn)` — the ETL (T7) must call the upsert-type methods and `setCursor` inside the same `fn`, and only through the `tx` it receives.
- The `receipts` watermark uses a boundary that can stably re-query ties, such as `(updated_at, receipt_id)`. If the API supports only a single timestamp, re-query inclusive of the boundary timestamp and remove duplicates via PK upsert.
- Keep the resource order because of dependencies, but do not report an earlier resource's success plus a later resource's failure as overall success. The result carries per-resource success/failure and the last successful time.

### 11.2 Snapshots and run identifiers

- Use a `runId` and `snappedAt` fixed for one sync run across all inventory rows. To avoid collisions when re-running at the same instant, the actual migration adds `run_id` or defines the PK as `(run_id, store_id, variant_id)`.
- `appendInventorySnapshot` and the current-stock upsert are handled in the same transaction (`Warehouse.transaction`). An empty inventory response does not overwrite the existing current stock with 0; it is treated as a sync error.
- `inventory_snapshots.store_id`/`variant_id` are foreign keys referencing `stores`/`products` respectively — a snapshot for a non-existent store or product is rejected at load time.

### 11.3 Numeric and time normalization

- `soldQty` distinguishes the raw net sales quantity from the quantity used for computation. The computational sales quantity and current stock are each `max(0, value)`, and negative raw values get `data_quality_warnings` attached.
- Receipts with a `cancelled_at` are not loaded into `sales_lines` by the ETL (SPEC §9) — whether SALE or REFUND, they are treated as incomplete transactions and excluded from both sales and refund aggregates.
- Postgres `numeric` is handled explicitly as decimal/string at the boundary and then converted per the quantity policy. Apart from display rounding and the reorder `ceil`, intermediate calculations are not rounded arbitrarily.
- The sales window is defined as `[start of business-local today-N days, start of local today)`. The projected stockout date is computed only for finite days of cover, and the return value includes the reference timezone.

### 11.4 Permissions and tool separation

- `sell_through`, `inventory_status`, `stockout_risk`, `reorder_suggestions`, `sync_status` run with read-only DB credentials.
- `sync_now` is a write operation. In production, route it to a separate sync process/write credentials, and if it is exposed via MCP, register it only when `SYNC_TOOL_ENABLED=true`. The default is disabled.
- Concurrent `sync_now` calls are limited to a single run by a DB advisory lock. Logs and MCP errors do not include secrets or raw external API responses.
  - **Implementation correction (T9)**: to match TESTING §7 "other calls return an in-progress error/status", the **non-blocking**
    `pg_try_advisory_lock` (`withTryAdvisoryLock`, `src/adapters/advisoryLock.ts`) is used — if already
    locked it throws `AdvisoryLockBusyError` immediately without waiting. The migration runner's (`scripts/
    migrate.ts`) `withAdvisoryLock` is blocking (wait, then run sequentially), which has different semantics, so it is kept as a separate
    function — both helpers live in `src/adapters/advisoryLock.ts` (originally migrate.ts-only;
    moved in T9 so that src does not depend on scripts).

### 11.5 Agent run log

- `agent_send_log` must be able to distinguish not just successful sends but the `no_suggestions`, `dry_run`, `sending`, `sent`, `failed` outcomes. The actual migration adds `status`, `error_code`, `run_id`, and for unsent states either makes `recipient`/`subject` nullable or uses a separate `agent_run_log`.
- Double-send prevention uses the **reservation pattern**: T8 must commit a `status='sending'` row first, before calling `provider.send()`. A partial unique index allowing at most one `sending`/`sent` per `run_id` turns this INSERT into an atomic lock — if the insert fails with a unique violation, a send is already in progress or complete, so do not send again. On success update the same row to `sent`; on failure to `failed` (`failed` is not covered by the index, so a retry can reserve a new `sending` row again). How to reclaim old rows stuck in `sending` after a process crash is a policy decided in T8 (e.g. transition to `failed` after a certain time has elapsed).
  - **Implementation correction (T8)**: `pgWarehouse.logAgentSend` **always attempts `status='sending'` as a new INSERT only** (on unique violation it rethrows an error carrying the cause), and for `status='sent'/'failed'` it finds the `status='sending'` row for the same `run_id` and updates only that row. The original implementation only checked whether a row existed for the `run_id` and unconditionally UPDATEd if so, which had the defect that calling `logAgentSend('sending')` again with an already-`sent` `run_id` would silently revert that row to `sending` and allow a re-send — the partial unique index's protection was never actually triggered. Within the run cycle every run uses a new `run_id` (default `randomUUID()`), so this defect rarely surfaces in normal operation, but a retry script that explicitly reuses a `run_id` could double-send. Policy decision: **background reclamation is not automated** — in normal operation, where cron runs each time with a new `run_id`, nobody touches rows stuck in `sending`. The only path that closes such a row is "a human explicitly retries with the same run_id" in the SR2-MAIL-003 state machine below (the old wording "the operator transitions it to `failed` directly in the DB" is retired — `failed` means "definitely did not go out", so it must not be applied to a row whose outcome is unknown). A call that tries to record `sent`/`failed` without a `sending` is itself treated as an error and thrown.
  - **Same-run_id retry state machine (second adversarial review SR2-MAIL-003, `core/sendRetryPolicy.ts` + `agent/sendRetryGate.ts`)**: one `run_id` ends as `sending → sent | failed | unknown`. When a human retries with `--run-id=<previous value>`, both agents (`agent/reorder.ts`, `agent/folderScan.ts`) read the previous attempts via `Warehouse.listAgentSendAttempts(runId)` **immediately before** the `sending` reservation and decide as follows. ① If there is no `unknown`/`sending` row (first attempt, or after `failed`/`dry_run`), reserve as usual — `failed` is always safe because it is certain the request never reached the provider (SR2-MAIL-002). ② If there is an `unknown`/`sending` row, take the **oldest** `sent_at` among them as the reference time; if we are still **within** `NotificationProvider.dedupeTtlMs` (Resend: 24 hours, `RESEND_IDEMPOTENCY_TTL_MS`) minus the safety margin `DEDUPE_SAFETY_MARGIN_MS` (1 hour — absorbs clock skew and request duration), allow the retry (same Idempotency-Key, so the provider dedupes → in practice one email). In that case, if there is a row stuck in `sending`, close it as `unknown` (error_code `stale_sending`) via `Warehouse.markStaleSendingUnknown(runId)` before reserving — `sent_at` is kept (preserving the reference time). ③ If that time has passed (boundary inclusive — equal is refused), or the provider does not declare `dedupeTtlMs`, refuse with `SendRetryRefusedError` — because even with the same key the provider would treat it as a new send and send a duplicate. The error carries the previous attempt's time and status, the refusal reason, and the procedure ("check in the sending service's dashboard whether an email went out to the recipient around that time → if not, run with a new run_id without `--run-id`; if it did, no retry is needed"). **No automatic remote lookup is provided**: `unknown` means no response was received, so there is no message_id, and the Resend API has no endpoint to look up an existing email by Idempotency-Key (confirmed 2026-09-04), so human confirmation is the only path. This gate does not replace the partial unique index — an already-`sent` run_id or a concurrently live `sending` is still blocked atomically by the index.

### 11.6 Common response metadata

Every query tool includes at least `generated_at`, `data_last_synced_at`, `timezone`, `filters`, `warnings` in its result. Sell-through responses include the approximation formula, stale data carries a warning, and numeric fields separate the machine-readable raw value from the display string.

**Implementation (T9)**: the stale check is `computeFreshness()` in `core/freshness.ts` (pure function, default threshold
`DEFAULT_STALE_THRESHOLD_HOURS=24`, adjustable via env `STALE_THRESHOLD_HOURS`), shared by both the MCP query tools
(`src/mcp/tools.ts`) and the agent report (`buildReorderReport()` in `agent/reorder.ts`)
— the single point that makes the stale warning apply to "all queries and reports" per SPEC §9.

## 12. v0.2 deployment and stability design extensions (2026-09-03, response to the pre-npm-release adversarial review — TASKS T28)

This moves the `docs/004~008` adversarial review (40 findings) and the policy decisions of `docs/SPEC.md` §18 into implementation contracts. Per the principle at the top of this document that DESIGN is "the source of truth for the implementation", when the contracts written here differ from the actual code, fix the code to match the document. The responsible TASKS number is shown at the end of each subsection — this section itself only defines contracts and does not implement them.

### 12.1 Build/bin structure (REL-002/003/004, TASKS T29)

- **Public contract**: `retail-mcp` is a CLI/MCP server product. Library `exports` are not provided in this scope (a separate decision if they become necessary).
- **Build**: `tsc` compiles `src/**/*.ts` → `dist/**/*.js` + `.d.ts`. Direct source-tree execution (`tsx`) remains development-only and stays in `devDependencies` — the published package must work with only the pure JS in `dist/` (including `npm install --omit=dev` environments without `tsx`).
- **`bin`**: the MCP server entry point (`dist/server.js`) and the onboarding CLI (`dist/cli/onboard.js`) each get a shebang (`#!/usr/bin/env node`) and are registered in `package.json.bin`. The folder-scan and reorder agents are exposed only via `npm run agent:*` scripts (they are invoked by cron, so no separate global bin is needed) and will be revisited in a follow-up task if needed.
- **`files` allowlist**: include `dist/`, `migrations/`, `README.md`, `LICENSE`, `.env.example`; exclude `tests/`, `tests/fixtures/`, `docs/` (internal review documents), the ESLint/Vitest config, and the original `.ts` sources. The file list from `npm pack --dry-run` is pinned in the release gate (TASKS T29 completion criterion).
- **Verification**: add a smoke test to the release gate that installs the tarball into a temporary directory with `npm install --omit=dev` and then verifies up to `npx retail-mcp --help` (or MCP initialize) (QA-001, TASKS T29).

**Implemented (T29)**: `tsconfig.build.json` (`rootDir: src`, excludes `src/mocks/**`) and `scripts/verifyPack.ts` (`npm run verify:pack`) actually verify build → pack → fresh install → running `retail-mcp` (MCP `tools/list`) and `retail-mcp-onboard` (`.env` + template generation). This smoke test itself caught two defects that source-tree tests never surfaced — `src/adapters/mainModule.ts` (realpath comparison when `process.argv[1]` is an npm bin symlink) and `createReadlineAsk()` in `src/cli/onboard.ts` (Node's own behavior where repeated `rl.question()` calls stall on piped input; replaced with async-iterator consumption) — both IO-boundary defects that this document's §12.1 did not anticipate when the contract was first written.

### 12.2 Authoritative snapshot replacement contract — tombstone (DATA-002, TASKS T31)

Implementation contract for the policy decided in SPEC §18.

- **Boundary definition**: the "authoritative boundary" is (a) the single latest file in the watch folder in branch mode, (b) one snapshot file per branch in HQ consolidated mode (independent per branch) — the same unit as the "commit that branch's watermark only after the branch snapshot file has been parsed successfully to the end" already specified by §12 (old version, the actual usage procedure).
- **Schema**: add `active boolean not null default true` (or an equivalent status column) to `inventory_levels` and `sales_period_agg` (and to the `products` managed by the CSV channel). No physical deletion (`DELETE`) — for the sake of reactivation and the audit trail.
- **Transaction contract**: inside the upsert transaction of one authoritative scan, transition "rows that are not in this scan's (store, SKU) set but were previously `active=true` for that store" to `active=false` in the same transaction — the upsert and the tombstone commit together or roll back together atomically (no partial state; the same spirit as the "commit the watermark only after all pages succeed" principle in CLAUDE.md's implementation interpretation supplement).
- **Consumer contract**: reorder computation (`computeReorderMetrics`/`computeCsvReorderMetrics`), low-stock alerts, and default MCP queries see only `active=true` rows. Diagnostic queries such as `inventory_status` may expose an include-inactive option (decided at implementation time).
- **HQ consolidated mode isolation**: the tombstone decision compares only against that branch's previous state, inside a per-branch independent transaction — another branch's (store, SKU) is never misjudged as missing from this branch's scan.

**Implemented (T31)**: `migrations/006_tombstone_active_flag.sql` (`active boolean not null default true` on `inventory_levels`/`sales_period_agg` + a `(store_id, active)` index). `Warehouse.deactivateMissingCsvRows({storeIds, presentInventory, presentSales})` (new) — builds the "(store, SKU) key set present in this scan" via `unnest($2::text[], $3::text[])` and updates only the existing active rows outside it to `active=false` (no physical deletion). `upsertInventoryOn`/`upsertSalesPeriodAggOn` always upsert with `active=true`, guaranteeing automatic reactivation on reappearance, and `queryStockOn`/`querySalesPeriodAggOn` return only `active=true` — the Loyverse path (`sales_lines`/`etl/sync.ts`) never calls the tombstone, so its existing behavior is completely unchanged. `agent/folderScan.ts` calls `deactivateMissingCsvRows` inside the authoritative transaction of both `runFolderScan`/`runConsolidatedScan` (the same transaction as the upserts) — `presentInventory` is every inventory row in this file, `presentSales` only the rows with sales history (the two can differ).

### 12.3 File idempotency + daily digest (DATA-003/004, TASKS T31)

Implementation contract for the policy decided in SPEC §18.

- **Input identity**: compute the watch folder path (source identity) + the content hash (sha256) of the selected latest file (mtime alone is unreliable because it overlaps with the tie problem of OPS-003) and compare with the previous run.
- **Watermark storage**: store `{contentHash, lastSentAt}` as JSON in `sync_state` (existing table, reusing the free-form `resource` string — no new schema needed) under a key like `csv_branch_digest:<watchDir>` (the cursor column is text, so serialize as a JSON string).
- **Decision logic**: (1) If the content hash differs from the previous one, always process; decide whether to send based on whether issues exist, and update `lastSentAt` when sending. (2) If the content hash is the same, check whether 24 hours (or the local midnight boundary — to be fixed at implementation time) have passed since `lastSentAt` in the business timezone — if not, exit quietly as `unchanged` (no send, log only); if so, send one digest even with identical content, then update `lastSentAt`.
- **Relationship to SCM reconciliation results**: tied to DATA-007 (exposing SCM failure status) — SCM processing failure is also treated as an "issue" so it can be included in the daily digest (preventing complete silence).
- **atomic snapshot write**: the snapshot export in `folderScan.ts` does not `writeFile` directly to the fixed filename (`snapshot.csv`); it writes to a temporary file in the same directory (`snapshot.csv.tmp-<runId>`), then `fsync`s and replaces via `rename` (POSIX rename is atomic). The HQ collection process ignores files whose extension is `.tmp-*` (the temporary filename itself is the signal instead of a ready marker — no new file format is added).

**Implemented (T31)**:

- `src/adapters/atomicFile.ts` (new) — `writeFileAtomic(targetPath, content, {mode?})`. The temporary filename is `<targetPath>.tmp-<pid>-<timestamp>-<random>` (suffix style) — since `listInventoryFiles()` in `folderScan.ts` already selects only files whose name "ends" with those extensions via `/\.(csv|xlsx)$/i`, this name is naturally excluded without a separate filter. The snapshot write in `folderScan.ts` uses this utility — the `.env` write (SEC-005) will reuse the same utility in T32.
- `migrations/007_agent_send_log_unchanged_status.sql` — adds `unchanged` to `agent_send_log.status` (recreates the existing check constraint). Adds `"unchanged"` to `AgentSendStatus`.
- **Decision logic finalized (refined from the design above)**: content hash + `sync_state` watermark (`csv_branch_digest:<absolute watchDir path>`) is exactly as designed. However, **the scope was narrowed to the actual send-attempt path** — `no_suggestions`/`dry_run` never send an email in the first place, so they are always processed as-is regardless of the suppression decision (and the watermark is not updated either). `shouldSkipAsUnchanged()` is checked only on the path that is "really about to send an email", i.e. `willSend=true` and `issueCount>0`. The reason for narrowing: during the work, the existing guardrail 1 regression test ("only actually send when both SEND_MODE=live && confirm") calls `runFolderScan` twice in a row with the same file and the same time, and the initial implementation (skipping everything before parsing) recorded even the dry-run-like first call in the watermark, thereby suppressing the perfectly normal usage of a human re-checking repeatedly in dry-run — what DATA-003 actually aims to prevent is "actual email spam from cron running repeatedly", not repeated manual checks by a person.
- The watermark is updated **only at the moment an email is successfully sent (`sent`)** — it is not updated on `failed` (an actual send failure), so the next run can retry immediately even on the same day with the same content (the daily cap must not suppress failures as well).
- A suppressed run also returns the `alerts`/`reconciliation` this scan actually computed, as-is, with `status="unchanged"` — so the caller can tell what was suppressed.
- Tests: `tests/atomicFile.test.ts` (new), `tests/folderScan.test.ts` (digest suppression / re-send after 24 hours / no suppression on content change / no suppression on send failure / dry_run unaffected — 5 tests, tombstone 3 tests).

### 12.4 explore_sql isolation finalized — role enforcement + PGlite re-examination (SEC-001/002, TASKS T30)

Moves the policy decision of SPEC §18 into an implementation contract. The two-layer defense of §6/§17 (`sqlValidator` first, `BEGIN READ ONLY` second) is kept, but the previous assumption that "these two layers are enough" is lowered and the following is added.

- **Dedicated role required**: when enabling `EXPLORE_SQL_ENABLED=true` in a production deployment, the DB role that `pgWarehouse` opens with must not have execute permission on volatile functions such as `pg_advisory_lock`, `set_config`, or extension functions — the recommendation in the README "Permission separation" section is elevated to a mandatory checklist. The code does not forcibly query and validate role permissions (production DB role configuration is the deployer's responsibility, the same principle as existing guardrail 4) — instead it is made explicit via documentation and a startup warning log.
- **Regression tests**: pin the bypasses using `pg_try_advisory_lock`/`pg_advisory_unlock` and redefinition of `set_config('statement_timeout', ...)` as attack scenarios in `tests/exploreSqlExecutor.test.ts` (exactly as 005 SEC-001/002 reproduced them) — kept as regression tests that document not "we block this" but the fact itself that "there are parts these two layers alone cannot block, which is why the role restriction is mandatory".
- **PGlite exposure re-examination**: on top of not enforcing `statement_timeout` (the existing §17 limitation), PGlite does not support role-based function execution restrictions — the combination `EXPLORE_SQL_ENABLED=true` + PGlite (embedded) is directly exposed to the SEC-002 DoS path. When this combination is detected (the warehouse factory already knows the pg/pglite branch), leave a clear warning in the server startup log — whether to hard-block is finalized during the T30 implementation.

**Implemented (T30)**:

- Added `FORBIDDEN_FUNCTION_CALLS` to `core/sqlValidator.ts` (a list separate from `FORBIDDEN_KEYWORDS`) — blocks advisory-lock functions (`pg_advisory_lock`/`pg_try_advisory_lock`/...), `set_config`, backend control functions (`pg_terminate_backend`/`pg_cancel_backend`/`pg_reload_conf`/`pg_rotate_logfile`), and file/remote access functions (`lo_import`/`lo_export`/`dblink*`/`pg_read_file`/`pg_read_binary_file`/`pg_ls_dir`) at the function-name level (`\bname\s*\(`) — closing the exact bypass (demonstrated in 005) that the `\bword\b` matching of `FORBIDDEN_KEYWORDS` missed because there is no word boundary before the "_lock" in `pg_advisory_lock` (an underscore is also `\w`). Documented that it is still incomplete (every volatile function cannot be enumerated) — for functions outside the list such as `nextval()`, `BEGIN READ ONLY` remains the last line of defense.
- **Blocking decision finalized: with PGlite (embedded, no `DATABASE_URL`), `EXPLORE_SQL_ENABLED=true` refuses server startup by default.** `resolveServerConfig()` throws an error containing cause + remedy when `EXPLORE_SQL_ENABLED=true` without `DATABASE_URL` (= the PGlite path, the same criterion as `createWarehouseFromEnv`) — it can be bypassed only by additionally setting the new env `EXPLORE_SQL_ALLOW_PGLITE=true` (the same "explicit risk acknowledgment" double-gate pattern as `SEND_MODE=live && --confirm`). PGlite can neither separate permissions by role nor enforce `statement_timeout`, a combination in which both safeguards are absent, so rather than a complete block we chose "if you must enable it anyway, do so explicitly" — the real Postgres/Neon path works as before without this check.
- `createRetailMcpServer()` logs the dedicated-role recommendation warning once at server startup via `console.warn` (stderr — the MCP protocol owns stdout, which is never polluted) when `EXPLORE_SQL_ENABLED=true` (mentions only the warehouse kind; no secrets or connection details in the log).
- Tests: `tests/sqlValidator.test.ts` (each function blocklist entry + reproduction of the underscore bypass + schema-qualifier/case/whitespace bypass attempts + false-positive prevention), `tests/exploreSqlExecutor.test.ts` (new functions are rejected before execution + a documentation-purpose test that reproduces directly in a session that "had the validator been bypassed, READ ONLY alone would not have blocked the advisory lock"), `tests/server.test.ts` (3 cases of `EXPLORE_SQL_ALLOW_PGLITE` gating).

### 12.5 Atomic file write — shared utility (DATA-004, TASKS T31)

The atomic snapshot write of 12.3 and SEC-005 (`.env` 0600 atomic write) need the same pattern (temp file → flush → rename) — shared as `src/adapters/atomicFile.ts` (new, pure IO utility): `writeFileAtomic(path, content, { mode? })`. The `.env` write in `onboard.ts` and the snapshot write in `folderScan.ts` share this utility.

### 12.6 File and secret security — limits, formula escape, permissions, dependency exception (SEC-003~007, TASKS T32)

**File size / row count / cell length limits (SEC-003)** — `src/adapters/fileLimits.ts`: 20MB per file, 100,000 rows, 10,000 characters per cell. CSV is plain text, so a single file-size limit suffices (no compression amplification, so disk size is the memory ceiling). XLSX is zip-compressed, so it differs — it was originally implemented with `ExcelJS.stream.xlsx.WorkbookReader` (true streaming, checking the limit per row and not reading the remaining compressed data as soon as it is exceeded), but when tests ran concurrently across multiple files, an exception presumed to be an internal ExcelJS race reproduced intermittently even while reading the same fixture (details in `docs/005` SEC-003). Judging that a failure to read an inventory file is far more common and critical than a zip bomb, we reverted from the unverified streaming path to the existing buffered `workbook.xlsx.readFile` + "check the limits right after reading" — the **residual risk** (the check happens only after the whole file has already been decompressed into memory; the shared-strings cache is expanded even before that) is honestly left in a code comment. In real-world scenarios (store inventory, tens of thousands of rows or fewer) the file-size limit itself is already low, so the practical risk is judged small — revisit when the streaming reader stabilizes on the ExcelJS side (T33+).

**CSV formula injection escape (SEC-004)** — contract: the snapshot CSV (`snapshotExport.ts`) is treated as a "CSV a human may also open" (it is the machine re-import input for consolidated mode, but a branch staff member may also open it directly to check). `src/core/csvSafety.ts` — if a store name, product name, or SKU starts with `=`/`+`/`-`/`@`, a `'` is prepended on export. **Re-import strips it not in `snapshotExport.ts` alone but in `requiredTrimmedString` of `core/csvSchema.ts` (shared by store name, product name, and SKU)** — so it applies equally to original CSV/XLSX input that is not our own snapshot, guaranteeing a symmetric round trip regardless of file origin (it strips only under the same prefix condition, so values that originally started with `'` are not wrongly touched).

**`.env` file permissions (SEC-005)** — `writeEnvFile()` in `src/cli/onboard.ts` calls `writeFileAtomic(path, content, { mode: 0o600 })` (reusing the shared utility of 12.5). No separate "check and fix existing file permissions" logic is needed — POSIX `rename(2)` replaces the old inode at the target path entirely with the new inode, so if the newly written temp file is 0o600, the resulting file after rename is always 0o600 too (even if the existing file had looser permissions).

**Dependency vulnerability — approved exception (SEC-006)**: `overrides: { uuid: "^11.1.1" }` was added to `package.json`, but **this override applies only to the dev checkout (when running `npm install` on the repo directly) and not when another project installs this package as a dependency** — that is npm's own behavior (other package managers are largely the same) and cannot be fixed by this project. Direct verification by installing the actual tarball to be published into a completely fresh project (discovered during the work) confirmed that `uuid@8.3.2` still resolves as-is. exceljs calls `uuid`'s `v4()` only without arguments (it never takes the v3/v5/v6 path with the `buf` argument that the advisory concerns), so the practical risk was judged low, and a wholesale replacement with another library was deemed not worth destabilizing a stable path covered by 43 XLSX tests — left as an **approved exception** (rationale: `docs/005` SEC-006, re-review deadline 2027-03-03). An `npm audit` check was added as step 5 of `scripts/verifyPack.ts` (release gate) — based on the directory where the actual tarball was installed, it verifies every time that this exception is the only advisory URL (if a different/new vulnerability appears, the release gate fails).

**`SECURITY.md` (SEC-007)**: newly created at the repo root, containing supported versions (`main` only, since it is pre-release), response targets, the GitHub private security advisory reporting channel, and a summary of this project's known security design boundaries. Linked from the README document map.

### 12.7 SCM/field consistency — nullable clear, insufficient_data, scm_status, receipt aggregation (DATA-005~008, TASKS T33)

**Explicit clear of nullable fields (DATA-005)** — `ProductRow.lowStockThreshold`/`packSize` in `core/types.ts` were already `?: Numeric | null` (i.e. the type itself allowed the three states `undefined`/`null`/value), but no code actually distinguished and applied the three. Now `undefined` = "this upsert has no information for this field" (keep the existing DB value), `null` = "explicitly clear", value = set to that value — the three states are preserved end to end. `csvExcelParser.ts` distinguishes "column absent" from "column present but cell empty" by the presence of the column key in the raw row (before parsing) (for XLSX the header columns are pre-seeded as `undefined` on every row to give it the same property as CSV — discovered during the work: `eachCell({includeEmpty:false})` originally skipped empty cells, making the distinction impossible), and `pgWarehouse.upsertProductsOn` decides for the **whole batch (one file)** only "is there at least one row with any information at all for this field" and chooses the SET clause itself as either `excluded.x` (apply as-is, including clears) or `products.x` (preserve) — exploiting the property that column presence is an attribute at the file-header level, so it does not vary row by row within one batch (if it were to vary, it is one of two: all `undefined`, or none).

**SCM insufficient_data (DATA-006)** — added `insufficientData`/`insufficientDataReasons` to `StockReconciliationRow` in `core/metrics.ts`. If the opening stock is unknown (the key is absent from `openingStock` — always absent today, since there is no onboarding flow for entering physical-count values) or the SCM receipt period and the sales period do not overlap (new `periodsOverlap` option, decided by the pure function `periodsOverlap()`), `insufficientData: true` is set, and wording that asserts a definite cause such as "theft/damage/count-error verification needed" is not put into `warnings` (the numbers themselves remain for reference). **As of today no caller actually passes opening stock, so every SCM reconciliation is insufficientData** — definite mismatches only start appearing once an onboarding task for entering physical-count values exists.

**scm_status (DATA-007)** — added `ScmStatus` (`not_configured`/`no_file`/`failed`/`ok`) in `agent/folderScan.ts`, exposed on every return path as `FolderScanResult.scmStatus`. The `ok` case carries DATA-006's `insufficientData` as-is — the two findings are in the end different facets of the same axis, "how much to trust and expose the SCM reconciliation result", so they naturally merged into one status. When the actual report goes out, `renderAlertText` inserts only a one-line summary rather than a per-SKU list (to avoid noise) — this blocks the concern that "an SCM problem gets buried in an email that looks like a normal result" at the email-body level.

**Aggregating multiple receipts on the same date (DATA-008)** — instead of introducing a stable event key (impossible, since the source sheet lacks that information), `mapScmRowsToPurchaseReceipts` in `core/scmSchema.ts` sums quantities per (store, SKU, receipt date) just before returning (`aggregateSameDayReceipts`). Unit price and supplier (for audit; not used in computation) keep the last row's values. Re-scanning the same file assigns the same aggregated result each time (assignment), so it is idempotent — the key point is that the DB side never does `+=` accumulation.

## 12.8 Operational reliability — lock, tie-break, send idempotency, logs/retention (OPS-001~006, TASKS T34)

**PGlite close order (OPS-001)** — `close()` in `warehouseFactory.ts` wraps `db.close()`/`lock.release()` in independent try/catch blocks so that release always runs regardless of whether db.close() succeeds or fails. If both fail, both causes are preserved via `AggregateError` (throwing just one would silently lose the other cause). The catch on the initialization failure path (migration etc.) follows the same principle.

**PID reuse mitigation (OPS-002)** — added `hostname`/`nonce`/`pidStartedAt` to the lock file in `fileLock.ts`. `pidStartedAt` can only be obtained on POSIX (`ps -o lstart= -p <pid>`) — Windows has no equivalent command usable without installation (connected to OPS-006), so it is always `null` there, and in that case it safely falls back to the existing PID-only decision without this signal (the principle: even if the mitigation fails, it must not create a new failure). Decision order: ⓞ a lock with no hostname field at all is **always busy, as the owning host is unknown** (`FileLockBusyError.unknownHost=true`, never auto-reclaimed) — initially, for backward compatibility, it was treated as "same host" and passed on to the PID check, but on a shared filesystem that would let a local PID check alone steal another host's live lock, so the second adversarial review SR2-LOCK-002 changed it to the conservative handling (no migration option was provided, since there are no old-format locks on the user side before the npm publish). ① A lock written by another host (machineId if both sides have machineId, otherwise hostname mismatch — SR2-LOCK-001) is **always treated as busy** (never auto-reclaimed; a human must verify manually and then delete it), since this process has no way to check whether it is alive. ② On the same host, first check liveness with `isAlive(pid)`, but even if it is alive, if that pid's *current* start time differs from the one recorded in the lock (compared only when both are available), conclude that the OS reused the pid in the meantime, treat it as stale, and reclaim it.

**Non-atomicity of check-then-delete in release (SR2-LOCK-003, ACCEPTED 2026-09-04)** — `release()` reads the lock file to verify that the pid and nonce are ours, then does a separate `rm`. If someone deletes and recreates the file between those two syscalls, we delete the new owner's lock. Rationale for **deciding not to close this in code**: ① POSIX has no "unlink only if inode/content matches", and Node's standard library has no `flock` (excluding native modules is an existing decision of this project — the same principle by which OPS-002 was solved with just `ps`). ② Rename-based verification (move the lock to a temporary name, verify, then delete) leaves the lock slot empty while verifying, so a third party can acquire it with `wx`, and there is no way to put it back if it turns out not to be ours (`link` fails with EEXIST) — it creates a **wider** window — rejected. ③ Re-checking `stat().ino` right before deletion only shrinks the window from "read→delete" to "stat→delete", the same order of magnitude, so there is no practical gain; a test hook would enter production code; and on network FS/Windows where inodes are unstable, it would skip a normal release and create a new failure mode in which the lock leaks until process exit — rejected. ④ For this race to occur, an operator must **delete the lock of a live process** (violating the recovery protocol) and another process must create a new lock within that microsecond window — it does not occur on the normal path (`wx` exclusive create, nonce verification, the error message's guidance to "delete only after confirming the process is gone"). Instead, a **manual recovery protocol** is codified in the README "PGlite lock recovery" section: lock files are only ever deleted (never edited or replaced), and are left untouched if any retail-mcp process is running on any host. The residual risk is recorded as ACCEPTED in `docs/010_SECOND_ADVERSARIAL_REVIEW_T29_T36.md`.

**Latest-file determinism (OPS-003)** — instead of rejecting with an error, a deterministic tie-break was adopted: mtime descending, then full path descending on ties (`sortByMtimeThenPathDesc`, `agent/folderScan.ts`, shared by inventory/SCM file selection). Given the same set of files, the same file is always selected regardless of the OS `readdir` order. When a tie is actually detected, the warning log states that fact explicitly.

**Send unknown status + idempotency (OPS-004)** — confirmed from the API documentation (2026-09-03) that Resend supports the `Idempotency-Key` header (unique per request, 24-hour expiry, max 256 characters). `OutboundMessage.idempotencyKey` (new) carries the `runId` as-is and `resendProvider.ts` passes it as the header — even if a human retries with the same runId, only one email actually goes out. Added `"unknown"` to `AgentSendStatus` (migration 008) — `resendProvider.ts` marks the error `.name` as `AmbiguousSendError` **only on timeout** (a connection failure itself or an HTTP error response is not a candidate, since "whether it arrived" is certain), and `agent/folderScan.ts`/`agent/reorder.ts` see this and record `unknown` instead of `failed`. We nearly missed that `logAgentSendOn` in `pgWarehouse.ts` must include `unknown` alongside `sent`/`failed` as an "update the sending reservation row" target (omitting it leaves two rows for the same run_id — actually reproduced and fixed with an integration test). The "within 24 hours" condition initially existed only in the documentation and was not enforced by code — in the second adversarial review SR2-MAIL-003 it became a real gate via the same-run_id retry state machine of §11.5 (`core/sendRetryPolicy.ts`) (retries outside the retention window are refused; rows stuck in `sending` are closed as `unknown(stale_sending)` on retry).

**Structured logs, exit codes, retention, backup (OPS-005)** — `logStructured()` in `src/adapters/structuredLog.ts` (new) emits one `{event, runId, status, ...}` JSON line to stdout at the CLI entry points (`agent/folderScan.ts`, `agent/reorder.ts`), separate from the existing human-readable log (server.ts is excluded because its stdout is reserved for the MCP protocol). The exit-code contract (0=completed, 1=unhandled exception) merely documents the existing behavior in the README (no code change). The retention policy is `Warehouse.deleteOldInventorySnapshots`/`deleteOldAgentSendLog` (new) + `scripts/cleanup.ts` (`npm run cleanup`) — the same double gate as `npm run migrate` (dry-run by default, actual deletion only with `--confirm`), `CLEANUP_RETENTION_DAYS` (default 90 days). Backup/restore is documented in the README only (embedded PGlite = copy the data directory files; `DATABASE_URL` = delegated to the hosting service's managed backups).

**Installation environment compatibility (OPS-006) — resolved (T35)** — following the documentation of the supported range in the README (Node 20+, macOS verified, Linux unverified, Windows explicitly unverified), the `test` job of the CI first set up in T35 (`.github/workflows/ci.yml`) actually verifies that range: `os: [ubuntu-latest, macos-latest] × node: [20, 22]` (the declared minimum 20 + the next maintenance LTS 22), and on every combination runs `npm run verify:pack` (clean tarball install) in addition to typecheck/lint/format/test. The mere fact that CI runs on Linux runners also resolves "Linux unverified". Windows is still not in the matrix — a deliberate choice that keeps the already documented constraint that the `ps`-based OPS-002 auxiliary signal in `fileLock.ts` does not exist on Windows (§12.9).

## 12.9 Test gate P1 — first CI setup, coverage expansion, real Postgres component, supply-chain automation (QA-002~006, OPS-006, TASKS T35)

**CI architecture** — `.github/workflows/ci.yml` (this repository's first workflow), 4 jobs: `test` (OS/Node matrix, doubling for OPS-006), `coverage` (QA-002/003), `postgres-component` (QA-004, `postgres:16` service container), `audit` (QA-006, lockfile audit + secret scan + SBOM). All run on push (main)/PR — when T37 adds the actual npm publish workflow, it reuses passing this CI as a prerequisite.

**Coverage expansion (QA-002/003)** — widened `coverage.include` in `vitest.config.ts` from `src/core` alone to `src/{adapters,agent,mcp,cli}`, and set separate criteria per risk module in `coverage.thresholds` using glob keys (officially supported by Vitest coverage — the "Thresholds for utilities" pattern): core keeps the existing 90/90/90/85, `exploreSqlExecutor.ts`/`warehouseFactory.ts`/`resendProvider.ts` get individual criteria (directly tied to the SEC-001/002, OPS-001, OPS-004 regressions respectively), and `agent`/`mcp`/`cli` get group criteria. The numbers are **regression-prevention floors** with only slight headroom over the 2026-09-03 measurements (not ideal targets) — `npm run coverage` is exclusive to the CI `coverage` job and was not added to the local `npm run check` (too heavy; keeps the existing TESTING.md §8 principle).

**Real Postgres component tests (QA-004)** — `tests/component/postgres.component.test.ts` + `vitest.component.config.ts` (separate include: `tests/component/**`) + `npm run test:pg-component`. Does not violate guardrail 2 ("zero network calls in tests") — the default `vitest.config.ts` **excludes** `tests/component/**`, so the default gate never looks at this directory at all (`describe.skipIf` would be safe too, but making it invisible in the first place via exclude is clearer). If `TEST_DATABASE_URL` is absent, the whole suite is skipped. The same pattern as explore_sql being the only pre-approved exception to guardrail 4 — the "zero network" principle itself is kept, but separated out as an explicit opt-in suite. What is verified: migration idempotency/checksum mismatch detection, transaction rollback of a failed migration (confirming no schema_migrations record + no table created), whether an advisory lock is released to another connection immediately with just `pg_advisory_unlock` and without ending the session, whether `BEGIN READ ONLY` rejects writes on real Postgres as well (re-confirming the SEC-001 second line of defense), and whether `statement_timeout`, **which could not be verified with PGlite**, actually cancels a long-running query on real Postgres (closing the known §17 difference directly here). Committed after confirming 8/8 actually pass with local `postgresql@16` (brew).

**Supply-chain automation (QA-006)** — three things were newly added:
1. **lockfile audit** — `src/core/auditAllowlist.ts` (pure decision logic: advisory URL extraction + comparison against the approved list, moved from step 5 of `scripts/verifyPack.ts` and shared) is wrapped by `src/adapters/auditLockfile.ts` (IO: runs `npm audit --omit=dev --json`), and `scripts/auditLockfile.ts` (CLI) runs on every PR in the CI `audit` job. **fail-open/fail-closed policy**: if the audit run itself fails (registry unreachable, etc.), fail-open (warn only, pass) — that is an external service availability problem, not a code defect, so it does not block the PR. If the audit succeeds but a new advisory outside the approved list appears, fail-closed (block). It is not merged with the tarball-based audit (`scripts/verifyPack.ts`, SEC-006) because the inspection targets differ — T32 demonstrated that the dev lockfile can look optimistic because `overrides` apply to it (measured: in this session the lockfile audit returned 0 findings while the tarball audit returned the 1 approved uuid exception, i.e. different results), so keeping both criteria is actually meaningful.
2. **secret scan** — `src/core/secretScan.ts` (pure pattern matching: AWS keys, PEM blocks, Anthropic/Resend API key prefixes, Postgres URLs containing credentials — lines targeting localhost or carrying fake/example-style markers are excluded) is run by `scripts/secretScan.ts` (scans all tracked files per `git ls-files`) in the CI `audit` job. The reason for building it ourselves instead of an external action such as gitleaks is the same as the other decisions in this session (like the `ps`-based PID reuse mitigation of OPS-002) — there are only a few patterns and it is a pure function, so it can be unit-tested directly locally.
3. **SBOM** — the CI `audit` job runs `npm sbom --omit=dev --sbom-format cyclonedx` (a native npm 11 feature, no separate tool needed) and uploads the result as an artifact (90-day retention). When redirecting `npm run sbom` (local convenience script) to a file, `--silent` is required — we confirmed by measurement that `npm run` prints its banner to stdout as well, corrupting the JSON (CI calls `npm sbom` directly).

**Cross-reference table (QA-005)** — `docs/010_FINDING_TEST_CROSSREF.md` (new) — lists all 33 findings from 004~008 plus the 5 DOC findings from 009 and maps each to its responsible task, status, and test file. Among the missing cases that 008 enumerated, the only one actually empty was "concurrent read of a partial snapshot" — a real concurrent write-with-repeated-read race test was added to `tests/atomicFile.test.ts` (the existing test only checked "a handle opened before the write", which was not real concurrency).
