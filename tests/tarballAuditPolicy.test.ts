import { describe, expect, it } from "vitest";
import type { AcceptedAdvisory } from "../src/core/auditAllowlist.js";
import {
  evaluateTarballAudit,
  parseAuditUnavailablePolicy,
  shouldBlock,
} from "../src/core/tarballAuditPolicy.js";

const NOW = new Date("2026-09-04T00:00:00Z");
const APPROVED: AcceptedAdvisory[] = [
  { url: "https://github.com/advisories/GHSA-approved", expiresAt: "2027-03-03", rationale: "t" },
];
const report = (urls: string[]): string =>
  JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(urls.map((url, i) => [`pkg${i}`, { via: [{ url }] }])),
    metadata: {},
  });
/** The invalid response shape actually observed in CI on 2026-09-04. */
const REGISTRY_ERROR = JSON.stringify({
  error: { code: "E503", summary: "audit endpoint returned an error" },
});

describe("evaluateTarballAudit — published tarball audit verdict (pure)", () => {
  it("valid report + 0 vulnerabilities → pass (noneFound)", () => {
    expect(evaluateTarballAudit(report([]), NOW, APPROVED)).toEqual({
      kind: "pass",
      noneFound: true,
    });
  });

  it("only approved exceptions → pass (noneFound=false)", () => {
    expect(evaluateTarballAudit(report([APPROVED[0]!.url]), NOW, APPROVED)).toEqual({
      kind: "pass",
      noneFound: false,
    });
  });

  it("execution failure (null), non-JSON and error JSON are each unavailable with a different reason", () => {
    expect(evaluateTarballAudit(null, NOW, APPROVED)).toMatchObject({
      kind: "unavailable",
      reason: "no_output",
    });
    expect(evaluateTarballAudit("nope", NOW, APPROVED)).toMatchObject({
      kind: "unavailable",
      reason: "not_json",
    });
    expect(evaluateTarballAudit(REGISTRY_ERROR, NOW, APPROVED)).toMatchObject({
      kind: "unavailable",
      reason: "invalid_report",
    });
  });

  it("unapproved vulnerability → unexpected (with URL)", () => {
    expect(
      evaluateTarballAudit(
        report([APPROVED[0]!.url, "https://github.com/advisories/GHSA-new"]),
        NOW,
        APPROVED,
      ),
    ).toEqual({ kind: "unexpected", urls: ["https://github.com/advisories/GHSA-new"] });
  });

  it("approved exception past its deadline → expired (SR2-AUD-003)", () => {
    const later = new Date("2027-03-03T00:00:00Z");
    expect(evaluateTarballAudit(report([APPROVED[0]!.url]), later, APPROVED)).toEqual({
      kind: "expired",
      expired: [{ url: APPROVED[0]!.url, expiresAt: "2027-03-03" }],
    });
  });
});

describe("shouldBlock — policy affects only unavailable (PR gate warn / publish path fail)", () => {
  const unavailable = evaluateTarballAudit(null, NOW, APPROVED);
  const unexpected = evaluateTarballAudit(
    report(["https://github.com/advisories/GHSA-x"]),
    NOW,
    APPROVED,
  );
  const expired = evaluateTarballAudit(
    report([APPROVED[0]!.url]),
    new Date("2028-01-01T00:00:00Z"),
    APPROVED,
  );
  const pass = evaluateTarballAudit(report([]), NOW, APPROVED);

  it("fail policy (publish path): blocks unavailable too", () => {
    expect(shouldBlock(unavailable, "fail")).toBe(true);
  });

  it("warn policy (PR gate): lets unavailable through but still blocks found vulnerabilities and expired exceptions", () => {
    expect(shouldBlock(unavailable, "warn")).toBe(false);
    expect(shouldBlock(unexpected, "warn")).toBe(true);
    expect(shouldBlock(expired, "warn")).toBe(true);
  });

  it("pass is never blocked under any policy", () => {
    expect(shouldBlock(pass, "fail")).toBe(false);
    expect(shouldBlock(pass, "warn")).toBe(false);
  });
});

describe("parseAuditUnavailablePolicy — default is fail, unknown values are not silently relaxed", () => {
  it("absent means fail; 'fail'/'warn' as-is", () => {
    expect(parseAuditUnavailablePolicy(undefined)).toBe("fail");
    expect(parseAuditUnavailablePolicy("fail")).toBe("fail");
    expect(parseAuditUnavailablePolicy("warn")).toBe("warn");
  });

  it("an unknown value is an error containing the cause and the allowed values", () => {
    expect(() => parseAuditUnavailablePolicy("skip")).toThrow(/Invalid value.*"fail".*"warn"/);
  });
});
