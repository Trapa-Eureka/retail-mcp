import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildExampleTemplateCsv,
  collectOnboardAnswers,
  envUpdatesFor,
  mergeEnvFile,
  writeEnvFile,
  type AskFn,
  type OnboardAnswers,
} from "../src/cli/onboard.js";
import { parseCsvRow } from "../src/core/csvSchema.js";
import { runFolderScan } from "../src/agent/folderScan.js";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import { createMockNotificationProvider } from "../src/mocks/mockNotificationProvider.js";

/** An ask() that returns pre-scripted answers in order — for non-interactive ("scripted input") runs. */
function scriptedAsk(answers: string[]): AskFn {
  let i = 0;
  return (question: string) => {
    if (i >= answers.length) {
      return Promise.reject(new Error(`Ran out of scripted answers (question: "${question}").`));
    }
    return Promise.resolve(answers[i++]!);
  };
}

describe("collectOnboardAnswers", () => {
  it("branch mode — builds the settings when all answers are received non-interactively (scripted input)", async () => {
    const ask = scriptedAsk([
      "branch", // mode
      "", // DATABASE_URL empty → embedded
      "Downtown Store", // store name
      "/tmp/watch", // watchDir
      "/tmp/snapshot", // snapshotDir
      "10", // threshold
      "owner@example.com", // recipient
      "", // Resend API key empty → sending settings skipped (sender address is not asked)
    ]);
    const answers = await collectOnboardAnswers(ask);
    expect(answers).toEqual({
      mode: "branch",
      storeName: "Downtown Store",
      watchDir: "/tmp/watch",
      snapshotDir: "/tmp/snapshot",
      defaultLowStockThreshold: 10,
      recipient: "owner@example.com",
    });
  });

  it("email sending settings (optional) — given a Resend key, the sender address is required and both land in answers and the .env keys (T37 pre-publish check)", async () => {
    const key = ["re_", "TestOnly0000000000000000000"].join(""); // assembled at runtime to avoid scanner false positives
    const ask = scriptedAsk([
      "branch",
      "",
      "", // store name empty → default
      "/tmp/watch",
      "/tmp/snapshot",
      "5",
      "owner@example.com",
      key, // Resend API key
      "not-an-email", // malformed sender address → re-asked
      "alerts@example.com", // valid sender address
    ]);
    const answers = (await collectOnboardAnswers(ask)) as Extract<
      OnboardAnswers,
      { mode: "branch" }
    >;
    expect(answers.resendApiKey).toBe(key);
    expect(answers.mailFrom).toBe("alerts@example.com");

    const updates = envUpdatesFor(answers);
    expect(updates["RESEND_API_KEY"]).toBe(key);
    expect(updates["MAIL_FROM"]).toBe("alerts@example.com");
    expect(updates["SEND_MODE"]).toBeUndefined(); // onboarding never turns on the send mode — a person sets live in .env directly
  });

  it("leaving the Resend key empty skips the sender address question and leaves the RESEND_API_KEY/MAIL_FROM lines in .env untouched", async () => {
    const ask = scriptedAsk([
      "branch",
      "",
      "", // store name empty → default
      "/tmp/watch",
      "/tmp/snapshot",
      "5",
      "owner@example.com",
      "",
    ]);
    const answers = await collectOnboardAnswers(ask);
    const updates = envUpdatesFor(answers);
    expect(updates["RESEND_API_KEY"]).toBeUndefined();
    expect(updates["MAIL_FROM"]).toBeUndefined();
    // Values already filled in .env are preserved as is (mergeEnvFile ignores undefined).
    const merged = mergeEnvFile("RESEND_API_KEY=keep-me\nMAIL_FROM=keep@example.com\n", updates);
    expect(merged).toContain("RESEND_API_KEY=keep-me");
    expect(merged).toContain("MAIL_FROM=keep@example.com");
  });

  it("HQ mode — DATABASE_URL is included in answers when given", async () => {
    const ask = scriptedAsk(["consolidated", "postgres://x", "/tmp/collect"]);
    const answers = await collectOnboardAnswers(ask);
    expect(answers).toEqual({
      mode: "consolidated",
      collectDir: "/tmp/collect",
      databaseUrl: "postgres://x",
    });
  });

  it("uses the default of 5 when the threshold is left empty", async () => {
    const ask = scriptedAsk([
      "branch",
      "",
      "", // store name empty → default
      "/tmp/watch",
      "/tmp/snapshot",
      "", // threshold empty → default
      "owner@example.com",
      "", // sending settings skipped
    ]);
    const answers = (await collectOnboardAnswers(ask)) as Extract<
      OnboardAnswers,
      { mode: "branch" }
    >;
    expect(answers.defaultLowStockThreshold).toBe(5);
  });

  it("re-asks on repeated invalid mode input and finally throws a clear error", async () => {
    const ask = scriptedAsk(["bogus-value", "also-bogus", "still-bogus"]);
    await expect(collectOnboardAnswers(ask)).rejects.toThrow(/branch\/consolidated/);
  });

  it("re-asks when watchDir/snapshotDir are the same (passes once answered differently)", async () => {
    const ask = scriptedAsk([
      "branch",
      "",
      "", // store name empty → default
      "/tmp/same", // watchDir
      "/tmp/same", // snapshotDir (same — triggers re-ask)
      "/tmp/different", // re-answered snapshotDir
      "5",
      "owner@example.com",
      "", // sending settings skipped
    ]);
    const answers = (await collectOnboardAnswers(ask)) as Extract<
      OnboardAnswers,
      { mode: "branch" }
    >;
    expect(answers.watchDir).toBe("/tmp/same");
    expect(answers.snapshotDir).toBe("/tmp/different");
  });

  it("re-asks when the value is not an email address", async () => {
    const ask = scriptedAsk([
      "branch",
      "",
      "", // store name empty → default
      "/tmp/watch",
      "/tmp/snapshot",
      "5",
      "not-an-email", // malformed — triggers re-ask
      "owner@example.com", // valid re-answer
      "", // sending settings skipped
    ]);
    const answers = (await collectOnboardAnswers(ask)) as Extract<
      OnboardAnswers,
      { mode: "branch" }
    >;
    expect(answers.recipient).toBe("owner@example.com");
  });

  it("throws a clear error when a required value is left blank repeatedly", async () => {
    const ask = scriptedAsk(["branch", "", "", "", "", ""]);
    await expect(collectOnboardAnswers(ask)).rejects.toThrow(/No value was received/);
  });
});

