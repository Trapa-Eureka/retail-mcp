/**
 * `npm audit --json` 실행 + 제한 재시도 — `src/adapters/auditLockfile.ts`(CI 매 PR, lockfile
 * 기준)와 `scripts/verifyPack.ts`(release gate, 실제 게시 tarball 기준)가 공유한다.
 *
 * 왜 재시도가 필요한가(2026-09-04, SR2-AUD-003 PR #61의 CI에서 관측): Node 22 러너의 npm
 * 10.9.8이 bulk advisory 요청에 실패하면 폐기 예정인 `/-/npm/v1/security/audits/quick`으로
 * fallback하고, 레지스트리가 그 요청을 `400 Bad Request` + `npm-notice: This endpoint is being
 * retired`로 거절한다. 그 결과 `npm audit`은 `{"error": ...}`를 내거나 아무 리포트도 내지 못한다.
 * SR2-AUD-001/002가 이걸 "확인 불가"로 올바르게 판정하지만(release gate는 fail-closed), 같은
 * 워크플로에서 세 번 중 두 번이 이 이유로 재실행돼야 했다 — 코드 결함이 아니라 외부
 * 레지스트리의 일시 상태다. 그래서 **유효한 리포트를 얻지 못한 경우에만** 짧은 지수 백오프로
 * 몇 번 더 시도한다. 유효한 리포트(취약점이 있든 없든)는 진짜 답이므로 즉시 반환하고 절대
 * 재시도하지 않는다. 재시도를 다 써도 무효면 마지막 결과를 그대로 돌려줘 호출자의 기존
 * fail-open(PR 게이트)/fail-closed(release gate) 정책이 그대로 적용된다 — 이 모듈은 정책을
 * 바꾸지 않고 일시 실패만 흡수한다.
 *
 * `run`/`sleep`은 주입 가능하다 — 테스트는 실제 npm도 실제 대기도 쓰지 않는다(가드레일 2).
 */
import { execFileSync } from "node:child_process";
import { isValidAuditReport } from "../core/auditAllowlist.js";

export interface NpmAuditRunOptions {
  /** `npm audit`를 실행할 디렉터리. 기본값: 현재 작업 디렉터리. */
  cwd?: string;
  /** 총 시도 횟수(첫 시도 포함). 기본 3. */
  attempts?: number;
  /** 첫 재시도 전 대기(ms). 이후 시도마다 2배. 기본 2000. */
  baseDelayMs?: number;
  /** 테스트 주입용 — `npm audit --omit=dev --json`의 stdout, 실행 자체가 실패하면 null. */
  run?: (cwd: string | undefined) => string | null;
  /** 테스트 주입용 — 기본값: setTimeout 기반 대기. */
  sleep?: (ms: number) => Promise<void>;
  /** 재시도 사이의 경고 출력. 기본값: console.warn. */
  warn?: (message: string) => void;
}

/** npm audit를 한 번 실행한다. 실행 자체가 실패하면(레지스트리 접근 불가 등) null을 반환한다. */
export function runNpmAuditJsonOnce(cwd: string | undefined): string | null {
  try {
    return execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      encoding: "utf8",
      ...(cwd !== undefined ? { cwd } : {}),
    });
  } catch (err) {
    // npm audit는 취약점이 발견되기만 해도 0이 아닌 종료 코드로 끝난다 — 그 경우엔 JSON
    // 리포트 자체가 stdout에 담겨 있다(진짜 실행 실패와 구분해야 한다).
    const withStdout = err as { stdout?: unknown };
    if (typeof withStdout.stdout === "string" && withStdout.stdout.trim().length > 0) {
      return withStdout.stdout;
    }
    return null;
  }
}

/** stdout이 파싱되고 유효한 취약점 리포트 형식(`isValidAuditReport`)인지 — 재시도 여부의 유일한 기준. */
export function isValidAuditStdout(stdout: string | null): boolean {
  if (stdout === null) return false;
  try {
    return isValidAuditReport(JSON.parse(stdout));
  } catch {
    return false;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 유효한 리포트를 얻을 때까지 최대 `attempts`번 시도한다. 반환값은 마지막 시도의 stdout(또는
 * null) — 유효성 판정과 그에 따른 정책은 호출자 몫이다.
 */
export async function runNpmAuditJsonWithRetry(
  options: NpmAuditRunOptions = {},
): Promise<string | null> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const run = options.run ?? runNpmAuditJsonOnce;
  const sleep = options.sleep ?? defaultSleep;
  const warn = options.warn ?? ((message: string): void => console.warn(message));

  let last: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = run(options.cwd);
    if (isValidAuditStdout(last)) return last;
    if (attempt < attempts) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      warn(
        `[npm audit] ${attempt}/${attempts}번째 시도가 유효한 리포트를 내지 못했습니다` +
          `(레지스트리 일시 오류로 추정 — 폐기 예정 quick 엔드포인트 fallback 등). ${delay}ms 후 재시도합니다.`,
      );
      await sleep(delay);
    }
  }
  return last;
}
