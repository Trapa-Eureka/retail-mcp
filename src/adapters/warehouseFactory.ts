/**
 * Shared entry point for creating a `Warehouse` — replaces the "error if `DATABASE_URL` is
 * missing" logic that `server.ts`/`agent/reorder.ts` (and, later, the CSV/Excel folder scan,
 * TASKS T18) each had duplicated.
 *
 * When `DATABASE_URL` is set, it connects to network Postgres (Neon/Supabase etc.) with pg.Pool
 * as before. When it is not, it defaults to **embedded, file-persisted PGlite** (default path
 * `.retail-mcp/data/`) — so that non-developer users of the CSV/Excel channel are not required
 * to create a Neon account and configure a connection string (SPEC.md §12 "warehouse" decision).
 *
 * PGlite lets several processes open the same data directory at once without an error, but
 * silently loses the writes of whichever opened later (SPEC §12 spike result) — so before
 * opening the embedded path, exclusive access is always secured with `fileLock.ts` (T13). If
 * another live process is already using that directory, startup is refused with
 * `FileLockBusyError` (which includes the cause and the fix).
 *
 * The automatic local PGlite migration done by this module is not subject to CLAUDE.md
 * guardrail 5 ("production `DATABASE_URL` migrations are run by humans only") — it initialises a
 * local embedded DB, not a remote production DB.
 *
 * The network Postgres (DATABASE_URL) path, conversely, auto-applies no migrations at all
 * (guardrail 5). Instead the caller (server.ts/agent entry points) explicitly runs
 * `ensureNetworkMigrationsApplied()` (SR2-REL-001, second adversarial review), which reports a
 * missing or partially applied schema immediately, as a message that says what to do rather
 * than as a raw Postgres error. Not putting that check inside `createNetworkWarehouse()` is
 * deliberate — `createWarehouseFromEnv()` not attempting a real network connection even when
 * DATABASE_URL is set was already a guaranteed contract (warehouseFactory.test.ts "does not
 * attempt a real connection"), and it must not be broken here.
 */
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import type { Warehouse } from "../core/types.js";
import { acquireFileLock, type FileLock } from "./fileLock.js";
import {
  checkPendingMigrations,
  loadMigrations,
  runMigrations,
  createPgliteExecutor,
  type QueryOnlyExecutor,
} from "./migrationRunner.js";
import {
  createPgConnectionProvider,
  createPgliteConnectionProvider,
  createPgWarehouse,
  withSession,
  type DbConnectionProvider,
  type DbSession,
} from "./pgWarehouse.js";

/** Default path for embedded PGlite data when `DATABASE_URL` is not set (relative to the process working directory). */
export const DEFAULT_EMBEDDED_DATA_DIR = ".retail-mcp/data";

export interface WarehouseHandle {
  warehouse: Warehouse;
  kind: "pg" | "pglite";
  /**
   * Present only when kind === "pg" — needed for Postgres-only features such as the
   * `sync_now` advisory lock (pg_try_advisory_lock) (DESIGN §11.4). The embedded PGlite path
   * does not have this value.
   */
  pgPool?: Pool;
  /**
   * The same connection provider used to build `warehouse` — always present, for pg and pglite
   * alike. Used only for the very few exceptions that need a session outside the Warehouse's
   * fixed-query contract, like `explore_sql` (TASKS T27) (currently explore_sql is the only one).
   */
  connectionProvider: DbConnectionProvider;
  /** Cleans up all open resources (pg.Pool connections, or the PGlite instance + file lock). */
  close(): Promise<void>;
}

export interface CreateWarehouseOptions {
  /** For test injection. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Embedded path override. Default: env RETAIL_MCP_DATA_DIR or DEFAULT_EMBEDDED_DATA_DIR. */
  dataDir?: string;
}

