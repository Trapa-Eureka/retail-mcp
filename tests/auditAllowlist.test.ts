import { describe, expect, it } from "vitest";
import {
  ACCEPTED_ADVISORY_URLS,
  checkAdvisoriesAgainstAllowlist,
  extractAdvisoryUrls,
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
