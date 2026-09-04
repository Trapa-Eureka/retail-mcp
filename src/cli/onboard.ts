#!/usr/bin/env node
/**
 * Onboarding CLI (`npm run onboard`, TASKS T21) — asks for the branch/HQ mode, the watched
 * folder path, the low-stock threshold and recipient email, and the warehouse choice
 * (embedded by default / `DATABASE_URL` optional), saves them to `.env`, and in branch mode
 * creates an example CSV in the SPEC §12 fixed template inside the watched folder.
 *
 * npm package `bin` (TASKS T29, DESIGN §12.1) — `package.json.bin["retail-mcp-onboard"]`
 * points at the built `dist/cli/onboard.js`. When developing inside the repository, keep
 * using `npm run onboard` (runs the source directly via tsx).
 *
 * Question/answer collection (`collectOnboardAnswers`) and `.env` merging (`mergeEnvFile`)
 * are split out as pure functions — injecting `ask()` lets them be tested non-interactively
 * (with a script that pre-decides the answers) without a real terminal.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { writeFileAtomic } from "../adapters/atomicFile.js";
import { isMainModule } from "../adapters/mainModule.js";
import { exportSnapshotCsv } from "../core/snapshotExport.js";

export type AskFn = (question: string) => Promise<string>;

async function askRequired(ask: AskFn, question: string, maxAttempts = 3): Promise<string> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const answer = (await ask(question)).trim();
    if (answer !== "") return answer;
    if (attempt < maxAttempts) {
      console.log("A value is required — please enter it again.");
    }
  }
  throw new Error(
    `No value was received for "${question}" after ${maxAttempts} attempts. Prepare the value and run again.`,
  );
}

async function askWithDefault(ask: AskFn, question: string, defaultValue: string): Promise<string> {
  const answer = (await ask(`${question} (default: ${defaultValue})`)).trim();
  return answer === "" ? defaultValue : answer;
}

async function askChoice<T extends string>(
  ask: AskFn,
  question: string,
  choices: readonly T[],
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = (await ask(`${question} (${choices.join("/")})`)).trim().toLowerCase();
    if ((choices as readonly string[]).includes(raw)) return raw as T;
    if (attempt < maxAttempts) {
      console.log(`"${raw}" is not a known value — please enter one of ${choices.join(" or ")}.`);
    }
  }
  throw new Error(
    `No valid value (${choices.join("/")}) was received for "${question}" after ${maxAttempts} attempts.`,
  );
}

function isLikelyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ── Answer collection (pure logic — only ask() is injected) ─────────────────

export interface BranchOnboardAnswers {
  mode: "branch";
  /**
   * Name of this store/branch as the user wants it to appear in reports. Store and product
   * names are data, not configuration: every CSV row carries its own `store` and `product`
   * values. This answer only seeds the `store` column of the generated example template so the
   * first file the user opens already shows their own store name instead of a placeholder.
   */
  storeName: string;
  watchDir: string;
  snapshotDir: string;
  defaultLowStockThreshold: number;
  recipient: string;
  databaseUrl?: string;
  /**
   * Email sending settings (optional, added in the T37 pre-publish check) — both are needed
   * for live sending. If left empty during onboarding, `retail-mcp-scan` only previews
   * (dry-run); fill `RESEND_API_KEY`/`MAIL_FROM` in `.env` later. The values are written only
   * to `.env` (0600) and never echoed to the screen.
   */
  resendApiKey?: string;
  mailFrom?: string;
}

export interface ConsolidatedOnboardAnswers {
  mode: "consolidated";
  collectDir: string;
  databaseUrl?: string;
}

export type OnboardAnswers = BranchOnboardAnswers | ConsolidatedOnboardAnswers;