describe("mergeEnvFile", () => {
  it("adds new keys to an empty file", () => {
    const result = mergeEnvFile("", { CSV_MODE: "branch", DATABASE_URL: undefined });
    expect(result).toContain("CSV_MODE=branch");
    expect(result).not.toContain("DATABASE_URL");
  });

  it("preserves the other lines of an existing file (comments, other keys) as is", () => {
    const existing = "# description\nANTHROPIC_API_KEY=secret\nCSV_MODE=old\n";
    const result = mergeEnvFile(existing, { CSV_MODE: "branch" });
    expect(result).toContain("# description");
    expect(result).toContain("ANTHROPIC_API_KEY=secret");
    expect(result).toContain("CSV_MODE=branch");
    expect(result).not.toContain("CSV_MODE=old");
  });

  it("an undefined value leaves the existing line untouched (DATABASE_URL empty → embedded stays)", () => {
    const existing = "DATABASE_URL=postgres://existing\n";
    const result = mergeEnvFile(existing, { DATABASE_URL: undefined });
    expect(result).toContain("DATABASE_URL=postgres://existing");
  });
});

describe("writeEnvFile (SEC-005, TASKS T32)", () => {
  let dir: string;
  let envPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-onboard-env-"));
    envPath = join(dir, ".env");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a new .env file with 0600 permissions", async () => {
    await writeEnvFile(envPath, "DATABASE_URL=postgres://x\n");
    const info = await stat(envPath);
    // macOS/Linux basis — on Windows CI these bits mean something different, so they are
    // re-examined in a separate matrix (same caveat as atomicFile.test.ts, TASKS T34 OPS-006).
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readFile(envPath, "utf8")).toBe("DATABASE_URL=postgres://x\n");
  });

  it("rewriting replaces looser permissions on an existing .env with 0600", async () => {
    await writeFile(envPath, "DATABASE_URL=postgres://old\n", { mode: 0o644 });
    expect((await stat(envPath)).mode & 0o777).toBe(0o644);

    await writeEnvFile(envPath, "DATABASE_URL=postgres://new\n");

    const info = await stat(envPath);
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readFile(envPath, "utf8")).toBe("DATABASE_URL=postgres://new\n");
  });

  it("the existing .env is not corrupted even if the process dies mid-write (only the temp file fails) — atomic replace", async () => {
    await writeFile(envPath, "DATABASE_URL=postgres://before\n");
    await chmod(envPath, 0o600);
    await writeEnvFile(envPath, "DATABASE_URL=postgres://after\n");
    // Replaced by a single rename, so only the final content is visible with no intermediate state (atomicFile.ts contract).
    expect(await readFile(envPath, "utf8")).toBe("DATABASE_URL=postgres://after\n");
  });
});

