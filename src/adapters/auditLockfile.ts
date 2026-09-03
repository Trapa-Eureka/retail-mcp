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
 * 통신 실패 등으로 안 되면(JSON을 못 받음) **fail-open**(경고만 출력하고 통과) — 이건
 * 코드 결함이 아니라 외부 서비스 가용성 문제라 이것만으로 PR을 막지 않는다. 반대로 audit는
 * 성공했는데 승인 목록(`src/core/auditAllowlist.ts`) 밖의 새 advisory가 나오면
 * **fail-closed**로 반드시 막는다.
 */
import { execFileSync } from "node:child_process";
import {
  checkAdvisoriesAgainstAllowlist,
  extractAdvisoryUrls,
  type NpmAuditReport,
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

/** 반환값: 게이트를 막아야 하면 실패 사유 문자열, 통과하면 null. */
export function evaluateLockfileAudit(stdout: string | null): string | null {
  if (stdout === null) {
    console.warn(
      "npm audit 실행 자체가 실패했습니다(레지스트리 접근 불가 등으로 추정) — " +
        "fail-open 정책으로 이 게이트는 통과시킵니다. 수동으로 npm audit를 재시도해 확인하세요.",
    );
    return null;
  }

  let report: NpmAuditReport;
  try {
    report = JSON.parse(stdout) as NpmAuditReport;
  } catch (err) {
    console.warn(
      `npm audit 출력이 JSON으로 파싱되지 않았습니다 — fail-open 정책으로 이 게이트는 ` +
        `통과시킵니다.\n${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const advisoryUrls = extractAdvisoryUrls(report);
  const { unexpected, noneFound } = checkAdvisoriesAgainstAllowlist(advisoryUrls);
  if (unexpected.length > 0) {
    return (
      `lockfile 기준으로 승인되지 않은 새 취약점이 발견됐습니다: ${unexpected.join(", ")} — ` +
      "docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md SEC-006을 재검토하세요."
    );
  }
  console.log(
    noneFound
      ? "lockfile 기준 audit 통과 — 취약점 0건."
      : `lockfile 기준 audit 통과 — 승인된 예외만 확인됨(${advisoryUrls.join(", ")}).`,
  );
  return null;
}
