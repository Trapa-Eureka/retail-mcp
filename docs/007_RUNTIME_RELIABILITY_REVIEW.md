# 007 — Runtime and Operational Reliability Adversarial Review

- Review date: 2026-09-03
- Scope: local PGlite, file handling, email/agent execution, operational observability
- Verdict: **Remediation required — error recovery and operational state determination are insufficient for the npm user environment**
- Status: **RESOLVED (T34 PR #45 — OPS-001~005, T35 PR #47 — OPS-006, 2026-09-03)** — OPS-001~006 all resolved. The full re-review will be conducted in T37. Details in `docs/DESIGN.md` §12.8~12.9.

## OPS-001 — The lock is not released when PGlite close fails

- Severity: **High**
- Area: `warehouseFactory.ts`
- Evidence: `close()` runs in the order `await db.close(); await lock.release();`. If `db.close()` rejects, the release does not run.
- Impact: While the process stays alive, the PID in the lock file is also judged to be alive, so subsequent runs may keep being blocked.
- Fix criteria: Run the lock release in `finally` and define an aggregate error policy so that both cleanup errors are observable.
- **Resolution (T34, 2026-09-03)**: `close()` in `warehouseFactory.ts` wraps `db.close()`/`lock.release()` in independent try/catch blocks so that the release is always attempted — if both fail, both are preserved via `AggregateError`; if only one fails, only that cause is thrown. The catch block for initialization (migration) failure was reinforced on the same principle (AggregateError so that a release failure does not mask the original cause). Tests: `tests/warehouseFactory.test.ts` (fails `PGlite.prototype.close` via a spy to check that the lock is still released, and that on double failure both causes are preserved in an AggregateError).

## OPS-002 — On PID reuse, a stale lock is misjudged as a live lock

- Severity: **Medium**
- Area: `fileLock.ts`
- Evidence: The ownership determination depends only on whether the PID is alive. If the OS reassigns a dead process's PID to another process, an old lock also appears active.
- Impact: Service startup can be blocked until the lock is deleted manually.
- Fix criteria: Store hostname, process start identity, and nonce, and compare the actual process start time on platforms where that is possible. Also document a safe operational recovery procedure for sufficiently old locks.
- **Resolution (T34, 2026-09-03)**: Added `hostname`/`nonce`/`pidStartedAt` (obtained via `ps -o lstart= -p <pid>` on POSIX; always null on Windows — tied to OPS-006) to the lock file. ① A lock written by another host cannot have its liveness verified by this process, so it is **never auto-reclaimed** and is always treated as busy (manual verification required) — legacy locks (no hostname field) are treated as "same host" for backward compatibility. ② Even if the same pid is alive, if that pid's _current_ start time differs from what the lock recorded, the OS is assumed to have reused the pid in the meantime, and the lock is treated as stale and reclaimed (if either value could not be obtained, it safely falls back to the previous determination without this signal). release() also deletes only when the nonce matches as well. The safe operational recovery procedure is documented in the README "Operational reliability" section (the only case where a person must delete manually is cross-host). Tests: `tests/fileLock.test.ts` (new describe with 6 tests — pid reuse/not reuse/start time unobtainable/cross-host/legacy backward compatibility/lock file field check).

## OPS-003 — The tie order in latest-file selection is not deterministic

- Severity: **Medium**
- Area: inventory/SCM file selection
- Evidence: Sorts in descending order by `mtimeMs` only, with no filename tie-breaker on ties.
- Impact: If multiple files end up with the same mtime during file copying/decompression, different data may be selected depending on the OS readdir order.
- Fix criteria: On an mtime tie, either raise a clear error or define a stable tie-breaker such as a filename/content marker.
- **Resolution (T34, 2026-09-03)**: Instead of rejecting with an error, a **deterministic tie-breaker** was adopted — mtime descending, then full path descending on ties (`sortByMtimeThenPathDesc`, `agent/folderScan.ts`). This does not block with an error the common situation where multiple files are legitimately copied within the same second, yet for the same set of files it always picks the same file regardless of the OS `readdir` order. When a tie is actually detected, a warning log line "수정 시각이 동일해 파일명 역순으로 결정론적으로 골랐습니다" ("modification times are identical, so the file was chosen deterministically in reverse filename order") is left so the user can learn the cause. Both inventory file and SCM file selection share the same helper. Tests: `tests/folderScan.test.ts` (forces identical mtimes via `utimes`, then confirms that repeated scans always select the same file).

## OPS-004 — No automatic recovery contract for failures where email send success is uncertain

- Severity: **High**
- Area: Resend timeout + `sending` reservation
- Evidence: A timeout error signals "may already have been sent", but the state changes `sending → failed`, allowing the same runId to be re-reserved. No provider idempotency key is passed either.
- Impact: Retrying after a lost network response can send duplicate emails. The DB reservation prevents concurrent calls but does not guarantee exactly-once for the remote side effect.
- Fix criteria: Check whether Resend supports idempotency and use a stable key, or keep a separate `unknown` state and do not auto-retry without human confirmation.
- **Resolution (T34, 2026-09-03)**: Both were adopted. **Confirmed from the documentation that Resend actually supports the `Idempotency-Key` header** (resend.com API docs, 2026-09-03 — unique per request, 24-hour expiry, max 256 characters) — `runId` is passed as-is in `OutboundMessage.idempotencyKey` (new) (`agent/folderScan.ts`/`agent/reorder.ts`), and `resendProvider.ts` forwards it as the header. Even if a person manually retries with the same runId (e.g. after checking an `unknown`), only one email actually goes out. **New `"unknown"` in `AgentSendStatus`** (migration 008) — `resendProvider.ts` marks the error's `.name` as `AmbiguousSendError` only on timeout (a connection failure itself or an HTTP error response is not a candidate, since in those cases it is certain whether "the request did/did not arrive"), and `agent/folderScan.ts`/`agent/reorder.ts` see this and record `unknown` instead of `failed`. `logAgentSendOn` in `pgWarehouse.ts` also had to include `unknown` among the statuses that "update the sending reservation row", alongside `sent`/`failed` (omitting it creates a separately inserted row — a bug leaving two rows for the same run_id — actually reproduced and confirmed by test). Since this project has no automatic retry logic at all, "do not auto-retry without human confirmation" already holds by itself. Tests: `tests/resendProvider.test.ts` (Idempotency-Key header passed/omitted, AmbiguousSendError only on timeout), `tests/pgWarehouse.test.ts` (unknown updates the same row), `tests/folderScan.test.ts` (inject AmbiguousSendError → confirm exactly one unknown is recorded in agent_send_log).

## OPS-005 — No long-running observability or retention policy

- Severity: **Medium**
- Area: console output, DB logs, snapshot/history
- Evidence: There is no structured log format, log level, correlation id propagation, or retention period and cleanup job for agent_send_log/inventory_snapshots.
- Impact: Tracing the cause of an outage and forecasting storage are difficult, and tables grow without bound in long-term operation.
- Fix criteria: Define structured logs including runId, an exit code contract, a retention period/cleanup command, and backup/recovery procedures.
- **Resolution (T34, 2026-09-03)**: **Structured logs** — `logStructured()` in `src/adapters/structuredLog.ts` (new) writes a single-line `{event, runId, status, ...}` JSON to stdout, separate from the existing human-readable completion log line (the branch/HQ modes in `agent/folderScan.ts`, and `agent/reorder.ts`, respectively). The MCP server (`server.ts`) is excluded because its stdout is protocol-only. **Exit code contract** — the existing behavior (0 on success, 1 on an unhandled exception) is formalized in the README "Operational reliability" section (no code change, documentation only). **Retention period/cleanup** — `Warehouse.deleteOldInventorySnapshots`/`deleteOldAgentSendLog` (new, `pgWarehouse.ts`) + `scripts/cleanup.ts` (`npm run cleanup`, human-only) — the same double gate as `npm run migrate` (dry-run by default, actual deletion only with `--confirm`), `CLEANUP_RETENTION_DAYS` (default 90 days). **Backup/recovery** — README documentation only (embedded PGlite: copy the data directory files; `DATABASE_URL`: delegated to the hosting service's managed backups — this project does not implement anything separately). Tests: `tests/structuredLog.test.ts` (confirms the output is JSON-parseable), `tests/pgWarehouse.test.ts` (new describe with 4 tests — delete/dry-run for each table).

## OPS-006 — The scope of installation environment compatibility verification is unclear

- Severity: **Medium**
- Evidence: Only `engines.node >=20` exists; there is no OS/Node version matrix CI and no record of clean-install verification. PGlite, ExcelJS, TextDecoder (euc-kr), and the file lock are sensitive to platform differences.
- Impact: It passes on the development machine, but install/encoding/path behavior may break on Windows/Linux or another Node LTS.
- Fix criteria: Decide the minimum supported OS and Node LTS and run a clean tarball install + core e2e in a CI matrix.
- **Resolution (T34 partial + T35 complete)**: Following T34's documentation of the supported range in the README "Operational reliability" section (Node 20+, Windows explicitly unverified), T35 set up an actual CI matrix as the `test` job in `.github/workflows/ci.yml` (`os: [ubuntu-latest, macos-latest] × node: [20, 22]`, with typecheck/lint/format/test + `npm run verify:pack` on every combination), completing "the range documented as supported is actually verified on every PR". CI running on Linux runners in itself also resolved "Linux unverified". Windows is still not in the matrix — a deliberate choice that keeps as-is the known limitation of the `ps`-based OPS-002 auxiliary signal (already documented in the README).

## Operations re-review criteria

- [x] Lock released on every close path (T34)
- [x] Stale lock recovery policy and PID reuse handling (T34)
- [x] Latest-input determinism (T34)
- [x] unknown/idempotency policy for remote sends (T34)
- [x] Structured log, retention, and backup contracts (T34)
- [x] Supported OS/Node matrix passes (T35, together with the initial CI setup) — `.github/workflows/ci.yml` `test` job
