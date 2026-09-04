import { describe, expect, it } from "vitest";
import {
  ACCEPTED_ADVISORIES,
  ACCEPTED_ADVISORY_URLS,
  checkAdvisoriesAgainstAllowlist,
  extractAdvisoryUrls,
  isAdvisoryExpired,
  isValidAuditReport,
  type AcceptedAdvisory,
  type NpmAuditReport,
} from "../src/core/auditAllowlist.js";

/** A fixed reference time clearly before the real approved exception (expires 2027-03-03) — does not depend on the real clock. */
const BEFORE_EXPIRY = new Date("2026-09-04T00:00:00.000Z");

describe("extractAdvisoryUrls", () => {
  it("extracts advisory URLs from the vulnerabilities tree without duplicates", () => {
    const report: NpmAuditReport = {
      vulnerabilities: {
        uuid: { via: [{ url: "https://github.com/advisories/GHSA-aaaa" }] },
        exceljs: {
          via: [
            { url: "https://github.com/advisories/GHSA-aaaa" },
            { url: "https://github.com/advisories/GHSA-bbbb" },
            "uuid", // via can also contain strings (direct dependency names) — must be ignored.
          ],
        },
      },
    };
    expect(extractAdvisoryUrls(report).sort()).toEqual([
      "https://github.com/advisories/GHSA-aaaa",
      "https://github.com/advisories/GHSA-bbbb",
    ]);
  });

  it("returns an empty array when vulnerabilities is absent", () => {
    expect(extractAdvisoryUrls({})).toEqual([]);
  });
});

