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
/** 2026-09-04 CI에서 실제로 관측된 무효 응답 형태. */
const REGISTRY_ERROR = JSON.stringify({
  error: { code: "E503", summary: "audit endpoint returned an error" },
});

describe("evaluateTarballAudit — 게시 tarball audit 판정(순수)", () => {
  it("유효한 리포트 + 취약점 0건 → pass(noneFound)", () => {
    expect(evaluateTarballAudit(report([]), NOW, APPROVED)).toEqual({
      kind: "pass",
      noneFound: true,
    });
  });

  it("승인된 예외만 → pass(noneFound=false)", () => {
    expect(evaluateTarballAudit(report([APPROVED[0]!.url]), NOW, APPROVED)).toEqual({
      kind: "pass",
      noneFound: false,
    });
  });

  it("실행 실패(null)·비JSON·오류 JSON은 각각 이유가 다른 unavailable", () => {
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

  it("승인되지 않은 취약점 → unexpected(URL 포함)", () => {
    expect(
      evaluateTarballAudit(
        report([APPROVED[0]!.url, "https://github.com/advisories/GHSA-new"]),
        NOW,
        APPROVED,
      ),
    ).toEqual({ kind: "unexpected", urls: ["https://github.com/advisories/GHSA-new"] });
  });

  it("승인 예외의 기한이 지났으면 → expired(SR2-AUD-003)", () => {
    const later = new Date("2027-03-03T00:00:00Z");
    expect(evaluateTarballAudit(report([APPROVED[0]!.url]), later, APPROVED)).toEqual({
      kind: "expired",
      expired: [{ url: APPROVED[0]!.url, expiresAt: "2027-03-03" }],
    });
  });
});

describe("shouldBlock — 정책은 unavailable에만 영향(PR gate warn / 게시 경로 fail)", () => {
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

  it("fail 정책(게시 경로): unavailable도 막는다", () => {
    expect(shouldBlock(unavailable, "fail")).toBe(true);
  });

  it("warn 정책(PR gate): unavailable은 통과시키지만 취약점 발견·기한 경과는 여전히 막는다", () => {
    expect(shouldBlock(unavailable, "warn")).toBe(false);
    expect(shouldBlock(unexpected, "warn")).toBe(true);
    expect(shouldBlock(expired, "warn")).toBe(true);
  });

  it("pass는 어느 정책에서도 막지 않는다", () => {
    expect(shouldBlock(pass, "fail")).toBe(false);
    expect(shouldBlock(pass, "warn")).toBe(false);
  });
});

describe("parseAuditUnavailablePolicy — 기본은 fail, 모르는 값은 조용히 완화하지 않는다", () => {
  it("없으면 fail, 'fail'/'warn'은 그대로", () => {
    expect(parseAuditUnavailablePolicy(undefined)).toBe("fail");
    expect(parseAuditUnavailablePolicy("fail")).toBe("fail");
    expect(parseAuditUnavailablePolicy("warn")).toBe("warn");
  });

  it("알 수 없는 값은 원인+허용값이 담긴 에러", () => {
    expect(() => parseAuditUnavailablePolicy("skip")).toThrow(/올바르지 않습니다.*"fail".*"warn"/);
  });
});
