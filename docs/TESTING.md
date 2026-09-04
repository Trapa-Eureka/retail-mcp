# TESTING — retail-mcp

Purpose: let the agent verify deterministically and locally, without live cloud services (POS, DB, email, LLM). In particular, since **the metric formulas are the heart of this product**, we pin the formulas down with hand-calculated golden cases.

## 1. Principles

- Zero network calls in tests. DB is **PGlite** (in-process Postgres — same SQL dialect as production, file/memory mode), POS is fixtures, send and LLM are mocks.
- Determinism: `FixedClock`, no randomness. All date calculations are based on the injected clock.
- `npm run check` = typecheck + lint + test. The whole thing within a few seconds.

## 2. Mock and fixture setup

| Component | Description |
|---|---|
| `FixtureLoyverseClient` | Replays `fixtures/loyverse/*.json` (stores/items/receipts/inventory — the shape of real API responses). Reproduces pagination and cursors |
| PGlite helper | Applies `migrations/*.sql` to a fresh instance per test → guarantees the same schema as production |
| `MockNotificationProvider` | Records sends + injects failures via `failFor` (same pattern as sheet_mcp) |
| `MockSummarizer` | Returns a fixed string / reproduces LLM failure with `fail: true` |
| `FixedClock` | Fixed reference date (e.g. 2026-09-01T00:00Z) |

Fixture scenario: 2 stores × 8 items × last 35 days of sales — including fast sellers, non-sellers, refunds, a new item (5 days of history), zero stock, and Unicode item names (Tagalog, Korean).

## 3. Golden cases (unit — core/metrics)

Hand-calculated values are hard-coded in the tests. Examples:

- 60 sold over 30 days, ending stock 40 → sell-through = 60/(60+40) = **0.60**
- 56 sold over 28 days → daily average 2.0 / stock 15 → cover **7.5 days** → **at risk** against lead 7 + safety 3 = 10
- Target cover 21 days → suggested qty = ceil(21×2.0 − 15) = **27**
- 0 sold + stock 20 → daily average 0 → cover shown as ∞, not at risk, suggestion 0
- 0 sold + stock 0 → sell-through null (shown to distinguish new/no-stock)
- Including refunds (sold 10, refunded −2) → aggregated as soldQty 8

## 4. Mandatory edge-case checklist (component)

**ETL**
- [ ] Syncing the same fixture twice → row count unchanged (idempotent upsert)
- [ ] receipts cursor save/resume: failure after 1 of 2 pages → cursor not advanced → re-run resumes from there
- [ ] Refund receipt → loaded as negative qty
- [ ] Snapshots: 2 syncs → 2 points in time exist in `inventory_snapshots`

**MCP tools**
- [ ] Default `sell_through` call = matches the golden case values, includes the approximation footnote
- [ ] `reorder_suggestions` result = **exactly identical** to the agent report table (regression guard via the same core)
- [ ] store_id and category filter correctness / nonexistent store_id → error containing how to fix
- [ ] `sync_status` — returns cursor and timestamp

**Agent**
- [ ] 0 suggestions → 0 sends, log only
- [ ] `SEND_MODE=dry_run` → 0 provider calls, dry-run output includes the table
- [ ] The mock provider is called only when both `SEND_MODE=live` + `--confirm` are present (neither alone suffices)
- [ ] `MockSummarizer` failure → send proceeds with the table only, without a summary
- [ ] After sending, recorded in `agent_send_log` (including whether dry_run)

