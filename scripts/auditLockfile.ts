/**
 * lockfile 기준 dependency audit CLI 진입점 (QA-006, TASKS T35) — CI 매 PR에서 실행.
 * 핵심 로직(IO + 판정)은 `src/adapters/auditLockfile.ts`에 있다(테스트가 실제 npm audit를
 * 실행하지 않고 판정 로직만 검증할 수 있도록 — `scripts/migrate.ts`와 같은 구조).
 * `npm audit` 실행은 유효한 리포트를 못 얻으면 제한 재시도한다(`src/adapters/npmAudit.ts`).
 */
import { evaluateLockfileAudit, runNpmAuditJson } from "../src/adapters/auditLockfile.js";

async function main(): Promise<void> {
  const failure = evaluateLockfileAudit(await runNpmAuditJson());
  if (failure !== null) {
    console.error(failure);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