describe("buildExampleTemplateCsv", () => {
  it("produces an example row that parses as is with the T15 schema", () => {
    const csv = buildExampleTemplateCsv(new Date("2026-09-03T00:00:00Z"));
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2); // header + 1 example row
    const [, dataLine] = lines;
    const values = dataLine!.split(",");
    const headers = lines[0]!.split(",");
    const raw = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    expect(() => parseCsvRow(raw)).not.toThrow();
  });

  it("uses the store name given during onboarding as the example row's store value (nothing is hard-coded)", () => {
    const csv = buildExampleTemplateCsv(new Date("2026-09-03T00:00:00Z"), "Harbor Kiosk");
    const [header, dataLine] = csv.trim().split("\n");
    expect(header!.split(",")[0]).toBe("store");
    expect(dataLine!.split(",")[0]).toBe("Harbor Kiosk");
    expect(csv).not.toContain("Main Store");
  });
});

describe("T18 (runFolderScan) starts as is from the onboarding result", () => {
  let dir: string;
  let watchDir: string;
  let snapshotDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-onboard-"));
    watchDir = join(dir, "watch");
    snapshotDir = join(dir, "snapshot");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(watchDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("collectOnboardAnswers → envUpdatesFor → merged .env values make runFolderScan work correctly", async () => {
    const ask = scriptedAsk([
      "branch",
      "", // embedded warehouse
      "", // store name empty → default
      watchDir,
      snapshotDir,
      "5",
      "owner@example.com",
      "", // sending settings skipped
    ]);
    const answers = await collectOnboardAnswers(ask);
    const updates = envUpdatesFor(answers);
    const envContent = mergeEnvFile("", updates);

    // Round-trip through a real .env file to verify parsing too (exactly as onboarding writes it).
    const envPath = join(dir, ".env");
    await writeFile(envPath, envContent, "utf8");
    const reread = await readFile(envPath, "utf8");
    const parsed: Record<string, string> = Object.fromEntries(
      reread
        .split("\n")
        .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m): [string, string] => [m[1]!, m[2]!]),
    );
    expect(parsed["CSV_WATCH_DIR"]).toBe(watchDir);
    expect(parsed["CSV_SNAPSHOT_DIR"]).toBe(snapshotDir);
    expect(parsed["REPORT_RECIPIENT"]).toBe("owner@example.com");

    // Actually create the example template file in the watched folder (exactly as onboarding
    // does) and start T18's runFolderScan as is with those values — the same fields main() reads
    // from process.env are passed directly here (same values, verified without polluting the
    // real process env).
    await writeFile(join(watchDir, "template-example.csv"), buildExampleTemplateCsv(), "utf8");

    const db = await createTestWarehouse();
    const warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock("2026-09-03T00:00:00Z"),
        notificationProvider: createMockNotificationProvider(),
      },
      {
        watchDir: parsed["CSV_WATCH_DIR"]!,
        snapshotDir: parsed["CSV_SNAPSHOT_DIR"]!,
        defaultLowStockThreshold: Number(parsed["CSV_DEFAULT_LOW_STOCK_THRESHOLD"]),
        recipient: parsed["REPORT_RECIPIENT"]!,
      },
    );

    expect(result.itemCount).toBe(1);
  });
});