export async function collectOnboardAnswers(ask: AskFn): Promise<OnboardAnswers> {
  const mode = await askChoice(
    ask,
    "Select the connection mode — branch (a store, watches its inventory file directly) / consolidated (HQ, collects branch snapshots)",
    ["branch", "consolidated"] as const,
  );

  const databaseUrlRaw = await ask(
    "Postgres connection string to use as the warehouse (Neon/Supabase etc.)? Leave empty to use the local embedded PGlite",
  );
  const databaseUrl = databaseUrlRaw.trim() === "" ? undefined : databaseUrlRaw.trim();

  if (mode === "consolidated") {
    const collectDir = await askRequired(
      ask,
      "Path of the collection folder where branch snapshots arrive?",
    );
    return { mode, collectDir, ...(databaseUrl !== undefined ? { databaseUrl } : {}) };
  }

  const storeName = await askWithDefault(
    ask,
    "Name of this store or branch (used as the `store` value in the example template; each CSV row carries its own store name)",
    DEFAULT_EXAMPLE_STORE_NAME,
  );

  const watchDir = await askRequired(ask, "Path of the folder to watch for CSV/Excel files?");
  let snapshotDir: string;
  for (;;) {
    snapshotDir = await askRequired(
      ask,
      "Path of the folder to save snapshot CSVs to (must differ from the watched folder)?",
    );
    if (path.resolve(watchDir) !== path.resolve(snapshotDir)) break;
    console.log(
      "The watched folder and the snapshot folder are the same — please enter two different folders.",
    );
  }

  const thresholdRaw = await askWithDefault(
    ask,
    "Default low-stock threshold for items with no sales history (per-item values can be set in the CSV low_stock_threshold column)",
    "5",
  );
  const defaultLowStockThreshold = Number(thresholdRaw);
  if (!Number.isFinite(defaultLowStockThreshold) || defaultLowStockThreshold < 0) {
    throw new Error(
      `Invalid low-stock threshold: "${thresholdRaw}". It must be a number of 0 or more.`,
    );
  }

  let recipient: string;
  for (;;) {
    recipient = await askRequired(ask, "Email address that should receive low-stock alerts?");
    if (isLikelyEmail(recipient)) break;
    console.log(`"${recipient}" is not a valid email address — please enter it again.`);
  }

  // Email sending settings (optional). Live sending needs both a Resend API key and a sender
  // address — if the key is left empty, explain that only preview (dry-run) is available and
  // do not ask for the sender address. If a key is given but no sender address, sending would
  // fail, so in that case the sender address is required.
  const resendApiKeyRaw = (
    await ask(
      "Resend API key for sending email (starts with re_, issued at resend.com > API Keys)? " +
        "Leave empty to only preview (dry-run) for now and fill the sending settings in .env later",
    )
  ).trim();
  let mailFrom: string | undefined;
  if (resendApiKeyRaw !== "") {
    for (;;) {
      mailFrom = await askRequired(
        ask,
        "Sender email address (an address on a domain verified in Resend, e.g. alerts@yourdomain.com)?",
      );
      if (isLikelyEmail(mailFrom)) break;
      console.log(`"${mailFrom}" is not a valid email address — please enter it again.`);
    }
  }

  return {
    mode,
    storeName,
    watchDir,
    snapshotDir,
    defaultLowStockThreshold,
    recipient,
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    ...(resendApiKeyRaw !== "" ? { resendApiKey: resendApiKeyRaw } : {}),
    ...(mailFrom !== undefined ? { mailFrom } : {}),
  };
}

// ── .env merge (preserves existing content, only updates/adds managed keys) ─

/** If a line for a key in `updates` already exists, replace its value; otherwise append it at the end of the file. */
export function mergeEnvFile(
  existing: string,
  updates: Record<string, string | undefined>,
): string {
  const existingLines = existing.split("\n");
  const keysHandled = new Set<string>();

  const updatedLines = existingLines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match) return line;
    const key = match[1]!;
    if (!(key in updates)) return line;
    keysHandled.add(key);
    const value = updates[key];
    return value === undefined ? line : `${key}=${value}`;
  });

  const toAppend = Object.entries(updates).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !keysHandled.has(entry[0]),
  );
  if (toAppend.length === 0) return updatedLines.join("\n");

  const isBlankFile = updatedLines.length === 1 && updatedLines[0] === "";
  const header = isBlankFile ? [] : updatedLines;
  const appendedLines = toAppend.map(([key, value]) => `${key}=${value}`);
  return (
    [
      ...header,
      ...(header.length > 0 ? [""] : []),
      "# --- added by onboarding (npm run onboard) ---",
      ...appendedLines,
    ].join("\n") + "\n"
  );
}

/** Converts answers into the key=value map managed in .env (undefined when there is no value — mergeEnvFile leaves those alone). */
export function envUpdatesFor(answers: OnboardAnswers): Record<string, string | undefined> {
  const shared: Record<string, string | undefined> = {
    CSV_MODE: answers.mode,
    DATABASE_URL: answers.databaseUrl,
  };
  if (answers.mode === "consolidated") {
    return { ...shared, CSV_COLLECT_DIR: answers.collectDir };
  }
  return {
    ...shared,
    CSV_WATCH_DIR: answers.watchDir,
    CSV_SNAPSHOT_DIR: answers.snapshotDir,
    CSV_DEFAULT_LOW_STOCK_THRESHOLD: String(answers.defaultLowStockThreshold),
    REPORT_RECIPIENT: answers.recipient,
    // Empty → undefined → mergeEnvFile leaves any existing line untouched (preserves values already filled in).
    RESEND_API_KEY: answers.resendApiKey,
    MAIL_FROM: answers.mailFrom,
  };
}

// ── Example template file (branch mode) ─────────────────────────────────────

/** Placeholder store name for the example template when onboarding is not used (e.g. tests). */
export const DEFAULT_EXAMPLE_STORE_NAME = "Main Store";

/** One-row example CSV in exactly the SPEC §12 fixed template header/format — reuses the T19
 * export as is. `storeName` is the onboarding answer; product name/SKU stay placeholders because
 * products are per-row data the user fills in. */
