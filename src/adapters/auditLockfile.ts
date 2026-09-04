/**
 * lockfile 기준 dependency audit 실행 로직 (QA-006, TASKS T35).
 *
 * `scripts/auditLockfile.ts`(CI 매 PR용 CLI 진입점)가 가져다 쓴다 — 테스트가 실제 `npm
 * audit`를 실행하지 않고 `evaluateLockfileAudit()`만 순수 입력으로 검증할 수 있도록 IO
 * (`execFileSync`)와 판정 로직을 이 어댑터 파일로 분리했다(`scripts/migrate.ts` ↔
 * `src/adapters/migrationRunner.ts`와 같은 전례).
 *
 * `scripts/verifyPack.ts`의 5단계(실제 게시 tarball 설치 디렉터리 기준, release gate 전용,
 * 무거움)와 검사 대상이 다르다 — 이건 저장소 lockfile(`--omit=dev`로 production 의존성만)
 * 기준이라 훨씬 가볍게 매 PR에서 돌릴 수 있다. 두 기준이 다르게 나올 수 있다는 걸 T32가
 * 이미 실증했으므로(npm `overrides`가 tarball 소비자에게는 적용되지 않음) 하나로 합치지
 * 않고 둘 다 유지한다 — 여기서 걸러지면 지금 당장, verifyPack에서 걸러지면 게시 직전.
 *
 * **fail-open/fail-closed 정책(QA-006 수정 기준)**: `npm audit` 실행 자체가 레지스트리
 * 통신 실패 등으로 안 되거나, 실행은 됐지만 유효한 리포트 형식이 아니면(예: 레지스트리가
 * `{"error": {...}}`를 반환) **fail-open**(경고만 출력하고 통과) — 이건 코드 결함이
 * 아니라 외부 서비스 가용성 문제라 이것만으로 PR을 막지 않는다. **단, "확인 불가"를
 * "취약점 0건"이라고 말하지 않는다**(2차 적대적 검수 SR2-AUD-002 — 예전엔 `{"error":...}`
 * 처럼 `vulnerabilities` 키가 없는 응답도 파싱만 성공하면 그대로 "0건"으로 통과시켰다).
 * 이 PR 편의 게이트와 달리 release gate(`scripts/verifyPack.ts`)는 같은 무효 리포트를
 * **fail-closed**로 막는다(SR2-AUD-001) — 게시 직전 판단은 "레지스트리가 잠깐 느렸을
 * 수도 있으니 통과"가 아니라 "확인될 때까지 막는다"가 맞다. audit는 성공했는데 승인
 * 목록(`src/core/auditAllowlist.ts`) 밖의 새 advisory가 나오면 여기서도 **fail-closed**로
 * 반드시 막는다.
 */
import { execFileSync } from "node:child_process";
import {
  ACCEPTED_ADVISORIES,
  checkAdvisoriesAgainstAllowlist,
  extractAdvisoryUrls,
  isValidAuditReport,
} from "../core/auditAllowlist.js";

/** npm audit를 실행한다. 실행 자체가 실패하면(레지스트리 접근 불가 등) null을 반환한다. */
export function runNpmAuditJson(): string | null {
  try {
    return execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8" });
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

/**
 * 반환값: 게이트를 막아야 하면 실패 사유 문자열, 통과하면 null.
 * `now`는 승인 예외의 만료 판정 기준 시각(SR2-AUD-003) — 테스트는 고정 시각을 넘기고, CLI는
 * 기본값(시스템 시계)을 쓴다.
 */
export function evaluateLockfileAudit(
  stdout: string | null,
  now: Date = new Date(),
): string | null {
  if (stdout === null) {
    console.warn(
      "npm audit 실행 자체가 실패했습니다(레지스트리 접근 불가 등으로 추정) — " +
        "fail-open 정책으로 이 게이트는 통과시킵니다. 수동으로 npm audit를 재시도해 확인하세요.",
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    console.warn(
      `npm audit 출력이 JSON으로 파싱되지 않았습니다 — fail-open 정책으로 이 게이트는 ` +
        `통과시킵니다.\n${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (!isValidAuditReport(parsed)) {
    // SR2-AUD-002 — 여기서 "취약점 0건"이라고 말하면 안 된다. 형식이 이상한 응답(레지스트리
    // 오류 등)은 "안전을 확인 못 함"이지 "안전함"이 아니다. PR 편의 게이트라 fail-open은
    // 유지하되, 메시지는 절대 0건이라고 하지 않는다.
    console.warn(
      "npm audit 출력이 유효한 취약점 리포트 형식이 아닙니다(레지스트리 오류 응답 등으로 " +
        '추정) — fail-open 정책으로 이 게이트는 통과시키지만 "취약점 0건 확인"은 아닙니다. ' +
        `수동으로 npm audit를 재시도해 확인하세요.\n${JSON.stringify(parsed).slice(0, 300)}`,
    );
    return null;
  }

  const advisoryUrls = extractAdvisoryUrls(parsed);
  const { unexpected, expired, noneFound } = checkAdvisoriesAgainstAllowlist(
    advisoryUrls,
    ACCEPTED_ADVISORIES,
    now,
  );
  if (unexpected.length > 0) {
    return (
      `lockfile 기준으로 승인되지 않은 새 취약점이 발견됐습니다: ${unexpected.join(", ")} — ` +
      "docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md SEC-006을 재검토하세요."
    );
  }
  if (expired.length > 0) {
    // SR2-AUD-003 — 승인 예외에는 재검토 기한이 있고 여기서 기계적으로 집행한다(예전엔 기한이
    // 주석에만 있어 지나도 계속 자동 승인됐다). 이건 외부 서비스 문제가 아니라 우리 쪽 결정
    // 사항이 만료된 것이므로 PR 게이트에서도 fail-closed다.
    return (
      "승인된 audit 예외의 재검토 기한이 지났습니다: " +
      expired.map((e) => `${e.url}(기한 ${e.expiresAt})`).join(", ") +
      " — 근본 해결(의존성 업그레이드/대체)하거나, 재검토 후 근거를 갱신하고 " +
      "src/core/auditAllowlist.ts ACCEPTED_ADVISORIES의 expiresAt을 연장하세요(docs/005 SEC-006)."
    );
  }
  console.log(
    noneFound
      ? "lockfile 기준 audit 통과 — 취약점 0건."
      : `lockfile 기준 audit 통과 — 승인된 예외만 확인됨(${advisoryUrls.join(", ")}).`,
  );
  return null;
}