**Performance guard**
- [x] 50,000-row sales-line fixture: ETL load + `reorder_suggestions` computation total < 10 seconds (BUDGET_MS, on PGlite) — `tests/performance.test.ts`. **This test is excluded under `npm run coverage` (v8 instrumentation)** (`vitest.config.ts`, TASKS T36) — we measured it failing repeatedly in CI at 6567ms/5463ms/5042ms etc. Measuring a wall-clock budget under an instrumented run is itself a wrong measurement, so the guard was not removed but moved to an uninstrumented tool — this guard is still enforced by the uninstrumented `test` job (plain `vitest run`, every PR/OS/Node combination). **The budget itself was also raised from 5 to 10 seconds** (second adversarial review response) — even after excluding coverage it kept failing in the plain `test` job at 5015~5392ms, which finally confirmed that 5 seconds was too tight given shared CI runner noise (a normal local run is ~2 seconds, so 10 seconds still catches real regressions).

## 5. Manual smoke (human-only — scripts/smoke.ts)

`npm run smoke`: with a real Loyverse token + real DB, ① sync ② call the 3 tools and print output ③ agent dry-run. **Live send is not part of the smoke** — the first live send is done once by a human directly with `--confirm`.

## 6. Coverage

- `src/core/` 90% or above (vitest --coverage, reported in T9). Adapters are supplemented by the smoke.

## 7. Additional regression guards

**Sync and concurrency**

- [ ] On a mid-page failure, both that resource's data and the watermark roll back to the previous state, and the re-run safely reprocesses duplicates from the previous watermark
- [ ] Zero omissions even when multiple receipts with the same `updated_at` straddle a page boundary
- [ ] Syncing twice with a `FixedClock` that returns the same time causes no snapshot PK conflict and snapshots remain distinguishable per run
- [ ] Of 2 concurrent `sync_now` calls, only one runs and the other returns an in-progress error/status

**Numbers, dates and quality**

- [ ] With refunds exceeding sales in a period and negative on-hand stock, computed results do not go negative and include a quality warning
- [ ] At business midnight, month-end and DST boundaries, the last-N-days window matches the spec and is independent of the machine's local timezone
- [ ] With fractional quantities and large `numeric` values, the reorder `ceil` policy matches with no intermediate rounding
- [ ] Stale sync results and approximate sell-through include the required warning and the last successful time

**Security and failures**

- [ ] With a read-only DB role, the 5 query tools succeed and writes and `sync_now` fail/are not registered
- [ ] Verify API timeout, 429 `Retry-After` and the retry cap; no secrets in error/log snapshots
- [ ] Zero duplicate emails on a live retry with the same `run_id`
- [ ] Summarizer input contains no tokens, email addresses or unnecessary raw receipt data

The coverage report and the 50k-row performance guard are completed in **T10** of `TASKS.md` (T9 also covers MCP feature regression tests).

## 8. Release gate and attack regression tests (2026-09-03, response to the docs/004~008 adversarial review — TASKS T28)

As the pre-npm-publish adversarial review (`docs/004_NPM_RELEASE_PACKAGING_REVIEW.md`~`docs/008_TEST_AND_RELEASE_GATE_REVIEW.md`) pointed out, the gates so far (`npm run check` + §1~§7 above) only verify the repository source tree and an environment with devDependencies installed, and do not verify actual npm installation, operational boundaries or attack scenarios (008 QA-001~006). The following are added as the **release gate** (mandatory before npm publish, separate from each local `npm run check`) — the actual implementation of each item is done under its assigned TASKS number.

**Packaging gate (TASKS T29 — implemented, `npm run verify:pack`)**

- [x] The file list of `npm pack --dry-run` matches the `files` allowlist (only `dist`/`migrations`/`README`/`LICENSE`/`.env.example`) — confirmed 97 → 63 files
- [x] After installing the tarball into a temporary directory with `npm install --omit=dev`, running `bin` or reaching MCP initialize succeeds (QA-001) — `scripts/verifyPack.ts` verifies both `retail-mcp` (MCP `tools/list`) and `retail-mcp-onboard` (`.env` + template generation) with real spawns. Not yet automatically wired into `npm run check`/CI (it is a heavy procedure that goes through build + pack + install, so it is kept as a separate release-gate-only script, apart from the TESTING §1 principle) — CI wiring is T37.

**Security gate (TASKS T30/T32 — complete)**

