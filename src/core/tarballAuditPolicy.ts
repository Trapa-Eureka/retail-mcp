/**
 * `npm audit` verdict for the published tarball (pure) — used by step 6 of `scripts/verifyPack.ts`.
 *
 * Background (2026-09-04, right after T37): on the same day the npm advisory endpoint went down
 * intermittently and PRs #72, #73 and #74 became unmergeable one after another. That was because
 * `verify:pack` treated "audit unavailable = failure (fail-closed)" identically in both the CI
 * `test` matrix (every PR, 4 jobs) and the actual publish path (`prepublishOnly`) — even a PR
 * fixing one line of docs had to wait for the registry to recover. The fix criterion of
 * SR2-AUD-001 was originally "**separate** the PR convenience gate from the release gate — in
 * release/T37, audit unavailability is a failure", so that separation is made into data here.
 *
 * Policy (`AuditUnavailablePolicy`):
 * - `fail` (default, actual publish path): fail when no valid report is obtained. The decision
 *   right before publishing does not let "unknown" through.
 * - `warn` (CI PR gate only, enabled explicitly by `ci.yml`): passes with a warning **only when no
 *   valid report exists**. If a report exists and shows unapproved vulnerabilities or expired
 *   exceptions, it **always fails** regardless of policy — what is relaxed is "could not verify",
 *   not "vulnerability found".
 *
 * Why this is safe: for a new vulnerability to reach publication via this path, (1) a PR must be
 * merged while the registry is down and (2) the audit in `prepublishOnly` (policy `fail`) must
 * also pass, and (2) never passes without a valid report. The lockfile-based audit job
 * (`auditLockfile.ts`) was already fail-open in the same way, so the policy is consistent within
 * the PR gate. The remaining difference is "a vulnerability in the tarball tree may be learned a
 * little later than PR merge time", and that time is bounded above by pre-publish
 * (prepublishOnly).
 */
import {
  ACCEPTED_ADVISORIES,
  checkAdvisoriesAgainstAllowlist,
  extractAdvisoryUrls,
  isValidAuditReport,
  type AcceptedAdvisory,
  type ExpiredAdvisory,
} from "./auditAllowlist.js";

export type AuditUnavailablePolicy = "fail" | "warn";

export const AUDIT_UNAVAILABLE_FLAG = "audit-unavailable";

/** Parses `--audit-unavailable=<value>` — absent means `fail` (publish-path default); an unknown value is an error (must not silently relax). */
export function parseAuditUnavailablePolicy(raw: string | undefined): AuditUnavailablePolicy {
  if (raw === undefined || raw === "fail") return "fail";
  if (raw === "warn") return "warn";
  throw new Error(
    `Invalid value for --${AUDIT_UNAVAILABLE_FLAG}: "${raw}". Only "fail" (default, publish path) or ` +
      `"warn" (CI PR gate only) is allowed.`,
  );
}

export type TarballAuditVerdict =
  /** Valid report + within the approved scope. `noneFound` signals the approved exception may no longer be needed. */
  | { kind: "pass"; noneFound: boolean }
  /** No valid report was obtained — fails (fail) or passes with a warning (warn) depending on policy. */
  | { kind: "unavailable"; reason: "no_output" | "not_json" | "invalid_report"; detail: string }
  /** Unapproved vulnerability — always fails regardless of policy. */
  | { kind: "unexpected"; urls: string[] }
  /** Review deadline of an approved exception has passed (SR2-AUD-003) — always fails regardless of policy. */
  | { kind: "expired"; expired: ExpiredAdvisory[] };

/**
 * Judges the `npm audit --json` stdout (last result after retries, null if execution failed). `now`
 * is the reference time for expiry of approved exceptions — passed explicitly by the caller
 * (CLAUDE.md: no implicit dependence on the local clock for date verdicts).
 */
export function evaluateTarballAudit(
  stdout: string | null,
  now: Date,
  allowlist: readonly AcceptedAdvisory[] = ACCEPTED_ADVISORIES,
): TarballAuditVerdict {
  if (stdout === null) {
    return {
      kind: "unavailable",
      reason: "no_output",
      detail:
        "npm audit itself failed to run even after retries (presumably registry unreachable, timeout, etc.).",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      kind: "unavailable",
      reason: "not_json",
      detail: `npm audit output could not be parsed as JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isValidAuditReport(parsed)) {
    // SR2-AUD-001/002 — an invalid response such as {"error": {...}} is not mistaken for "0 vulnerabilities".
    return {
      kind: "unavailable",
      reason: "invalid_report",
      detail:
        "npm audit output is not a valid vulnerability report format (presumably a registry error response, etc.): " +
        JSON.stringify(parsed).slice(0, 500),
    };
  }
  const { unexpected, expired, noneFound } = checkAdvisoriesAgainstAllowlist(
    extractAdvisoryUrls(parsed),
    allowlist,
    now,
  );
  if (unexpected.length > 0) return { kind: "unexpected", urls: unexpected };
  if (expired.length > 0) return { kind: "expired", expired };
  return { kind: "pass", noneFound };
}

/**
 * Verdict + policy → should the gate be blocked. Only `unavailable` is affected by policy — the rest
 * always block. The caller (verifyPack.ts) throws when this returns true and, when false (for
 * unavailable), leaves a warning.
 */
export function shouldBlock(verdict: TarballAuditVerdict, policy: AuditUnavailablePolicy): boolean {
  switch (verdict.kind) {
    case "pass":
      return false;
    case "unavailable":
      return policy === "fail";
    case "unexpected":
    case "expired":
      return true;
  }
}
