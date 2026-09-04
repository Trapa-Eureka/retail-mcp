# 001 — T0 Adversarial Review Record

- Review date: 2026-09-02
- Target commit: `220c831` (`T0: Project scaffolding`)
- Verdict (at time of review): **Conditional failure — the common gate passes, but part of the scaffolding contract is either not executable or not enforced**
- Current status (re-confirmed 2026-09-03, in response to docs/009 DOC-005): **RESOLVED** — every item under "Re-review completion criteria" below is [x]; merged via the `fix-t0` branch (2026-09-02).
- Scope: diagnosis and recording only. No code is modified in this document.

## Verification results

```text
npm run check
Test Files  4 passed (4)
Tests       15 passed (15)
typecheck, lint, test passed
```

The current test count is as of after T1 and T2 were implemented. T0's own dummy tests were removed in T1.

## Finding 001-01 — Scripts marked complete have entry points that do not exist

- Severity: **Medium**
- Area: `package.json`, README quickstart, TASKS T0 completion scope
- Evidence:
  - `dev` runs `src/server.ts`, but the file does not currently exist.
  - `agent:reorder` runs `src/agent/reorder.ts`, but the file does not currently exist.
  - `smoke` runs `scripts/smoke.ts`, but the file does not currently exist.
  - The README states these are "valid after T0 is complete".
- Impact: A user following the quickstart for the completed T0 fails immediately with module-not-found. There is no distinction between a state where only the script names exist and executable scaffolding.
- Required action:
  1. Align the README's validity point with the actual implementation tasks (T9/T11), or
  2. Provide temporary entry points in T0 that emit a clear `not implemented` message.
  3. Distinguish "script registered" from "script executable" in TASKS.

## Finding 001-02 — Prettier is not enforced in the common gate

- Severity: **Medium**
- Area: `package.json`, T0's "Prettier" requirement
- Evidence: `format` only has the write command (`prettier --write .`); there is no `format:check`, and it is not included in `npm run check`.
- Impact: Code with broken formatting still passes the mandatory gate. The mechanical verdict for the "TS strict + ESLint + Prettier" scaffolding described in the docs is incomplete.
- Required action: Add a `prettier --check .` script and include it in `check`; manage intentionally excluded files via `.prettierignore`.

## Finding 001-03 — Environment file ignore scope stays at the bare minimum

- Severity: **Low**
- Area: `.gitignore`, secrets guardrail
- Evidence: Only `.env` is excluded; conventional variants such as `.env.local`, `.env.development`, `.env.test.local` are not excluded.
- Impact: If a developer puts a real token in a variant environment file, it can be committed by mistake.
- Required action: Exclude `.env*` and allow only `!.env.example`, or add a check that the project permits only the single `.env` file.

## Re-review completion criteria

- [x] README/TASKS contract for the non-existent entry points matches the actual state — added placeholders to `src/server.ts`/`src/agent/reorder.ts`/`scripts/smoke.ts` that print a "scheduled for T{n}" notice and return exit code 1; the README quickstart specifies when each command becomes valid
- [x] Formatting errors fail `npm run check` — `format:check` (`prettier --check .`) included in `check`. Prose documents (`*.md`) excluded via `.prettierignore` (separate from the code-formatting gate)
- [x] Confirmed the policy preventing commits of environment files other than `.env.example` — changed `.gitignore` to `.env*` + `!.env.example`
- [x] `npm run check` passes

Resolution commit: `fix-t0` branch (2026-09-02)
