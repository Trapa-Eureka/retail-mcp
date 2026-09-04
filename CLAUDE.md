# CLAUDE.md — retail-mcp steering

Sell-through and inventory BI MCP server for multi-branch retail + reorder suggestion agent. The v0.1 data source is Loyverse only (implementation complete; live deployment on hold until a pilot is confirmed) — the next actual release target is the **v0.2 CSV/Excel upload channel** (folder watch, embedded PGlite by default). Background and metric definitions are in `docs/SPEC.md`; the implementation design is in `docs/DESIGN.md`. The public npm distribution target is `@shiz_son/retail-mcp` (MIT) — pre-release review and policy are in `docs/SPEC.md` §18, `docs/004~009`.

## Stack

- Node.js 20+, TypeScript **strict** (including `noUncheckedIndexedAccess`)
- MCP: `@modelcontextprotocol/sdk` — stdio transport
- Warehouse: **embedded PGlite is the default** (`.retail-mcp/data/`, protected against multiple processes by its own file lock) — when `DATABASE_URL` is set, the `pg` driver path for Neon/Supabase etc. Tests always use **PGlite** (in-process, zero network)
- Data sources: CSV/Excel folder watch (v0.2, next actual release target, `csv-parse`/`exceljs`) — the Loyverse REST API (`LOYVERSE_API_TOKEN`, v0.1, implementation complete, awaiting pilot) coexists, isolated behind an adapter
- Notifications: `NotificationProvider` + `ResendEmailProvider` ported from sheet_mcp
- LLM (agent summaries only): Claude API
- Verification: Vitest + ESLint + Prettier, schemas with `zod`, migrations = plain SQL files + our own runner

## Commands

```bash
npm run check           # typecheck + lint + format:check + test in one go — the mandatory gate for task completion
npm run test            # vitest run
npm run coverage        # coverage threshold including risky modules (CI-only gate, not part of check — TESTING.md §8)
npm run typecheck       # tsc --noEmit
npm run lint            # eslint .
npm run dev             # run the MCP server over stdio
npm run onboard         # interactive setup CLI — generates the CSV/Excel channel .env + example templates
npm run agent:folder-scan  # one CSV/Excel channel scan (v0.2, next actual release target, dry_run by default)
npm run agent:reorder   # one reorder agent run (Loyverse path, dry_run by default)
npm run migrate         # migrations against DATABASE_URL (production runs are human-only)
npm run cleanup         # clean up logs/snapshots past the retention period (dry-run by default, human-only)
npm run smoke           # manual smoke against real Loyverse + real DB (human-only)
npm run verify:pack     # fresh-install the actual published tarball + run bins + audit (release gate, also wired into CI)
```

CI (`.github/workflows/ci.yml`, TASKS T35) runs most of the gates above (including coverage) on every push/PR, plus the real Postgres component tests (`npm run test:pg-component`), `verify:pack` across the supported OS/Node matrix, and dependency audit/secret scan/SBOM (`npm run audit:lockfile`/`secret-scan`/`sbom`). These scripts are intentionally absent from the local `npm run check` (they are heavy or need real network access — TESTING.md §8).

## Source layout

```
src/
  core/        # pure logic: metrics (sell-through, days of cover, reorder quantity), csvSchema, scmSchema, sqlValidator, types — no external IO
  etl/         # Loyverse sync orchestration (assembles LoyverseClient + Warehouse, manages cursors)
  adapters/    # loyverseClient, pgWarehouse, csvExcelParser, resendProvider, exploreSqlExecutor, fileLock, warehouseFactory, migratePg
  mocks/       # FixtureLoyverseClient, PGlite warehouse helper, MockNotificationProvider, FixedClock
  agent/       # reorder.ts (Loyverse path) / folderScan.ts (CSV/Excel path, branch and HQ modes) — scheduled-run entry points, thin orchestration only. npm-distributed bins `retail-mcp-reorder`/`retail-mcp-scan` (added in the T37 pre-publish check — installed users had no command to run the core features)
  cli/         # onboard.ts — interactive setup CLI (`npm run onboard`, bin `retail-mcp-onboard` — also asks optional questions for send settings: Resend key and sender address) / migrate.ts — npm-distributed bin `retail-mcp-migrate` (SR2-REL-001)
  mcp/         # tools.ts — MCP tool logic (server.ts only registers and assembles)
  server.ts    # MCP server entry point (registration and assembly only, no logic)
migrations/    # 001_init.sql ... sequentially numbered SQL files
scripts/       # repo-only CLI shells (migrate/cleanup/verifyPack/auditLockfile/secretScan/smoke) — not included in the npm package, reuse the logic in src/adapters
tests/  fixtures/loyverse/  fixtures/csvExcel/  fixtures/scm/  component/(real Postgres only, excluded from the default gate)
.github/workflows/ci.yml  # OS/Node matrix, coverage, real Postgres component, dependency audit/secret scan/SBOM
```

