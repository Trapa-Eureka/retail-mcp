import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createPgliteExecutor,
  loadMigrations,
  runMigrations,
  type SqlExecutor,
} from "../scripts/migrate.js";

const EXPECTED_TABLES = [
  "agent_send_log",
  "inventory_levels",
  "inventory_snapshots",
  "products",
  "sales_lines",
  "sales_period_agg",
  "schema_migrations",
  "stores",
  "sync_state",
];

describe("migration runner", () => {
  let db: PGlite;
  let executor: SqlExecutor;

  beforeEach(() => {
    db = new PGlite();
    executor = createPgliteExecutor(db);
  });

  it("all tables exist after applying all migrations", async () => {
    const migrations = await loadMigrations();
    const result = await runMigrations(executor, migrations);

    // The number of migrations grows with each task, so compare against the actual list instead of hard-coding file names.
    expect(result.applied).toEqual(migrations.map((m) => m.id));
    expect(result.skipped).toEqual([]);

    const { rows } = await executor.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    const tableNames = rows.map((r) => r.table_name).sort();
    for (const expected of EXPECTED_TABLES) {
      expect(tableNames).toContain(expected);
    }
  });

  it("is idempotent when run twice (the second run skips everything)", async () => {
    const migrations = await loadMigrations();

    const first = await runMigrations(executor, migrations);
    expect(first.applied).toEqual(migrations.map((m) => m.id));

    const second = await runMigrations(executor, migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(migrations.map((m) => m.id));

    // Also confirm the row count did not double (direct evidence that nothing was re-applied)
    const { rows } = await executor.query<{ count: string }>(
      "select count(*)::text as count from schema_migrations",
    );
    expect(rows[0]?.count).toBe(String(migrations.length));
  });

  it("agent_send_log.status allows only the defined values", async () => {
    const migrations = await loadMigrations();
    await runMigrations(executor, migrations);

    await expect(
      executor.exec(
        `insert into agent_send_log (run_id, sent_at, status, suggestion_count, dry_run)
         values ('r1', now(), 'invalid_status', 0, true)`,
      ),
    ).rejects.toThrow();
  });

  it("agent_send_log allows at most one sending/sent per run_id and allows a retry after failed", async () => {
    const migrations = await loadMigrations();
    await runMigrations(executor, migrations);

    await executor.exec(
      `insert into agent_send_log (run_id, sent_at, status, suggestion_count, dry_run)
       values ('r1', now(), 'sending', 3, false)`,
    );

    // A second 'sending' reservation attempt with the same run_id — must be rejected because it is already sending
    await expect(
      executor.exec(
        `insert into agent_send_log (run_id, sent_at, status, suggestion_count, dry_run)
         values ('r1', now(), 'sending', 3, false)`,
      ),
    ).rejects.toThrow();

    // After transitioning to failed, a retry (new sending row) with the same run_id is allowed
    await executor.exec(`update agent_send_log set status = 'failed' where run_id = 'r1'`);
    await expect(
      executor.exec(
        `insert into agent_send_log (run_id, sent_at, status, suggestion_count, dry_run)
         values ('r1', now(), 'sending', 3, false)`,
      ),
    ).resolves.not.toThrow();
  });

  it("inventory_snapshots rejects rows referencing a non-existent store/product (FK)", async () => {
    const migrations = await loadMigrations();
    await runMigrations(executor, migrations);

    await expect(
      executor.exec(
        `insert into inventory_snapshots (run_id, snapped_at, store_id, variant_id, in_stock)
         values ('run1', now(), 'no_such_store', 'no_such_variant', 10)`,
      ),
    ).rejects.toThrow();
  });
});
