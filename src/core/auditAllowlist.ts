/**
 * Pure logic that extracts advisory URLs from `npm audit --json` output and compares them against
 * the approved list.
 *
 * Originally lived only in `scripts/verifyPack.ts` (release gate step 5, based on the actual
 * published tarball) and was moved here in TASKS T35 (QA-006) — `scripts/auditLockfile.ts` (CI on
 * every PR, based on the dev lockfile) needed the same verdict logic. The two scripts differ in
 * **what they inspect** (one the tarball install directory, the other the repository lockfile) —
 * T32 demonstrated that npm `overrides` are not applied for tarball consumers, so they are not
 * merged into one. Only the verdict logic (advisory URL extraction + allowlist comparison) is
 * shared.
 */

export interface NpmAuditReport {
  vulnerabilities?: Record<string, { via?: unknown[] }>;
}

/**
 * Checks whether `npm audit --json` actually produced a valid vulnerability report. When the audit
 * itself could not run (registry unreachable etc.), npm emits JSON of the form `{"error": {...}}` —
 * there is no `vulnerabilities` key at all, and the old code mistook that for "0 vulnerabilities"
 * as long as it parsed (second adversarial review SR2-AUD-002 — reproduced and confirmed directly:
 * `checkAdvisoriesAgainstAllowlist(extractAdvisoryUrls({error: {...}}))` yielded
 * `noneFound: true`). A real success response always has `vulnerabilities` as an object (measured
 * on npm 11.6.2: `{ auditReportVersion, vulnerabilities, metadata }`) — if an `error` field is
 * present or `vulnerabilities` is not an object, the report is judged invalid. Callers must treat
 * an invalid verdict as "could not verify", never as "safe" (the fail-open/closed policy differs
 * per caller — see `src/adapters/auditLockfile.ts` / `scripts/verifyPack.ts`).
 */
export function isValidAuditReport(value: unknown): value is NpmAuditReport {
  if (typeof value !== "object" || value === null) return false;
  if ("error" in value) return false;
  const vulnerabilities = (value as { vulnerabilities?: unknown }).vulnerabilities;
  return typeof vulnerabilities === "object" && vulnerabilities !== null;
}

/**
 * One approved audit exception — second adversarial review SR2-AUD-003: this used to be an array of
 * URL strings and the review deadline lived **only in a comment**, so CI kept auto-approving the
 * same advisory after the deadline passed. Now the deadline (`expiresAt`) and the reason
 * (`rationale`) are data, and `checkAdvisoriesAgainstAllowlist` enforces expiry mechanically
 * against a reference time.
 */
export interface AcceptedAdvisory {
  url: string;
  /** `YYYY-MM-DD` (UTC calendar day). Considered expired from UTC 00:00 of this date — "fails starting on the expiry day itself". */
  expiresAt: string;
  rationale: string;
}

/**
 * Approved exception from SEC-006 (review 005, TASKS T32) — the `uuid@^8.3.0` pinned by
 * exceljs@4.4.0 is affected by GHSA-w5hq-g745-h8pq (bounds check flaw in uuid v3/v5/v6), but
 * exceljs only calls `uuidv4()` with no arguments and never reaches the vulnerable code path.
 */
export const ACCEPTED_ADVISORIES: readonly AcceptedAdvisory[] = [
  {
    url: "https://github.com/advisories/GHSA-w5hq-g745-h8pq",
    expiresAt: "2027-03-03",
    rationale:
      "uuid<11.1.1 via exceljs — the advisory is a bounds check flaw when passing buf to v3/v5/v6, and " +
      "exceljs only calls v4() with no arguments, so the vulnerable path is not reached (docs/005 SEC-006). " +
      "Re-check by the deadline whether exceljs has bumped its own uuid dependency — if not, revisit patching or an alternative library.",
  },
];

/** Derived list for callers that only need URLs (compatibility with the pre-structured API). */
export const ACCEPTED_ADVISORY_URLS: readonly string[] = ACCEPTED_ADVISORIES.map((a) => a.url);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Expired when `expiresAt` (UTC calendar day) is at or before the reference time `now` — fails from
 * UTC 00:00 of the expiry day. A malformed date is treated as "expired" (a typo in approval data
 * must not silently become a permanent approval).
 */
export function isAdvisoryExpired(expiresAt: string, now: Date): boolean {
  if (!ISO_DATE.test(expiresAt)) return true;
  const expiryMs = Date.parse(`${expiresAt}T00:00:00.000Z`);
  if (Number.isNaN(expiryMs)) return true;
  return now.getTime() >= expiryMs;
}

/** Extracts the set of advisory URLs from an `npm audit --json` report (for why comparison is by URL rather than package name, see checkAdvisoriesAgainstAllowlist below). */
export function extractAdvisoryUrls(report: NpmAuditReport): string[] {
  const advisoryUrls = new Set<string>();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === "object" && via !== null && "url" in via && typeof via.url === "string") {
        advisoryUrls.add(via.url);
      }
    }
  }
  return [...advisoryUrls];
}

export interface ExpiredAdvisory {
  url: string;
  expiresAt: string;
}

export interface AdvisoryCheckResult {
  /** Advisory URLs not in the approved list — even one must block the gate. */
  unexpected: string[];
  /** Advisories in the approved list whose deadline has passed as of the reference time — even one
   * must block the gate (SR2-AUD-003). Passing requires extending the deadline after review, or a root fix. */
  expired: ExpiredAdvisory[];
  /** No advisories found at all — a signal that the approved exception may no longer be needed. */
  noneFound: boolean;
}

/**
 * Compares a list of advisory URLs against the approved list. **Comparison is by advisory URL
 * (GHSA ID), not package name** — the `npm audit` result tree also lists the audited project
 * itself as an "affected" root entry (the name can differ per installing project), so comparing
 * by the advisory URL that precisely identifies the actual vulnerability is immune to accidental
 * name matches/mismatches.
 *
 * `now` is passed explicitly by the caller (CLAUDE.md implementation notes — the local machine
 * clock is never used implicitly for date verdicts) — tests pass a fixed time, the real gates pass
 * the system clock.
 */
export function checkAdvisoriesAgainstAllowlist(
  advisoryUrls: string[],
  allowlist: readonly AcceptedAdvisory[],
  now: Date,
): AdvisoryCheckResult {
  const byUrl = new Map(allowlist.map((a) => [a.url, a]));
  const unexpected: string[] = [];
  const expired: ExpiredAdvisory[] = [];
  for (const url of advisoryUrls) {
    const accepted = byUrl.get(url);
    if (accepted === undefined) {
      unexpected.push(url);
    } else if (isAdvisoryExpired(accepted.expiresAt, now)) {
      expired.push({ url, expiresAt: accepted.expiresAt });
    }
  }
  return { unexpected, expired, noneFound: advisoryUrls.length === 0 };
}
