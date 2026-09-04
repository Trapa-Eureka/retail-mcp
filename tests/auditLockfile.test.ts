import { describe, expect, it, vi } from "vitest";
import { ACCEPTED_ADVISORIES, ACCEPTED_ADVISORY_URLS } from "../src/core/auditAllowlist.js";
import { evaluateLockfileAudit } from "../src/adapters/auditLockfile.js";

/** 실제 승인 예외(2027-03-03 만료)보다 확실히 이전인 고정 기준 시각 — 실제 시계에 의존하지 않는다. */
const BEFORE_EXPIRY = new Date("2026-09-04T00:00:00.000Z");

describe("evaluateLockfileAudit — fail-open/fail-closed 정책(QA-006, TASKS T35)", () => {
  it("stdout이 null이면(npm audit 실행 자체 실패) fail-open — 통과(null) 처리한다", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(evaluateLockfileAudit(null, BEFORE_EXPIRY)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fail-open"));
    warnSpy.mockRestore();
  });

  it("stdout이 JSON이 아니면 fail-open — 통과(null) 처리한다", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(evaluateLockfileAudit("이건 JSON이 아닙니다", BEFORE_EXPIRY)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("취약점이 하나도 없으면 통과(null)한다", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      evaluateLockfileAudit(JSON.stringify({ vulnerabilities: {} }), BEFORE_EXPIRY),
    ).toBeNull();
    logSpy.mockRestore();
  });

  it("승인 목록 안의 advisory만 있고 기한 전이면 통과(null)한다", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const report = {
      vulnerabilities: { uuid: { via: [{ url: ACCEPTED_ADVISORY_URLS[0] }] } },
    };
    expect(evaluateLockfileAudit(JSON.stringify(report), BEFORE_EXPIRY)).toBeNull();
    logSpy.mockRestore();
  });

  it("승인 목록 밖의 새 advisory가 있으면 fail-closed — 사유 문자열을 반환한다", () => {
    const report = {
      vulnerabilities: {
        "some-pkg": { via: [{ url: "https://github.com/advisories/GHSA-new-unapproved" }] },
      },
    };
    const failure = evaluateLockfileAudit(JSON.stringify(report), BEFORE_EXPIRY);
    expect(failure).not.toBeNull();
    expect(failure).toContain("GHSA-new-unapproved");
  });

  describe("승인 예외 재검토 기한 집행 — 2차 적대적 검수 SR2-AUD-003", () => {
    const accepted = ACCEPTED_ADVISORIES[0]!;
    const report = JSON.stringify({
      vulnerabilities: { uuid: { via: [{ url: accepted.url }] } },
    });

    it("기한이 지난 승인 예외가 리포트에 나오면 PR 게이트도 fail-closed — 기한과 조치를 담은 사유를 반환한다", () => {
      const dayOfExpiry = new Date(`${accepted.expiresAt}T00:00:00.000Z`);
      const failure = evaluateLockfileAudit(report, dayOfExpiry);
      expect(failure).not.toBeNull();
      expect(failure).toContain("재검토 기한이 지났습니다");
      expect(failure).toContain(accepted.url);
      expect(failure).toContain(accepted.expiresAt);
      expect(failure).toContain("expiresAt");
    });

    it("기한 전날까지는 같은 리포트가 통과한다(경계 확인)", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const dayBefore = new Date(new Date(`${accepted.expiresAt}T00:00:00.000Z`).getTime() - 1);
      expect(evaluateLockfileAudit(report, dayBefore)).toBeNull();
      logSpy.mockRestore();
    });
  });

  describe("무효 리포트(레지스트리 오류 등) — 2차 적대적 검수 SR2-AUD-002 회귀", () => {
    it("npm 레지스트리 오류 응답({error: ...})은 fail-open으로 통과하되 '0건'이라고 말하지 않는다", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorResponse = JSON.stringify({
        error: { code: "ENOTFOUND", summary: "registry unreachable" },
      });

      expect(evaluateLockfileAudit(errorResponse, BEFORE_EXPIRY)).toBeNull();
      // 예전엔 이 케이스가 "취약점 0건" 로그를 남겼다(SR2-AUD-002) — 이제는 절대 그렇게
      // 말하지 않아야 한다.
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("0건"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("유효한 취약점 리포트"));

      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("vulnerabilities가 객체가 아니면(형식 이상) fail-open으로 통과하되 '0건'이라고 말하지 않는다", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      expect(
        evaluateLockfileAudit(JSON.stringify({ vulnerabilities: "oops" }), BEFORE_EXPIRY),
      ).toBeNull();
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("0건"));
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
      logSpy.mockRestore();
    });
  });
});
