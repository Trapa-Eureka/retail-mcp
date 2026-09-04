# 008 — Test and Release Gate Adversarial Review

- Review date: 2026-09-03
- Current result: `npm run check` passes, 33 files/376 tests pass
- coverage: statements 99.66%, branches 94.66%, functions 100%, lines 100% (`src/core`)
- Verdict: **Excellent on the numbers, but the npm install/operations boundary and attack scenarios sit outside the gate**
- Status: **RESOLVED(T29 PR #40 — QA-001, T35 PR #47 — QA-002~006, 2026-09-03)** — QA-001~006 all resolved. T37(2026-09-04): mechanical steps 1~7 of the 8-step release gate passed + `prepublishOnly` wired up — the execution record is in `docs/TASKS.md` T37 "gate execution log". Step 8 (version, changelog, tag, provenance, human approval): version `0.1.0` confirmed, scope changed to `@shiz_son` (PR #74), provenance decided as `.github/workflows/release.yml` (tag push → `npm publish --provenance`, including the `prepublishOnly` gate) — the remaining human work is registering the `NPM_TOKEN` secret and approving the publish (`docs/TASKS.md` T37). The gate list is reflected in `docs/TESTING.md` §8, and the per-finding test cross-reference in `docs/010_FINDING_TEST_CROSSREF.md`.

## QA-001 — Tests verify only the source tree, not the actual tarball

- Severity: **Critical**
- Basis: All tests run against the repository's TS source in an environment with devDependencies installed. There is no `npm pack → fresh directory → npm install --omit=dev → run bin/MCP` test.
- Impact: Even if all 376 tests pass, the published package can be unrunnable.
- Fix criteria: Add a tarball install smoke test as a mandatory release gate.

## QA-002 — `npm run check` does not include the coverage threshold

- Severity: **Medium**
- Basis: `coverage` is a separate script. Coverage currently passes, but `check` alone — the ordinary PR/deploy gate — cannot detect a drop.
- Impact: In later changes, core coverage could fall below 90% while the mandatory gate still passes.
- Fix criteria: Include `npm run coverage` in the CI/release gate. Whether to include it in every local check can be decided with execution time in mind.
- **Resolved (T35, 2026-09-03)**: The CI `coverage` job runs `npm run coverage` on every PR (`.github/workflows/ci.yml`). It was deliberately left out of the local `npm run check` (execution time considered, as proposed — rationale recorded in TESTING.md §8).

## QA-003 — Coverage scope is limited to core

- Severity: **High**
- Basis: The threshold include is only `src/core/**/*.ts`. There is no enforced standard for `exploreSqlExecutor`, `folderScan`, `warehouseFactory`, the providers, and the CLI, which matter for publishing/security.
- Impact: The quality of the core business pure functions is high, but unexecuted branches can accumulate at the IO/security boundaries where real failures actually occur.
- Fix criteria: Add a separate whole-project standard or set per-risk-module thresholds. Spell out a list of critical branches rather than a simple overall percentage.
- **Resolved (T35, 2026-09-03)**: Expanded `coverage.include` in `vitest.config.ts` to `src/{core,adapters,agent,mcp,cli}` and added per-risk-module standards as glob keys in `coverage.thresholds` — `exploreSqlExecutor.ts`/`warehouseFactory.ts`/`resendProvider.ts` get individual standards (directly tied to SEC-001/002, OPS-001, and OPS-004 respectively), `agent`/`mcp`/`cli` get group standards, and core keeps the existing 90/90/90/85. The numbers are regression-prevention floors with only a small margin below the 2026-09-03 measured values (core 99.69/95.19/100/100, adapters 89.39/81.45/88.46/91.45, agent 74.63/60.3/74.35/74.27, cli 69/67.74/70.58/66.29, mcp 83.33/67.07/90/93.44) — not ideal targets.

## QA-004 — Insufficient real-Postgres contract verification

- Severity: **High**
- Basis: Most tests are based on PGlite or mock connections. The project itself has already confirmed PGlite's timeout differences, and there are other differences/commonalities such as session locks.
- Impact: Migration lock, READ ONLY, pg pool session, and numeric/date parsing can fail differently only on production Postgres.
- Fix criteria: Component-test migration, transaction rollback, read-only role, advisory lock cleanup, and explore_sql timeout against a CI service Postgres.
- **Resolved (T35, 2026-09-03)**: `tests/component/postgres.component.test.ts` (+ `vitest.component.config.ts`, `npm run test:pg-component`) — covers, in 6 describe blocks, migration idempotency/checksum mismatch, transaction rollback of a failed migration, advisory lock cleanup, `BEGIN READ ONLY` write rejection, and even actual `statement_timeout` cancellation, which could not be verified with PGlite. It runs only in the CI `postgres-component` job (`postgres:16` service container) — the default gate (guardrail 2) does not see this directory thanks to the exclude in `vitest.config.ts`. Confirmed 8/8 passing against a local `postgresql@16` (brew).

## QA-005 — No known attack/correctness regression cases

- Severity: **High**
- Missing cases:
  - snapshot packSize round-trip
  - preventing duplicate sends for an unchanged file
  - cleaning up SKUs that disappeared from a new snapshot
  - concurrent read of a partial snapshot
  - explore_sql bypass using `pg_advisory_lock` and `set_config`
  - CSV formula injection and large XLSX/CSV limits
  - SCM period mismatch / no opening inventory / failure status
- Fix criteria: Connect all re-review items from documents 005~007 to automated tests.
- **Resolved (T35, 2026-09-03)**: `docs/010_FINDING_TEST_CROSSREF.md` (new) cross-references all 33 findings from 004~008 against their responsible tests. Of the 7 missing cases above, 6 were already automated (added alongside the resolution of each 005~007 finding), and the only one that was actually empty was "concurrent read of a partial snapshot" — a genuine concurrent write-while-repeatedly-reading race test was newly added to `tests/atomicFile.test.ts` (the existing test only checked "a handle opened before the write", which was not real concurrency).

## QA-006 — Dependency audit and tarball content inspection are not automated

- Severity: **High**
- Basis: A manual audit found 2 moderate issues and the pack dry-run showed 97 unnecessary files, but neither is in `check`/CI.
- Fix criteria: Add a lockfile audit policy, allowlist assertion, and secret scan/SBOM to the release workflow. Also decide the fail-open/fail-closed policy for when the audit service is down.
- **Resolved (T35, 2026-09-03)**: The CI `audit` job runs all three on every PR. ① lockfile audit (`src/adapters/auditLockfile.ts` + `npm run audit:lockfile`) — if the audit run itself fails, fail-open (warn, pass); if it succeeds but an advisory outside the approved list (`src/core/auditAllowlist.ts`) shows up, fail-closed. It is kept alongside the tarball-based audit (SEC-006, `scripts/verifyPack.ts`) because the inspection targets differ — measurements reconfirmed that they come out differently: the dev lockfile has 0 findings while the tarball has 1 approved uuid exception (the `overrides` non-propagation problem T32 already demonstrated). ② secret scan (`src/core/secretScan.ts` + `npm run secret-scan`) — patterns for AWS keys/PEM/Anthropic·Resend key prefixes/Postgres URLs containing credentials, across all tracked files per `git ls-files`. ③ SBOM (`npm sbom --sbom-format cyclonedx`, uploaded as an artifact with 90-day retention). The allowlist assertion (tarball content inspection) is already done by step 1 of T29's `verify:pack`, and since T35 it also runs in the CI `test` job on every OS/Node combination.

## Recommended release gate

1. Clean checkout and install on the supported Node/OS matrix
2. typecheck + lint + format check + unit/component/e2e
3. Coverage thresholds for core and risk modules
4. Production dependency audit + secret/license scan
5. Clean build
6. `npm pack` allowlist verification
7. Tarball `--omit=dev` fresh install + CLI/MCP smoke
8. Human approval after confirming version, changelog, git tag, and provenance
