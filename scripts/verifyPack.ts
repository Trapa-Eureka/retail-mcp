/**
 * npm publish tarball verification script (TASKS T29, response to QA-001) — for humans/CI only,
 * not part of `npm run check` (TESTING.md §8 states that the "release gate" is separate from every
 * local check).
 *
 * Verifies the **tarball that will actually be published**, not the repository source: build →
 * `npm pack` → install into a completely fresh directory with `npm install --omit=dev` (an
 * environment without dev dependencies such as `tsx`) → actually run the installed `bin`s
 * (`retail-mcp`, `retail-mcp-onboard`, `retail-mcp-migrate`, `retail-mcp-scan`,
 * `retail-mcp-reorder`) to confirm.
 *
 * - `retail-mcp`: connects over stdio with a real MCP client and confirms that `tools/list` matches
 *   the production default (only the 5 query tools, `sync_now`/`explore_sql` disabled).
 * - `retail-mcp-onboard`: pipes branch-mode answers to stdin and confirms that `.env` and the
 *   example template CSV are actually created.
 * - `retail-mcp-migrate` (SR2-REL-001, second adversarial review): confirms the bin is actually
 *   included in the tarball and executable, and exits with a clear error when DATABASE_URL is
 *   missing (the actual apply path requiring a real Postgres is verified by
 *   tests/component/postgres.component.test.ts).
 *
 * On failure it exits non-zero with an error containing the cause (so CI can run this script as a
 * release gate).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runNpmAuditJsonWithRetry } from "../src/adapters/npmAudit.js";
import { ACCEPTED_ADVISORIES } from "../src/core/auditAllowlist.js";
import { parseNamedArg } from "../src/core/cliArgs.js";
import {
  AUDIT_UNAVAILABLE_FLAG,
  evaluateTarballAudit,
  parseAuditUnavailablePolicy,
  shouldBlock,
  type AuditUnavailablePolicy,
} from "../src/core/tarballAuditPolicy.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const EXPECTED_DEFAULT_TOOLS = [
  "inventory_status",
  "reorder_suggestions",
  "sell_through",
  "stockout_risk",
  "sync_status",
].sort();

function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** Runs a command with the given cwd and returns stdout — on failure throws an error that includes stderr. */
function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function packTarball(destDir: string): string {
  heading("1) Build + npm pack");
  run("npm", ["run", "build"], REPO_ROOT);
  const json = run("npm", ["pack", "--json", "--pack-destination", destDir], REPO_ROOT);
  const [entry] = JSON.parse(json) as { filename: string }[];
  if (!entry) throw new Error("npm pack did not return a result filename.");
  const tarballPath = path.join(destDir, entry.filename);
  console.log(`tarball: ${tarballPath}`);
  return tarballPath;
}

async function installFresh(tarballPath: string, installDir: string): Promise<void> {
  heading("2) --omit=dev install into a completely fresh directory");
  await writeFile(
    path.join(installDir, "package.json"),
    JSON.stringify({ name: "retail-mcp-pack-smoke", version: "0.0.0", private: true }, null, 2),
  );
  run("npm", ["install", "--omit=dev", tarballPath], installDir);
}

async function assertExecutable(binPath: string): Promise<void> {
  const info = await stat(binPath).catch(() => {
    throw new Error(
      `bin file was not installed: ${binPath} — check the package.json bin/files allowlist.`,
    );
  });
  if (!info.isFile()) throw new Error(`bin path is not a file: ${binPath}`);
}

