/**
 * Execution logic for the lockfile-based dependency audit (QA-006, TASKS T35).
 *
 * Used by `scripts/auditLockfile.ts` (CLI entry point for CI on every PR) — the IO
 * (`execFileSync`) and the verdict logic are separated into this adapter file so tests can verify
 * `evaluateLockfileAudit()` with pure inputs without running a real `npm audit` (same precedent as
 * `scripts/migrate.ts` ↔ `src/adapters/migrationRunner.ts`).
 *
 * The subject of inspection differs from step 5 of `scripts/verifyPack.ts` (based on the install
 * directory of the actual published tarball, release gate only, heavy) — this one is based on the
 * repository lockfile (`--omit=dev`, production dependencies only), so it is much lighter and can
 * run on every PR. T32 already demonstrated that the two baselines can differ (npm `overrides` are
 * not applied for tarball consumers), so both are kept rather than merged — a catch here means
 * right now, a catch in verifyPack means right before publishing.
 *
 * **fail-open/fail-closed policy (QA-006 fix criterion)**: if `npm audit` itself cannot run
 * (registry communication failure etc.), or it ran but the output is not a valid report format
 * (e.g. the registry returned `{"error": {...}}`), it is **fail-open** (print a warning and pass)
 * — this is an external service availability problem, not a code defect, so it alone does not
 * block a PR. **However, "could not verify" is never reported as "0 vulnerabilities"** (second
 * adversarial review SR2-AUD-002 — previously a response without the `vulnerabilities` key, such
 * as `{"error":...}`, was passed as "0" as long as it parsed). Unlike this PR convenience gate, the
 * release gate (`scripts/verifyPack.ts`) blocks the same invalid report **fail-closed**
 * (SR2-AUD-001) — the decision right before publishing must be "block until verified", not "the
 * registry may have been momentarily slow, so pass". If the audit succeeded and a new advisory
 * outside the approved list (`src/core/auditAllowlist.ts`) appears, this gate also blocks it
 * **fail-closed** without exception.
 */
import {
  ACCEPTED_ADVISORIES,
  checkAdvisoriesAgainstAllowlist,
  extractAdvisoryUrls,
  isValidAuditReport,
} from "../core/auditAllowlist.js";
import { runNpmAuditJsonWithRetry } from "./npmAudit.js";

/**
 * Runs npm audit (with limited retries if no valid report is obtained — see `npmAudit.ts`). Returns
 * null if execution itself fails all the way (registry unreachable etc.). Retries do not change the
 * policy — the fail-open verdict on an invalid result is still made by `evaluateLockfileAudit`.
 */
export function runNpmAuditJson(): Promise<string | null> {
  return runNpmAuditJsonWithRetry();
}

/**
 * Return value: a failure reason string if the gate must be blocked, null if it passes.
 * `now` is the reference time for expiry of approved exceptions (SR2-AUD-003) — tests pass a fixed
 * time, the CLI uses the default (system clock).
 */
export function evaluateLockfileAudit(
  stdout: string | null,
  now: Date = new Date(),
): string | null {
  if (stdout === null) {
    console.warn(
      "npm audit itself failed to run (presumably registry unreachable, etc.) — " +
        "this gate passes under the fail-open policy. Re-run npm audit manually to verify.",
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    console.warn(
      `npm audit output could not be parsed as JSON — this gate passes under the fail-open ` +
        `policy.\n${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (!isValidAuditReport(parsed)) {
    // SR2-AUD-002 — must not say "0 vulnerabilities" here. A malformed response (registry error
    // etc.) means "could not confirm safety", not "safe". It stays fail-open because this is a PR
    // convenience gate, but the message never claims 0 findings.
    console.warn(
      "npm audit output is not a valid vulnerability report format (presumably a registry error " +
        'response, etc.) — this gate passes under the fail-open policy, but this is NOT "0 vulnerabilities confirmed". ' +
        `Re-run npm audit manually to verify.\n${JSON.stringify(parsed).slice(0, 300)}`,
    );
    return null;
  }

  const advisoryUrls = extractAdvisoryUrls(parsed);
  const { unexpected, expired, noneFound } = checkAdvisoriesAgainstAllowlist(
    advisoryUrls,
    ACCEPTED_ADVISORIES,
    now,
  );
  if (unexpected.length > 0) {
    return (
      `New unapproved vulnerabilities were found against the lockfile: ${unexpected.join(", ")} — ` +
      "review docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md SEC-006."
    );
  }
  if (expired.length > 0) {
    // SR2-AUD-003 — approved exceptions have a review deadline and it is enforced mechanically here
    // (previously the deadline lived only in a comment and kept auto-approving after it passed).
    // This is not an external service problem but an expiry of our own decision, so it is
    // fail-closed even in the PR gate.
    return (
      "The review deadline of an approved audit exception has passed: " +
      expired.map((e) => `${e.url} (deadline ${e.expiresAt})`).join(", ") +
      " — fix at the root (upgrade/replace the dependency), or re-review, update the rationale and " +
      "extend expiresAt in src/core/auditAllowlist.ts ACCEPTED_ADVISORIES (docs/005 SEC-006)."
    );
  }
  console.log(
    noneFound
      ? "Lockfile audit passed — 0 vulnerabilities."
      : `Lockfile audit passed — only approved exceptions found (${advisoryUrls.join(", ")}).`,
  );
  return null;
}
