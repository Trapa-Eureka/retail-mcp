# 010 — Review Finding ↔ Automated Test Cross-Reference

- Written: 2026-09-03 (TASKS T35, in response to QA-005 "write a cross-reference table of whether all re-review items from 005~007 are connected to automated tests")
- Scope: all findings raised by `docs/004`~`008` (REL/SEC/DATA/OPS/QA, 33 items) + the 5 DOC-\* items in `docs/009` + **the 19 SR2-\* items in the second adversarial review `docs/010_SECOND_ADVERSARIAL_REVIEW_T29_T36.md`** (added 2026-09-04, "SR2" section below).
- Update rule: when code/tests that address a finding change, update this table too in the same PR. This table itself is
  not the source of truth — each finding's "resolution basis" still lives in the body of `docs/004`~`009`; this is
  only an index for quickly finding "which automated tests currently protect that resolution".

## Legend

- **Status**: `Automated` = the tests below prevent regression / `CI only` = runs only in a CI job, not in local
  `npm run test`/`check` (guardrail 2 exception or a heavy release gate) / `Manual/human` = an item that cannot be
  expressed as an automated test (e.g., `npm whoami` ownership confirmation) / `Planned` = responsible task not yet started
- **Tests**: only file names are listed; where needed you can narrow further by the describe block names inside the file
  (most cite the finding ID verbatim in the describe/it name).

