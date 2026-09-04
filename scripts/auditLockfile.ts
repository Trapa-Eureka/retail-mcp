/**
 * CLI entry point for the lockfile-based dependency audit (QA-006, TASKS T35) — run by CI on every PR.
 * The core logic (IO + verdict) is in `src/adapters/auditLockfile.ts` (so tests can verify the
 * verdict logic without running a real npm audit — same structure as `scripts/migrate.ts`).
 * The `npm audit` run is retried a limited number of times when no valid report is obtained
 * (`src/adapters/npmAudit.ts`).
 */
import { evaluateLockfileAudit, runNpmAuditJson } from "../src/adapters/auditLockfile.js";

async function main(): Promise<void> {
  const failure = evaluateLockfileAudit(await runNpmAuditJson());
  if (failure !== null) {
    console.error(failure);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
