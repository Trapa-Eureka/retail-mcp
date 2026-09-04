/**
 * Decides "was this file executed directly" (CLI entry point vs imported module) — shared by
 * `src/server.ts` and `src/cli/onboard.ts` (TASKS T29).
 *
 * Found during the work (QA-001 tarball smoke test, `scripts/verifyPack.ts`):
 * `process.argv[1] === fileURLToPath(import.meta.url)` holds when run directly from the
 * repository with `tsx src/server.ts`, but breaks when run through the **symbolic link** npm
 * creates in `node_modules/.bin/` — `process.argv[1]` is the symlink path used for execution
 * as-is, while `import.meta.url` has already been resolved to the real path (realpath) by the
 * Node module system, so the two strings differ. As a result `main()` was never called and the
 * process silently exited immediately with code 0 — a defect that went unnoticed because there
 * was no error either. `process.argv[1]` is therefore also resolved with realpath before
 * comparing.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}
