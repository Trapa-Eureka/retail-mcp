import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  checkPendingMigrations,
  computeChecksum,
  createPgliteExecutor,
  runMigrations,
  withAdvisoryLock,
  type Migration,
  type SqlExecutor,
} from "../scripts/migrate.js";
import { LEGACY_RAW_CHECKSUMS } from "../src/adapters/migrationRunner.js";

function freshExecutor(): SqlExecutor {
  const db = new PGlite();
  return createPgliteExecutor(db);
}

function migration(id: string, sql: string): Migration {
  return { id, sql, checksum: computeChecksum(sql) };
}

describe("runMigrations — checksum validation", () => {
  it("aborts with a clear error when the content of an applied migration changes (checksum mismatch)", async () => {
    const executor = freshExecutor();

    await runMigrations(executor, [migration("001_init", "create table t (id int)")]);

    const tampered = [migration("001_init", "create table t (id int, extra int)")];
    await expect(runMigrations(executor, tampered)).rejects.toThrow(/checksum/);
  });

  it("skips on re-run when the content is identical (checksum match)", async () => {
    const executor = freshExecutor();
    const sql = "create table t (id int)";

    await runMigrations(executor, [migration("001_init", sql)]);
    const second = await runMigrations(executor, [migration("001_init", sql)]);

    expect(second.skipped).toEqual(["001_init"]);
    expect(second.applied).toEqual([]);
    expect(second.rebaselined).toEqual([]);
  });

  it("ignores full-line comments and blank lines in the checksum (comment-only edits are not a content change)", async () => {
    const executor = freshExecutor();
    const original = "-- creates t\ncreate table t (id int);\n\n-- done\n";
    const commentEdited =
      "-- creates table t (translated comment)\n\ncreate table t (id int);   \n";

    await runMigrations(executor, [migration("001_init", original)]);
    const second = await runMigrations(executor, [migration("001_init", commentEdited)]);

    expect(computeChecksum(original)).toBe(computeChecksum(commentEdited));
    expect(second.skipped).toEqual(["001_init"]);
    expect(second.rebaselined).toEqual([]);
  });

  it("still aborts when an inline trailing comment's code part or a statement changes", async () => {
    const executor = freshExecutor();
    await runMigrations(executor, [migration("001_init", "create table t (id int); -- pk")]);
    const changed = [migration("001_init", "create table t (id int, x int); -- pk")];
    await expect(runMigrations(executor, changed)).rejects.toThrow(/checksum/);
  });

  it("re-baselines a record that holds the 0.1.0 raw checksum of a bundled migration, once", async () => {
    const executor = freshExecutor();
    const sql = "create table legacy_t (id int)";
    const current = migration("001_init", sql);
    // Simulate a DB migrated by 0.1.0: the row exists with the raw-file checksum of that time.
    await runMigrations(executor, [current]);
    await executor.exec(
      `update schema_migrations set checksum = '${LEGACY_RAW_CHECKSUMS["001_init"]}' where id = '001_init'`,
    );

    const first = await runMigrations(executor, [current]);
    expect(first.rebaselined).toEqual(["001_init"]);
    expect(first.skipped).toEqual(["001_init"]);
    expect(first.applied).toEqual([]);

    const { rows } = await executor.query<{ checksum: string }>(
      "select checksum from schema_migrations where id = '001_init'",
    );
    expect(rows[0]?.checksum).toBe(current.checksum);

    const second = await runMigrations(executor, [current]);
    expect(second.rebaselined).toEqual([]);
    expect(second.skipped).toEqual(["001_init"]);
  });

  it("does not re-baseline an unknown mismatch even for a bundled migration id", async () => {
    const executor = freshExecutor();
    const current = migration("002_sales_period_agg", "create table agg (id int)");
    await runMigrations(executor, [current]);
    await executor.exec(
      "update schema_migrations set checksum = 'deadbeef' where id = '002_sales_period_agg'",
    );
    await expect(runMigrations(executor, [current])).rejects.toThrow(/checksum/);
  });

  it("LEGACY_RAW_CHECKSUMS covers exactly the eight migrations shipped in 0.1.0", () => {
    expect(Object.keys(LEGACY_RAW_CHECKSUMS).sort()).toEqual([
      "001_init",
      "002_sales_period_agg",
      "003_product_low_stock_threshold",
      "004_purchase_receipts",
      "005_product_pack_size",
      "006_tombstone_active_flag",
      "007_agent_send_log_unchanged_status",
      "008_agent_send_log_unknown_status",
    ]);
    for (const value of Object.values(LEGACY_RAW_CHECKSUMS))
      expect(value).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("runMigrations — rollback on failure", () => {
  it("rolls back the effect of earlier statements and leaves no history when a migration fails midway", async () => {
    const executor = freshExecutor();
    // The second CREATE TABLE fails with the same name — same transaction, so the first must be rolled back too
    const failingSql = `
      create table ok_table (id int primary key);
      create table ok_table (id int primary key);
    `;

    await expect(runMigrations(executor, [migration("001_bad", failingSql)])).rejects.toThrow();

    const { rows: tables } = await executor.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_name = 'ok_table'",
    );
    expect(tables).toHaveLength(0);

    const { rows: history } = await executor.query<{ id: string }>(
      "select id from schema_migrations where id = '001_bad'",
    );
    expect(history).toHaveLength(0);
  });

  it("can run normal follow-up queries on the same executor after the rollback", async () => {
    const executor = freshExecutor();
    const failingSql = `
      create table ok_table (id int primary key);
      create table ok_table (id int primary key);
    `;
    await expect(runMigrations(executor, [migration("001_bad", failingSql)])).rejects.toThrow();

    // Confirm ROLLBACK restored the session to a normal state — not left in an aborted transaction state
    const { rows } = await executor.query<{ ok: number }>("select 1 as ok");
    expect(rows[0]?.ok).toBe(1);
  });
});

describe("withAdvisoryLock", () => {
  it("calls lock acquire → fn → unlock in order, and always unlocks even when fn fails", async () => {
    const calls: string[] = [];
    const fakeClient = {
      query: (text: string) => {
        calls.push(text);
        return Promise.resolve({ rows: [] });
      },
    };

    await expect(
      withAdvisoryLock(fakeClient, 123, () => {
        calls.push("fn");
        return Promise.reject(new Error("boom"));
      }),
    ).rejects.toThrow("boom");

    expect(calls).toEqual(["select pg_advisory_lock($1)", "fn", "select pg_advisory_unlock($1)"]);
  });

  it("returns fn's return value as-is when fn succeeds", async () => {
    const fakeClient = { query: () => Promise.resolve({ rows: [] }) };
    const result = await withAdvisoryLock(fakeClient, 123, () => Promise.resolve(42));
    expect(result).toBe(42);
  });
});

describe("checkPendingMigrations (second adversarial review SR2-REL-001)", () => {
  it("treats everything as pending when the schema_migrations table itself does not exist (completely empty DB)", async () => {
    const executor = freshExecutor();
    const migrations = [
      migration("001_a", "create table a (id int)"),
      migration("002_b", "create table b (id int)"),
    ];

    const status = await checkPendingMigrations(executor, migrations);
    expect(status.pending).toEqual(["001_a", "002_b"]);
  });

  it("has an empty pending list when everything is applied", async () => {
    const executor = freshExecutor();
    const migrations = [migration("001_a", "create table a (id int)")];
    await runMigrations(executor, migrations);

    const status = await checkPendingMigrations(executor, migrations);
    expect(status.pending).toEqual([]);
  });

  it("marks only the remainder as pending when only some are applied", async () => {
    const executor = freshExecutor();
    const first = migration("001_a", "create table a (id int)");
    const second = migration("002_b", "create table b (id int)");
    await runMigrations(executor, [first]);

    const status = await checkPendingMigrations(executor, [first, second]);
    expect(status.pending).toEqual(["002_b"]);
  });

  it("rethrows query failures other than a missing table as-is instead of mistaking them for pending", async () => {
    const executor: SqlExecutor = {
      exec: () => Promise.reject(new Error("not used")),
      query: () => Promise.reject(new Error("connection lost (simulated)")),
    };

    await expect(
      checkPendingMigrations(executor, [migration("001_a", "create table a (id int)")]),
    ).rejects.toThrow("connection lost");
  });
});
