/**
 * git 히스토리 범위 대상 시크릿 스캔 — 2차 적대적 검수 SR2-SEC-003.
 *
 * `scripts/secretScan.ts`의 기본 모드는 `git ls-files`, 즉 **현재 트리**만 본다. PR 중간 커밋에
 * 시크릿을 넣고 마지막 커밋에서 지우면 현재 트리엔 없으니 통과하지만, 그 blob은 원격 git
 * 히스토리에 그대로 남아 누구나 열람할 수 있다(ci.yml의 `fetch-depth: 0`이 그걸 검사하는 것처럼
 * 읽혔지만 실제로는 아니었다). 이 모듈은 `base..head` 범위의 **모든 커밋** 각각의 트리를 열어
 * base 트리에 없던 blob을 전부 읽어 스캔한다 — endpoint diff(base vs head)만 보면 놓치는
 * "넣고 지운" 케이스가 중간 커밋의 트리에서 잡힌다. blob은 oid로 중복 제거하므로 같은 내용은
 * 한 번만 스캔된다.
 *
 * 판정 로직은 `src/core/secretScan.ts`(순수 함수) 그대로 쓴다. 여기는 git IO만 담당한다 —
 * `auditLockfile.ts`처럼 CI 셸(`scripts/`)이 가져다 쓰는 어댑터.
 */
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { scanContentForSecrets, type SecretFinding } from "../core/secretScan.js";

