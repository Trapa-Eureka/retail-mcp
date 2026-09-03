import { describe, expect, it, vi } from "vitest";
import { ACCEPTED_ADVISORY_URLS } from "../src/core/auditAllowlist.js";
import { evaluateLockfileAudit } from "../src/adapters/auditLockfile.js";

describe("evaluateLockfileAudit — fail-open/fail-closed 정책(QA-006, TASKS T35)", () => {
  it("stdout이 null이면(npm audit 실행 자체 실패) fail-open — 통과(null) 처리한다", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(evaluateLockfileAudit(null)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fail-open"));
    warnSpy.mockRestore();
  });

  it("stdout이 JSON이 아니면 fail-open — 통과(null) 처리한다", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(evaluateLockfileAudit("이건 JSON이 아닙니다")).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("취약점이 하나도 없으면 통과(null)한다", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(evaluateLockfileAudit(JSON.stringify({ vulnerabilities: {} }))).toBeNull();
    logSpy.mockRestore();
  });

  it("승인 목록 안의 advisory만 있으면 통과(null)한다", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const report = {
      vulnerabilities: { uuid: { via: [{ url: ACCEPTED_ADVISORY_URLS[0] }] } },
    };
    expect(evaluateLockfileAudit(JSON.stringify(report))).toBeNull();
    logSpy.mockRestore();
  });

  it("승인 목록 밖의 새 advisory가 있으면 fail-closed — 사유 문자열을 반환한다", () => {
    const report = {
      vulnerabilities: {
        "some-pkg": { via: [{ url: "https://github.com/advisories/GHSA-new-unapproved" }] },
      },
    };
    const failure = evaluateLockfileAudit(JSON.stringify(report));
    expect(failure).not.toBeNull();
    expect(failure).toContain("GHSA-new-unapproved");
  });
});
