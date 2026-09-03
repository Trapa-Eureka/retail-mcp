/**
 * 커밋된 시크릿 스캔 CLI 진입점 (QA-006, TASKS T35) — CI 매 PR에서 실행.
 * 판정 로직은 `src/core/secretScan.ts`(순수 함수, 단위 테스트 대상)에 있다.
 *
 * 두 범위를 스캔한다:
 * 1. **현재 트리** — `git ls-files`로 추적 중인 파일 전체(untracked/.gitignore 대상은 애초에
 *    push되지 않으니 제외해도 안전). 항상 실행.
 * 2. **히스토리 범위**(`--range=<base>..<head>`, 2차 적대적 검수 SR2-SEC-003) — 범위 안의 모든
 *    커밋 트리에서 base에 없던 blob 전부(`src/adapters/secretScanGit.ts`). PR 중간 커밋에
 *    시크릿을 넣고 마지막 커밋에서 지우면 현재 트리 스캔은 통과하지만 원격 히스토리엔 남는다 —
 *    그 케이스를 잡는다. CI가 pull_request엔 `base.sha..head.sha`, push엔
 *    `event.before..sha`를 넘긴다(.github/workflows/ci.yml). base를 찾을 수 없으면(첫 push/
 *    force push의 all-zero SHA, 얕은 clone) 범위 스캔은 **명시적으로 건너뛰었다고 출력**하고
 *    트리 스캔 결과만으로 판정한다 — 조용히 0건 처리하지 않는다.
 *
 * 파일 단위 제외 목록은 의도적으로 없다(SR2-SEC-002) — 스캐너 자체의 테스트 파일도 픽스처를
 * 런타임에 조합해 다른 파일과 똑같이 스캔된다. 의도된 완성 리터럴이 꼭 필요하면 파일 제외가
 * 아니라 줄 단위 `secretscan-allow` 마커를 쓴다.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGitRange, shouldSkipPath, UnknownBaseError } from "../src/adapters/secretScanGit.js";
import { parseNamedArg } from "../src/core/cliArgs.js";
import { scanContentForSecrets, type SecretFinding } from "../src/core/secretScan.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

function listTrackedFiles(): string[] {
  const stdout = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((file) => !shouldSkipPath(file));
}

async function scanCurrentTree(): Promise<{ fileCount: number; findings: SecretFinding[] }> {
  const files = listTrackedFiles();
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const content = await readFile(path.join(REPO_ROOT, file), "utf8").catch(() => null);
    if (content === null) continue; // 심볼릭 링크 깨짐 등 — 스캔 목적상 무시해도 안전.
    findings.push(...scanContentForSecrets(file, content));
  }
  return { fileCount: files.length, findings };
}

function parseRange(argv: readonly string[]): { base: string; head: string } | undefined {
  const raw = parseNamedArg(argv, "range");
  if (raw === undefined) return undefined;
  const sep = raw.indexOf("..");
  if (sep <= 0 || sep + 2 >= raw.length) {
    throw new Error(`--range 형식이 잘못됐습니다: "${raw}". <base>..<head> 형태여야 합니다.`);
  }
  return { base: raw.slice(0, sep), head: raw.slice(sep + 2) };
}

async function main(): Promise<void> {
  const tree = await scanCurrentTree();
  const findings: SecretFinding[] = [...tree.findings];
  const summary: string[] = [`현재 트리 ${tree.fileCount}개 파일`];

  const range = parseRange(process.argv);
  if (range !== undefined) {
    try {
      const result = scanGitRange(REPO_ROOT, range.base, range.head);
      findings.push(...result.findings);
      summary.push(`히스토리 범위 커밋 ${result.commitCount}개·새 blob ${result.newBlobCount}개`);
    } catch (err) {
      if (!(err instanceof UnknownBaseError)) throw err;
      console.warn(`[secret-scan] 히스토리 범위 스캔 건너뜀 — ${err.message}`);
      summary.push("히스토리 범위 스캔 건너뜀(base 없음)");
    }
  }

  if (findings.length > 0) {
    console.error(`시크릿으로 의심되는 값이 ${findings.length}건 발견됐습니다:`);
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line} — ${f.patternName} (${f.matchPreview})`);
    }
    console.error(
      "실제 시크릿이면 즉시 폐기(rotate)하고 git 히스토리에서 제거하세요(`파일@커밋` 라벨은 현재 " +
        "트리엔 없지만 히스토리에 남아 있다는 뜻 — 파일을 지우는 것만으로는 해결되지 않습니다). " +
        "테스트 픽스처의 의도된 가짜 값이면 해당 줄에 `secretscan-allow` 마커를 " +
        "추가하세요(예: `// secretscan-allow: 테스트 픽스처`) — src/core/secretScan.ts의 " +
        "EXPLICIT_ALLOW_MARKER 참고. 흔한 단어(fake/example 등)로는 더 이상 우회되지 않습니다(SR2-SEC-001).",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`시크릿 스캔 통과 — ${summary.join(", ")} 확인, 발견 0건.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
