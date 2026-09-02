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

describe("마이그레이션 러너", () => {
  let db: PGlite;
  let executor: SqlExecutor;

  beforeEach(() => {
    db = new PGlite();
    executor = createPgliteExecutor(db);
  });

  it("전 마이그레이션 적용 후 전 테이블이 존재한다", async () => {
    const migrations = await loadMigrations();
    const result = await runMigrations(executor, migrations);

    expect(result.applied).toEqual(["001_init", "002_sales_period_agg"]);
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
    expect(first.applied).toEqual(["001_init", "002_sales_period_agg"]);

    const second = await runMigrations(executor, migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["001_init", "002_sales_period_agg"]);

    // 행 수가 두 배로 늘지 않았는지도 확인 (재적용되지 않았다는 직접 증거)
    const { rows } = await executor.query<{ count: string }>(
      "select count(*)::text as count from schema_migrations",
    );
    expect(rows[0]?.count).toBe("2");
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

  it("agent_send_log는 run_id당 sending/sent를 최대 1건만 허용하고 failed는 재시도를 허용한다", async () => {
    const migrations = await loadMigrations();
    await runMigrations(executor, migrations);

    await executor.exec(
      `insert into agent_send_log (run_id, sent_at, status, suggestion_count, dry_run)
       values ('r1', now(), 'sending', 3, false)`,
    );

    // 같은 run_id로 두 번째 'sending' 예약 시도 — 이미 발송 중이므로 거부되어야 한다
    await expect(
      executor.exec(
        `insert into agent_send_log (run_id, sent_at, status, suggestion_count, dry_run)
         values ('r1', now(), 'sending', 3, false)`,
      ),
    ).rejects.toThrow();

    // 실패로 전이 후에는 같은 run_id로 재시도(새 sending 행)가 허용된다
    await executor.exec(`update agent_send_log set status = 'failed' where run_id = 'r1'`);
    await expect(
      executor.exec(
        `insert into agent_send_log (run_id, sent_at, status, suggestion_count, dry_run)
         values ('r1', now(), 'sending', 3, false)`,
      ),
    ).resolves.not.toThrow();
  });

  it("inventory_snapshots는 존재하지 않는 매장/상품을 참조하는 행을 거부한다 (FK)", async () => {
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