describe("checkAdvisoriesAgainstAllowlist", () => {
  it("returns only URLs not in the approved list as unexpected", () => {
    const result = checkAdvisoriesAgainstAllowlist(
      [ACCEPTED_ADVISORY_URLS[0]!, "https://github.com/advisories/GHSA-new-one"],
      ACCEPTED_ADVISORIES,
      BEFORE_EXPIRY,
    );
    expect(result.unexpected).toEqual(["https://github.com/advisories/GHSA-new-one"]);
    expect(result.expired).toEqual([]);
    expect(result.noneFound).toBe(false);
  });

  it("unexpected and expired are empty when everything is in the approved list and before the deadline", () => {
    const result = checkAdvisoriesAgainstAllowlist(
      [ACCEPTED_ADVISORY_URLS[0]!],
      ACCEPTED_ADVISORIES,
      BEFORE_EXPIRY,
    );
    expect(result.unexpected).toEqual([]);
    expect(result.expired).toEqual([]);
  });

  it("noneFound is true when there are no advisories at all", () => {
    const result = checkAdvisoriesAgainstAllowlist([], ACCEPTED_ADVISORIES, BEFORE_EXPIRY);
    expect(result.noneFound).toBe(true);
    expect(result.unexpected).toEqual([]);
    expect(result.expired).toEqual([]);
  });

  it("judges against a custom allowlist when one is passed (by URL, not package name)", () => {
    const custom: AcceptedAdvisory[] = [
      { url: "https://github.com/advisories/GHSA-custom", expiresAt: "2030-01-01", rationale: "t" },
    ];
    const result = checkAdvisoriesAgainstAllowlist(
      ["https://github.com/advisories/GHSA-custom"],
      custom,
      BEFORE_EXPIRY,
    );
    expect(result.unexpected).toEqual([]);
  });

  describe("review deadline enforcement (second adversarial review SR2-AUD-003)", () => {
    const url = "https://github.com/advisories/GHSA-expiring";
    const allowlist: AcceptedAdvisory[] = [{ url, expiresAt: "2027-03-03", rationale: "t" }];

    it("is approved until 23:59:59Z of the day before the deadline", () => {
      const result = checkAdvisoriesAgainstAllowlist(
        [url],
        allowlist,
        new Date("2027-03-02T23:59:59.999Z"),
      );
      expect(result.expired).toEqual([]);
      expect(result.unexpected).toEqual([]);
    });

    it("is expired from UTC 00:00 of the deadline day — fails starting on the expiry day itself", () => {
      const result = checkAdvisoriesAgainstAllowlist(
        [url],
        allowlist,
        new Date("2027-03-03T00:00:00.000Z"),
      );
      expect(result.expired).toEqual([{ url, expiresAt: "2027-03-03" }]);
      // Expiry is a different category from "not in the approved list" — it is not duplicated into unexpected.
      expect(result.unexpected).toEqual([]);
    });

    it("is still expired long after the deadline (previously it lived only in a comment and was a permanent approval)", () => {
      const result = checkAdvisoriesAgainstAllowlist(
        [url],
        allowlist,
        new Date("2028-01-01T00:00:00.000Z"),
      );
      expect(result.expired).toHaveLength(1);
    });

    it("no problem when the advisory does not appear in the report even after the deadline (expiry applies only to what is actually found)", () => {
      const result = checkAdvisoriesAgainstAllowlist(
        [],
        allowlist,
        new Date("2028-01-01T00:00:00.000Z"),
      );
      expect(result.expired).toEqual([]);
      expect(result.noneFound).toBe(true);
    });

    it("the real approval data (ACCEPTED_ADVISORIES) has deadline and rationale as data and is well-formed", () => {
      expect(ACCEPTED_ADVISORIES.length).toBeGreaterThan(0);
      for (const a of ACCEPTED_ADVISORIES) {
        expect(a.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(a.rationale.length).toBeGreaterThan(0);
        // Must not be expired at a reference time before the deadline (a data typo that is already expired is caught here).
        expect(isAdvisoryExpired(a.expiresAt, BEFORE_EXPIRY)).toBe(false);
      }
    });
  });
});

describe("isAdvisoryExpired", () => {
  it("treats a malformed date as expired — a typo in approval data must not silently become a permanent approval", () => {
    expect(isAdvisoryExpired("2027/03/03", BEFORE_EXPIRY)).toBe(true);
    expect(isAdvisoryExpired("someday", BEFORE_EXPIRY)).toBe(true);
    expect(isAdvisoryExpired("", BEFORE_EXPIRY)).toBe(true);
  });

  it("compares valid dates at the UTC midnight boundary", () => {
    expect(isAdvisoryExpired("2027-03-03", new Date("2027-03-02T23:59:59.999Z"))).toBe(false);
    expect(isAdvisoryExpired("2027-03-03", new Date("2027-03-03T00:00:00.000Z"))).toBe(true);
  });
});

describe("isValidAuditReport (second adversarial review SR2-AUD-001/002, TASKS)", () => {
  it("the real npm audit success response shape (auditReportVersion/vulnerabilities/metadata) is valid", () => {
    expect(
      isValidAuditReport({
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: { vulnerabilities: { total: 0 } },
      }),
    ).toBe(true);
  });

  it("vulnerabilities alone is valid (other fields are not required)", () => {
    expect(isValidAuditReport({ vulnerabilities: {} })).toBe(true);
  });

  it("an npm registry error response ({error: ...}) is invalid — no vulnerabilities key", () => {
    expect(isValidAuditReport({ error: { code: "ENOTFOUND", summary: "..." } })).toBe(false);
  });

  it("judges invalid when an error field is present even if vulnerabilities is also there (conservatively)", () => {
    expect(isValidAuditReport({ error: {}, vulnerabilities: {} })).toBe(false);
  });

  it("invalid when vulnerabilities is not an object (string/number/null)", () => {
    expect(isValidAuditReport({ vulnerabilities: "oops" })).toBe(false);
    expect(isValidAuditReport({ vulnerabilities: null })).toBe(false);
    expect(isValidAuditReport({ vulnerabilities: 42 })).toBe(false);
  });

  it("invalid when the vulnerabilities key itself is absent", () => {
    expect(isValidAuditReport({})).toBe(false);
  });

  it("non-object values (array/string/null/undefined) are all invalid", () => {
    expect(isValidAuditReport(null)).toBe(false);
    expect(isValidAuditReport(undefined)).toBe(false);
    expect(isValidAuditReport("not an object")).toBe(false);
    expect(isValidAuditReport([])).toBe(false);
  });
});
