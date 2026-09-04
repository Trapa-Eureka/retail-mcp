/**
 * Secret scan over a git history range — second adversarial review SR2-SEC-003.
 *
 * The default mode of `scripts/secretScan.ts` is `git ls-files`, i.e. it only looks at the
 * **current tree**. If a secret is added in an intermediate commit of a PR and removed in the last
 * commit, it is absent from the current tree and passes, but that blob remains in the remote git
 * history for anyone to read (the `fetch-depth: 0` in ci.yml read as if it checked that, but it
 * did not). This module opens the tree of **every commit** in the `base..head` range and reads and
 * scans every blob that was not in the base tree — the "added then removed" case that an endpoint
 * diff (base vs head) misses is caught in the intermediate commit's tree. Blobs are deduplicated by
 * oid, so identical content is scanned only once.
 *
 * The verdict logic is `src/core/secretScan.ts` (pure function) as-is. This file handles git IO
 * only — an adapter used by the CI shell (`scripts/`), like `auditLockfile.ts`.
 */
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { scanContentForSecrets, type SecretFinding } from "../core/secretScan.js";

/** Extensions that are meaningless to read as text (or always large) — the same list is shared with the tree scan. */
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

/** The "no previous commit" value GitHub Actions gives as `github.event.before` on a first push / force push etc. */
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

/** Blob entries of `git ls-tree -r <sha>` — submodules (commit) and symbolic links are filtered out by mode, leaving blobs only. */
function listBlobs(repoRoot: string, sha: string): TreeEntry[] {
  const out = git(repoRoot, ["ls-tree", "-r", "-z", sha]);
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    // Format: "<mode> <type> <oid>\t<path>"
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    if (type !== "blob" || mode === undefined || oid === undefined) continue;
    if (mode === "120000") continue; // Symbolic link — its content is only the link target path.
    entries.push({ oid, filePath: record.slice(tab + 1) });
  }
  return entries;
}

export interface RangeScanResult {
  /** Number of commits in the range actually scanned. */
  commitCount: number;
  /** Number of blobs newly scanned because they were not in the base tree (after dedup by oid). */
  newBlobCount: number;
  findings: SecretFinding[];
}

export class UnknownBaseError extends Error {
  constructor(base: string) {
    super(
      `The base commit "${base}" for the range scan could not be found in this repository. ` +
        "Either there is no previous commit because this is a first push/force push (all-zero SHA), or fetch-depth is insufficient — " +
        "in that case the history range scan is skipped and only the current tree scan is valid.",
    );
    this.name = "UnknownBaseError";
  }
}

/**
 * Scans every blob absent from the base tree across all commit trees in the `base..head` range.
 * If base does not exist (all-zero SHA, shallow clone, etc.), throws `UnknownBaseError` — so the
 * caller can explicitly announce "range scan not possible" and continue the verdict with the tree
 * scan alone (it is not silently passed as 0 findings).
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
      // The commit is appended to the report label so it is immediately clear that "it is not in the current tree but remains in history".
      findings.push(...scanContentForSecrets(`${filePath}@${commit.slice(0, 8)}`, content));
    }
  }

  return { commitCount: commits.length, newBlobCount: seen.size, findings };
}

/** A tracked file that could not be read and therefore was not checked — a separate category (unable to check) from a secret "finding". */
export interface UnreadableFile {
  filePath: string;
  /** Node errno code (EACCES/ENOENT/EISDIR etc.), or the error message if unknown. */
  reason: string;
}

export interface TrackedScanResult {
  /** Number of files actually read and scanned (excluding extension skips, symbolic links and read failures). */
  scannedFileCount: number;
  /** Number of tracked files skipped because they are symbolic links (content is only the link target path — consistent with the mode 120000 exclusion in the range scan). */
  skippedSymlinkCount: number;
  /** Second adversarial review SR2-SEC-004 — previously `readFile(...).catch(() => null)` silently
   * skipped these and succeeded with "0 findings". Now all of them are collected and returned, and
   * the caller (scripts/secretScan.ts) fails with non-zero (fail-closed) — we must not claim a pass
   * when there are files that could not be checked. */
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
 * Scans the entire current tree (`git ls-files`). Only two things are skipped deliberately, and both
 * are explicit rules — the binary extension allowlist (`SKIP_EXTENSIONS`) and symbolic links
 * (`lstat`). Any file that could not be read for any other reason is returned in `unreadable` (no
 * silent continue, SR2-SEC-004).
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
      // lstat: looks at the link itself (does not follow) — a broken link is also identified as a
      // "link" here and is not caught as an ENOENT read failure.
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
