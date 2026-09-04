/**
 * `src/adapters/secretScanGit.ts` (second adversarial review SR2-SEC-003) — actually creates a
 * temporary git repository, builds a "commit adding a secret → commit removing it" history, and
 * confirms that the current tree yields 0 findings while the range scan catches it. No network is
 * used (local git commands only).
 *
 * Fixture secrets are assembled at runtime (same reason as SR2-SEC-002 — this file itself is a scan
 * target). The assembled complete string is committed only to the temporary repository in tmpdir
 * and never enters this repository's tree.
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

  it("range scan catches a secret added in an intermediate commit and removed in the last one (the case the current tree scan misses)", async () => {
    const base = git(repo, "rev-parse", "HEAD");

    await writeFile(join(repo, "config.ts"), `export const key = "${fakeAwsKey()}";\n`);
    git(repo, "add", "config.ts");
    git(repo, "commit", "-q", "-m", "oops: commit a key");
    const leakCommit = git(repo, "rev-parse", "HEAD");

    git(repo, "rm", "-q", "config.ts");
    git(repo, "commit", "-q", "-m", "remove key");
    const head = git(repo, "rev-parse", "HEAD");

    // The current tree (ls-files at HEAD) has no secret file — the state the old scanner passed.
    expect(git(repo, "ls-files")).toBe("clean.ts");

    const result = scanGitRange(repo, base, head);
    expect(result.commitCount).toBe(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.patternName).toBe("AWS Access Key ID");
    // The label must carry the path and commit so it is immediately clear that "it remains in history".
    expect(result.findings[0]?.file).toBe(`config.ts@${leakCommit.slice(0, 8)}`);
  });

  it("does not rescan blobs already in the base tree, and counts the same blob only once", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    // Add files with identical content across two commits — same blob oid, so 1 new blob.
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

  it("base == head yields 0 commits and 0 findings", () => {
    const head = git(repo, "rev-parse", "HEAD");
    const result = scanGitRange(repo, head, head);
    expect(result.commitCount).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("an all-zero SHA (github.event.before of a first push/force push) throws UnknownBaseError — not silently passed as 0 findings", () => {
    const head = git(repo, "rev-parse", "HEAD");
    expect(() => scanGitRange(repo, "0".repeat(40), head)).toThrow(UnknownBaseError);
  });

  it("a base commit not in the repository is also UnknownBaseError (shallow clone etc.)", () => {
    const head = git(repo, "rev-parse", "HEAD");
    expect(() => scanGitRange(repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", head)).toThrow(
      UnknownBaseError,
    );
  });

  it("does not read blobs with binary extensions (same SKIP_EXTENSIONS as the tree scan)", () => {
    expect(shouldSkipPath("docs/logo.PNG")).toBe(true);
    expect(shouldSkipPath("src/server.ts")).toBe(false);
  });
});

describe("scanTrackedFiles (SR2-SEC-004 — read failures are not silently skipped)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "retail-mcp-secretscan-tree-"));
    git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "clean.ts"), "export const x = 1;\n");
    git(repo, "add", "clean.ts");
    git(repo, "commit", "-q", "-m", "base");
  });

  afterEach(async () => {
    // rm can fail if a chmod 000 file is left behind — restore permissions first.
    await chmod(join(repo, "locked.txt"), 0o644).catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
  });

  it("a normal tree counts files and unreadable is empty", async () => {
    const result = await scanTrackedFiles(repo);
    expect(result.scannedFileCount).toBe(1);
    expect(result.unreadable).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("an unreadable tracked file (no permission) lands in unreadable with filename and errno — previously it was a silent continue", async () => {
    // root ignores permission bits so this case cannot be reproduced — CI runners/local dev
    // environments are not root. Skip if root (marking as not reproducible, not passing wrongly).
    if (process.getuid?.() === 0) return;

    await writeFile(join(repo, "locked.txt"), "cannot read me\n");
    git(repo, "add", "locked.txt");
    git(repo, "commit", "-q", "-m", "add locked");
    await chmod(join(repo, "locked.txt"), 0o000);

    const result = await scanTrackedFiles(repo);
    expect(result.unreadable).toEqual([{ filePath: "locked.txt", reason: "EACCES" }]);
    // Readable files are still scanned — a failure does not stop the whole run; it is collected and reported.
    expect(result.scannedFileCount).toBe(1);
  });

  it("a tracked file that vanished from the working tree (race/local deletion) lands in unreadable as ENOENT", async () => {
    await writeFile(join(repo, "gone.txt"), "x\n");
    git(repo, "add", "gone.txt");
    git(repo, "commit", "-q", "-m", "add gone");
    await unlink(join(repo, "gone.txt")); // Still tracked from git's point of view.

    const result = await scanTrackedFiles(repo);
    expect(result.unreadable).toEqual([{ filePath: "gone.txt", reason: "ENOENT" }]);
  });

  it("symbolic links are counted as 'skipped', neither scanned nor failed (including broken links — consistent with the mode 120000 exclusion in the range scan)", async () => {
    await symlink("clean.ts", join(repo, "link-ok"));
    await symlink("does-not-exist", join(repo, "link-broken"));
    git(repo, "add", "link-ok", "link-broken");
    git(repo, "commit", "-q", "-m", "add links");

    const result = await scanTrackedFiles(repo);
    expect(result.skippedSymlinkCount).toBe(2);
    expect(result.unreadable).toEqual([]);
    expect(result.scannedFileCount).toBe(1);
  });

  it("binary extensions are excluded only via the allowlist and are not caught as unreadable", async () => {
    await writeFile(join(repo, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    git(repo, "add", "img.png");
    git(repo, "commit", "-q", "-m", "add png");

    const result = await scanTrackedFiles(repo);
    expect(result.scannedFileCount).toBe(1); // clean.ts only
    expect(result.unreadable).toEqual([]);
  });
});
