/**
 * 커밋된 시크릿 스캔 CLI 진입점 (QA-006, TASKS T35) — CI 매 PR에서 실행.
 * 판정 로직은 `src/core/secretScan.ts`(순수 함수, 단위 테스트 대상)에 있다. 여기서는
 * `git ls-files`로 추적 중인 파일 목록을 얻고(untracked/.gitignore 대상은 애초에 push되지
 * 않으니 검사 대상에서 제외해도 안전), 바이너리로 보이는 확장자만 건너뛴 뒤 각 파일을
 * 읽어 스캔한다.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanContentForSecrets, type SecretFinding } from "../src/core/secretScan.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

/** 텍스트로 읽어도 의미 없는(또는 항상 큰) 확장자 — 스캔에서 제외한다. */
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
]);

// 파일 단위 제외 목록은 의도적으로 없다(2차 적대적 검수 SR2-SEC-002). 예전엔
// `tests/secretScan.test.ts` 하나를 이름으로 통째로 빼뒀다 — 스캐너 자체의 테스트라 완성된
// 가짜 시크릿 리터럴을 담고 있어 CI에서 자기 자신을 발견해 걸렸기 때문(TASKS T35). 그러나
// 파일 전체 제외는 그 파일에 진짜 자격증명이 들어가도 구조적으로 못 보는 영구 blind spot이다.
// 지금은 그 테스트가 픽스처를 런타임에 조합해(어느 한 줄에도 완성 패턴이 없음) 다른 파일과
// 똑같이 스캔되고, 자기 소스를 스캔해 0건임을 스스로 assert한다. 의도된 완성 리터럴이 꼭
// 필요하면 파일 제외가 아니라 줄 단위 `secretscan-allow` 마커를 쓴다.
function listTrackedFiles(): string[] {
  const stdout = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((file) => !SKIP_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

async function main(): Promise<void> {
  const files = listTrackedFiles();
  const findings: SecretFinding[] = [];

  for (const file of files) {
    const content = await readFile(path.join(REPO_ROOT, file), "utf8").catch(() => null);
    if (content === null) continue; // 심볼릭 링크 깨짐 등 — 스캔 목적상 무시해도 안전.
    findings.push(...scanContentForSecrets(file, content));
  }

  if (findings.length > 0) {
    console.error(`시크릿으로 의심되는 값이 ${findings.length}건 발견됐습니다:`);
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line} — ${f.patternName} (${f.matchPreview})`);
    }
    console.error(
      "실제 시크릿이면 즉시 폐기(rotate)하고 git 히스토리에서 제거하세요. " +
        "테스트 픽스처의 의도된 가짜 값이면 해당 줄에 `secretscan-allow` 마커를 " +
        "추가하세요(예: `// secretscan-allow: 테스트 픽스처`) — src/core/secretScan.ts의 " +
        "EXPLICIT_ALLOW_MARKER 참고. 흔한 단어(fake/example 등)로는 더 이상 우회되지 않습니다(SR2-SEC-001).",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`시크릿 스캔 통과 — 추적 파일 ${files.length}개 확인, 발견 0건.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
