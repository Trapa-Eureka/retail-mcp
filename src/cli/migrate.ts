#!/usr/bin/env node
/**
 * Migration CLI for the npm package (`retail-mcp-migrate`) — second adversarial review
 * SR2-REL-001.
 *
 * npm-installed users who chose `DATABASE_URL` (network Postgres such as Neon/Supabase) had no
 * official command inside the published package to apply the schema — `scripts/migrate.ts` is
 * repository-only and not included in the npm package (CLAUDE.md source layout), and
 * `package.json.bin` registered only server/onboard. This file closes that gap —
 * `package.json.bin["retail-mcp-migrate"]` points at the built `dist/cli/migrate.js`.
 *
 * The actual apply/check logic (including the advisory lock) is shared with `scripts/migrate.ts`
 * (repository-only) through `src/adapters/migratePg.ts`. However, this bin must be safe for
 * someone who just installed it from npm and is using it for the first time, so it adds one more
 * human-confirmation guard — the default is **dry-run** (shows only the target DB host/db name
 * and the list of pending migrations, applies nothing), and actually applying requires an
 * explicit `--confirm` (the same pattern as guardrail 1's `SEND_MODE=dry_run` + `--confirm`
 * double gate, applied to migrations). CLAUDE.md guardrail 5 ("production migrations are run
 * by humans only") still holds with this bin — this gate additionally prevents that "human"
 * from accidentally running it unconfirmed inside an automation pipeline.
 *
 * The raw `DATABASE_URL` (including credentials) is never written to any output (CLAUDE.md
 * implementation notes) — only host/db name is shown (describeTarget).
 */
import { isMainModule } from "../adapters/mainModule.js";
import {
  applyMigrationsToDatabaseUrl,
  checkPendingMigrationsForDatabaseUrl,
} from "../adapters/migratePg.js";

/** Extracts only host[:port]/dbname from DATABASE_URL, without credentials — so the raw value
 * never reaches the logs. Even if parsing itself fails (a malformed value) it does not throw
 * and substitutes a notice instead. */
export function describeTarget(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(could not parse the connection string, so the target cannot be shown)";
  }
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Add the Postgres connection string issued by Neon/Supabase etc. to .env.",
    );
  }

  const target = describeTarget(databaseUrl);
  const confirm = argv.includes("--confirm");

  if (!confirm) {
    const { pending } = await checkPendingMigrationsForDatabaseUrl(databaseUrl);
    if (pending.length === 0) {
      console.log(`[dry-run] target: ${target} — no pending migrations. Nothing to run.`);
      return;
    }
    console.log(
      `[dry-run] target: ${target}\n` +
        `Migrations to apply (${pending.length}): ${pending.join(", ")}\n` +
        "To actually apply them, run again with --confirm: retail-mcp-migrate --confirm",
    );
    return;
  }

  console.log(`target: ${target} — applying migrations...`);
  const result = await applyMigrationsToDatabaseUrl(databaseUrl);
  console.log(
    `Migrations complete — applied ${result.applied.length} (${result.applied.join(", ") || "none"}), ` +
      `skipped ${result.skipped.length}`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