The actual resolving commit/PR of the task (Txx) pointed to by the "Owner" column of each table is attached as
`PR #NN` in the heading of that Txx section in `docs/TASKS.md` (T28→#39, T29→#40, T30→#41, T31→#42, T32→#43, T33→#44, T34→#45, T35→#47) —
it is mapped once here rather than repeated on each of the 33 finding rows.

## REL — npm distribution packaging (`docs/004`, owner T29/T37)

| ID | Summary | Status | Basis/Tests |
|---|---|---|---|
| REL-001 | `private:true` blocks publish | Automated | `package.json` (private removed, scope/access confirmed) — a regression is immediately exposed by `npm pack` |
| REL-002 | No bin/main for installers to run | Automated | `scripts/verifyPack.ts` (actually spawns all 5 bins — the T37 pre-publish check (2026-09-04) found and filled the gap that `retail-mcp-scan`/`retail-mcp-reorder` for the core features were missing; steps 6 and 7) |
| REL-003 | Distributed artifact is TS but tsx is a devDependency | Automated | `scripts/verifyPack.ts` (successful bin execution after `--omit=dev` install is itself the regression evidence) |
| REL-004 | 97 files published without a distribution allowlist | Automated | `scripts/verifyPack.ts` step 1 (`npm pack --dry-run` file list) |
| REL-005 | No license/metadata | Manual/human | `package.json`/`LICENSE` — the values themselves are confirmed by a human, not subject to automated regression |
| REL-006 | No install/upgrade/uninstall docs + no migration CLI for external DATABASE_URL (SR2-REL-001) | Resolved (documented in T36 → fully resolved in code on 2026-09-04 with the `retail-mcp-migrate` bin) | README documentation work + `scripts/verifyPack.ts` (bin execution and error paths) + `tests/component/postgres.component.test.ts` (real Postgres application and idempotency) + `tests/warehouseFactory.test.ts`/`tests/migrateRunner.test.ts` (PGlite unit) |
| REL-007 | No automated gate before publish | Automated (T29 → completed in T37, 2026-09-04) | `prepack` automatically invokes `build`. `verify:pack` runs on every PR in T35's `test` job (OS/Node matrix). T37 wired up `prepublishOnly: npm run check && npm run verify:pack` — wherever `npm publish` runs, the gate cannot be skipped (a regression is exposed by the publish attempt itself) |
| REL-008 | Package name/ownership unverified | Manual/human (T37 done) | Risk mitigated by adopting a scope. T37 (2026-09-04): `npm whoami`=`shiz_son`, no `@trapa-eureka` organization → package name changed to `@shiz_son/retail-mcp` (user decision), availability confirmed by `npm view` 404 |

## SEC — Security/dependencies (`docs/005`, owner T30/T32/T35)

| ID | Summary | Status | Tests |
|---|---|---|---|
| SEC-001 | READ ONLY cannot block advisory-lock-type side effects | Automated | `tests/sqlValidator.test.ts`, `tests/exploreSqlExecutor.test.ts` |
| SEC-002 | Timeout can be neutralized by redefining `set_config` | Automated | `tests/sqlValidator.test.ts`, `tests/exploreSqlExecutor.test.ts` |
| SEC-003 | No limits for large/zip-bomb CSV·XLSX | Automated | `tests/fileLimits.test.ts`, `tests/csvExcelParser.test.ts` |
| SEC-004 | CSV formula injection | Automated | `tests/csvSafety.test.ts`, `tests/snapshotExport.test.ts` |
| SEC-005 | No `.env` permissions/atomicity | Automated | `tests/onboard.test.ts` |
| SEC-006 | Unreviewed dependency vulnerability (uuid via exceljs) | Automated (double) | Against the published tarball: `scripts/verifyPack.ts` step 5. Against the lockfile (early warning, new in T35): `tests/auditLockfile.test.ts` + `npm run audit:lockfile` in the CI `audit` job |
| SEC-007 | No security policy/reporting channel | Automated (existence check) | The existence of `SECURITY.md` is itself the deliverable — content accuracy is human review |

## DATA — Data accuracy (`docs/006`, owner T31/T33)

| ID | Summary | Status | Tests |
|---|---|---|---|
| DATA-001 | packSize export→import round-trip loss | Automated | `tests/snapshotExport.test.ts` |
| DATA-002 | Disappeared SKUs/stores not tombstoned | Automated | `tests/pgWarehouse.test.ts`, `tests/folderScan.test.ts` |
| DATA-003 | Risk of duplicate sends/silence when the same file is run repeatedly | Automated | `tests/folderScan.test.ts` (daily digest describe) |
| DATA-004 | Risk of corruption if the process dies mid-snapshot-write | Automated | `tests/atomicFile.test.ts` (including partial-read race, strengthened in T35) |
| DATA-005 | undefined/null/value three-state not distinguished | Automated | `tests/csvExcelParser.test.ts`, `tests/pgWarehouse.test.ts` |
| DATA-006 | Definitive discrepancy warning without opening inventory | Automated | `tests/metrics.test.ts` (insufficientData describe) |
| DATA-007 | SCM processing failure not visible in results | Automated | `tests/folderScan.test.ts` (scmStatus-related cases) |
| DATA-008 | Multiple receipts on the same date collapsed | Automated | `tests/scmSchema.test.ts` |

## OPS — Operational reliability (`docs/007`, owner T34/T35)

| ID | Summary | Status | Tests |
|---|---|---|---|
| OPS-001 | Lock not released when db.close() fails | Automated | `tests/warehouseFactory.test.ts` |
| OPS-002 | PID reuse/other-host lock misjudgment | Automated | `tests/fileLock.test.ts` (PID reuse and cross-host describes) |
| OPS-003 | Non-deterministic choice on latest-file tie | Automated | `tests/folderScan.test.ts` (mtime tie-break case) |
| OPS-004 | Send timeout misclassified as failure, retry risk | Automated | `tests/resendProvider.test.ts`, `tests/pgWarehouse.test.ts`, `tests/folderScan.test.ts` |
| OPS-005 | No structured logs/retention policy | Automated | `tests/structuredLog.test.ts`, `tests/pgWarehouse.test.ts` (retention describe) |
| OPS-006 | Supported OS/Node matrix unverified | **CI only (new in T35)** | The `test` job in `.github/workflows/ci.yml` — `os: [ubuntu-latest, macos-latest] × node: [20, 22]`, running through `npm run verify:pack` on each combination. Windows remains explicitly unverified (the policy already documented in README/DESIGN §12.8, unchanged) |

## QA — Test/release gate (`docs/008`, owner T29/T35)

| ID | Summary | Status | Tests/Configuration |
|---|---|---|---|
| QA-001 | Tests do not verify the tarball | Automated (local) + CI only (T35) | `scripts/verifyPack.ts` — since T35 also runs on every OS/Node combination in the CI `test` job |
| QA-002 | Coverage threshold not in `check` | **CI only (new in T35)** | `coverage.thresholds` in `vitest.config.ts` + CI `coverage` job (`npm run coverage`). Deliberately not included in local `check` (heavy, TESTING.md §8) |
| QA-003 | Coverage scope limited to core | Automated (new in T35) | `coverage.include` in `vitest.config.ts` expanded to `src/{core,adapters,agent,mcp,cli}` + per-risk-module glob thresholds for explore_sql/warehouseFactory/resendProvider/agent/mcp/cli |
| QA-004 | Insufficient real-Postgres contract verification | **CI only (new in T35)** | `tests/component/postgres.component.test.ts` (migration idempotency and checksum, transaction rollback, READ ONLY, advisory lock cleanup, explore_sql statement_timeout) — against the `postgres:16` service container of the CI `postgres-component` job. Locally skipped unless `TEST_DATABASE_URL` is set |
| QA-005 | No attack/correctness regression cases | Automated | See "QA-005 details" below — the 005~007 items are already fully connected via the SEC/DATA/OPS tables above |
| QA-006 | Audit/tarball inspection not automated | **CI only (new in T35)** | lockfile audit: `tests/auditLockfile.test.ts` + `npm run audit:lockfile` in the CI `audit` job (fail-open/closed policy is in `src/adapters/auditLockfile.ts`). secret scan: `tests/secretScan.test.ts` + `npm run secret-scan`. SBOM: the CI `audit` job generates a CycloneDX SBOM as an artifact |

### QA-005 details (missing cases listed by 008)

| Case | Tests |
|---|---|
| snapshot packSize round-trip | `tests/snapshotExport.test.ts` |
| preventing duplicate sends for an unchanged file | `tests/folderScan.test.ts` (daily digest describe) |
| cleaning up SKUs that disappeared from a new snapshot | `tests/pgWarehouse.test.ts`, `tests/folderScan.test.ts` (tombstone) |
| **concurrent read of a partial snapshot** | `tests/atomicFile.test.ts` (the "repeated reads during the write only ever see the complete old version or the complete new version..." case, newly added in T35 — previously there was only a "read before write" and no genuine concurrent race) |
| explore_sql bypass using `pg_advisory_lock`/`set_config` | `tests/sqlValidator.test.ts`, `tests/exploreSqlExecutor.test.ts` |
| CSV formula injection and large XLSX/CSV limits | `tests/csvSafety.test.ts`, `tests/snapshotExport.test.ts`, `tests/fileLimits.test.ts`, `tests/csvExcelParser.test.ts` |
| SCM period mismatch / no opening inventory / failure status | `tests/metrics.test.ts`, `tests/folderScan.test.ts` |

## DOC — Documentation consistency (`docs/009`, owner T28/T36)

| ID | Summary | Status |
|---|---|---|
| DOC-001 | TASKS T0~T7 status mislabeled | Resolved (T28) — labeling corrected, not subject to automated tests |
| DOC-002 | CLAUDE/DESIGN reflect only v0.1 rules | Resolved (T28, with T29~T34 subsequently adding each section to DESIGN) |
| DOC-003 | MCP tool count described differently across documents | Resolved (T28) — `tests/server.test.ts`/`tests/mcpTools.test.ts` pin the actually exposed tool list as a regression, so a doc-code mismatch surfaces there |
| DOC-004 | No npm distribution usage docs | Resolved (T36) — new README "Installation (after npm publish)" section |
| DOC-005 | No lifecycle labeling in documents 001~003 | Resolved (T28) — status labels added to `docs/001~003` |

> As of T35 this cross-reference had pointed out the inconsistency between the summary "DOC-002~004 in T36" on the 6th line of `docs/009` and the table above (DOC-002/003
> were already substantively resolved in T28) — T36 corrected that line of `docs/009` itself
> (see 009).

## SR2 — Second adversarial review (`docs/010_SECOND_ADVERSARIAL_REVIEW_T29_T36.md`, reviewed 2026-09-03 → handled 2026-09-04)

Re-reviewing the first-review response (T29~T36) itself yielded 19 findings (P0 6, P1 10, P2 3). Each finding was handled as **one PR** (no task number — the PR column below is the resolving commit), and the full resolution basis is in the `RESOLVED` line under each item in the original document. Cross-reference method (2026-09-04): confirmed with `grep` that the test files below actually exist and that the finding ID appears verbatim in the `describe`/`it` names — all 13 findings resolved in code have the ID in the name, so no test needed renaming, and everything except the 1 item in `tests/component/**` runs in the default gate (`vitest.config.ts`, `npm run check`).

| ID | Priority | Summary | Status | Basis/Tests | PR |
|---|---|---|---|---|---|
| SR2-SEC-001 | P0 | secret-scan bypassed by a single placeholder word | Automated | `tests/secretScan.test.ts` (5 common words are no longer excluded; only the dedicated `secretscan-allow` marker is accepted) | #49 |
| SR2-AUD-001 | P0 | Audit execution/JSON errors treated as CI success (fail-open) | Automated | `tests/auditAllowlist.test.ts` (`isValidAuditReport`), `scripts/verifyPack.ts` (invalid report fails closed in the release gate — runs on every PR in the `test` job) | #50 |
| SR2-AUD-002 | P0 | Error JSON mistaken for "0 vulnerabilities" | Automated | `tests/auditLockfile.test.ts` (an `{error:{…}}` report does not leave a "0 findings" log) | #50 |
| SR2-MAIL-001 | P0 | Random runId on every run invalidates retry idempotency | Automated (partial) + manual | `tests/cliArgs.test.ts` (`parseNamedArg` — `--run-id` parsing). The argv → `opts.runId` wiring in `main()` itself is outside unit tests — reproduced and confirmed by actually running the CLI (see RESOLVED in the original document). Passing `opts.runId` is already pinned by the T34 tests | #51 |
| SR2-LOCK-001 | P0 | Other host's active lock deleted on hostname collision | Automated | `tests/fileLock.test.ts` ("machineId-based cross-host judgement (second adversarial review SR2-LOCK-001)" describe, 5 tests) | #53 |
| SR2-REL-001 | P0 | No migration CLI for network Postgres users | Automated + CI only | `tests/cliMigrate.test.ts`, `tests/migrateRunner.test.ts`, `tests/warehouseFactory.test.ts` (`ensureNetworkMigrationsApplied`), `scripts/verifyPack.ts` (bin execution and error paths); real Postgres application and idempotency in `tests/component/postgres.component.test.ts` (CI `postgres-component` job only) | #55 |
| SR2-CI-001 | P1 | Workflow token permissions not pinned | CI only (configuration) | `permissions: contents: read` at the top of `.github/workflows/ci.yml` — cannot be expressed as a test; the workflow file itself is the deliverable. Stated in `SECURITY.md` | #54 |
| SR2-MAIL-002 | P1 | Non-timeout network errors misclassified as `failed` | Automated | `tests/resendProvider.test.ts` (6 tests with fixtures shaped like real undici errors — only `ECONNREFUSED`/`ENOTFOUND` are failed; `ECONNRESET`/`UND_ERR_SOCKET`/no code are ambiguous) | #56 |
| SR2-SEC-002 | P1 | Blind spot from excluding all of `tests/secretScan.test.ts` | Automated (self-verifying) | `tests/secretScan.test.ts` (fixtures assembled at runtime + scans its own source and asserts 0 findings), `SELF_EXCLUDE` removed from `scripts/secretScan.ts` | #58 |
| SR2-SEC-003 | P1 | git history scan description and implementation mismatch | Automated + CI only | `tests/secretScanGit.test.ts` (`scanGitRange` — 6 tests with a temporary repository of "commit that adds → commit that removes"); the CI `audit` job actually runs it with `--range=$SCAN_BASE..$SCAN_HEAD` | #59 |
| SR2-SEC-004 | P1 | File read failures silently ignored (fail-open) | Automated | `tests/secretScanGit.test.ts` (`scanTrackedFiles` — 5 tests for EACCES/ENOENT/symbolic link/binary allowlist), `scripts/secretScan.ts` makes `unreadable` non-zero | #60 |
| SR2-AUD-003 | P1 | Approved-exception expiry date is only a comment | Automated | `tests/auditAllowlist.test.ts` (expiry boundary, format errors, real-data validation), `tests/auditLockfile.test.ts` (failure string on the expiry day), `scripts/verifyPack.ts` (release gate throw) | #61 |
| SR2-CI-002 | P1 | Action/Postgres images use movable tags | CI only (configuration) + manual update | 9 `uses:` lines in `ci.yml` pinned to full SHA + `postgres:16@sha256:…`; verification is this workflow itself running with the pinned values on every PR (`Download action repository … (SHA:…)`/`docker pull …@sha256:…` in the job logs). Updates via `.github/dependabot.yml` (Actions) + the manual procedure in TESTING.md §8 (digest) | #63 |
| SR2-LOCK-002 | P1 | Old-format lock without hostname reclaimed as same-host | Automated | `tests/fileLock.test.ts` ("legacy lock without hostname is owner-host-unknown → busy (second adversarial review SR2-LOCK-002)" describe, 5 tests) | #65 |
| SR2-MAIL-003 | P1 | No retry policy after the dedupe retention window | Automated | `tests/sendRetryPolicy.test.ts` (pure decision, 11), `tests/reorderAgent.test.ts` (6), `tests/folderScan.test.ts` (2), `tests/pgWarehouse.test.ts` (`listAgentSendAttempts`/`markStaleSendingUnknown`, 2) | #66 |
| SR2-CI-004 | P1 | Branch protection/required checks unverified | **Manual/human** (repository settings) | GitHub ruleset `22244613` (main, PR required, 7 required checks, 0 bypass) — a setting outside the repository, so untestable. Human confirmation item in `docs/TASKS.md` T37 + confirmation command (`gh api repos/…/rules/branches/main`). Every PR merge passing the ruleset is the ongoing verification (#67 is the first case) | #67 |
| SR2-CI-003 | P2 | No job `timeout-minutes` | CI only (configuration) | `timeout-minutes` on the four jobs in `ci.yml` (test 50 / audit 30 / coverage 25 / postgres-component 15, about 2× the observed maximum — with rationale comments). Readjustment rule in TESTING.md §8. Verification is each PR's CI passing within the limits | #69 |
| SR2-LOCK-003 | P2 | Check-then-delete in release is non-atomic | **ACCEPTED · Manual/human** | No code change — an atomic "delete if contents match" is impossible with POSIX/Node standards; the rationale for rejecting the 3 alternatives (flock/rename/inode re-check) is in `DESIGN.md` §12.8. Mitigation is the manual recovery protocol in README "PGlite lock recovery" (delete only; forbidden if a running process exists). The race cannot be reproduced deterministically, so no automated test; the existing "do not delete if owned by another pid at release time" in `tests/fileLock.test.ts` pins ownership verification on the non-contended path | #70 |
| SR2-SEC-005 | P2 | Insufficient coverage of credential types actually in use (npm/GitHub tokens, `LOYVERSE_API_TOKEN` values, etc.) | Automated | `tests/secretScan.test.ts` ("credential coverage extension (second adversarial review SR2-SEC-005)" describe, 7 tests — LOYVERSE assignment expressions, GitHub, npm, Google, Bearer detection + false-positive defense + marker/preview rules, self-verification kept). Limitations are in the `SECURITY.md` "Limitations of the in-house secret scanner" item | #71 |

**Side measures (not findings)**: 3 environment problems observed in the CI of the PRs above — `tests/performance.test.ts` budget 5s→10s (#52), `vitest.config.ts` `hookTimeout` 20s (#57), limited retry on invalid `npm audit` reports `src/adapters/npmAudit.ts` + `tests/npmAudit.test.ts` (#62). See the "Side measures" line at the head of the original document.

## What this table does not cover

- It does not mean a finding is "completely blocked" — for example, for SEC-001/002 the limitation that the `FORBIDDEN_FUNCTION_CALLS`
  blocklist only blocks known functions remains as-is in each original document. This table means "if a regression occurs,
  a test catches it", not "an attack is theoretically impossible".
- REL-005/006/008, parts of SEC-007, and DOC-\* by nature ask "does the value match human intent" and
  cannot be expressed as automated tests — marked `Manual/human` in the tables.
- SR2-CI-001/002/004 are workflow files and repository settings, so there are no unit tests — "CI actually runs
  with that configuration" (job logs, merges under the ruleset) is the verification, and CI-004 is confirmed once more by a human in T37.
