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

/**
 * `src/core/secretScan.ts`의 패턴 매칭 자체를 검증하는 파일 — 일부러 표시 없는 가짜 값을
 * 그대로 담고 있어야 한다(줄에 fake/example류 마커를 붙이면 그 assertion 자체가 무의미해
 * 진다). 그래서 이 파일 하나만 이름으로 스캔에서 제외한다(실제로 CI에서 자기 자신을
 * 발견해 걸린 적이 있다 — TASKS T35).
 */
const SELF_EXCLUDE = new Set(["tests/secretScan.test.ts"]);

function listTrackedFiles(): string[] {
  const stdout = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((file) => !SKIP_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .filter((file) => !SELF_EXCLUDE.has(file));
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
        "테스트 픽스처의 의도된 가짜 값이면 해당 줄에 fake/example/placeholder류 표시를 추가하거나 " +
        "scripts/secretScan.ts의 PLACEHOLDER_LINE_MARKER를 확인하세요.",
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
