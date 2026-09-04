/**
 * CLI entry point for the committed-secret scan (QA-006, TASKS T35) — run by CI on every PR.
 * The verdict logic is in `src/core/secretScan.ts` (pure function) and the git/file IO in
 * `src/adapters/secretScanGit.ts` (unit-tested). This file is a shell that handles only argument
 * parsing, output and the exit code.
 *
 * Two scopes are scanned:
 * 1. **Current tree** — every file tracked by `git ls-files` (untracked/.gitignore'd files are never
 *    pushed in the first place, so excluding them is safe). Always runs.
 * 2. **History range** (`--range=<base>..<head>`, second adversarial review SR2-SEC-003) — every
 *    blob absent from base across all commit trees in the range. If a secret is added in an
 *    intermediate commit of a PR and removed in the last commit, the current tree scan passes but
 *    the remote history keeps it — this catches that case. CI passes `base.sha..head.sha` for
 *    pull_request and `event.before..sha` for push (.github/workflows/ci.yml). If base cannot be
 *    found (all-zero SHA of a first push/force push, shallow clone), the range scan **prints that
 *    it was explicitly skipped** and the verdict is made from the tree scan result alone.
 *
 * There are two cases of non-zero exit (both printed as separate categories):
 * - A value suspected to be a secret was found.
 * - **There are tracked files that could not be read and therefore were not checked** (SR2-SEC-004)
 *   — previously `readFile(...).catch(() => null)` silently skipped them and succeeded with "0
 *   findings". We must not claim a pass when there are files that could not be checked
 *   (fail-closed). The only intentional exclusions are the binary extension allowlist and symbolic
 *   links.
 *
 * There is deliberately no per-file exclusion list (SR2-SEC-002) — even the scanner's own test file
 * assembles its fixtures at runtime and is scanned exactly like any other file. If an intentional
 * complete literal is truly needed, use the per-line `secretscan-allow` marker rather than a file
 * exclusion.
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
    throw new Error(`Invalid --range format: "${raw}". It must be of the form <base>..<head>.`);
  }
  return { base: raw.slice(0, sep), head: raw.slice(sep + 2) };
}

async function main(): Promise<void> {
  const tree = await scanTrackedFiles(REPO_ROOT);
  const findings: SecretFinding[] = [...tree.findings];
  const summary: string[] = [
    `current tree ${tree.scannedFileCount} files` +
      (tree.skippedSymlinkCount > 0
        ? ` (${tree.skippedSymlinkCount} symbolic links excluded)`
        : ""),
  ];

  const range = parseRange(process.argv);
  if (range !== undefined) {
    try {
      const result = scanGitRange(REPO_ROOT, range.base, range.head);
      findings.push(...result.findings);
      summary.push(`history range ${result.commitCount} commits, ${result.newBlobCount} new blobs`);
    } catch (err) {
      if (!(err instanceof UnknownBaseError)) throw err;
      console.warn(`[secret-scan] history range scan skipped — ${err.message}`);
      summary.push("history range scan skipped (no base)");
    }
  }

  let failed = false;

  if (findings.length > 0) {
    failed = true;
    console.error(`${findings.length} value(s) suspected to be secrets were found:`);
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line} — ${f.patternName} (${f.matchPreview})`);
    }
    console.error(
      "If it is a real secret, rotate it immediately and remove it from git history (a `file@commit` label means it is not in the current " +
        "tree but remains in history — deleting the file alone does not resolve it). " +
        "If it is an intentional fake value in a test fixture, add the `secretscan-allow` marker to that line " +
        "(e.g. `// secretscan-allow: test fixture`) — see EXPLICIT_ALLOW_MARKER in src/core/secretScan.ts. " +
        "Common words (fake/example etc.) no longer bypass the scan (SR2-SEC-001).",
    );
  }

  if (tree.unreadable.length > 0) {
    failed = true;
    console.error(
      `Unable to check: ${tree.unreadable.length} tracked file(s) could not be read and were not scanned (separate from secret findings — ` +
        "the scan is not judged as passed while there are files that could not be checked, SR2-SEC-004):",
    );
    for (const u of tree.unreadable) {
      console.error(`  ${u.filePath} — ${u.reason}`);
    }
    console.error(
      "Check file permissions, encoding and existence. If it is a binary that is meaningless to check as text, " +
        "adding it to SKIP_EXTENSIONS (extension allowlist) in src/adapters/secretScanGit.ts is the only " +
        "permitted exclusion method — there is no per-filename exclusion (SR2-SEC-002).",
    );
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log(`Secret scan passed — ${summary.join(", ")} checked, 0 findings.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
