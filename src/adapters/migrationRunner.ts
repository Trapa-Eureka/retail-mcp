/**
 * Migration runner core logic — reused by both pg (Postgres) and PGlite.
 *
 * Originally lived only in `scripts/migrate.ts`, but T14 (embedded PGlite warehouse as the
 * default) made production code (`server.ts`/`agent/reorder.ts`) need it too, so it moved
 * here — to avoid the wrong dependency direction of `src` depending on `scripts` (same
 * precedent as advisoryLock.ts: scripts may depend on src, but not the other way round).
 * `scripts/migrate.ts` is now a CLI entry point that consumes this module (a human runs it
 * against the production DATABASE_URL, guardrail 5), and `src/mocks/pglite.ts` (test-only
 * PGlite warehouse) imports from here as well.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool as PoolType } from "pg";

export const MIGRATIONS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../migrations");

/** Migration file naming rule: `{3-digit sequence}_{description}.sql` (e.g. 001_init.sql). The id is the file name without extension. */
const MIGRATION_ID_PATTERN = /^[0-9]{3}_[a-z0-9_]+$/;

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
}

/** SQL executor — minimal interface so that pg (Pool/PoolClient) and PGlite can be handled the same way. */
export interface SqlExecutor {
  /** Executes parameterless SQL (multiple statements allowed). Result rows are not used. */
  exec(sql: string): Promise<void>;
  /** Executes a single query whose result rows are needed. */
  query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>;
}

/** pg's Pool and PoolClient share the same query() signature. */
type PgQueryable = Pick<PoolType, "query">;

export function createPgExecutor(client: PgQueryable): SqlExecutor {
  return {
    async exec(sql) {
      await client.query(sql);
    },
    async query<T extends Record<string, unknown>>(sql: string) {
      const result = await client.query<T>(sql);
      return { rows: result.rows };
    },
  };
}

/** Wraps a PGlite instance as a SqlExecutor. Only the interface matters, so the concrete type is taken as unknown. */
export function createPgliteExecutor(db: {
  exec(sql: string): Promise<unknown>;
  query(sql: string): Promise<{ rows: unknown[] }>;
}): SqlExecutor {
  return {
    async exec(sql) {
      await db.exec(sql);
    },
    async query<T extends Record<string, unknown>>(sql: string) {
      const result = await db.query(sql);
      return { rows: result.rows as T[] };
    },
  };
}

/**
 * Checksum input normalisation (2026-09-04, English translation of the repository): full-line
 * `--` comments and blank lines are dropped and trailing whitespace is trimmed before hashing,
 * so that editing a comment in an applied migration file no longer counts as "content changed".
 * Anything that can affect the database — statements, identifiers, inline trailing comments'
 * code part, string literals — is still hashed byte-for-byte. Both sides (file and recorded
 * value) go through the same function, so the guard stays deterministic.
 */
export function normalizeMigrationSql(sql: string): string {
  return sql
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0 && !line.trimStart().startsWith("--"))
    .join("\n");
}

export function computeChecksum(sql: string): string {
  return createHash("sha256").update(normalizeMigrationSql(sql), "utf8").digest("hex");
}

/**
 * Checksums that 0.1.0 (the first npm publish, 2026-09-04) recorded in `schema_migrations` —
 * sha256 over the *raw* file contents, which at that time carried Korean comments. The
 * repository was translated to English afterwards (comments only; `normalizeMigrationSql` of
 * every file is unchanged), and the hashing itself moved to the normalised form above. A DB
 * migrated by 0.1.0 therefore holds one of these values for each id; `runMigrations` accepts
 * exactly this recorded value once, rewrites it to the current checksum and moves on. Any other
 * mismatch still aborts. Never add a migration here that was actually changed in substance.
 */
export const LEGACY_RAW_CHECKSUMS: Readonly<Record<string, string>> = {
  "001_init": "49effa177222ba43c0dccd8ee13d1cac4a9488b6d567dc8db24740ffcb732bbd",
  "002_sales_period_agg": "68514f835799c9c327c760e47584adc71e168013810627a60945809f0bc8979b",
  "003_product_low_stock_threshold":
    "7da18e493353c4e787e965404fe8b41a7451f17aefb7c61af58abe6641f98d52",
  "004_purchase_receipts": "ac44f4516552ef6dc68568dcd3d02e02e9b1fb3bad45982f8a4fab0e7b205485",
  "005_product_pack_size": "81927c335b176229d14a5fb63b310369e59a1b22a3f71c76483ce138823c48b5",
  "006_tombstone_active_flag": "452e4a6d58aaae3f65d10ddbc283907c56b47b65e5c5449ea520226304ced730",
  "007_agent_send_log_unchanged_status":
    "ac6c7ebc70cc7ff9b2c42eae40b45136ec77095a71307433307de25ecac9cd7f",
  "008_agent_send_log_unknown_status":
    "137203ab0b4ae9fc0aa306dd00fa6c6d2f955f1e7414c6ed397845d7732dc9d1",
};

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    if (!MIGRATION_ID_PATTERN.test(id)) {
      throw new Error(
        `Migration file name does not follow the naming rule: ${file}. ` +
          `Rename it to the {3-digit sequence}_{description}.sql format (e.g. 001_init.sql).`,
      );
    }
    const sql = await readFile(path.join(dir, file), "utf8");
    migrations.push({ id, sql, checksum: computeChecksum(sql) });
  }
  return migrations;
}