export function buildExampleTemplateCsv(
  now: Date = new Date(),
  storeName: string = DEFAULT_EXAMPLE_STORE_NAME,
): string {
  return exportSnapshotCsv({
    inventory: [{ storeId: storeName, variantId: "SKU-EXAMPLE", inStock: "10", updatedAt: now }],
    products: [
      {
        variantId: "SKU-EXAMPLE",
        itemId: "SKU-EXAMPLE",
        name: "Example Product",
        sku: "SKU-EXAMPLE",
        category: null,
        lowStockThreshold: "5",
      },
    ],
    salesPeriodAgg: [],
  });
}

// ── CLI entry point ─────────────────────────────────────────────────────────

const ENV_PATH = ".env";
const EXAMPLE_TEMPLATE_FILE_NAME = "template-example.csv";

async function readExistingEnv(): Promise<string> {
  try {
    return await readFile(ENV_PATH, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Writes `.env` atomically with 0o600 permissions (SEC-005, TASKS T32) — it holds sensitive
 * data such as DATABASE_URL and email addresses, so only the owner may read/write it.
 * `writeFileAtomic` creates a fresh temp file as 0o600 and then replaces via rename, so even
 * if the existing `.env` had looser permissions (e.g. 0o644 created by umask), after the
 * rename it always carries the new inode's permissions (0o600) — every onboarding run is
 * itself the fix, with no separate "check and repair existing file permissions" step
 * (rename(2) replaces the old inode at the target path with a completely new inode — the old
 * file's permissions do not carry over). Kept separate from `main()` so it can be tested
 * directly without a real readline.
 */
export async function writeEnvFile(envPath: string, content: string): Promise<void> {
  await writeFileAtomic(envPath, content, { mode: 0o600 });
}

/**
 * Builds an `AskFn` that pulls one line at a time from `rl`'s async iterator instead of
 * calling `rl.question()` repeatedly.
 *
 * Found during work (QA-001 tarball smoke test, `scripts/verifyPack.ts`) — with piped
 * non-interactive input (`printf "a\nb\nc" | retail-mcp-onboard`, the usual way for CI/script
 * onboarding), calling `readline/promises`' `rl.question()` several times in sequence means
 * **only the first question receives an answer and the following ones hang forever** — when
 * stdin is not a TTY, the remaining lines already sitting in the pipe are consumed before
 * `question()` registers its next listener; this is known Node behaviour (when a person types
 * line by line in a terminal each line arrives late, so the problem never shows — and the
 * unit tests of `collectOnboardAnswers` inject `ask()` without going through a real
 * `readline`, which hid this defect). Explicitly pulling one line at a time from the async
 * iterator is safe for both TTY and pipes — the same mechanism as the `for await...of rl`
 * consumption pattern recommended by the official Node docs.
 */
function createReadlineAsk(rl: ReturnType<typeof createInterface>): AskFn {
  const lines = rl[Symbol.asyncIterator]();
  return async (question) => {
    process.stdout.write(`${question}: `);
    const { value, done } = await lines.next();
    return done || value === undefined ? "" : value;
  };
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = createReadlineAsk(rl);
    const answers = await collectOnboardAnswers(ask);

    const existingEnv = await readExistingEnv();
    const merged = mergeEnvFile(existingEnv, envUpdatesFor(answers));
    await writeEnvFile(ENV_PATH, merged);
    console.log(`Settings saved to ${ENV_PATH} (permissions 0600).`);

    if (answers.mode === "branch") {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(answers.watchDir, { recursive: true });
      const templatePath = path.join(answers.watchDir, EXAMPLE_TEMPLATE_FILE_NAME);
      await writeFile(templatePath, buildExampleTemplateCsv(new Date(), answers.storeName), "utf8");
      console.log(
        `Created an example template file: ${templatePath}\n` +
          "Open this file and fill it with your real inventory data, or replace it with a file in the same format.",
      );
    }

    // Both installed users (npm bin) and repository developers (npm run) read this, so both commands are listed.
    const hasSending = answers.mode === "branch" && answers.resendApiKey !== undefined;
    console.log(
      [
        "Onboarding complete.",
        "Next: run `retail-mcp-scan` (in the repository: `npm run agent:folder-scan`) once from the same folder and check the result.",
        "  The default is preview (SEND_MODE=dry_run), so no email is sent — the result is only printed to the screen.",
        hasSending
          ? "To enable live sending, set SEND_MODE to live in .env, run `retail-mcp-scan --confirm` manually once to verify delivery, and then register it for automatic runs (cron)."
          : 'To enable live sending, fill RESEND_API_KEY and MAIL_FROM in .env, set SEND_MODE to live, and run `retail-mcp-scan --confirm` manually once to verify delivery (README "5. Enable email sending").',
      ].join("\n"),
    );
  } finally {
    rl.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
