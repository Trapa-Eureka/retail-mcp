# 005 — Security and Dependency Adversarial Review

- Review date: 2026-09-03
- Scope: arbitrary SQL, file input/output, secrets, runtime dependencies
- Verdict: **Release blocked — the `explore_sql` isolation claim does not hold, and known dependency vulnerabilities exist**
- Status: **Partially RESOLVED (T30 PR #41 — SEC-001~002, T32 PR #43 — SEC-003~007, 2026-09-03)** — all resolved. The full re-review will be conducted in T37. The strengthened explore_sql policy is reflected in `docs/SPEC.md` §18 and `docs/DESIGN.md` §12.4; file limits, formula escape, .env permissions, and the dependency exception are reflected in `docs/DESIGN.md` §12.6.

## SEC-001 — READ ONLY transactions do not block side-effecting SELECTs

- Severity: **Critical**
- Area: `src/core/sqlValidator.ts`, `src/adapters/exploreSqlExecutor.ts`
- Reproduction:

```sql
begin read only;
select pg_try_advisory_lock(727100104);
rollback;
select pg_try_advisory_lock(727100104);
```

In an empirical PGlite test, both calls returned `true`, and the session advisory lock remained even after the rollback. It took two unlocks to release it fully.

- Cause: PostgreSQL's READ ONLY restricts table/sequence writes, but it is not a sandbox that forbids the external side effects of every volatile function. The blocklist's `\block\b` also fails to catch `pg_advisory_lock` because of the underscore.
- Impact: A user could preempt the advisory locks used for migration/sync to disrupt operations, or leave locks behind on a pooled session. Depending on installed extensions and DB privileges, other side-effecting functions could be called as well.
- Fix criteria: Require a dedicated DB role whose execution privileges on dangerous functions are restricted, not just its write privileges. Prefer a restricted query AST targeting allowed schemas/tables, or fixed analytics tools, over arbitrary expressions. At minimum, attack tests for advisory lock/unlock, backend control, and file/network/configuration functions are needed.
- **Resolution (T30)**: Added `FORBIDDEN_FUNCTION_CALLS` to `core/sqlValidator.ts` (a function-name-level blocklist matching `\bname\s*\(` — closes the underscore bypass that `\block\b` missed) — the advisory lock family, `set_config`, the backend-control family, and the file/remote-access family. This reproduction scenario (`begin read only; select pg_try_advisory_lock(...); rollback; select pg_try_advisory_lock(...)`) is kept verbatim in `tests/exploreSqlExecutor.test.ts` as a living regression test, documenting the very fact that "READ ONLY alone cannot block advisory locks". The dedicated DB role requirement is reflected as policy in SPEC §18/DESIGN §12.4 and as a checklist in the README (in T36) — the code does not forcibly query role privileges (configuring the operational role is the deployer's responsibility, the existing principle of guardrail 4). The allowed-schema/table restricted query AST approach was not adopted (because explore_sql is, by definition, the sole exception that has no fixed-query form) — basis in SPEC §18.

## SEC-002 — Users can change `statement_timeout` back

- Severity: **Critical**
- Area: `explore_sql`
- Evidence: The executor first calls `set_config('statement_timeout', ...)`, but a user SELECT can also call `set_config`. The validator does not forbid this.
- Impact: Even on real Postgres, a user can overwrite the timeout with 0 or a large value and run expensive queries for a long time. PGlite, as documented, does not enforce the timeout at all, so a more direct CPU/memory DoS is possible.
- Fix criteria: Blocking the execution of configuration functions such as `set_config` alone does not make a complete sandbox. Combine a dedicated role, server-side `statement_timeout` enforcement, a separate restricted connection/pool, and concurrency/cost limits, and add bypass regression tests. On PGlite, consider making `explore_sql` disabled by force rather than by default.
- **Resolution (T30)**: Blocked `set_config(` via `FORBIDDEN_FUNCTION_CALLS` so that user SQL cannot override the executor's own `statement_timeout` setting (regression tests in `tests/sqlValidator.test.ts`/`tests/exploreSqlExecutor.test.ts`). "On PGlite, consider making explore_sql disabled by force rather than by default" was settled as **blocked by default + explicit override** (`EXPLORE_SQL_ALLOW_PGLITE=true`, the same pattern as `SEND_MODE=live && --confirm`) — `resolveServerConfig()` refuses server startup with an error containing the cause + remedy when `EXPLORE_SQL_ENABLED=true` is set without `DATABASE_URL` (`tests/server.test.ts`). Server-side `statement_timeout` enforcement, a separate connection pool, and concurrency limits are already effective on real Postgres (the pg path) as standard GUCs, and for the PGlite-specific limitation the block above eliminated the bypass path itself.

## SEC-003 — XLSX/CSV input has no file size, row count, or cell length limits

- Severity: **High**
- Area: `csvExcelParser.ts`, `folderScan.ts`
- Evidence: The entire file is loaded into memory via `readFile`/ExcelJS, and every parse error is also accumulated in a string array. There are no limits on decompressed size, worksheet row count, or cell string length.
- Impact: A large/zip-bomb XLSX or a massive CSV placed in the watched folder can exhaust process memory and CPU. With repeated cron execution, the outage persists.
- Fix criteria: Define a file size limit before reading, XLSX decompression/worksheet limits, maximum row/column/cell length, and an error-count cap. When exceeded, return the cause and the allowed value.
- **Resolution (T32, 2026-09-03)**: New `src/adapters/fileLimits.ts` — limits of 20MB file size, 100,000 rows, and 10,000 characters per cell. Since CSV is plain text, the single file-size limit makes the maximum on-disk size also the memory limit (no compression amplification), but XLSX is zip-compressed, so that does not hold. **Discovered during the work**: it was initially implemented with `ExcelJS.stream.xlsx.WorkbookReader` (true streaming, checking the limits per row and, once exceeded, not reading the remaining compressed data), but when the test suite was run repeatedly and concurrently with multiple files, `TypeError: Cannot read properties of undefined (reading 'sheets')` — presumed to be an ExcelJS internal race — reproduced intermittently even while reading the same fixture (an ExcelJS implementation problem, not this project's code). Since failing to read an inventory file is far more common and critical than a zip bomb, we decided not to use the unverified streaming path in production, reverted to the existing buffered `workbook.xlsx.readFile`, and moved the limit checks to immediately after reading (at the `worksheet.eachRow` iteration point) — the residual risk (the limits are checked after the entire file has already been decompressed into memory; the shared-strings cache stage runs before the limit check) is honestly recorded in `fileLimits.ts`/`csvExcelParser.ts`. Tests: `tests/fileLimits.test.ts` (pure-function unit tests), `tests/csvExcelParser.test.ts` (integration tests for row-count and cell-length overflow for CSV and XLSX respectively, actually reproduced with a 100,001-row fixture).

## SEC-004 — No spreadsheet formula injection defense in the snapshot CSV

- Severity: **High**
- Area: `snapshotExport.ts`
- Evidence: Store names, product names, and SKUs are written to the CSV as-is even when they start with `=`, `+`, `-`, or `@`. CSV quoting is only delimiter escaping, not a defense against spreadsheet formula execution.
- Impact: When a person opens the snapshot in Excel/Sheets, a malicious formula could execute or data could be exfiltrated to an external URL.
- Fix criteria: Settle the contract on whether the CSV is opened by humans or is machine-only. If humans can open it, safely escape values with dangerous prefixes and test the round-trip policy.
- **Resolution (T32, 2026-09-03)**: Contract settled — the snapshot CSV is treated as a "CSV that humans may also open" (there is a real possibility that a branch staff member opens it directly to check). `src/core/csvSafety.ts` (new) — if a store name, product name, or SKU starts with `=`/`+`/`-`/`@`, a `'` is prepended so that Excel/Sheets treat it as text (export, `snapshotExport.ts`). On re-import (`requiredTrimmedString` in `core/csvSchema.ts`), it is stripped exactly in reverse under the same condition, and since this is applied symmetrically to the store name, product name, and SKU fields at every branch, including original CSV/XLSX inputs, the round-trip does not break even for files that are not our own export. Tests: `tests/csvSafety.test.ts` (pure escape/unescape), `tests/snapshotExport.test.ts` (confirms the prefix is included in the export output + confirms that after an export→re-parse round-trip the data matches the original domain data exactly).

## SEC-005 — `.env` does not enforce sensitive-file permissions

- Severity: **High**
- Area: `src/cli/onboard.ts`
- Evidence: `writeFile(".env", ...)` specifies no mode. New file permissions depend on the process umask, and existing file permissions are not checked either. DATABASE_URL and email addresses are stored there.
- Impact: On a multi-user machine, the configuration and DB credentials can be read by other accounts.
- Fix criteria: Create new files atomically with `0o600`, and check/correct existing files for safe permissions as well. Prevent partial corruption via temp file→fsync→rename.
- **Resolution (T32, 2026-09-03)**: `writeEnvFile()` in `src/cli/onboard.ts` calls `writeFileAtomic()` (the shared utility created in T31, DATA-004) with `{ mode: 0o600 }`. No separate "check/correct existing file permissions" step is needed — POSIX `rename(2)` completely replaces the old inode at the target path with the new inode, so even if the existing `.env` had looser permissions (e.g. 0o644 created via umask), every onboarding run is itself a correction to 0o600. Tests: `tests/onboard.test.ts` (confirms a new file is 0600, confirms a loosely-permissioned existing file is replaced with 0600).

## SEC-006 — 2 known moderate vulnerabilities in runtime dependencies

- Severity: **High**
- Verification: `npm audit --omit=dev --json`
- Result: Through the direct dependency `exceljs`, `GHSA-w5hq-g745-h8pq` for `uuid < 11.1.1` is included. npm's tally is 2 moderate (`exceljs`, `uuid`).
- Impact: The advisory is a bounds-check flaw when passing a buffer to uuid v3/v5/v6. Whether that path is directly called in the current application has not been confirmed, but a basis for risk acceptance or removal is needed before public release.
- Fix criteria: Check whether it is resolved in ExcelJS's latest dependency tree, and do not follow the simple automatic downgrade suggestion. After verifying the compatibility of a replacement library/override and the XLSX tests, if an audit exception remains, record its basis and expiry date.
- **Fix attempted + ended in an approved exception (T32, 2026-09-03)**: The suggested automatic downgrade (exceljs 3.4.0, a semver major) was not adopted. Instead, `overrides: { uuid: "^11.1.1" }` was added to `package.json` — `npm audit --omit=dev` on the dev checkout becomes clean with 0 findings, and all XLSX tests (43) were confirmed passing. **However, during the work, verifying the tarball that would actually be published by installing it into a completely fresh project (`scripts/verifyPack.ts`) showed that uuid@8.3.2 still resolved** — npm's `overrides` apply only when that package itself is the root project, and not when it is installed as a dependency of another project (npm's own behavior, which this project cannot fix). In other words, this override helps dev-checkout hygiene but **has no effect whatsoever for users who install the published package** — it is kept (free dev hygiene), but SEC-006 is not marked as finished on that basis.
  - Code-path check: `exceljs` calls `uuid`'s `v4()` **only without arguments** (`node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`) — the advisory (GHSA-w5hq-g745-h8pq) is a bounds-check flaw when passing `buf` to `v3`/`v5`/`v6`, so exceljs's actual call path does not reach the vulnerable code.
  - A full replacement with an alternative library was considered but not adopted — judged not to be a substantial enough risk (moderate, unreachable code path) to justify rewriting a stable parsing path with 43 XLSX tests riding on it.
  - **Approved exception**: `uuid`'s `GHSA-w5hq-g745-h8pq` (via exceljs, "<11.1.1"). The basis is the code-path check above. **Re-review deadline: 2027-03-03** (re-check whether exceljs has bumped its own uuid dependency by then — if not, re-evaluate a patch/alternative library). **The deadline is enforced mechanically by CI** (second adversarial review SR2-AUD-003, 2026-09-04): it is encoded as data in `ACCEPTED_ADVISORIES` in `src/core/auditAllowlist.ts` as `{url, expiresAt: "2027-03-03", rationale}`, and both `npm run audit:lockfile` (every PR) and `verify:pack` (release gate) stop counting this advisory as approved and block **fail-closed** once the reference time is at or past UTC 00:00 on the deadline day — previously the deadline lived only in a comment, so it kept being auto-approved even after it passed. The only way to extend it is to update `expiresAt` after a re-review.
  - Added an `npm audit` step to the release gate in `scripts/verifyPack.ts` (step 5) — it checks every time **against the directory where the tarball to be published is actually installed**, and verifies that the only advisory URL present is the single approved exception (`GHSA-w5hq-g745-h8pq`). If a new/different vulnerability appears, the release gate fails.

## SEC-007 — No security policy or vulnerability reporting channel

- Severity: **Medium**
- Evidence: There is no `SECURITY.md`, no supported-versions statement, and no private reporting channel.
- Impact: Users of the public package may expose vulnerabilities as public issues or be unable to find how to report them.
- Fix criteria: Link supported versions, response targets, and a private reporting address in the SECURITY document and package metadata.
- **Resolution (T32, 2026-09-03)**: New `SECURITY.md` — supported versions (only the `main` branch, since this is pre-release), response targets (initial response within 5 business days, etc.), the GitHub private security advisory (Security Advisories) reporting channel, and a summary of this project's known security design boundaries (explore_sql, file limits, the scope of formula escape). Link added to the README document map.

## Security re-review criteria

- [x] `explore_sql` dedicated role, function execution privileges, and PGlite policy settled (T30 — the role via policy/documentation, PGlite blocked by default in code)
- [x] Advisory lock and timeout override attack tests pass (T30)
- [x] File resource limits and CSV formula defense applied (T32) — `fileLimits.ts`, `csvSafety.ts`
- [x] `.env` 0600 + atomic write (T32) — `writeEnvFile()` (`cli/onboard.ts`) + `writeFileAtomic()`
- [x] Runtime dependency audit — 1 approved exception (uuid, re-review 2027-03-03) documented + regression watched by the `verify:pack` release gate (T32). Not yet 0 — see SEC-006 details. The re-review deadline is encoded as data in `ACCEPTED_ADVISORIES.expiresAt` and enforced mechanically by CI/the release gate (SR2-AUD-003).
- [x] `SECURITY.md` added (T32)
