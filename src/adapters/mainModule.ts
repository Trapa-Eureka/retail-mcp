/**
 * "이 파일이 직접 실행됐는가"(CLI 진입점 vs import된 모듈) 판정 — `src/server.ts`/
 * `src/cli/onboard.ts`가 공유한다(TASKS T29).
 *
 * 착수 중 발견(QA-001 tarball smoke test, `scripts/verifyPack.ts`): `process.argv[1] ===
 * fileURLToPath(import.meta.url)`는 저장소에서 `tsx src/server.ts`로 직접 실행할 때는
 * 맞지만, npm이 `node_modules/.bin/`에 만드는 **심볼릭 링크**를 통해 실행하면 깨진다 —
 * `process.argv[1]`은 실행에 쓰인 심볼릭 링크 경로 그대로인 반면 `import.meta.url`은
 * Node 모듈 시스템이 이미 실제 경로(realpath)로 해석한 뒤라 둘이 문자열로 다르다. 그
 * 결과 `main()`이 전혀 호출되지 않고 프로세스가 즉시 종료 코드 0으로 조용히 끝났다 —
 * 에러도 없어 눈에 띄지 않는 결함이었다. `process.argv[1]`도 realpath로 맞춰 비교한다.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}