async function createEmbeddedWarehouse(dataDir: string): Promise<WarehouseHandle> {
  const lock: FileLock = await acquireFileLock(dataDir);
  try {
    const db = new PGlite(dataDir);
    try {
      const executor = createPgliteExecutor(db);
      const migrations = await loadMigrations();
      await runMigrations(executor, migrations);
    } catch (err) {
      await db.close();
      throw err;
    }

    const connectionProvider = createPgliteConnectionProvider(db);
    const warehouse = createPgWarehouse(connectionProvider);
    return {
      warehouse,
      kind: "pglite",
      connectionProvider,
      // OPS-001 (005 review, TASKS T34) — this used to be `await db.close(); await lock.release();`
      // in that order, so if db.close() rejected, release never ran at all. If the lock is not
      // released, the next run stays blocked until the process dies (or a human deletes it by
      // hand) — so release is always attempted regardless of whether db.close() succeeded or
      // failed. The two cleanup steps can each fail independently (e.g. a PGlite internal error
      // + the lock file removed by another process in between), and throwing only one of them
      // would silently drop the other cause — if both fail, both are preserved in an
      // AggregateError.
      async close() {
        const errors: unknown[] = [];
        try {
          await db.close();
        } catch (err) {
          errors.push(err);
        }
        try {
          await lock.release();
        } catch (err) {
          errors.push(err);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(
            errors,
            "Multiple errors occurred while closing the warehouse (both db.close() and lock.release() " +
              "failed) — check each cause in the errors array.",
          );
        }
      },
    };
  } catch (err) {
    // The lock must always be released even when initialisation (migrations etc.) fails — if
    // release() fails here too (same principle as OPS-001), preserve both so the original cause
    // (err) is not silently masked.
    try {
      await lock.release();
    } catch (releaseErr) {
      throw new AggregateError(
        [err, releaseErr],
        "Embedded warehouse initialisation failed and releasing the lock failed too — check each cause in the errors array.",
        { cause: releaseErr },
      );
    }
    throw err;
  }
}

function createNetworkWarehouse(databaseUrl: string): WarehouseHandle {
  const pool = new Pool({ connectionString: databaseUrl });
  const connectionProvider = createPgConnectionProvider(pool);
  const warehouse = createPgWarehouse(connectionProvider);
  return {
    warehouse,
    kind: "pg",
    pgPool: pool,
    connectionProvider,
    close: () => pool.end(),
  };
}

/**
 * Creates a `Warehouse` with pg when `DATABASE_URL` is set, otherwise with embedded PGlite
 * (including automatic migration). The caller must call `handle.close()` when done (returns
 * pg.Pool connections, or releases the PGlite instance + file lock).
 */
export async function createWarehouseFromEnv(
  opts: CreateWarehouseOptions = {},
): Promise<WarehouseHandle> {
  const env = opts.env ?? process.env;
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl) return createNetworkWarehouse(databaseUrl);

  const dataDir = opts.dataDir ?? env["RETAIL_MCP_DATA_DIR"] ?? DEFAULT_EMBEDDED_DATA_DIR;
  return createEmbeddedWarehouse(dataDir);
}

function queryOnlyExecutorFromSession(session: DbSession): QueryOnlyExecutor {
  return {
    query: <T extends Record<string, unknown>>(sql: string) => session.query<T>(sql),
  };
}

/**
 * SR2-REL-001 (second adversarial review) — on the network Postgres path
 * (`handle.kind === "pg"`), reports a missing or partially applied schema as a clear message
 * that includes the command to run, rather than a raw Postgres error ("relation ... does not
 * exist"). Writes nothing (read-only, not subject to guardrails 4/5). On the embedded PGlite
 * path (`handle.kind === "pglite"`), `createEmbeddedWarehouse` has already auto-migrated at
 * startup, so this function does nothing in that case.
 *
 * It is not built into `createWarehouseFromEnv()` itself — to keep the existing contract that
 * that function does not attempt a real network connection even when DATABASE_URL is set
 * (warehouseFactory.test.ts regression). The caller (server.ts/agent entry points) calls it
 * explicitly right after obtaining the handle.
 *
 * The raw `DATABASE_URL` (including credentials) is never written to any output of this
 * function (CLAUDE.md implementation notes).
 */
export async function ensureNetworkMigrationsApplied(handle: WarehouseHandle): Promise<void> {
  if (handle.kind !== "pg") return;

  const migrations = await loadMigrations();
  const { pending } = await withSession(handle.connectionProvider, (session) =>
    checkPendingMigrations(queryOnlyExecutorFromSession(session), migrations),
  );
  if (pending.length === 0) return;

  throw new Error(
    `The database that DATABASE_URL points to has no schema yet, or only part of it is applied ` +
      `(${pending.length} pending migration(s): ${pending.join(", ")}). ` +
      "First check the target and the pending migrations with npx retail-mcp-migrate (dry-run), " +
      "then apply them with npx retail-mcp-migrate --confirm and run again.",
  );
}
