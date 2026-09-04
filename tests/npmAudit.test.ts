/**
 * `src/adapters/npmAudit.ts` — `npm audit --json` 실행의 제한 재시도. 실제 npm도 실제 대기도 쓰지
 * 않는다(`run`/`sleep` 주입). 정책(fail-open/closed)은 호출자 몫이라 여기서는 "언제 재시도하고
 * 언제 즉시 반환하는가"만 검증한다.
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
/** 2026-09-04 CI에서 실제로 관측된 형태 — 폐기 예정 quick 엔드포인트 fallback이 400을 받은 경우. */
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
  it("첫 시도가 유효한 리포트면 재시도하지 않는다", async () => {
    const h = harness([VALID_EMPTY]);
    const out = await runNpmAuditJsonWithRetry({ ...h.options, cwd: "/tmp/x" });
    expect(out).toBe(VALID_EMPTY);
    expect(h.calls).toEqual(["/tmp/x"]);
    expect(h.sleeps).toEqual([]);
  });

  it("취약점이 있는 유효한 리포트도 진짜 답이므로 즉시 반환한다(재시도로 결과를 바꾸려 하지 않는다)", async () => {
    const h = harness([VALID_WITH_VULN, VALID_EMPTY]);
    const out = await runNpmAuditJsonWithRetry(h.options);
    expect(out).toBe(VALID_WITH_VULN);
    expect(h.calls).toHaveLength(1);
  });

  it("레지스트리 오류 응답 뒤 유효한 리포트가 오면 그걸 반환한다(관측된 CI 실패 시나리오)", async () => {
    const h = harness([REGISTRY_ERROR, VALID_EMPTY]);
    const out = await runNpmAuditJsonWithRetry({ ...h.options, baseDelayMs: 100 });
    expect(out).toBe(VALID_EMPTY);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([100]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("1/3");
  });

  it("실행 자체 실패(null)·JSON 아님·오류 JSON 전부 재시도 대상이고, 백오프는 2배씩 늘어난다", async () => {
    const h = harness([null, "not json", REGISTRY_ERROR, VALID_EMPTY]);
    const out = await runNpmAuditJsonWithRetry({ ...h.options, attempts: 4, baseDelayMs: 50 });
    expect(out).toBe(VALID_EMPTY);
    expect(h.calls).toHaveLength(4);
    expect(h.sleeps).toEqual([50, 100, 200]);
  });

  it("재시도를 다 써도 무효면 마지막 결과를 그대로 반환한다 — 정책(fail-open/closed)은 호출자가 정한다", async () => {
    const h = harness([REGISTRY_ERROR, null, REGISTRY_ERROR]);
    const out = await runNpmAuditJsonWithRetry({ ...h.options, attempts: 3, baseDelayMs: 1 });
    expect(out).toBe(REGISTRY_ERROR);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([1, 2]); // 마지막 시도 뒤에는 대기하지 않는다.
    expect(h.warnings).toHaveLength(2);
  });

  it("attempts=1이면 재시도 없이 한 번만 실행한다", async () => {
    const h = harness([null]);
    const out = await runNpmAuditJsonWithRetry({ ...h.options, attempts: 1 });
    expect(out).toBeNull();
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });
});

describe("시도당 상한 — 응답 없는 레지스트리에서 6~7분씩 기다리지 않는다(T37 후속, 2026-09-04)", () => {
  it("npm에 짧은 fetch 설정을 플래그로 넘긴다(기본값 fetch-timeout 300초·retries 2를 덮어씀)", () => {
    const args = npmAuditArgs();
    expect(args.slice(0, 3)).toEqual(["audit", "--omit=dev", "--json"]);
    for (const flag of NPM_AUDIT_FETCH_FLAGS) expect(args).toContain(flag);
    expect(args).toContain("--fetch-timeout=30000");
    expect(args).toContain("--fetch-retries=1");
    // 상한은 fetch 설정으로 계산되는 최악(≈70초)보다 커야 정상 경로를 자르지 않고, 5분(npm 기본
    // fetch-timeout 한 번)보다는 확실히 작아야 의미가 있다.
    expect(DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(70_000);
    expect(DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS).toBeLessThan(300_000);
  });

  it("프로세스가 timeoutMs 안에 끝나지 않으면 강제 종료하고 null(실행 실패)로 취급한다 — 네트워크 없음, 멈추는 node 스크립트로 재현", () => {
    const startedAt = Date.now();
    const out = runNpmAuditJsonOnce(undefined, {
      timeoutMs: 300,
      command: { file: process.execPath, args: ["-e", "setTimeout(() => {}, 10_000)"] },
    });
    const elapsed = Date.now() - startedAt;
    expect(out).toBeNull();
    expect(elapsed).toBeLessThan(5_000); // 10초짜리 스크립트가 0.3초 상한에 잘렸다.
  });

  it("상한 안에 끝나면 stdout을 그대로 돌려준다(exit code가 0이 아니어도 — npm audit는 취약점만 있어도 non-zero)", () => {
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

  it("시간 초과로 잘린 시도는 재시도 대상이다 — 다음 시도가 유효하면 그걸 반환한다", async () => {
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
  it("유효한 리포트만 true — null/비JSON/오류 JSON은 false", () => {
    expect(isValidAuditStdout(VALID_EMPTY)).toBe(true);
    expect(isValidAuditStdout(VALID_WITH_VULN)).toBe(true);
    expect(isValidAuditStdout(null)).toBe(false);
    expect(isValidAuditStdout("nope")).toBe(false);
    expect(isValidAuditStdout(REGISTRY_ERROR)).toBe(false);
  });
});
