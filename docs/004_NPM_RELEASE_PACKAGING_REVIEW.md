# 004 — npm Release and Packaging Adversarial Review

- Review date: 2026-09-03
- Target: `package.json`, npm tarball, install/run contract
- Verdict: **Release blocked — the current package cannot be published, and there is no public entry point to run after installation**
- Status: **Partially RESOLVED (T29, PR #40, 2026-09-03)** — REL-001~005 resolved. REL-006 (install/upgrade docs) documented in the README in T36 (the gap of the missing migration CLI was explicitly left open and carried over to T37). REL-007 (full release gate) RESOLVED in T37 by wiring `prepublishOnly` (2026-09-04). REL-008 was confirmed in T37 as far as the `npm view` 404 (name available; user decision: reuse is irrelevant), and since the npm organization for the `@trapa-eureka` scope does not exist (`npm org ls` 403, publishing account `shiz_son`), **the package name was changed to `@shiz_son/retail-mcp` by user decision on 2026-09-04 — RESOLVED** (SPEC §18 updated — the T29 records under REL-001/REL-008 below are left with the name as it was at the time and are corrected by this line). The policy decisions (scope/license) are reflected in `docs/SPEC.md` §18.
- Review command: `npm pack --dry-run --json --cache /tmp/retail-mcp-npm-cache`

## REL-001 — `private: true` explicitly blocks npm publish

- Severity: **Critical**
- Basis: `private` in `package.json` is `true`. npm refuses to publish a package with this setting.
- Impact: In the current state, `npm publish` cannot succeed even with correct authentication and permissions.
- Fix criteria: First finalize the public/private distribution policy and the npm scope, then change the `private` policy. For a public package, specify a personal/organization scope and `publishConfig.access` to prevent accidental target changes.
- **Resolved (T29)**: `private` removed, `name: "@trapa-eureka/retail-mcp"`, `publishConfig.access: "public"` specified.

## REL-002 — No `bin`/`exports`/`main` for installers to run

- Severity: **Critical**
- Basis: The package contains `src/server.ts`, `src/cli/onboard.ts`, etc., but `package.json` has no `bin`, `exports`, or `main`. There is also no root `index.js`, Node's default entry point.
- Impact: None of `npm install retail-mcp`, `npx retail-mcp`, or library import works as a usage mode. Only `npm run ...` inside the repository works.
- Fix criteria: Choose the product's public contract first.
  - If it is a CLI/MCP server product, add a shebang to the built JS executable and register `bin`.
  - If a library is also provided, define `exports` and type declarations separately.
  - Install the tarball into a temporary directory and verify as far as `npx <bin> --help` or MCP initialize.
- **Resolved (T29)**: Registered `retail-mcp` (`dist/server.js`) and `retail-mcp-onboard` (`dist/cli/onboard.js`) in `bin`, `main: "dist/server.js"`. `exports` (library contract) explicitly excluded as out of scope (DESIGN §12.1 — distributed only as a CLI/MCP server product). Verified tarball fresh-install + MCP initialize + onboard execution via `scripts/verifyPack.ts` (QA-001) — in the process, two additional real defects were found and fixed: (1) the `isMainModule` check `process.argv[1] === fileURLToPath(import.meta.url)` was always false when going through a symbolic link (npm bin), so `main()` never ran at all (split out into `src/adapters/mainModule.ts`, fixed with a realpath comparison); (2) calling `rl.question()` from `readline/promises` repeatedly with piped input only answers the first question and then hangs forever — a known behavior of Node itself (replaced with `createReadlineAsk()`, which consumes an async iterator).

- **Follow-up (T37 pre-publish check, 2026-09-04)**: T29's 2 `bin`s (+ migrate from SR2-REL-001) covered only the MCP server, setup, and migration, and **the tarball had no command for an installed user to run the core functionality (inventory file scan + low-stock notification, Loyverse reorder proposals)** — the `npm run agent:folder-scan` the README pointed to is a repository-only script. Added `retail-mcp-scan` (`dist/agent/folderScan.js`) and `retail-mcp-reorder` (`dist/agent/reorder.js`) as bins (shebang, build chmod), and steps 6 and 7 of `scripts/verifyPack.ts` verify that both bins are executable and emit a guiding error when required configuration is missing. The reason the product was unusable despite passing this finding's verification criterion ("install the tarball and actually run the bins") is that the list of bins under verification was "the bins that exist", not "the entry points the product needs" — from now on, when adding a bin, cross-check against the README's user procedures.

## REL-003 — The distributed artifact is TypeScript source, but the runner `tsx` is a devDependency

- Severity: **Critical**
- Basis: The tarball contains only `.ts` source and no `dist/`. The run scripts call `tsx`, but `tsx` is in `devDependencies`, so it is not guaranteed in a normal production install.
- Impact: Even when calling the package scripts directly, it cannot run in an `npm install --omit=dev` environment.
- Fix criteria: Build JS and `.d.ts` into `dist/` in `prepack` and run the production entry points with Node. A fresh-install smoke test must pass using only the build output.
- **Resolved (T29)**: `tsconfig.build.json` (`rootDir: src`, `outDir: dist`, `src/mocks/**` excluded — confirmed via grep that it is not used at runtime) + `npm run build` (`tsc -p tsconfig.build.json` + `chmod +x` on the bin files), automatically invoked by `package.json.scripts.prepack`. `tsx` remains a devDependency (used only for in-repo development such as `npm run dev`). **Additional discovery while starting the work**: `@electric-sql/pglite` was in `devDependencies`, but the embedded warehouse default path (`warehouseFactory.ts`, production runtime) actually imports it directly — installing with `npm install --omit=dev` died immediately with `ERR_MODULE_NOT_FOUND`. Resolved by moving it to `dependencies`.

## REL-004 — No distribution file allowlist, so 97 development/test assets get published

- Severity: **High**
- Basis: There is no `.npmignore` or `package.json.files`, so npm uses the `.gitignore` fallback. The dry-run tarball unpacks to 823,508 bytes, including the entire test suite, test fixtures, the existing adversarial review documents, ESLint/Vitest configs, 95KB of raw fixtures, etc.
- Impact: Install size and public attack surface grow unnecessarily, and local-only fixtures or internal documents could be distributed by mistake in the future.
- Fix criteria: Prefer a `files` allowlist to include only the required files such as `dist`, runtime migrations/templates, README, LICENSE. Pin the `npm pack --dry-run` file list as a release gate.
- **Resolved (T29)**: `package.json.files = ["dist", "migrations", "README.md", "LICENSE", ".env.example"]`. `npm pack --dry-run` result reduced from 97 files (823,508 bytes) → 63 files (unpacked 301.2kB); confirmed that tests, fixtures, internal review documents, and ESLint/Vitest configs are all excluded.

## REL-005 — No license or package provenance metadata

- Severity: **High**
- Basis: There is no LICENSE file and no `package.json.license`, `repository`, `bugs`, `homepage`, or `author`.
- Impact: External users cannot determine the terms under which they may legally reuse/redistribute, nor where the source/issues live. It is hard to consider public npm distribution ready.
- Fix criteria: After the rights holder decides on a license, make LICENSE and the metadata consistent. Do not publish before the license decision.
- **Resolved (T29)**: Per user confirmation (MIT), created `LICENSE` + filled in all of `license`/`author`/`repository`/`bugs`/`homepage` in `package.json` (using the actual remote repository values of the GitHub organization `Trapa-Eureka` as-is).

## REL-006 — No install/upgrade/uninstall or data path contract

- Severity: **High**
- Basis: The README only describes the flow of cloning the repository and running `npm install`. There is nothing on npm registry installation, CLI names, the `.retail-mcp/data` created in the current working directory, migration/upgrade, or whether data is preserved on uninstall.
- Impact: Global execution or different working directories can create different DBs, and users cannot know the data location or how to back it up.
- Fix criteria: Decide on a stable per-OS user data directory or an explicit `RETAIL_MCP_DATA_DIR` requirement, and add install/upgrade/uninstall/backup documentation.
- **Partially resolved (T36, 2026-09-03)**: Added an "Installation (after npm publish)" section to the README — the policy itself was already fixed in code (CWD-relative `.retail-mcp/data`, `RETAIL_MCP_DATA_DIR` override, `warehouseFactory.ts`); this only documented it. Specified the install (`npm install -g`) / upgrade (`npm install -g @latest`, safe via migration sequence numbers + checksums) / uninstall (`npm uninstall -g`, data is not deleted) procedures. **Real gap found while starting the work**: the published npm package has no migration CLI for external `DATABASE_URL` (Neon etc.) users — `scripts/migrate.ts` is a repository-only script not included in the `dist` build output of `package.json.files`/`tsconfig.build.json` (requires the devDependency `tsx`). The embedded PGlite path auto-migrates, so it is unaffected. This gap is stated explicitly in the README and left for **T37 to decide whether to add a migration bin** (code changes are outside T36's scope).
- **Fully resolved (2026-09-04, second adversarial review SR2-REL-001)**: Registered the `retail-mcp-migrate` bin in `package.json.bin` and implemented it in `src/cli/migrate.ts` — default dry-run (shows only the target host/db name and the list of pending migrations; credentials are not shown), actual application with `--confirm` (the same dry_run + --confirm double gate pattern as guardrail 1, applied to migrations as well). `server.ts`/`agent/reorder.ts`/`agent/folderScan.ts`, when starting on the `DATABASE_URL` path, use `ensureNetworkMigrationsApplied()` (`warehouseFactory.ts`) to report a missing schema immediately with an error that points to this command instead of a raw Postgres error. `scripts/verifyPack.ts` (release gate) verifies bin execution and the error paths on the actual tarball, and `tests/component/postgres.component.test.ts` verifies application and idempotency against real Postgres.

## REL-007 — No automatic blocking gate before publish

- Severity: **High**
- Basis: There is no `prepublishOnly`/`prepack`/release script, so the publish command can be run without `npm run check`, coverage, audit, or pack verification.
- Impact: An unverified tarball can be uploaded as a permanent npm version through local state or a CI mistake.
- Fix criteria: Automatically run at least `clean → build → check → coverage → pack/install smoke`, and keep CI trusted publishing/provenance and an approval step separately.
- Partial progress (T29): `prepack` automatically invokes `build`, which at minimum prevents the accident of "packing without building". `npm run verify:pack` (pack/install smoke) was created but is not yet wired to `prepublishOnly` — wiring the full gate is T37.
- **RESOLVED (T37, 2026-09-04)**: Wired `prepublishOnly: npm run check && npm run verify:pack` in `package.json` — wherever `npm publish` runs (local/CI), publishing is aborted unless typecheck/lint/format/full tests → clean build → `npm pack` allowlist → `--omit=dev` fresh install → smoke of the 3 bins → tarball-based audit all pass. The coverage threshold, lockfile audit, and secret scan are already enforced as required checks by CI on every PR (SR2-CI-004 ruleset), so they were not duplicated in the local publish hook (they are heavy, and only commits merged into main are publish candidates, so they have already passed). "CI trusted publishing/provenance and an approval step" was separated into the T37 human-confirmation items (`docs/TASKS.md` T37) — the decision between local publish (no provenance) vs. a release workflow (OIDC provenance) is the user's.

## REL-008 — Package name, ownership, and public scope are not verified

- Severity: **High**
- Basis: The current name is the unscoped `retail-mcp`, and the repository has no record of an npm owner/scope decision. The 2026-09-03 response to `npm view retail-mcp name version owners --json` returned an E404 saying it is not simply a new name but **a package unpublished on 2026-01-12**. This response alone does not mean the current account can reuse the name. An unscoped name becomes a public package owned by the user account.
- Impact: If the name is already taken or the package must be published under organization ownership, it can fail at the last step or be published under the wrong namespace.
- Fix criteria: A human confirms `npm whoami`, the npm web UI/owner policy, whether the unpublished name can be reused, the scope, and public/restricted distribution. For an organization product, consider `@org/retail-mcp` first.
- Mitigation (T29): Adopting the scoped name `@trapa-eureka/retail-mcp` avoids the reuse uncertainty of the unscoped `retail-mcp` altogether (SPEC §18). However, confirming `npm whoami`/organization account access remains a human item — to be done in T37. **T37 result (2026-09-04)**: `npm whoami`=`shiz_son`, the `@trapa-eureka` organization does not exist → package name changed to the account scope `@shiz_son/retail-mcp` (user decision). The purpose of adopting a scope (avoiding name-reuse uncertainty) is still achieved.

## Release re-review criteria

- [x] Publish target (scope/access/registry/license) approved — `@trapa-eureka/retail-mcp`, public, MIT (SPEC §18, T29)
- [x] `private` policy, `bin`/`exports`, build output finalized (T29 — `exports` intentionally not provided)
- [x] Allowlist-based tarball content review (T29, re-confirmed via `npm pack --dry-run` at 61→63 files)
- [x] CLI/MCP runs with production dependencies only after a tarball fresh install (T29, `scripts/verifyPack.ts`)
- [ ] Confirm the automatic release gate and provenance/2FA procedure — to be done in T37 (008 8-step release gate)