/** 텍스트로 읽어도 의미 없는(또는 항상 큰) 확장자 — 트리 스캔과 같은 목록을 공유한다. */
export const SKIP_EXTENSIONS: ReadonlySet<string> = new Set([
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

export function shouldSkipPath(filePath: string): boolean {
  return SKIP_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** GitHub Actions가 첫 push/force push 등에서 `github.event.before`로 주는 "이전 커밋 없음" 값. */
const NULL_SHA = /^0{40}$/;

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

interface TreeEntry {
  oid: string;
  filePath: string;
}

/** `git ls-tree -r <sha>`의 blob 항목 — 서브모듈(commit)·심볼릭 링크는 mode로 걸러 blob만 남긴다. */
function listBlobs(repoRoot: string, sha: string): TreeEntry[] {
  const out = git(repoRoot, ["ls-tree", "-r", "-z", sha]);
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    // 형식: "<mode> <type> <oid>\t<path>"
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    if (type !== "blob" || mode === undefined || oid === undefined) continue;
    if (mode === "120000") continue; // 심볼릭 링크 — 내용이 링크 대상 경로일 뿐이다.
    entries.push({ oid, filePath: record.slice(tab + 1) });
  }
  return entries;
}

export interface RangeScanResult {
  /** 실제로 스캔한 범위의 커밋 수. */
  commitCount: number;
  /** base 트리에 없어 새로 스캔한 blob 수(oid 기준 중복 제거 후). */
  newBlobCount: number;
  findings: SecretFinding[];
}

export class UnknownBaseError extends Error {
  constructor(base: string) {
    super(
      `범위 스캔의 base 커밋 "${base}"을(를) 이 저장소에서 찾을 수 없습니다. ` +
        "첫 push/force push라 이전 커밋이 없거나(all-zero SHA) fetch-depth가 충분하지 않은 경우입니다 — " +
        "이 경우 히스토리 범위 스캔은 건너뛰고 현재 트리 스캔만 유효합니다.",
    );
    this.name = "UnknownBaseError";
  }
}

/**
 * `base..head` 범위의 모든 커밋 트리에서 base 트리에 없던 blob을 전부 스캔한다.
 * base가 존재하지 않으면(all-zero SHA, 얕은 clone 등) `UnknownBaseError`를 던진다 — 호출자가
 * "범위 스캔 불가"를 명시적으로 알리고 트리 스캔만으로 판정을 이어가게 하기 위해서다(조용히
 * 0건으로 통과시키지 않는다).
 */
export function scanGitRange(repoRoot: string, base: string, head: string): RangeScanResult {
  if (NULL_SHA.test(base)) throw new UnknownBaseError(base);
  try {
    git(repoRoot, ["cat-file", "-e", `${base}^{commit}`]);
  } catch {
    throw new UnknownBaseError(base);
  }

  const baseOids = new Set(listBlobs(repoRoot, base).map((e) => e.oid));
  const commits = git(repoRoot, ["rev-list", `${base}..${head}`])
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const seen = new Set<string>();
  const findings: SecretFinding[] = [];
  for (const commit of commits) {
    for (const { oid, filePath } of listBlobs(repoRoot, commit)) {
      if (baseOids.has(oid) || seen.has(oid)) continue;
      seen.add(oid);
      if (shouldSkipPath(filePath)) continue;
      const content = git(repoRoot, ["cat-file", "-p", oid]);
      // 리포트 라벨에 커밋을 붙여 "현재 트리에는 없지만 히스토리에 남아 있다"는 걸 바로 알 수 있게 한다.
      findings.push(...scanContentForSecrets(`${filePath}@${commit.slice(0, 8)}`, content));
    }
  }

  return { commitCount: commits.length, newBlobCount: seen.size, findings };
}

/** 읽지 못해 검사하지 못한 추적 파일 — 시크릿 "발견"과는 별개 카테고리(검사 불가)다. */
export interface UnreadableFile {
  filePath: string;
  /** Node errno 코드(EACCES/ENOENT/EISDIR 등) 또는 알 수 없으면 에러 메시지. */
  reason: string;
}

export interface TrackedScanResult {
  /** 실제로 읽어 스캔한 파일 수(확장자 스킵·심볼릭 링크·읽기 실패 제외). */
  scannedFileCount: number;
  /** 심볼릭 링크라 건너뛴 추적 파일 수(내용이 링크 대상 경로일 뿐 — range 스캔의 mode 120000 제외와 일관). */
  skippedSymlinkCount: number;
  /** 2차 적대적 검수 SR2-SEC-004 — 예전엔 `readFile(...).catch(() => null)`로 조용히 건너뛰어
   * "발견 0건"으로 성공했다. 이제 전부 모아 반환하고 호출자(scripts/secretScan.ts)가 non-zero로
   * 실패시킨다(fail-closed) — 검사하지 못한 파일이 있는데 통과라고 말하면 안 된다. */
  unreadable: UnreadableFile[];
  findings: SecretFinding[];
}

function errnoReason(err: unknown): string {
  if (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  ) {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * 현재 트리(`git ls-files`) 전체를 스캔한다. 의도적으로 건너뛰는 건 두 가지뿐이고 둘 다 명시적
 * 규칙이다 — binary 확장자 allowlist(`SKIP_EXTENSIONS`)와 심볼릭 링크(`lstat`). 그 외 어떤 이유로든
 * 읽지 못한 파일은 `unreadable`에 담아 반환한다(조용히 continue하지 않는다, SR2-SEC-004).
 */
export async function scanTrackedFiles(repoRoot: string): Promise<TrackedScanResult> {
  const files = git(repoRoot, ["ls-files", "-z"])
    .split("\0")
    .filter((f) => f.length > 0)
    .filter((f) => !shouldSkipPath(f));

  const result: TrackedScanResult = {
    scannedFileCount: 0,
    skippedSymlinkCount: 0,
    unreadable: [],
    findings: [],
  };

  for (const file of files) {
    const absolute = path.join(repoRoot, file);
    let content: string;
    try {
      // lstat: 링크 자체를 본다(follow하지 않음) — 깨진 링크도 여기서 "링크"로 판별돼 ENOENT로
      // 읽기 실패에 잡히지 않는다.
      if ((await lstat(absolute)).isSymbolicLink()) {
        result.skippedSymlinkCount++;
        continue;
      }
      content = await readFile(absolute, "utf8");
    } catch (err) {
      result.unreadable.push({ filePath: file, reason: errnoReason(err) });
      continue;
    }
    result.scannedFileCount++;
    result.findings.push(...scanContentForSecrets(file, content));
  }

  return result;
}
