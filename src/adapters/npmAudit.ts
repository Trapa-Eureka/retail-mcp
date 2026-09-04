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
 * 왜 시도당 상한이 필요한가(2026-09-04 후속, T37 — main run 33841569631·PR #72의 macOS 러너에서
 * 관측): 레지스트리가 응답을 끊는 상태(`read ECONNRESET`)에서는 npm 자체의 fetch 재시도가 시도당
 * **6~7분**을 소모했다 — npm 기본값이 `fetch-timeout` 300초, `fetch-retries` 2, 재시도 간격 최대
 * 60초라 "연결은 되는데 응답이 안 오는" 상태를 한 번 만날 때마다 5분을 기다린다. 우리 3회 재시도가
 * 그 위에 얹혀 한 job이 19분 넘게 `npm audit`만 붙잡고 있었다(test job 상한 50분에 근접). 그래서
 * ① npm에 짧은 fetch 설정을 CLI 플래그로 넘기고(`NPM_AUDIT_FETCH_FLAGS` — 30초 timeout, 1회 재시도,
 * 재시도 간격 2~10초) ② 그와 무관하게 프로세스 자체를 `perAttemptTimeoutMs`(기본 90초)에 강제
 * 종료한다(npm이 플래그를 무시하거나 다른 곳에서 멈춰도 상한은 지켜진다). 시도당 최악 90초 ×
 * 3회 + 백오프 6초 ≈ 5분이 이제 상한이다 — 예전 19분+에서. 결과 정책은 그대로: 시간 초과는 "실행
 * 실패(null)"로 취급돼 재시도 대상이 되고, 끝까지 무효면 호출자가 fail-open/closed를 정한다.
 *
 * `run`/`sleep`은 주입 가능하다 — 테스트는 실제 npm도 실제 대기도 쓰지 않는다(가드레일 2).
 */
import { execFileSync } from "node:child_process";
import { isValidAuditReport } from "../core/auditAllowlist.js";

/**
 * npm 자체의 네트워크 대기를 짧게 만드는 CLI 설정(위 모듈 주석 ①). 값은 ms. `fetch-timeout`
 * 30초: 정상 응답은 수 초 안에 오고, 30초를 넘기면 이미 "끊긴" 상태로 보는 게 맞다.
 * `fetch-retries` 1: npm 내부 재시도는 한 번만 — 바깥의 `runNpmAuditJsonWithRetry`가 시도
 * 단위 재시도를 담당하므로 안팎 재시도가 곱해지지 않게 한다.
 */
export const NPM_AUDIT_FETCH_FLAGS: readonly string[] = [
  "--fetch-timeout=30000",
  "--fetch-retries=1",
  "--fetch-retry-mintimeout=2000",
  "--fetch-retry-maxtimeout=10000",
];

/** 시도당 프로세스 강제 종료 상한(위 모듈 주석 ②). fetch 설정으로 계산되는 최악(30초 + 재시도
 * 10초 + 30초 ≈ 70초)에 여유를 둔 값. */
export const DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS = 90_000;

/** `npm audit` 한 번에 넘기는 인자 전체 — 테스트가 플래그 포함을 검증할 수 있게 분리. */
export function npmAuditArgs(): string[] {
  return ["audit", "--omit=dev", "--json", ...NPM_AUDIT_FETCH_FLAGS];
}

export interface NpmAuditOnceOptions {
  /** 시도당 강제 종료 상한(ms). 기본 DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** 테스트 주입용 — 실제 npm 대신 실행할 명령과 인자(예: 일정 시간 멈추는 node 스크립트). */
  command?: { file: string; args: string[] };
}

export interface NpmAuditRunOptions {
  /** `npm audit`를 실행할 디렉터리. 기본값: 현재 작업 디렉터리. */
  cwd?: string;
  /** 총 시도 횟수(첫 시도 포함). 기본 3. */
  attempts?: number;
  /** 첫 재시도 전 대기(ms). 이후 시도마다 2배. 기본 2000. */
  baseDelayMs?: number;
  /** 시도당 프로세스 강제 종료 상한(ms). 기본 DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS(90초). `run`을
   * 주입하면 그쪽이 책임진다(이 값은 기본 실행기에만 적용). */
  perAttemptTimeoutMs?: number;
  /** 테스트 주입용 — `npm audit --omit=dev --json ...`의 stdout, 실행 자체가 실패하면 null. */
  run?: (cwd: string | undefined) => string | null;
  /** 테스트 주입용 — 기본값: setTimeout 기반 대기. */
  sleep?: (ms: number) => Promise<void>;
  /** 재시도 사이의 경고 출력. 기본값: console.warn. */
  warn?: (message: string) => void;
}

/**
 * npm audit를 한 번 실행한다. 실행 자체가 실패하면(레지스트리 접근 불가, `timeoutMs` 초과로 강제
 * 종료 등) null을 반환한다 — 두 경우 모두 호출자 입장에선 "이번 시도는 답이 없다"로 같다.
 */
export function runNpmAuditJsonOnce(
  cwd: string | undefined,
  options: NpmAuditOnceOptions = {},
): string | null {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS;
  const file = options.command?.file ?? "npm";
  const args = options.command?.args ?? npmAuditArgs();
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      // SIGKILL — npm은 SIGTERM을 받아도 자식 fetch가 끝날 때까지 기다릴 수 있다. 상한은 상한이다.
      killSignal: "SIGKILL",
      ...(cwd !== undefined ? { cwd } : {}),
    });
  } catch (err) {
    // npm audit는 취약점이 발견되기만 해도 0이 아닌 종료 코드로 끝난다 — 그 경우엔 JSON
    // 리포트 자체가 stdout에 담겨 있다(진짜 실행 실패와 구분해야 한다). 시간 초과로 죽였을 땐
    // stdout이 비어 있거나 잘려 있어 아래 null 경로로 간다(잘린 JSON은 isValidAuditStdout이 거른다).
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
  const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS;
  const run =
    options.run ??
    ((cwd: string | undefined): string | null =>
      runNpmAuditJsonOnce(cwd, { timeoutMs: perAttemptTimeoutMs }));
  const sleep = options.sleep ?? defaultSleep;
  const warn = options.warn ?? ((message: string): void => console.warn(message));

  let last: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    last = run(options.cwd);
    if (isValidAuditStdout(last)) return last;
    if (attempt < attempts) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      warn(
        `[npm audit] ${attempt}/${attempts}번째 시도가 유효한 리포트를 내지 못했습니다` +
          `(${elapsedSec}초 소요 — 레지스트리 일시 오류로 추정: 폐기 예정 quick 엔드포인트 fallback, ` +
          `응답 없는 연결 등). ${delay}ms 후 재시도합니다.`,
      );
      await sleep(delay);
    }
  }
  return last;
}
