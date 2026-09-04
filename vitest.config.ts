import { defaultExclude, defineConfig } from "vitest/config";

// vitest.config.ts is plain JS re-evaluated on every run, so whether --coverage is on can be
// determined directly from process.argv (no separate env var or script change needed).
const coverageEnabled = process.argv.includes("--coverage");

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      ...defaultExclude,
      // tests/component/** is a separate suite that needs a real Postgres (QA-004, TASKS T35,
      // vitest.component.config.ts + `npm run test:pg-component` only) — explicitly excluded from
      // the default gate (guardrail 2: zero network calls in tests). skipIf would also be safe (the
      // file runs but is skipped), but excluding it so the file is never even looked at reflects the
      // intent "the default gate does not know this directory exists at all" exactly.
      "tests/component/**",
      // The wall-clock budget in performance.test.ts is fundamentally incompatible with the v8
      // coverage instrumentation overhead — confirmed after repeated real failures in CI (coverage
      // job) (6567ms/5463ms etc., TASKS T36). The performance guard itself is still enforced on
      // every PR by the uninstrumented `test` job (plain `vitest run`) — removing it here is not
      // "loosening the guard" but "measuring the guard with the right tool" (measuring a wall-clock
      // budget on an instrumented run was a wrong measurement to begin with).
      // (The budget value itself (BUDGET_MS) was also raised from 5s to 10s independently of
      // coverage — second adversarial review response, see the comment in tests/performance.test.ts.
      // The instrumentation exclusion remains valid separately from that.)
      ...(coverageEnabled ? ["tests/performance.test.ts"] : []),
    ],
    // PGlite (in-process Postgres) startup has been observed to exceed the default 5000ms in
    // CI/shared-CPU environments (especially when overlapping with --coverage's v8 instrumentation
    // overhead) — raised to a generous 20 seconds. The 50k-row performance guard itself asserts its
    // own BUDGET_MS (10 seconds) directly inside the test, independent of this value.
    testTimeout: 20_000,
    // hookTimeout is set to the same value — PGlite startup (`createTestWarehouse()`) happens inside
    // a `beforeEach` **hook** in most suites, so hookTimeout (default 10 seconds) applies rather than
    // testTimeout. When only testTimeout was raised above, the same flake remained on the hook side
    // — under local parallel load three unrelated suites failed with "Hook timed out in 10000ms"
    // (reorderAgent/mcpTools etc., all on the createTestWarehouse line) and passed when re-run in
    // isolation (observed during second adversarial review SR2-MAIL-002 work, 2026-09-04).
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      // The scope, previously core only, is widened per QA-003 (008 review, TASKS T35) — enforced
      // thresholds also on the IO boundaries that matter for publish/security (explore_sql,
      // warehouseFactory, provider, CLI entry points). src/etl and src/mocks are excluded because
      // they are orchestration/test helpers, not core pure logic.
      include: [
        "src/core/**/*.ts",
        "src/adapters/**/*.ts",
        "src/agent/**/*.ts",
        "src/mcp/**/*.ts",
        "src/cli/**/*.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      // The global thresholds (plain keys) are the floor over the whole include set, and the glob
      // keys apply individually to their subsets (both must be satisfied at the same time) — the
      // "Thresholds for utilities" pattern from the Vitest coverage.thresholds docs. The numbers are
      // the current measured values (measured in TASKS T35, 2026-09-03) with only a little slack —
      // the goal is regression prevention ("cannot drop below the current level"), not an ideal
      // target. core keeps its existing thresholds (90/90/90/85) unchanged.
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 80,
        lines: 80,
        "src/core/**/*.ts": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "src/adapters/**/*.ts": { statements: 80, branches: 65, functions: 80, lines: 85 },
        // explore_sql is the only arbitrary-SQL execution path pre-approved by guardrail 4, so it
        // gets a separate, higher bar (SEC-001/002 regression prevention, docs/005).
        "src/adapters/exploreSqlExecutor.ts": {
          statements: 90,
          branches: 80,
          functions: 95,
          lines: 90,
        },
        // The file with the db.close()/lock.release() double-failure handling (OPS-001) — a
        // regression leads to the lock silently never being released.
        "src/adapters/warehouseFactory.ts": {
          statements: 80,
          branches: 70,
          functions: 95,
          lines: 80,
        },
        // The only send adapter with the Idempotency-Key/AmbiguousSendError (OPS-004) branches.
        "src/adapters/resendProvider.ts": {
          statements: 90,
          branches: 85,
          functions: 85,
          lines: 95,
        },
        "src/agent/**/*.ts": { statements: 65, branches: 50, functions: 65, lines: 65 },
        "src/mcp/**/*.ts": { statements: 75, branches: 60, functions: 80, lines: 85 },
        "src/cli/**/*.ts": { statements: 60, branches: 55, functions: 60, lines: 55 },
      },
    },
  },
});
