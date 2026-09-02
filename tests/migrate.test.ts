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
  "schema_migrations",
  "stores",
  "sync_state",
];

describe("마이그레이션 러너", () => {
  let db: PGlite;
  let executor: SqlExecutor;

  beforeEach(() => {
    db = new PGlite();
    executor = createPgliteExecutor(db);
  });

  it("001_init 적용 후 전 테이블이 존재한다", async () => {
    const migrations = await loadMigrations();
    const result = await runMigrations(executor, migrations);

    expect(result.applied).toEqual(["001_init"]);
    expect(result.skipped).toEqual([]);

    const { rows } = await executor.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    const tableNames = rows.map((r) => r.table_name).sort();
    for (const expected of EXPECTED_TABLES) {
      expect(tableNames).toContain(expected);
    }
  });

  it("2회 실행해도 멱등하다 (두 번째 실행은 전부 건너뜀)", async () => {
    const migrations = await loadMigrations();

    const first = await runMigrations(executor, migrations);
    expect(first.applied).toEqual(["001_init"]);

    const second = await runMigrations(executor, migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["001_init"]);

    // 행 수가 두 배로 늘지 않았는지도 확인 (재적용되지 않았다는 직접 증거)
    const { rows } = await executor.query<{ count: string }>(
      "select count(*)::text as count from schema_migrations",
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("agent_send_log.status는 정해진 값만 허용한다", async () => {
    const migrations = await loadMigrations();
    await runMigrations(executor, migrations);

    await expect(
      executor.exec(
        `insert into agent_send_log (run_id, sent_at, status, suggestion_count, dry_run)
         values ('r1', now(), 'invalid_status', 0, true)`,
      ),
    ).rejects.toThrow();
  });
});
