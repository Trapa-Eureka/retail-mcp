import { describe, expect, it } from "vitest";
import {
  ACCEPTED_ADVISORY_URLS,
  checkAdvisoriesAgainstAllowlist,
  extractAdvisoryUrls,
  isValidAuditReport,
  type NpmAuditReport,
} from "../src/core/auditAllowlist.js";

describe("extractAdvisoryUrls", () => {
  it("vulnerabilities 트리에서 advisory URL을 중복 없이 뽑는다", () => {
    const report: NpmAuditReport = {
      vulnerabilities: {
        uuid: { via: [{ url: "https://github.com/advisories/GHSA-aaaa" }] },
        exceljs: {
          via: [
            { url: "https://github.com/advisories/GHSA-aaaa" },
            { url: "https://github.com/advisories/GHSA-bbbb" },
            "uuid", // via에는 문자열(직접 의존성 이름)도 섞여 나올 수 있다 — 무시해야 한다.
          ],
        },
      },
    };
    expect(extractAdvisoryUrls(report).sort()).toEqual([
      "https://github.com/advisories/GHSA-aaaa",
      "https://github.com/advisories/GHSA-bbbb",
    ]);
  });

  it("vulnerabilities가 없으면 빈 배열을 반환한다", () => {
    expect(extractAdvisoryUrls({})).toEqual([]);
  });
});

describe("checkAdvisoriesAgainstAllowlist", () => {
  it("승인 목록에 없는 URL만 unexpected로 반환한다", () => {
    const result = checkAdvisoriesAgainstAllowlist([
      ACCEPTED_ADVISORY_URLS[0]!,
      "https://github.com/advisories/GHSA-new-one",
    ]);
    expect(result.unexpected).toEqual(["https://github.com/advisories/GHSA-new-one"]);
    expect(result.noneFound).toBe(false);
  });

  it("전부 승인 목록 안이면 unexpected가 비어 있다", () => {
    const result = checkAdvisoriesAgainstAllowlist([ACCEPTED_ADVISORY_URLS[0]!]);
    expect(result.unexpected).toEqual([]);
  });

  it("advisory가 하나도 없으면 noneFound가 true다", () => {
    const result = checkAdvisoriesAgainstAllowlist([]);
    expect(result.noneFound).toBe(true);
    expect(result.unexpected).toEqual([]);
  });

  it("커스텀 allowlist를 넘기면 그걸 기준으로 판정한다(패키지 이름이 아니라 URL 기준)", () => {
    const result = checkAdvisoriesAgainstAllowlist(
      ["https://github.com/advisories/GHSA-custom"],
      ["https://github.com/advisories/GHSA-custom"],
    );
    expect(result.unexpected).toEqual([]);
  });
});

describe("isValidAuditReport (2차 적대적 검수 SR2-AUD-001/002, TASKS)", () => {
  it("실제 npm audit 성공 응답 형태(auditReportVersion/vulnerabilities/metadata)는 유효하다", () => {
    expect(
      isValidAuditReport({
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: { vulnerabilities: { total: 0 } },
      }),
    ).toBe(true);
  });

  it("vulnerabilities만 있어도 유효하다(다른 필드는 요구하지 않음)", () => {
    expect(isValidAuditReport({ vulnerabilities: {} })).toBe(true);
  });

  it("npm 레지스트리 오류 응답({error: ...})은 무효다 — vulnerabilities 키가 없다", () => {
    expect(isValidAuditReport({ error: { code: "ENOTFOUND", summary: "..." } })).toBe(false);
  });

  it("error 필드가 있으면 vulnerabilities가 같이 있어도 무효로 판정한다(보수적으로)", () => {
    expect(isValidAuditReport({ error: {}, vulnerabilities: {} })).toBe(false);
  });

  it("vulnerabilities가 객체가 아니면(문자열/숫자/null) 무효다", () => {
    expect(isValidAuditReport({ vulnerabilities: "oops" })).toBe(false);
    expect(isValidAuditReport({ vulnerabilities: null })).toBe(false);
    expect(isValidAuditReport({ vulnerabilities: 42 })).toBe(false);
  });

  it("vulnerabilities 키 자체가 없으면 무효다", () => {
    expect(isValidAuditReport({})).toBe(false);
  });

  it("객체가 아닌 값(배열/문자열/null/undefined)은 전부 무효다", () => {
    expect(isValidAuditReport(null)).toBe(false);
    expect(isValidAuditReport(undefined)).toBe(false);
    expect(isValidAuditReport("not an object")).toBe(false);
    expect(isValidAuditReport([])).toBe(false);
  });
});
