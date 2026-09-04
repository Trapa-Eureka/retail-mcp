/**
 * `src/adapters/npmAudit.ts` — limited retries of the `npm audit --json` run. Uses neither the real
 * npm nor real waiting (`run`/`sleep` injected). Policy (fail-open/closed) is the caller's job, so
 * only "when to retry and when to return immediately" is verified here.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS,
  isValidAuditStdout,
  NPM_AUDIT_FETCH_FLAGS,
  npmAuditArgs,
  runNpmAuditJsonOnce,
  runNpmAuditJsonWithRetry,
} from "../src/adapters/npmAudit.js";

const VALID_EMPTY = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} });
const VALID_WITH_VULN = JSON.stringify({
  vulnerabilities: { uuid: { via: [{ url: "https://github.com/advisories/GHSA-x" }] } },
});
/** The shape actually observed in CI on 2026-09-04 — the deprecated quick endpoint fallback received a 400. */
const REGISTRY_ERROR = JSON.stringify({
  error: {
    code: "E400",
    summary: "400 Bad Request - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick",
  },
});

function harness(sequence: (string | null)[]) {
  const calls: (string | undefined)[] = [];
  const sleeps: number[] = [];
  const warnings: string[] = [];
  let i = 0;
  return {
    calls,
    sleeps,
    warnings,
    options: {
      run: (cwd: string | undefined) => {
        calls.push(cwd);
        const next = sequence[i] ?? null;
        i++;
        return next;
      },
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      warn: (m: string) => {
        warnings.push(m);
      },
    },
  };
}

describe("runNpmAuditJsonWithRetry", () => {
  it("does not retry when the first attempt is a valid report", async () => {
    const h = harness([VALID_EMPTY]);
    const out = await runNpmAuditJsonWithRetry({ ...h.options, cwd: "/tmp/x" });
    expect(out).toBe(VALID_EMPTY);
    expect(h.calls).toEqual(["/tmp/x"]);
    expect(h.sleeps).toEqual([]);
  });

  it("a valid report with vulnerabilities is also the real answer and is returned immediately (no attempt to change the result by retrying)", async () => {
    const h = harness([VALID_WITH_VULN, VALID_EMPTY]);
    const out = await runNpmAuditJsonWithRetry(h.options);
    expect(out).toBe(VALID_WITH_VULN);
    expect(h.calls).toHaveLength(1);
  });

  it("returns the valid report that follows a registry error response (the observed CI failure scenario)", async () => {
    const h = harness([REGISTRY_ERROR, VALID_EMPTY]);
    const out = await runNpmAuditJsonWithRetry({ ...h.options, baseDelayMs: 100 });
    expect(out).toBe(VALID_EMPTY);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([100]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("1/3");
  });

  it("execution failure (null), non-JSON and error JSON are all retry candidates, and the backoff doubles", async () => {
    const h = harness([null, "not json", REGISTRY_ERROR, VALID_EMPTY]);
    const out = await runNpmAuditJsonWithRetry({ ...h.options, attempts: 4, baseDelayMs: 50 });
    expect(out).toBe(VALID_EMPTY);
    expect(h.calls).toHaveLength(4);
    expect(h.sleeps).toEqual([50, 100, 200]);
  });

  it("returns the last result as-is when still invalid after all retries — the policy (fail-open/closed) is decided by the caller", async () => {
    const h = harness([REGISTRY_ERROR, null, REGISTRY_ERROR]);
    const out = await runNpmAuditJsonWithRetry({ ...h.options, attempts: 3, baseDelayMs: 1 });
    expect(out).toBe(REGISTRY_ERROR);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([1, 2]); // No wait after the last attempt.
    expect(h.warnings).toHaveLength(2);
  });

  it("attempts=1 runs exactly once without retrying", async () => {
    const h = harness([null]);
    const out = await runNpmAuditJsonWithRetry({ ...h.options, attempts: 1 });
    expect(out).toBeNull();
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });
});

describe("per-attempt cap — no 6-7 minute waits on an unresponsive registry (T37 follow-up, 2026-09-04)", () => {
  it("passes short fetch settings to npm as flags (overriding the defaults fetch-timeout 300 s / retries 2)", () => {
    const args = npmAuditArgs();
    expect(args.slice(0, 3)).toEqual(["audit", "--omit=dev", "--json"]);
    for (const flag of NPM_AUDIT_FETCH_FLAGS) expect(args).toContain(flag);
    expect(args).toContain("--fetch-timeout=30000");
    expect(args).toContain("--fetch-retries=1");
    // The cap must exceed the worst case computed from the fetch settings (≈70 s) so the normal path
    // is not cut, and be clearly below 5 minutes (one npm default fetch-timeout) to be meaningful.
    expect(DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(70_000);
    expect(DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS).toBeLessThan(300_000);
  });

  it("force-kills a process that does not finish within timeoutMs and treats it as null (execution failure) — no network, reproduced with a hanging node script", () => {
    const startedAt = Date.now();
    const out = runNpmAuditJsonOnce(undefined, {
      timeoutMs: 300,
      command: { file: process.execPath, args: ["-e", "setTimeout(() => {}, 10_000)"] },
    });
    const elapsed = Date.now() - startedAt;
    expect(out).toBeNull();
    expect(elapsed).toBeLessThan(5_000); // The 10-second script was cut at the 0.3-second cap.
  });

  it("returns stdout as-is when it finishes within the cap (even with a non-zero exit code — npm audit is non-zero merely when vulnerabilities exist)", () => {
    const out = runNpmAuditJsonOnce(undefined, {
      timeoutMs: 5_000,
      command: {
        file: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({vulnerabilities:{}})); process.exit(1)"],
      },
    });
    expect(out).toBe('{"vulnerabilities":{}}');
    expect(isValidAuditStdout(out)).toBe(true);
  });

  it("an attempt cut by timeout is a retry candidate — returns the next attempt if it is valid", async () => {
    let i = 0;
    const out = await runNpmAuditJsonWithRetry({
      attempts: 2,
      baseDelayMs: 1,
      sleep: () => Promise.resolve(),
      warn: () => {},
      run: () =>
        i++ === 0
          ? runNpmAuditJsonOnce(undefined, {
              timeoutMs: 200,
              command: { file: process.execPath, args: ["-e", "setTimeout(() => {}, 10_000)"] },
            })
          : VALID_EMPTY,
    });
    expect(out).toBe(VALID_EMPTY);
    expect(i).toBe(2);
  });
});

describe("isValidAuditStdout", () => {
  it("only a valid report is true — null/non-JSON/error JSON are false", () => {
    expect(isValidAuditStdout(VALID_EMPTY)).toBe(true);
    expect(isValidAuditStdout(VALID_WITH_VULN)).toBe(true);
    expect(isValidAuditStdout(null)).toBe(false);
    expect(isValidAuditStdout("nope")).toBe(false);
    expect(isValidAuditStdout(REGISTRY_ERROR)).toBe(false);
  });
});
