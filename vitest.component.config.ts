import { defineConfig } from "vitest/config";

/**
 * Configuration dedicated to the real-Postgres component tests (QA-004, TASKS T35) — deliberately
 * separated from `vitest.config.ts` (the default gate, `tests/**`, guardrail 2: zero network calls).
 * It only looks at `tests/component/**`, so `npm run test`/`npm run check` do not even know this
 * file exists — it runs only via `npm run test:pg-component` (CI only, requires TEST_DATABASE_URL).
 */
export default defineConfig({
  test: {
    include: ["tests/component/**/*.test.ts"],
    // pg_sleep-based timeout tests are mixed with real network round trips, so allow more headroom than the default 20 seconds.
    testTimeout: 30_000,
    // coverage is measured only in the default gate (vitest.config.ts) — not a target here.
    coverage: { enabled: false },
  },
});