## Conventions

- **The source of truth for metric formulas is `docs/DESIGN.md` §3.** When code, tests and docs disagree, align to the docs.
- All external IO (POS, DB, send, clock, LLM) goes behind interfaces. `core/` contains only interfaces and pure computation.
- No `any`. External input (API responses, tool arguments) is parsed with `zod` at the boundary.
- SQL in MCP query tools is **parameterized fixed queries only**. `explore_sql` (arbitrary SELECT queries, disabled by default in production) is the only exception, pre-approved by guardrail 4 — see `docs/SPEC.md` §17·§18, `docs/DESIGN.md` §12.4. When adding a new query tool, do not widen this exception; build it as a fixed query.
- Error messages include the cause plus how to fix it (e.g. `LOYVERSE_API_TOKEN is not set. Create one in Loyverse Back Office > Access tokens and add it to .env.`).
- Commit messages: `T{n}: summary` (written in English. Convention since 2026-09-02 — earlier commits were written in Korean and later rewritten in English).

## Guardrails (must not be violated)

1. **Live-send double gate**: default `SEND_MODE=dry_run`. A live send requires both `SEND_MODE=live` **and** the agent run argument `--confirm`. Tests must never take the live path under any circumstances.
2. **Zero network calls** in tests: DB is PGlite, POS is fixtures, send is a mock, LLM is a mock response. `tests/component/**` (targets real Postgres, `vitest.component.config.ts`) is the sole exception, following the same pattern as explore_sql in guardrail 4 — the default gate (`vitest.config.ts`) excludes this directory so the principle itself is not broken, and it runs only in CI's separate job (`postgres-component`). When adding a new real-network test, do not widen this exception; put it in here.
3. **The LLM does not produce numbers**: items, quantities and amounts come only from deterministic computation results, and LLM output is used only as summary text. Code that parses numbers out of LLM output and uses them in logic is forbidden.
4. Warehouse **writes go through the ETL path only**. MCP query tools are read-only (use a read-only role on the production DB). When enabling `explore_sql`, a dedicated role without execute permission on dangerous functions is mandatory — `BEGIN READ ONLY` alone does not prevent side effects such as advisory locks (`docs/SPEC.md` §18, `docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md` SEC-001/002).
5. Running `npm run migrate` against a production `DATABASE_URL` is human-only. The agent goes only as far as **writing the migration files**.
6. Secrets (`LOYVERSE_API_TOKEN`, `DATABASE_URL`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`) live in `.env` only. Never commit them; commit only `.env.example`.

## Way of working

- One session = one task from `docs/TASKS.md`. Self-correction loop until all completion criteria are met and `npm run check` passes. Stop and ask only when spec ambiguity makes progress impossible.
- On completion, summarize the changed files and verification results, then finish.

## Pruning log

Biweekly review, delete stale rules (`docs/WORKFLOW.md`).

- 2026-09-02: Initial version.
- 2026-09-03: Reflected completion of v0.2 (CSV/Excel channel, SCM reconciliation, pack-size rounding, `explore_sql`) + the pre-npm-release adversarial review (`docs/004~009`) — updated stack/layout/guardrails to the actual v0.2 structure, and stated the v0.2 transition status instead of leaving only "v0.1 data source is Loyverse only". No stale rules deleted (v0.1 rules remain valid; v0.2 was added on top).
- 2026-09-03 (T36): Reflected completion of T29~T35 by updating the command list (coverage/onboard/agent:folder-scan/cleanup/verify:pack), source layout (scripts/, tests/component/, .github/workflows/), guardrail 2 (tests/component/** exception) and the pre-release review section. On re-review there were no stale rules to delete — the v0.1 rules (guardrails 1/2/3/5/6, the Loyverse path) still exist in code and are enforced by tests regardless of the live-deployment hold.
- 2026-09-04: Resolved P0 SR2-REL-001 from the second adversarial review (`docs/010_SECOND_ADVERSARIAL_REVIEW_T29_T36.md`) — adding the `retail-mcp-migrate` bin closed the last remaining npm packaging gap (`docs/004` REL-006). Updated the source layout (`src/cli/migrate.ts`, `src/adapters/migratePg.ts`) and the pre-release review section. No stale rules to delete — this change keeps the existing guardrail 5 ("production migrations are human-only") intact and merely gives npm-distributed users a way to run it.

## Implementation interpretation supplement (2026-09-02 document check)

- Do not mix the name `cursor` across different meanings. Distinguish the API pagination token as the in-memory `pageCursor` and the completed incremental range as the DB `watermark`. Commit the watermark only after all pages of a resource have succeeded.
- Date and period calculations use `Clock` and an explicit business timezone. Store UTC in the DB and do not depend on the local machine timezone.
- Do not implicitly convert quantities and amounts to JS floating point. Make the parsing/rounding policy for DB `numeric` explicit at the boundary, and handle amounts together with a currency code.
- Do not leave tokens, DB URLs, email API keys or full external responses in logs, errors or dry-run output.
- Guardrail 4's "warehouse writes go through the ETL path only" is a rule about business data (`stores/products/sales/inventory`). The agent's audit-purpose run/send log writes are allowed, but MCP query tools must not modify business data. `sync_now` is an explicit exception that invokes ETL from MCP and is disabled by default in production.
- When documents conflict, the priority is `SPEC (product scope, metric definitions) → DESIGN (implementation contract) → TESTING/TASKS (verification, task order) → README`. When you find a conflict, do not guess from the implementation; first correct the related documents together.

## Pre-release review response (2026-09-03, `docs/TASKS.md` T28~T37)

- We ran an adversarial review before preparing npm publish (`docs/004~009`, 33 findings + 5 document-consistency issues) and the verdict was **release blocked**. T29~T35 (packaging/security/data/operations/test gates) are all complete — the per-finding resolution evidence is in `docs/010_FINDING_TEST_CROSSREF.md`. All that remains is T36 (this section — operational document sync) and T37 (final pass of the 8-step release gate in `docs/008` + human confirmation). `npm publish` is not run after T37 passes **until the user has separately confirmed**.
- SKUs/stores that disappear from a file-based authoritative scan (CSV/Excel folder channel) are **auto-tombstoned** (inactive status, no physical deletion, history preserved) — `docs/SPEC.md` §18, `docs/DESIGN.md` §12.2.
- Low-stock notifications from the branch folder scan **guarantee at most one digest per day** — even if the files do not change, it is not completely silent (so that "silent failures" such as SCM failures are not missed). `docs/SPEC.md` §18, `docs/DESIGN.md` §12.3.
- The public npm distribution target is `@shiz_son/retail-mcp` (scoped, `publishConfig.access=public`, MIT) — the unscoped `retail-mcp` is not adopted because of name-reuse uncertainty (unpublish history on 2026-01-12). The originally chosen `@trapa-eureka` scope was found in T37 to have no npm organization of that name (the publishing account is `shiz_son`), so by user decision on 2026-09-04 it was changed to the account scope `@shiz_son` — the GitHub repository (`Trapa-Eureka/retail-mcp`) and `author` are unchanged.
- **CI exists in this repository** (`.github/workflows/ci.yml`, T35) — on every push/PR it runs the supported OS/Node matrix, the coverage threshold, real Postgres component tests, and dependency audit/secret scan/SBOM. New code that breaks this gate is not merged.
- **Migration CLI for users of an external `DATABASE_URL` (Neon etc.)**: the `retail-mcp-migrate` bin (SR2-REL-001, second adversarial review, `docs/010_SECOND_ADVERSARIAL_REVIEW_T29_T36.md`) closed this gap — dry-run by default (shows only the target host/db name and pending migrations; credentials are not shown), actual application with `--confirm`. `scripts/migrate.ts` (repo-only, not included in `files`/build output) remains developer-only, and the actual application logic is shared via `src/adapters/migratePg.ts`. `server.ts`/`agent/reorder.ts`/`agent/folderScan.ts`, when starting on the `DATABASE_URL` path, use `ensureNetworkMigrationsApplied()` to report a missing schema immediately with an error that points to this command instead of a raw Postgres error (`docs/004` REL-006 fully resolved).