async function verifyMcpServerBin(installDir: string): Promise<void> {
  heading("3) Run retail-mcp (MCP server) bin — check tools/list");
  const binPath = path.join(installDir, "node_modules", ".bin", "retail-mcp");
  await assertExecutable(binPath);

  const client = new Client({ name: "verify-pack-client", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: binPath,
    cwd: installDir,
    env: { ...process.env, BUSINESS_TIMEZONE: "Asia/Manila" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_DEFAULT_TOOLS)) {
      throw new Error(
        `tools/list differs from the production default.\nExpected: ${EXPECTED_DEFAULT_TOOLS.join(", ")}\nActual: ${names.join(", ")}`,
      );
    }
    console.log(`tools/list confirmed: ${names.join(", ")}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function verifyOnboardBin(installDir: string): Promise<void> {
  heading("4) Run retail-mcp-onboard (onboarding CLI) bin — check .env + template creation");
  const binPath = path.join(installDir, "node_modules", ".bin", "retail-mcp-onboard");
  await assertExecutable(binPath);

  const onboardCwd = path.join(installDir, "onboard-run");
  await mkdir(onboardCwd, { recursive: true });

  // Same order as the collectOnboardAnswers() questions: mode → DB connection string (empty =
  // embedded) → watch folder → snapshot folder → threshold (empty = default) → recipient email →
  // Resend API key (empty = skip send settings, sender address is not asked).
  const answers = ["branch", "", "./watch", "./snapshot", "", "smoke@example.com", ""].join("\n");

  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(binPath, [], {
    cwd: onboardCwd,
    input: answers,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `retail-mcp-onboard returned a non-zero exit code (${String(result.status)}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  const envContent = await readFile(path.join(onboardCwd, ".env"), "utf8");
  if (!envContent.includes("CSV_MODE=branch")) {
    throw new Error(`.env does not contain CSV_MODE=branch:\n${envContent}`);
  }
  const templatePath = path.join(onboardCwd, "watch", "template-example.csv");
  await stat(templatePath).catch(() => {
    throw new Error(`Example template CSV was not created: ${templatePath}`);
  });
  console.log(".env + example template CSV creation confirmed");
}

/**
 * SR2-REL-001 (second adversarial review) — confirms that `retail-mcp-migrate` is actually
 * included in the tarball and executable. There is no real Postgres in this script's environment
 * (same spirit as guardrail 2 — the release gate does not depend on the network either), so the
 * actual migration apply is not verified here (tests/component/postgres.component.test.ts confirms
 * that with real Postgres). Instead only "the bin exists in the package, is executable, and exits
 * with clear guidance when DATABASE_URL is missing" is checked — the root defect of SR2-REL-001
 * was precisely "this bin itself was not in the tarball".
 */
async function verifyMigrateBin(installDir: string): Promise<void> {
  heading("5) Run retail-mcp-migrate (migration CLI) bin — check packaging and error path");
  const binPath = path.join(installDir, "node_modules", ".bin", "retail-mcp-migrate");
  await assertExecutable(binPath);

  const { spawnSync } = await import("node:child_process");
  const env = { ...process.env };
  delete env["DATABASE_URL"];
  const result = spawnSync(binPath, [], { cwd: installDir, encoding: "utf8", env });

  if (result.status === 0) {
    throw new Error(
      "retail-mcp-migrate succeeded (exit 0) even without DATABASE_URL — " +
        "the guard that blocks with an error when it is missing may be broken.",
    );
  }
  if (!result.stderr.includes("DATABASE_URL")) {
    throw new Error(
      `retail-mcp-migrate's error message does not mention DATABASE_URL:\nstderr:\n${result.stderr}`,
    );
  }
  console.log("bin executable confirmed + exits with guidance error when DATABASE_URL is missing");
}

/**
 * Found in the T37 pre-publish check (2026-09-04) — the tarball had no command at all for an
 * installing user to run the core feature (inventory file scan + low-stock alert)
 * (`npm run agent:folder-scan` is a repository-only script). The two agents are exposed as the
 * `retail-mcp-scan`/`retail-mcp-reorder` bins and, in the same way as the migrate bin, we check
 * "is it in the package, executable, and does it exit with a cause+fix error when required
 * settings are missing". The actual scan/send paths are verified by tests/folderScan.test.ts and
 * tests/reorderAgent.test.ts with PGlite/mocks.
 */
async function verifyAgentBin(
  step: string,
  binName: string,
  envOverrides: { unset: string[]; set: Record<string, string> },
  expectedMention: string,
  installDir: string,
): Promise<void> {
  heading(
    `${step} Run ${binName} bin — check packaging and guidance error when required settings are missing`,
  );
  const binPath = path.join(installDir, "node_modules", ".bin", binName);
  await assertExecutable(binPath);

  const { spawnSync } = await import("node:child_process");
  const env: Record<string, string | undefined> = { ...process.env, ...envOverrides.set };
  for (const key of envOverrides.unset) delete env[key];
  // Each bin gets its own working folder so embedded PGlite can create `.retail-mcp/data` under cwd.
  const runCwd = path.join(installDir, `${binName}-run`);
  await mkdir(runCwd, { recursive: true });
  const result = spawnSync(binPath, [], { cwd: runCwd, encoding: "utf8", env });

  if (result.status === 0) {
    throw new Error(
      `${binName} succeeded (exit 0) even without the required setting (${expectedMention}) — the guard that blocks with an error when it is missing may be broken.`,
    );
  }
  if (!result.stderr.includes(expectedMention)) {
    throw new Error(
      `${binName}'s error message does not mention ${expectedMention}:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  console.log(
    `bin executable confirmed + exits with guidance error when ${expectedMention} is missing`,
  );
}

/**
 * The "approved exception with recorded rationale and expiry date" of SEC-006 (review 005, TASKS
 * T32) — the `uuid@^8.3.0` pinned by exceljs@4.4.0 is affected by GHSA-w5hq-g745-h8pq (bounds
 * check flaw when passing buf to uuid v3/v5/v6, affected range "<11.1.1"). exceljs only calls
 * `uuidv4()` with no arguments (v4, no buf — confirmed in
 * `node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`) and never reaches the
 * vulnerable code path. The `overrides` in package.json bumped uuid to 11.1.1 in the dev checkout,
 * but **npm `overrides` are not applied when this package is installed as a dependency of another
 * project** — installing the actually published tarball into a completely fresh project, as this
 * script does, resolved uuid@8.3.2 unchanged (found during implementation). So the `npm audit` of
 * the dev checkout alone hides this defect — the real state is only known by re-checking against
 * **the directory where the actual tarball was installed** here. Review deadline: **2027-03-03**
 * (re-check whether exceljs has bumped its uuid dependency — if still not, revisit patching or an
 * alternative library).
 *
 * The verdict logic (advisory URL extraction + allowlist comparison) was moved to
 * `src/core/auditAllowlist.ts` (TASKS T35) — `scripts/auditLockfile.ts` (CI on every PR, dev
 * lockfile-based) needed the same logic. The approved list, rationale and review deadline comment
 * that lived here also moved to that file.
 */
async function verifyDependencyAudit(
  installDir: string,
  policy: AuditUnavailablePolicy,
): Promise<void> {
  heading(
    `8) npm audit — vulnerability check against the directory where the published tarball was actually installed (when unavailable: ${policy})`,
  );
  // Limited retries when no valid report is obtained (`src/adapters/npmAudit.ts` — 90 s cap per attempt).
  // If still invalid after all retries, the outcome depends on `policy` — the verdict itself is made
  // by the pure function `evaluateTarballAudit` (src/core/tarballAuditPolicy.ts); only enforcement happens here.
  //
  // - `fail` (default, `prepublishOnly` = actual publish path): "could not verify" also blocks (SR2-AUD-001, fail-closed).
  // - `warn` (explicitly enabled by the CI `test` matrix): only "could not verify" passes with a warning —
  //   unapproved vulnerabilities and expired exceptions always block regardless of policy. Introduced by
  //   user delegation after the 2026-09-04 registry outage made PRs #72-#74 unmergeable one after
  //   another (rationale in the tarballAuditPolicy.ts module comment).
  const stdout = await runNpmAuditJsonWithRetry({ cwd: installDir });
  // The reference time for expiry is captured explicitly once here (SR2-AUD-003) — for the release
  // gate, the system clock at the time a human runs it is the right one.
  const verdict = evaluateTarballAudit(stdout, new Date());

  if (shouldBlock(verdict, policy)) {
    switch (verdict.kind) {
      case "unavailable":
        throw new Error(
          `${verdict.detail}\nThe release gate (policy fail) does not let this state through — check the network/registry ` +
            "status and try again.",
        );
      case "unexpected":
        throw new Error(
          `New unapproved vulnerabilities were found in the published tarball: ${verdict.urls.join(", ")} — ` +
            "review docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md SEC-006.",
        );
      case "expired":
        // SR2-AUD-003 — the review deadline of an approved exception has passed. Previously the
        // deadline lived only in a comment and the release gate kept passing after it. This is the
        // decision right before publishing, so it is fail-closed.
        throw new Error(
          "The review deadline of an approved audit exception has passed: " +
            verdict.expired.map((e) => `${e.url} (deadline ${e.expiresAt})`).join(", ") +
            " — fix at the root (upgrade/replace the dependency), or re-review, update the rationale and " +
            "extend expiresAt in src/core/auditAllowlist.ts ACCEPTED_ADVISORIES (docs/005 SEC-006). " +
            "Publishing with an expired exception is not allowed.",
        );
      case "pass":
        break; // shouldBlock never returns true for pass — for type exhaustiveness.
    }
  }

  if (verdict.kind === "unavailable") {
    console.warn(
      `⚠ ${verdict.detail}\n  Passing with a warning under the PR gate policy (warn). The audit result of this tarball is ` +
        "always re-checked in `prepublishOnly` (policy fail) right before actual publishing — that step does not " +
        "pass without a valid report.",
    );
    return;
  }
  if (verdict.kind === "pass" && verdict.noneFound) {
    console.log(
      "0 vulnerabilities — the exceljs/uuid approved exception (SEC-006) may no longer be needed. " +
        "Update docs/005 and ACCEPTED_ADVISORIES in src/core/auditAllowlist.ts.",
    );
  } else if (verdict.kind === "pass") {
    const described = ACCEPTED_ADVISORIES.map((a) => `${a.url} (review deadline ${a.expiresAt})`);
    console.log(`Only approved exceptions found (${described.join(", ")}) — docs/005 SEC-006.`);
  }
}

async function main(): Promise<void> {
  // `--audit-unavailable=fail|warn` — absent means fail (publish-path default). An invalid value is
  // thrown right here (so it is never silently relaxed by the time step 6 is reached).
  const auditPolicy = parseAuditUnavailablePolicy(
    parseNamedArg(process.argv, AUDIT_UNAVAILABLE_FLAG),
  );
  const workDir = await mkdtemp(path.join(tmpdir(), "retail-mcp-verify-pack-"));
  const installDir = path.join(workDir, "install");
  await mkdir(installDir, { recursive: true });

  try {
    const tarballPath = packTarball(workDir);
    await installFresh(tarballPath, installDir);
    await verifyMcpServerBin(installDir);
    await verifyOnboardBin(installDir);
    await verifyMigrateBin(installDir);
    // retail-mcp-scan: guidance error when CSV_WATCH_DIR is missing in branch mode. BUSINESS_TIMEZONE
    // is provided so it does not stop at an earlier step (whichever check comes first, "exits with a
    // settings guidance error" is the point).
    await verifyAgentBin(
      "6)",
      "retail-mcp-scan",
      {
        unset: ["CSV_MODE", "CSV_WATCH_DIR", "CSV_SNAPSHOT_DIR", "DATABASE_URL"],
        set: { BUSINESS_TIMEZONE: "Asia/Manila", SEND_MODE: "dry_run" },
      },
      "CSV_WATCH_DIR",
      installDir,
    );
    // retail-mcp-reorder (Loyverse path): guidance error at the first check when BUSINESS_TIMEZONE is missing.
    await verifyAgentBin(
      "7)",
      "retail-mcp-reorder",
      { unset: ["BUSINESS_TIMEZONE", "DATABASE_URL"], set: { SEND_MODE: "dry_run" } },
      "BUSINESS_TIMEZONE",
      installDir,
    );
    await verifyDependencyAudit(installDir, auditPolicy);
    heading("All passed");
    console.log(`tarball fresh-install verification complete (temp directory: ${workDir})`);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
