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

/** 실제 승인 예외(2027-03-03 만료)보다 확실히 이전인 고정 기준 시각 — 실제 시계에 의존하지 않는다. */
const BEFORE_EXPIRY = new Date("2026-09-04T00:00:00.000Z");

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
    const result = checkAdvisoriesAgainstAllowlist(
      [ACCEPTED_ADVISORY_URLS[0]!, "https://github.com/advisories/GHSA-new-one"],
      ACCEPTED_ADVISORIES,
      BEFORE_EXPIRY,
    );
    expect(result.unexpected).toEqual(["https://github.com/advisories/GHSA-new-one"]);
    expect(result.expired).toEqual([]);
    expect(result.noneFound).toBe(false);
  });

  it("전부 승인 목록 안이고 기한 전이면 unexpected·expired가 비어 있다", () => {
    const result = checkAdvisoriesAgainstAllowlist(
      [ACCEPTED_ADVISORY_URLS[0]!],
      ACCEPTED_ADVISORIES,
      BEFORE_EXPIRY,
    );
    expect(result.unexpected).toEqual([]);
    expect(result.expired).toEqual([]);
  });

  it("advisory가 하나도 없으면 noneFound가 true다", () => {
    const result = checkAdvisoriesAgainstAllowlist([], ACCEPTED_ADVISORIES, BEFORE_EXPIRY);
    expect(result.noneFound).toBe(true);
    expect(result.unexpected).toEqual([]);
    expect(result.expired).toEqual([]);
  });

  it("커스텀 allowlist를 넘기면 그걸 기준으로 판정한다(패키지 이름이 아니라 URL 기준)", () => {
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

  describe("재검토 기한 집행(2차 적대적 검수 SR2-AUD-003)", () => {
    const url = "https://github.com/advisories/GHSA-expiring";
    const allowlist: AcceptedAdvisory[] = [{ url, expiresAt: "2027-03-03", rationale: "t" }];

    it("기한 전날 23:59:59Z까지는 승인이다", () => {
      const result = checkAdvisoriesAgainstAllowlist(
        [url],
        allowlist,
        new Date("2027-03-02T23:59:59.999Z"),
      );
      expect(result.expired).toEqual([]);
      expect(result.unexpected).toEqual([]);
    });

    it("기한 당일 UTC 00:00부터 expired다 — 만료일 당일부터 실패", () => {
      const result = checkAdvisoriesAgainstAllowlist(
        [url],
        allowlist,
        new Date("2027-03-03T00:00:00.000Z"),
      );
      expect(result.expired).toEqual([{ url, expiresAt: "2027-03-03" }]);
      // 만료는 "승인 목록에 없음"과 다른 카테고리다 — unexpected에 중복으로 들어가지 않는다.
      expect(result.unexpected).toEqual([]);
    });

    it("기한이 한참 지나도 expired다(예전엔 주석에만 있어 영구 승인이었다)", () => {
      const result = checkAdvisoriesAgainstAllowlist(
        [url],
        allowlist,
        new Date("2028-01-01T00:00:00.000Z"),
      );
      expect(result.expired).toHaveLength(1);
    });

    it("리포트에 그 advisory가 안 나오면 기한이 지났어도 아무 문제 없다(만료는 실제 발견된 것에만 적용)", () => {
      const result = checkAdvisoriesAgainstAllowlist(
        [],
        allowlist,
        new Date("2028-01-01T00:00:00.000Z"),
      );
      expect(result.expired).toEqual([]);
      expect(result.noneFound).toBe(true);
    });

    it("실제 승인 데이터(ACCEPTED_ADVISORIES)는 기한·근거를 데이터로 갖고 있고 형식이 유효하다", () => {
      expect(ACCEPTED_ADVISORIES.length).toBeGreaterThan(0);
      for (const a of ACCEPTED_ADVISORIES) {
        expect(a.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(a.rationale.length).toBeGreaterThan(0);
        // 기한 전 기준 시각으로는 만료가 아니어야 한다(데이터 오타로 이미 만료 상태면 여기서 잡힌다).
        expect(isAdvisoryExpired(a.expiresAt, BEFORE_EXPIRY)).toBe(false);
      }
    });
  });
});

describe("isAdvisoryExpired", () => {
  it("형식이 잘못된 날짜는 만료로 취급한다 — 승인 데이터 오타가 조용히 영구 승인이 되면 안 된다", () => {
    expect(isAdvisoryExpired("2027/03/03", BEFORE_EXPIRY)).toBe(true);
    expect(isAdvisoryExpired("언젠가", BEFORE_EXPIRY)).toBe(true);
    expect(isAdvisoryExpired("", BEFORE_EXPIRY)).toBe(true);
  });

  it("유효한 날짜는 UTC 자정 경계로 비교한다", () => {
    expect(isAdvisoryExpired("2027-03-03", new Date("2027-03-02T23:59:59.999Z"))).toBe(false);
    expect(isAdvisoryExpired("2027-03-03", new Date("2027-03-03T00:00:00.000Z"))).toBe(true);
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
