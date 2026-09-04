/**
 * Test-only PGlite warehouse helper (TESTING.md §2).
 * Creates a fresh in-process Postgres instance per test and applies migrations/*.sql with the
 * shared runner from adapters/migrationRunner.ts (loadMigrations/runMigrations), guaranteeing
 * the same schema as production (Postgres) and the same runner behaviour (file name
 * validation, history table, checksum).
 * No network calls.
 */
import { PGlite } from "@electric-sql/pglite";
import {
  createPgliteExecutor,
  loadMigrations,
  runMigrations,
} from "../adapters/migrationRunner.js";

export async function createTestWarehouse(): Promise<PGlite> {
  const db = new PGlite();
  const executor = createPgliteExecutor(db);
  const migrations = await loadMigrations();
  await runMigrations(executor, migrations);
  return db;
}
