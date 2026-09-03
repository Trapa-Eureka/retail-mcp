/**
 * `src/adapters/secretScanGit.ts`(2차 적대적 검수 SR2-SEC-003) — 임시 git 저장소를 실제로
 * 만들어 "시크릿을 넣은 커밋 → 지운 커밋" 히스토리를 구성하고, 현재 트리 기준으로는 0건이지만
 * 범위 스캔으로는 잡히는지 확인한다. 네트워크는 쓰지 않는다(로컬 git 명령만).
 *
 * 픽스처 시크릿은 런타임에 조합한다(SR2-SEC-002와 같은 이유 — 이 파일 자체가 스캔 대상이다).
 * 조합된 완성 문자열은 tmpdir의 임시 저장소에만 커밋되고 이 저장소 트리엔 들어오지 않는다.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  scanGitRange,
  scanTrackedFiles,
  shouldSkipPath,
  UnknownBaseError,
} from "../src/adapters/secretScanGit.js";

const fakeAwsKey = (): string => ["AKIA", "HISTORYONLYKEY01"].join("");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

describe("scanGitRange (SR2-SEC-003)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "retail-mcp-secretscan-git-"));
    git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "clean.ts"), "export const x = 1;\n");
    git(repo, "add", "clean.ts");
    git(repo, "commit", "-q", "-m", "base");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("중간 커밋에 넣고 마지막 커밋에서 지운 시크릿을 범위 스캔이 잡는다(현재 트리 스캔은 놓치는 케이스)", async () => {
    const base = git(repo, "rev-parse", "HEAD");

    await writeFile(join(repo, "config.ts"), `export const key = "${fakeAwsKey()}";\n`);
    git(repo, "add", "config.ts");
    git(repo, "commit", "-q", "-m", "oops: commit a key");
    const leakCommit = git(repo, "rev-parse", "HEAD");

    git(repo, "rm", "-q", "config.ts");
    git(repo, "commit", "-q", "-m", "remove key");
    const head = git(repo, "rev-parse", "HEAD");

    // 현재 트리(HEAD의 ls-files)에는 시크릿 파일이 없다 — 기존 스캐너가 통과시키던 상태.
    expect(git(repo, "ls-files")).toBe("clean.ts");

    const result = scanGitRange(repo, base, head);
    expect(result.commitCount).toBe(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.patternName).toBe("AWS Access Key ID");
    // 라벨에 경로와 커밋이 붙어 "히스토리에 남아 있다"는 걸 바로 알 수 있어야 한다.
    expect(result.findings[0]?.file).toBe(`config.ts@${leakCommit.slice(0, 8)}`);
  });

  it("base 트리에 이미 있던 blob은 다시 스캔하지 않고, 같은 blob은 한 번만 센다", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    // 같은 내용의 파일을 두 커밋에 걸쳐 추가 — blob oid가 같으므로 새 blob은 1개.
    await writeFile(join(repo, "a.txt"), "same content\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "a");
    await writeFile(join(repo, "b.txt"), "same content\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "b");

    const result = scanGitRange(repo, base, git(repo, "rev-parse", "HEAD"));
    expect(result.commitCount).toBe(2);
    expect(result.newBlobCount).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it("base == head면 커밋 0개·발견 0건이다", () => {
    const head = git(repo, "rev-parse", "HEAD");
    const result = scanGitRange(repo, head, head);
    expect(result.commitCount).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("all-zero SHA(첫 push/force push의 github.event.before)는 UnknownBaseError를 던진다 — 조용히 0건으로 통과시키지 않는다", () => {
    const head = git(repo, "rev-parse", "HEAD");
    expect(() => scanGitRange(repo, "0".repeat(40), head)).toThrow(UnknownBaseError);
  });

  it("저장소에 없는 base 커밋도 UnknownBaseError다(얕은 clone 등)", () => {
    const head = git(repo, "rev-parse", "HEAD");
    expect(() => scanGitRange(repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", head)).toThrow(
      UnknownBaseError,
    );
  });

  it("바이너리 확장자 blob은 읽지 않는다(트리 스캔과 같은 SKIP_EXTENSIONS)", () => {
    expect(shouldSkipPath("docs/logo.PNG")).toBe(true);
    expect(shouldSkipPath("src/server.ts")).toBe(false);
  });
});

describe("scanTrackedFiles (SR2-SEC-004 — 읽기 실패는 조용히 건너뛰지 않는다)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "retail-mcp-secretscan-tree-"));
    git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "clean.ts"), "export const x = 1;\n");
    git(repo, "add", "clean.ts");
    git(repo, "commit", "-q", "-m", "base");
  });

  afterEach(async () => {
    // chmod 000 파일이 남아 있으면 rm이 실패할 수 있다 — 먼저 권한을 되돌린다.
    await chmod(join(repo, "locked.txt"), 0o644).catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
  });

  it("정상 트리는 파일 수를 세고 unreadable이 비어 있다", async () => {
    const result = await scanTrackedFiles(repo);
    expect(result.scannedFileCount).toBe(1);
    expect(result.unreadable).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("추적 파일을 읽지 못하면(권한 없음) unreadable에 파일명과 errno가 담긴다 — 예전엔 조용히 continue였다", async () => {
    // root는 권한 비트를 무시하므로 이 케이스를 재현할 수 없다 — CI 러너/로컬 개발 환경은
    // root가 아니다. root면 건너뛴다(잘못 통과시키는 게 아니라 재현 불가 표시).
    if (process.getuid?.() === 0) return;

    await writeFile(join(repo, "locked.txt"), "cannot read me\n");
    git(repo, "add", "locked.txt");
    git(repo, "commit", "-q", "-m", "add locked");
    await chmod(join(repo, "locked.txt"), 0o000);

    const result = await scanTrackedFiles(repo);
    expect(result.unreadable).toEqual([{ filePath: "locked.txt", reason: "EACCES" }]);
    // 읽을 수 있는 파일은 여전히 스캔된다 — 실패가 전체를 멈추지 않고 모아서 보고한다.
    expect(result.scannedFileCount).toBe(1);
  });

  it("추적 중이지만 워킹 트리에서 사라진 파일(race/로컬 삭제)은 ENOENT로 unreadable에 담긴다", async () => {
    await writeFile(join(repo, "gone.txt"), "x\n");
    git(repo, "add", "gone.txt");
    git(repo, "commit", "-q", "-m", "add gone");
    await unlink(join(repo, "gone.txt")); // git 입장에선 여전히 tracked.

    const result = await scanTrackedFiles(repo);
    expect(result.unreadable).toEqual([{ filePath: "gone.txt", reason: "ENOENT" }]);
  });

  it("심볼릭 링크는 스캔도 실패도 아닌 '건너뜀'으로 센다(깨진 링크 포함 — range 스캔의 mode 120000 제외와 일관)", async () => {
    await symlink("clean.ts", join(repo, "link-ok"));
    await symlink("does-not-exist", join(repo, "link-broken"));
    git(repo, "add", "link-ok", "link-broken");
    git(repo, "commit", "-q", "-m", "add links");

    const result = await scanTrackedFiles(repo);
    expect(result.skippedSymlinkCount).toBe(2);
    expect(result.unreadable).toEqual([]);
    expect(result.scannedFileCount).toBe(1);
  });

  it("binary 확장자는 allowlist로만 제외되고 unreadable로 잡히지 않는다", async () => {
    await writeFile(join(repo, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    git(repo, "add", "img.png");
    git(repo, "commit", "-q", "-m", "add png");

    const result = await scanTrackedFiles(repo);
    expect(result.scannedFileCount).toBe(1); // clean.ts만
    expect(result.unreadable).toEqual([]);
  });
});
