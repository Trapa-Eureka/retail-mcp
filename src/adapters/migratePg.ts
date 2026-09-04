/**
 * Shared logic for safely applying/checking migrations against the `DATABASE_URL` Postgres,
 * wrapped in an advisory lock — shared by `scripts/migrate.ts` (repository-only, guardrail 5:
 * "production migrations are run by humans only") and `src/cli/migrate.ts` (npm-published bin
 * `retail-mcp-migrate`, second adversarial review SR2-REL-001).
 *
 * Originally the pool creation, client acquisition, advisory lock wiring and cleanup lived only
 * in `scripts/migrate.ts` — the two entry points may target the same DB with the same lock key
 * (MIGRATION_LOCK_KEY), and if that value were hard-coded separately in two files, someone
 * would fix one and forget the other. It is consolidated here in one place.
 */
import { Pool, type PoolClient } from "pg";
import { withAdvisoryLock } from "./advisoryLock.js";
import {
  checkPendingMigrations,
  createPgExecutor,
  loadMigrations,
  runMigrations,
  type PendingMigrationsStatus,
  type RunMigrationsResult,
} from "./migrationRunner.js";

/** Advisory lock key dedicated to migration runs. The value itself has no meaning; it only
 * needs to be "fixed, and arbitrary enough not to collide with other uses by accident". */
export const MIGRATION_LOCK_KEY = 727_100_104;

/** Applies all pending migrations while preventing concurrent runs with an advisory lock. */
export async function applyMigrationsToDatabaseUrl(
  databaseUrl: string,
): Promise<RunMigrationsResult> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client: PoolClient = await pool.connect();
  try {
    return await withAdvisoryLock(client, MIGRATION_LOCK_KEY, async () => {
      const executor = createPgExecutor(client);
      const migrations = await loadMigrations();
      return runMigrations(executor, migrations);
    });
  } finally {
    client.release();
    await pool.end();
  }
}

/** Applies nothing (read-only) and only checks the ids of pending migrations —
 * used by the default dry-run mode of `retail-mcp-migrate`. */
export async function checkPendingMigrationsForDatabaseUrl(
  databaseUrl: string,
): Promise<PendingMigrationsStatus> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const executor = createPgExecutor(pool);
    const migrations = await loadMigrations();
    return await checkPendingMigrations(executor, migrations);
  } finally {
    await pool.end();
  }
}
