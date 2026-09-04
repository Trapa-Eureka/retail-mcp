/**
 * Migration runner CLI entry point.
 *
 * Running `npm run migrate` applies migrations/*.sql to the DATABASE_URL Postgres in file-name
 * order, only those not yet applied. The history is recorded in the schema_migrations table,
 * and already applied migrations are skipped, so running it several times is safe (idempotent).
 *
 * Concurrency safety: the whole run is wrapped in an advisory lock (pg_advisory_lock) (even if
 * two processes start at the same time, only one actually applies the DDL) — the actual wiring
 * (pool/client/lock) lives in `src/adapters/migratePg.ts` (shared with `src/cli/migrate.ts`,
 * the npm-published bin `retail-mcp-migrate`, SR2-REL-001 — if the same lock key were
 * hard-coded separately in two files, someone would fix one and forget the other).
 *
 * Runs against a production DATABASE_URL are done by humans only (CLAUDE.md guardrail 5).
 *
 * The runner core logic (loadMigrations/runMigrations/executor) lives in
 * `src/adapters/migrationRunner.ts` (T14 — moved when production code needed it too). This file
 * is the CLI shell that consumes it.
 */
import { fileURLToPath } from "node:url";
import { applyMigrationsToDatabaseUrl } from "../src/adapters/migratePg.js";

export { withAdvisoryLock, type LockClient } from "../src/adapters/advisoryLock.js";
export {
  MIGRATIONS_DIR,
  checkPendingMigrations,
  computeChecksum,
  createPgExecutor,
  createPgliteExecutor,
  loadMigrations,
  runMigrations,
  type Migration,
  type PendingMigrationsStatus,
  type RunMigrationsResult,
  type SqlExecutor,
} from "../src/adapters/migrationRunner.js";
export {
  MIGRATION_LOCK_KEY,
  applyMigrationsToDatabaseUrl,
  checkPendingMigrationsForDatabaseUrl,
} from "../src/adapters/migratePg.js";

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Add the Postgres connection string issued by Neon/Supabase to .env.",
    );
  }

  const result = await applyMigrationsToDatabaseUrl(databaseUrl);
  console.log(
    `Migrations complete — applied ${result.applied.length} (${result.applied.join(", ") || "none"}), ` +
      `skipped ${result.skipped.length}`,
  );
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
