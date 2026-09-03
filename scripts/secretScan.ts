/**
 * 커밋된 시크릿 스캔 CLI 진입점 (QA-006, TASKS T35) — CI 매 PR에서 실행.
 * 판정 로직은 `src/core/secretScan.ts`(순수 함수), git/파일 IO는 `src/adapters/secretScanGit.ts`
 * (단위 테스트 대상)에 있다. 이 파일은 인자 파싱·출력·종료 코드만 담당하는 셸이다.
 *
 * 두 범위를 스캔한다:
 * 1. **현재 트리** — `git ls-files`로 추적 중인 파일 전체(untracked/.gitignore 대상은 애초에
 *    push되지 않으니 제외해도 안전). 항상 실행.
 * 2. **히스토리 범위**(`--range=<base>..<head>`, 2차 적대적 검수 SR2-SEC-003) — 범위 안의 모든
 *    커밋 트리에서 base에 없던 blob 전부. PR 중간 커밋에 시크릿을 넣고 마지막 커밋에서 지우면
 *    현재 트리 스캔은 통과하지만 원격 히스토리엔 남는다 — 그 케이스를 잡는다. CI가
 *    pull_request엔 `base.sha..head.sha`, push엔 `event.before..sha`를 넘긴다
 *    (.github/workflows/ci.yml). base를 찾을 수 없으면(첫 push/force push의 all-zero SHA, 얕은
 *    clone) 범위 스캔은 **명시적으로 건너뛰었다고 출력**하고 트리 스캔 결과만으로 판정한다.
 *
 * 종료 코드가 0이 아닌 경우는 두 가지다(둘 다 별도 카테고리로 출력):
 * - 시크릿으로 의심되는 값이 발견됨.
 * - **읽지 못해 검사하지 못한 추적 파일이 있음**(SR2-SEC-004) — 예전엔 `readFile(...).catch(()
 *   => null)`로 조용히 건너뛰어 "발견 0건"으로 성공했다. 검사하지 못한 파일이 있는데 통과라고
 *   말하면 안 된다(fail-closed). 의도적 제외는 binary 확장자 allowlist와 심볼릭 링크만.
 *
 * 파일 단위 제외 목록은 의도적으로 없다(SR2-SEC-002) — 스캐너 자체의 테스트 파일도 픽스처를
 * 런타임에 조합해 다른 파일과 똑같이 스캔된다. 의도된 완성 리터럴이 꼭 필요하면 파일 제외가
 * 아니라 줄 단위 `secretscan-allow` 마커를 쓴다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGitRange, scanTrackedFiles, UnknownBaseError } from "../src/adapters/secretScanGit.js";
import { parseNamedArg } from "../src/core/cliArgs.js";
import type { SecretFinding } from "../src/core/secretScan.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

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
  const tree = await scanTrackedFiles(REPO_ROOT);
  const findings: SecretFinding[] = [...tree.findings];
  const summary: string[] = [
    `현재 트리 ${tree.scannedFileCount}개 파일` +
      (tree.skippedSymlinkCount > 0 ? `(심볼릭 링크 ${tree.skippedSymlinkCount}개 제외)` : ""),
  ];

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

  let failed = false;

  if (findings.length > 0) {
    failed = true;
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
  }

  if (tree.unreadable.length > 0) {
    failed = true;
    console.error(
      `검사 불가: 추적 파일 ${tree.unreadable.length}개를 읽지 못해 스캔하지 못했습니다(시크릿 발견과는 별개 — ` +
        "검사하지 못한 파일이 있으면 통과로 판정하지 않습니다, SR2-SEC-004):",
    );
    for (const u of tree.unreadable) {
      console.error(`  ${u.filePath} — ${u.reason}`);
    }
    console.error(
      "파일 권한·인코딩·존재 여부를 확인하세요. 텍스트로 검사할 의미가 없는 binary라면 " +
        "src/adapters/secretScanGit.ts의 SKIP_EXTENSIONS(확장자 allowlist)에 추가하는 것만이 " +
        "허용된 제외 방법입니다 — 파일명 단위 제외는 두지 않습니다(SR2-SEC-002).",
    );
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log(`시크릿 스캔 통과 — ${summary.join(", ")} 확인, 발견 0건.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
