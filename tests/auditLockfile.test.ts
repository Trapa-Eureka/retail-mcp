import { describe, expect, it, vi } from "vitest";
import { ACCEPTED_ADVISORIES, ACCEPTED_ADVISORY_URLS } from "../src/core/auditAllowlist.js";
import { evaluateLockfileAudit } from "../src/adapters/auditLockfile.js";

/** A fixed reference time clearly before the real approved exception (expires 2027-03-03) — does not depend on the real clock. */
const BEFORE_EXPIRY = new Date("2026-09-04T00:00:00.000Z");

describe("evaluateLockfileAudit — fail-open/fail-closed policy (QA-006, TASKS T35)", () => {
  it("fail-open when stdout is null (npm audit itself failed to run) — treated as pass (null)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(evaluateLockfileAudit(null, BEFORE_EXPIRY)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fail-open"));
    warnSpy.mockRestore();
  });

  it("fail-open when stdout is not JSON — treated as pass (null)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(evaluateLockfileAudit("this is not JSON", BEFORE_EXPIRY)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("passes (null) when there are no vulnerabilities at all", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      evaluateLockfileAudit(JSON.stringify({ vulnerabilities: {} }), BEFORE_EXPIRY),
    ).toBeNull();
    logSpy.mockRestore();
  });

  it("passes (null) when only advisories in the approved list are present and before the deadline", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const report = {
      vulnerabilities: { uuid: { via: [{ url: ACCEPTED_ADVISORY_URLS[0] }] } },
    };
    expect(evaluateLockfileAudit(JSON.stringify(report), BEFORE_EXPIRY)).toBeNull();
    logSpy.mockRestore();
  });

  it("fail-closed when a new advisory outside the approved list is present — returns a reason string", () => {
    const report = {
      vulnerabilities: {
        "some-pkg": { via: [{ url: "https://github.com/advisories/GHSA-new-unapproved" }] },
      },
    };
    const failure = evaluateLockfileAudit(JSON.stringify(report), BEFORE_EXPIRY);
    expect(failure).not.toBeNull();
    expect(failure).toContain("GHSA-new-unapproved");
  });

  describe("approved exception review deadline enforcement — second adversarial review SR2-AUD-003", () => {
    const accepted = ACCEPTED_ADVISORIES[0]!;
    const report = JSON.stringify({
      vulnerabilities: { uuid: { via: [{ url: accepted.url }] } },
    });

    it("the PR gate is also fail-closed when an expired approved exception appears in the report — returns a reason with the deadline and the action", () => {
      const dayOfExpiry = new Date(`${accepted.expiresAt}T00:00:00.000Z`);
      const failure = evaluateLockfileAudit(report, dayOfExpiry);
      expect(failure).not.toBeNull();
      expect(failure).toContain("review deadline of an approved audit exception has passed");
      expect(failure).toContain(accepted.url);
      expect(failure).toContain(accepted.expiresAt);
      expect(failure).toContain("expiresAt");
    });

    it("the same report passes until the day before the deadline (boundary check)", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const dayBefore = new Date(new Date(`${accepted.expiresAt}T00:00:00.000Z`).getTime() - 1);
      expect(evaluateLockfileAudit(report, dayBefore)).toBeNull();
      logSpy.mockRestore();
    });
  });

  describe("invalid report (registry error etc.) — second adversarial review SR2-AUD-002 regression", () => {
    it("an npm registry error response ({error: ...}) passes fail-open but does not say '0 vulnerabilities'", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorResponse = JSON.stringify({
        error: { code: "ENOTFOUND", summary: "registry unreachable" },
      });

      expect(evaluateLockfileAudit(errorResponse, BEFORE_EXPIRY)).toBeNull();
      // Previously this case logged "0 vulnerabilities" (SR2-AUD-002) — it must never say that now.
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("0 vulnerabilities"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("valid vulnerability report"));

      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("passes fail-open when vulnerabilities is not an object (malformed) but does not say '0 vulnerabilities'", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      expect(
        evaluateLockfileAudit(JSON.stringify({ vulnerabilities: "oops" }), BEFORE_EXPIRY),
      ).toBeNull();
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("0 vulnerabilities"));
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
      logSpy.mockRestore();
    });
  });
});