export interface RunMigrationsResult {
  applied: string[];
  skipped: string[];
  /** Ids whose recorded 0.1.0 raw checksum was replaced by the current normalised checksum
   * (see `LEGACY_RAW_CHECKSUMS`). Always a subset of `skipped`. */
  rebaselined: string[];
}

/** Postgres SQLSTATE — the table being queried does not exist. Both pg and PGlite throw the
 * same code (verified by direct reproduction). */
const UNDEFINED_TABLE_SQLSTATE = "42P01";

function isUndefinedTableError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: unknown }).code === UNDEFINED_TABLE_SQLSTATE
  );
}

export interface PendingMigrationsStatus {
  /** Ids of migrations not yet applied (in file order). */
  pending: string[];
}

/** Minimal read-only interface — `checkPendingMigrations` writes nothing, so it does not
 * require the full `SqlExecutor` with `exec()` (a `SqlExecutor` still satisfies this type
 * as-is, so existing callers need no change). */
export type QueryOnlyExecutor = Pick<SqlExecutor, "query">;

/**
 * Second adversarial review SR2-REL-001 — applies nothing (read-only) and only checks
 * whether pending migrations exist. Shared by the network Postgres startup pre-check in
 * `warehouseFactory.ts` and the dry-run mode of `retail-mcp-migrate` — the goal is to turn a
 * raw Postgres error ("relation ... does not exist") into a message that says what to do.
 *
 * If the `schema_migrations` table itself does not exist (a completely empty DB), everything
 * is considered pending. Any other query failure (connection lost, no permission, etc.) does
 * not mean "migrations are needed" at all, so it is rethrown as-is — a real outage must not be
 * mistaken for "run migrate".
 */
export async function checkPendingMigrations(
  executor: QueryOnlyExecutor,
  migrations: readonly Migration[],
): Promise<PendingMigrationsStatus> {
  let rows: { id: string }[];
  try {
    const result = await executor.query<{ id: string }>("select id from schema_migrations");
    rows = result.rows;
  } catch (err) {
    if (isUndefinedTableError(err)) return { pending: migrations.map((m) => m.id) };
    throw err;
  }
  const appliedIds = new Set(rows.map((r) => r.id));
  return { pending: migrations.filter((m) => !appliedIds.has(m.id)).map((m) => m.id) };
}

/**
 * Applies migrations in order. An id already recorded in schema_migrations is skipped only
 * when its checksum matches — if the file content changed after being applied, it aborts
 * with a clear error. Each migration runs BEGIN → apply SQL → record history → COMMIT as
 * separate statements, and explicitly ROLLBACKs on failure. The caller must run this whole
 * function on a single connection (client) — taking a different connection from a pool for
 * each call could put BEGIN and COMMIT/ROLLBACK on different sessions.
 */
export async function runMigrations(
  executor: SqlExecutor,
  migrations: Migration[],
): Promise<RunMigrationsResult> {
  await executor.exec(
    `create table if not exists schema_migrations (
       id text primary key,
       checksum text not null,
       applied_at timestamptz not null default now()
     )`,
  );

  const { rows } = await executor.query<{ id: string; checksum: string }>(
    "select id, checksum from schema_migrations",
  );
  const appliedChecksumById = new Map(rows.map((r) => [r.id, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];
  const rebaselined: string[] = [];

  for (const migration of migrations) {
    const existingChecksum = appliedChecksumById.get(migration.id);
    if (existingChecksum !== undefined) {
      if (existingChecksum !== migration.checksum) {
        if (LEGACY_RAW_CHECKSUMS[migration.id] === existingChecksum) {
          // Recorded by 0.1.0 over the raw (Korean-commented) file — same statements, so
          // rewrite the record to the current checksum instead of aborting.
          await executor.exec(
            `update schema_migrations set checksum = '${migration.checksum}' where id = '${migration.id}'`,
          );
          rebaselined.push(migration.id);
          skipped.push(migration.id);
          continue;
        }
        throw new Error(
          `The content of the already applied migration "${migration.id}" has changed ` +
            `(the recorded checksum differs from the current file's checksum). ` +
            `Do not modify applied migration files; add the change as a new migration file with the next number instead.`,
        );
      }
      skipped.push(migration.id);
      continue;
    }

    try {
      await executor.exec("begin");
      await executor.exec(migration.sql);
      await executor.exec(
        `insert into schema_migrations (id, checksum) values ('${migration.id}', '${migration.checksum}')`,
      );
      await executor.exec("commit");
      applied.push(migration.id);
    } catch (err) {
      try {
        await executor.exec("rollback");
      } catch {
        // A failure of the rollback itself is ignored — the original error is thrown below to preserve the cause.
      }
      throw err;
    }
  }

  return { applied, skipped, rebaselined };
}
