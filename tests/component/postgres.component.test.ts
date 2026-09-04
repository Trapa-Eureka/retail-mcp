/**
 * Component tests for a real Postgres service container only (QA-004, TASKS T35).
 *
 * **Not included** in the default gate of `npm run test`/`npm run check` (guardrail 2: zero
 * network calls in tests, DB is always PGlite) — `vitest.config.ts` excludes this directory, it
 * runs only via `vitest.component.config.ts` (dedicated to the tests/component directory), and
 * only through `npm run test:pg-component` (dedicated to CI's `postgres-component` job,
 * targeting the **disposable** Postgres service container TEST_DATABASE_URL points to) — the
 * same pattern as explore_sql being the only pre-approved exception to guardrail 4: the "zero
 * network" principle itself is not broken; this is split into a separate, explicitly opt-in
 * suite.
 *
 * **Never point TEST_DATABASE_URL at a real production/shared DB** — this suite applies all of
 * migrations/*.sql as-is on every run and creates arbitrary advisory lock keys/temporary tables.
 * If TEST_DATABASE_URL is not set, the whole suite is skipped (`npm run test:pg-component` ends
 * as "skipped" without error even without a real Postgres locally).
 *
 * The already known difference between PGlite and real Postgres (`docs/SPEC.md` §17 — PGlite
 * does not actually enforce statement_timeout) is confirmed here not to reproduce on real
 * Postgres.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AdvisoryLockBusyError,
  withAdvisoryLock,
  withTryAdvisoryLock,
} from "../../src/adapters/advisoryLock.js";
import { createExploreSqlExecutor } from "../../src/adapters/exploreSqlExecutor.js";
import {
  applyMigrationsToDatabaseUrl,
  checkPendingMigrationsForDatabaseUrl,
} from "../../src/adapters/migratePg.js";
import {
  checkPendingMigrations,
  createPgExecutor,
  loadMigrations,
  runMigrations,
  type Migration,
} from "../../src/adapters/migrationRunner.js";
import { createPgConnectionProvider } from "../../src/adapters/pgWarehouse.js";
import {
  createWarehouseFromEnv,
  ensureNetworkMigrationsApplied,
} from "../../src/adapters/warehouseFactory.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("Postgres component tests (QA-004, TASKS T35)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("migration — idempotency and checksum validation on real Postgres", () => {
    it("safely skips the same set of migrations when run twice in a row", async () => {
      const client = await pool.connect();
      try {
        const executor = createPgExecutor(client);
        const migrations = await loadMigrations();

        const first = await runMigrations(executor, migrations);
        expect(first.applied.length + first.skipped.length).toBe(migrations.length);

        const second = await runMigrations(executor, migrations);
        expect(second.applied).toEqual([]);
        expect(second.skipped.length).toBe(migrations.length);
      } finally {
        client.release();
      }
    });

    it("blocks with a clear error when the checksum of an already applied migration changes", async () => {
      const client = await pool.connect();
      try {
        const executor = createPgExecutor(client);
        const migrations = await loadMigrations();
        await runMigrations(executor, migrations); // Guarantee the fully applied state

        const tampered: Migration[] = migrations.map((m, i) =>
          i === 0 ? { ...m, checksum: "tampered-checksum" } : m,
        );
        await expect(runMigrations(executor, tampered)).rejects.toThrow(/has changed/);
      } finally {
        client.release();
      }
    });
  });

  describe("transaction rollback — a failed migration leaves no trace", () => {
    it("a migration with a syntax error is rolled back and not recorded in schema_migrations", async () => {
      const client = await pool.connect();
      try {
        const executor = createPgExecutor(client);
        const broken: Migration = {
          id: "999_broken_component_test",
          sql: "create table qa004_should_not_exist (x int); this is not valid sql",
          checksum: "deadbeef",
        };

        await expect(runMigrations(executor, [broken])).rejects.toThrow();

        const historyRows = await client.query("select 1 from schema_migrations where id = $1", [
          "999_broken_component_test",
        ]);
        expect(historyRows.rows).toHaveLength(0);

        const tableExists = await client.query<{ reg: string | null }>(
          "select to_regclass('public.qa004_should_not_exist') as reg",
        );
        expect(tableExists.rows[0]?.reg).toBeNull();
      } finally {
        client.release();
      }
    });
  });

  describe("advisory lock cleanup — unlock takes effect immediately without ending the session", () => {
    it("another connection cannot acquire while withAdvisoryLock holds it, and can acquire immediately after release", async () => {
      const key = 20_260_903_01;
      const holder = await pool.connect();
      try {
        await withAdvisoryLock(holder, key, async () => {
          const contender = await pool.connect();
          try {
            const { rows } = await contender.query<{ locked: boolean }>(
              "select pg_try_advisory_lock($1) as locked",
              [key],
            );
            expect(rows[0]?.locked).toBe(false);
          } finally {
            contender.release();
          }
        });

        const afterRelease = await pool.connect();
        try {
          const { rows } = await afterRelease.query<{ locked: boolean }>(
            "select pg_try_advisory_lock($1) as locked",
            [key],
          );
          expect(rows[0]?.locked).toBe(true);
          await afterRelease.query("select pg_advisory_unlock($1)", [key]);
        } finally {
          afterRelease.release();
        }
      } finally {
        holder.release();
      }
    });

    it("withTryAdvisoryLock: an already locked key fails with AdvisoryLockBusyError without waiting", async () => {
      const key = 20_260_903_02;
      const holder = await pool.connect();
      const contender = await pool.connect();
      try {
        await holder.query("select pg_advisory_lock($1)", [key]);
        await expect(
          withTryAdvisoryLock(contender, key, () => Promise.resolve("unreachable")),
        ).rejects.toBeInstanceOf(AdvisoryLockBusyError);
      } finally {
        await holder.query("select pg_advisory_unlock($1)", [key]);
        holder.release();
        contender.release();
      }
    });
  });

  describe("READ ONLY transaction (explore_sql second line of defence, SEC-001) — reconfirmed on real Postgres", () => {
    it("writes are refused inside BEGIN READ ONLY", async () => {
      const client = await pool.connect();
      try {
        await client.query("begin read only");
        await expect(client.query("create temporary table qa004_ro_test (x int)")).rejects.toThrow(
          /read-only transaction/i,
        );
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    });
  });

  describe("explore_sql statement_timeout — the part that could not be verified with PGlite (§17)", () => {
    it("on real Postgres, statement_timeout actually cancels a long-running query", async () => {
      const executor = createExploreSqlExecutor(createPgConnectionProvider(pool));
      await expect(
        executor.execute("select pg_sleep(2), 1 as x", { timeoutMs: 200 }),
      ).rejects.toThrow(/cancel/i);
    }, 10_000);

    it("a query that finishes within timeoutMs returns its result normally (regression guard — cancellation is not over-eager)", async () => {
      const executor = createExploreSqlExecutor(createPgConnectionProvider(pool));
      const result = await executor.execute("select 1 as x", { timeoutMs: 5000 });
      expect(result.rows).toEqual([{ x: 1 }]);
    });
  });

  // SR2-REL-001 (second adversarial review) — verifies the npm-published migration CLI
  // (`retail-mcp-migrate`) and the network Postgres startup pre-check against real Postgres.
  // The PGlite unit tests (tests/migrateRunner.test.ts, tests/warehouseFactory.test.ts) already
  // verified the logic itself, so here only "does the real pg.Pool wiring actually work" is
  // additionally confirmed.
  describe("network Postgres migration CLI/pre-check (SR2-REL-001) — real Postgres wiring check", () => {
    it("on an empty schema (separate temporary schema) checkPendingMigrations treats everything as pending — SQLSTATE 42P01 detection works on real Postgres, not just PGlite", async () => {
      const client = await pool.connect();
      const tempSchema = `qa_rel001_empty_${Date.now()}`;
      try {
        await client.query(`create schema "${tempSchema}"`);
        await client.query(`set search_path to "${tempSchema}"`);
        const migrations = await loadMigrations();
        const status = await checkPendingMigrations(createPgExecutor(client), migrations);
        expect(status.pending).toEqual(migrations.map((m) => m.id));
      } finally {
        await client.query("reset search_path").catch(() => undefined);
        await client.query(`drop schema if exists "${tempSchema}" cascade`);
        client.release();
      }
    });

    it("applyMigrationsToDatabaseUrl/checkPendingMigrationsForDatabaseUrl: pending is empty after applying and re-running is idempotent (the pg.Pool wiring retail-mcp-migrate actually uses)", async () => {
      const migrations = await loadMigrations();

      const result = await applyMigrationsToDatabaseUrl(TEST_DATABASE_URL as string);
      expect(result.applied.length + result.skipped.length).toBe(migrations.length);

      const status = await checkPendingMigrationsForDatabaseUrl(TEST_DATABASE_URL as string);
      expect(status.pending).toEqual([]);

      // Idempotency — applying again on the fully applied state skips everything.
      const second = await applyMigrationsToDatabaseUrl(TEST_DATABASE_URL as string);
      expect(second.applied).toEqual([]);
    });

    it("ensureNetworkMigrationsApplied: a real pg warehouse made with createWarehouseFromEnv(DATABASE_URL) passes after the schema is applied", async () => {
      // The test above has already applied all migrations to the public schema.
      const handle = await createWarehouseFromEnv({
        env: { DATABASE_URL: TEST_DATABASE_URL },
      });
      try {
        expect(handle.kind).toBe("pg");
        await expect(ensureNetworkMigrationsApplied(handle)).resolves.toBeUndefined();
      } finally {
        await handle.close();
      }
    });
  });
});