- [x] explore_sql bypass attempts using volatile functions such as `pg_advisory_lock` and `set_config` redefinition are pinned by regression tests (SEC-001/002) — `tests/sqlValidator.test.ts` (function blocklist), `tests/exploreSqlExecutor.test.ts` (rejection before execution + a documentation test demonstrating "had the validator been bypassed, READ ONLY alone would not have stopped it"), `tests/server.test.ts` (`EXPLORE_SQL_ALLOW_PGLITE` gating)
- [x] Escape and round-trip tests for snapshot CSV formula injection (values starting with `=`/`+`/`-`/`@`) (SEC-004) — `tests/csvSafety.test.ts`, `tests/snapshotExport.test.ts`
- [x] File size, row and cell-length limit tests against large/zip-bomb XLSX and bulk CSV (SEC-003) — `tests/fileLimits.test.ts`, `tests/csvExcelParser.test.ts` (for residual risk see the `src/adapters/fileLimits.ts`/`csvExcelParser.ts` docs — XLSX is judged buffered)
- [x] `.env` 0600 + atomic write test (SEC-005) — `tests/onboard.test.ts`
- [x] `npm audit --omit=dev` reports 0 findings, or an approved exception with recorded rationale and expiry date (SEC-006) — not 0: one approved exception, uuid (via exceljs) (re-review 2027-03-03, details in `docs/005`) + `scripts/verifyPack.ts` checks every time, **against an install of the actual published tarball**, that this is the only exception (release gate step 5; discovered during the work that the dev checkout's `overrides` do not apply to published consumers)

**Data accuracy gate (TASKS T31/T33 — complete)**

- [x] `포장수량` (pack quantity) is preserved on the snapshot export → import round trip (DATA-001) — `tests/snapshotExport.test.ts`
- [x] SKUs/stores that disappear from an authoritative scan are tombstoned and excluded from reorder and low-stock calculations (DATA-002) — `tests/pgWarehouse.test.ts` (`deactivateMissingCsvRows`), `tests/folderScan.test.ts` (tombstone e2e)
- [x] Repeated cron runs on the same file cause no re-send, and once a day has passed since the last send one digest is sent even with no changes (DATA-003) — `tests/folderScan.test.ts` (daily digest, 5 tests; scope limited to actual send attempts — DESIGN §12.3)
- [x] If the process dies while writing the snapshot file, the previous good snapshot is not corrupted (atomic write, DATA-004) — `tests/atomicFile.test.ts`
- [x] The three states — column absent (undefined) / explicit clear (null) / value — are correctly distinguished and applied on nullable fields (DATA-005) — `tests/csvExcelParser.test.ts` (CSV/XLSX parsing stage), `tests/pgWarehouse.test.ts` (upsert stage)
- [x] On an SCM opening-stock or period mismatch, it is marked `insufficientData` and no false discrepancy (a warning asserting a definite cause) is raised (DATA-006) — `tests/metrics.test.ts`
- [x] SCM processing failure is exposed as `scmStatus` in results/emails (DATA-007) — `tests/folderScan.test.ts`
- [x] Multiple receipts on the same date are summed without collapsing (DATA-008) — `tests/scmSchema.test.ts`

**Operational reliability gate (TASKS T34 — complete)**

- [x] The file lock is released even when `db.close()` fails (OPS-001) — `tests/warehouseFactory.test.ts` (confirms release on db.close() failure, AggregateError when both fail)
- [x] PID reuse is correctly identified as a stale lock, and a lock written by another host is not automatically reclaimed (OPS-002) — `tests/fileLock.test.ts` (new describe, 6 tests)
- [x] Latest-file ties (identical mtime) are handled deterministically (OPS-003) — `tests/folderScan.test.ts` (forces identical mtimes with `utimes`, then confirms repeated scans always select the same file)
- [x] An email send timeout remains in `unknown` status and is not automatically retried without human confirmation; Idempotency-Key is passed (OPS-004) — `tests/resendProvider.test.ts`, `tests/pgWarehouse.test.ts`, `tests/folderScan.test.ts`
- [x] A retry with the same run_id is allowed only within the provider dedupe retention window (Resend 24h − 1h safety margin); outside it, it is refused with `SendRetryRefusedError` and the provider is not called; rows stuck in `sending` are closed as `unknown(stale_sending)` on a retry within the retention window (`sent_at` preserved); providers without dedupe support are always refused; retries after `failed` are unlimited (second adversarial review SR2-MAIL-003) — `tests/sendRetryPolicy.test.ts` (pure decision, 11 tests: refuse at exactly the boundary / allow 1ms inside, anchor = oldest unknown/sending), `tests/reorderAgent.test.ts` (new describe, 6 tests), `tests/folderScan.test.ts` (new describe, 2 tests), `tests/pgWarehouse.test.ts` (`listAgentSendAttempts`/`markStaleSendingUnknown`, 2 tests)
- [x] Structured logs are parseable as JSON, and `agent_send_log`/`inventory_snapshots` rows past the retention period are cleaned up by `npm run cleanup` (OPS-005) — `tests/structuredLog.test.ts`, `tests/pgWarehouse.test.ts` (new describe, 4 tests)

**Postgres contract gate (TASKS T35 — complete, CI-only)**

- [x] Component-test migration, transaction rollback, READ ONLY role, advisory lock cleanup and explore_sql timeout on the CI service Postgres (QA-004) — `tests/component/postgres.component.test.ts` (`vitest.component.config.ts`, `npm run test:pg-component`), CI `postgres-component` job (`postgres:16` service container). Directly confirmed that the already-known difference between PGlite and real Postgres (§17, statement_timeout not enforced) does not reproduce on real Postgres (measured 8/8 passing with local `postgresql@16`, TASKS T35).
- [x] The CI matrix includes `npm run verify:pack` (clean tarball install) on the minimum supported OS/Node LTS (007 OPS-006, moved over from T34) — the `test` job in `.github/workflows/ci.yml`, `os: [ubuntu-latest, macos-latest] × node: [20, 22]`.

**Test gate / supply-chain gate (TASKS T35 — complete)**

- [x] Coverage threshold promoted to a mandatory CI gate (QA-002) — CI `coverage` job (`npm run coverage`). Intentionally not included in local `npm run check` (heavy).
- [x] Coverage scope extended beyond core (explore_sql/warehouseFactory/agent/mcp/cli) + per-risky-module thresholds (QA-003) — `coverage.include`/`thresholds` in `vitest.config.ts`.
- [x] All attack/accuracy regression cases from 005~007 are wired to automated tests (QA-005) — `docs/010_FINDING_TEST_CROSSREF.md` is the per-finding cross-reference table. The only blank newly filled this time is "partial snapshot concurrent read" (`tests/atomicFile.test.ts`).
- [x] Dependency audit (lockfile-based) + tarball allowlist assertion + secret scan + SBOM wired into the release workflow (QA-006) — CI `audit` job (`npm run audit:lockfile`, `npm run secret-scan`, `npm sbom` → artifact). For the fail-open/fail-closed policy see the doc comment in `src/adapters/auditLockfile.ts`.
- [x] External code that CI executes (Actions, service container images) is immutably pinned (second adversarial review SR2-CI-002, 2026-09-04) — `actions/checkout`, `actions/setup-node` and `actions/upload-artifact` in `.github/workflows/ci.yml` use a **full commit SHA + `# vX.Y.Z` comment** rather than the movable `@v4` tag, and the Postgres service uses the `postgres:16@sha256:…` manifest digest. Verification is that this workflow itself actually runs on every PR with the pinned SHA/digest. **Update procedure**:
  - Action SHAs — `.github/dependabot.yml` (github-actions ecosystem, monthly, one group) opens a PR that bumps the SHA and the tag comment together. A human merges after confirming CI passes (no auto-merge). For manual checks or when adding a new Action: `gh api repos/<owner>/<action>/git/ref/tags/<tag> --jq '.object.sha + " " + .object.type'` — if `type` is `tag` (annotated), resolve once more with `gh api repos/<owner>/<action>/git/tags/<sha> --jq .object.sha` and record the **commit** SHA.
  - Postgres digest — Dependabot does not update the workflow's `services.image`, so a human does it. Once a quarter or when a Postgres 16 minor release is announced, read the current digest with `curl -s https://hub.docker.com/v2/repositories/library/postgres/tags/16 | jq -r '.digest, .last_updated'` and change both the `image:` in `ci.yml` and the check date in the comment. Keep the tag (`16`) as is and change only the digest — a major-version change is a separate decision.
- [x] The CI gates above are enforced by repository settings so that even admins cannot bypass them (second adversarial review SR2-CI-004, 2026-09-04, applied after user approval) — `main` ruleset (id `22244613`): direct push, force push and deletion blocked, PR required (0 approvals — single maintainer), **7** required checks (test ×4 matrix, coverage, postgres component, dependency audit + secret scan; `strict` off), 0 bypass actors. Because this item cannot be verified in code (a repository setting outside the workflow file), it was added to the `docs/TASKS.md` T37 completion criteria as a **human-confirmation item** — check command `gh api repos/Trapa-Eureka/retail-mcp/rules/branches/main --jq '[.[].type]'`. The ongoing verification is that every PR merge actually passes this ruleset (`gh pr merge --admin` is no longer used).
- [x] Publishing happens only in CI, with provenance (T37, 2026-09-04) — `.github/workflows/release.yml`: `v*` tag push → verify tag ↔ `package.json` version match → `npm ci` → `npm publish --provenance --access public` (`prepublishOnly` = `npm run check && npm run verify:pack`, tarball audit fail-closed) → re-query the registry. Permissions: `id-token: write` on the publish job only. Since this is a workflow file that is not covered by automated tests, verification is the first actual publish (after user approval) followed by provenance confirmation with `npm audit signatures`
- [x] The policy for a tarball audit being "unavailable" is separated between the PR gate and the release gate (2026-09-04, decision delegated by the user — the same day, an npm advisory endpoint outage made PR #72~#74 unmergeable one after another) — `verify:pack --audit-unavailable=warn` is enabled only in the CI `test` matrix (passes with a warning only when a valid report could not be obtained; unapproved vulnerabilities and expired exceptions still fail), while the actual publish path `prepublishOnly` has no flag = `fail` (fail-closed), so nothing is published without a valid audit. The decision is the pure function `src/core/tarballAuditPolicy.ts` — `tests/tarballAuditPolicy.test.ts` (5 decision + 3 policy + 2 flag tests)
- [x] Every CI job has a `timeout-minutes` cap so that a deadlock or malicious PR cannot occupy a runner for a long time (GitHub default 6 hours) (second adversarial review SR2-CI-003, 2026-09-04) — `test` 50 min / `audit` 30 min / `coverage` 25 min / `postgres-component` 15 min. The values are roughly 2~3× the measured maxima from PR #63~#68 (24m28s / 15m0s / 10m17s / 4m24s); the rationale is in each job's comment in `ci.yml`. **Readjustment criteria**: for a job that failed on timeout, look at the cause first (a hang, or did the tests really grow?) — if the same job times out twice in a row and the logs show it was progressing (not a hang), raise it to 2× the newly observed maximum. Do not raise the value after a single failure, and when raising it, update the observed values and date in the comment as well.

Each item in this section exists to close the gap 007/008 pointed out — "even if 376 tests pass, the published package may be unrunnable or vulnerable to attack" — they are added on top of, not in place of, the existing gates in §1~§7. For the detailed per-finding cross-reference see `docs/010_FINDING_TEST_CROSSREF.md`.
