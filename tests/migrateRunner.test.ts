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

function freshExecutor(): SqlExecutor {
  const db = new PGlite();
  return createPgliteExecutor(db);
}

function migration(id: string, sql: string): Migration {
  return { id, sql, checksum: computeChecksum(sql) };
}

describe("runMigrations — checksum 검증", () => {
  it("적용된 마이그레이션의 내용이 바뀌면(checksum 불일치) 명확한 에러로 중단한다", async () => {
    const executor = freshExecutor();

    await runMigrations(executor, [migration("001_init", "create table t (id int)")]);

    const tampered = [migration("001_init", "create table t (id int, extra int)")];
    await expect(runMigrations(executor, tampered)).rejects.toThrow(/checksum/);
  });

  it("내용이 동일하면(checksum 일치) 재실행 시 건너뛴다", async () => {
    const executor = freshExecutor();
    const sql = "create table t (id int)";

    await runMigrations(executor, [migration("001_init", sql)]);
    const second = await runMigrations(executor, [migration("001_init", sql)]);

    expect(second.skipped).toEqual(["001_init"]);
    expect(second.applied).toEqual([]);
  });
});

describe("runMigrations — 실패 시 롤백", () => {
  it("마이그레이션 중간에 실패하면 이전 statement의 효과도 롤백되고 이력에 남지 않는다", async () => {
    const executor = freshExecutor();
    // 두 번째 CREATE TABLE이 같은 이름으로 실패한다 — 같은 트랜잭션이므로 첫 번째도 롤백돼야 한다
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

  it("롤백 후에도 같은 executor로 정상적인 후속 쿼리를 실행할 수 있다", async () => {
    const executor = freshExecutor();
    const failingSql = `
      create table ok_table (id int primary key);
      create table ok_table (id int primary key);
    `;
    await expect(runMigrations(executor, [migration("001_bad", failingSql)])).rejects.toThrow();

    // ROLLBACK이 세션을 정상 상태로 되돌렸는지 — aborted transaction 상태로 남아있지 않은지 확인
    const { rows } = await executor.query<{ ok: number }>("select 1 as ok");
    expect(rows[0]?.ok).toBe(1);
  });
});

describe("withAdvisoryLock", () => {
  it("lock 획득 → fn 실행 → unlock 순서로 호출하고, fn이 실패해도 반드시 unlock한다", async () => {
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

  it("fn이 성공하면 그 반환값을 그대로 돌려준다", async () => {
    const fakeClient = { query: () => Promise.resolve({ rows: [] }) };
    const result = await withAdvisoryLock(fakeClient, 123, () => Promise.resolve(42));
    expect(result).toBe(42);
  });
});

describe("checkPendingMigrations(2차 적대적 검수 SR2-REL-001)", () => {
  it("schema_migrations 테이블 자체가 없으면(완전히 빈 DB) 전체를 pending으로 본다", async () => {
    const executor = freshExecutor();
    const migrations = [
      migration("001_a", "create table a (id int)"),
      migration("002_b", "create table b (id int)"),
    ];

    const status = await checkPendingMigrations(executor, migrations);
    expect(status.pending).toEqual(["001_a", "002_b"]);
  });

  it("전부 적용돼 있으면 pending이 비어 있다", async () => {
    const executor = freshExecutor();
    const migrations = [migration("001_a", "create table a (id int)")];
    await runMigrations(executor, migrations);

    const status = await checkPendingMigrations(executor, migrations);
    expect(status.pending).toEqual([]);
  });

  it("일부만 적용돼 있으면 나머지만 pending으로 표시한다", async () => {
    const executor = freshExecutor();
    const first = migration("001_a", "create table a (id int)");
    const second = migration("002_b", "create table b (id int)");
    await runMigrations(executor, [first]);

    const status = await checkPendingMigrations(executor, [first, second]);
    expect(status.pending).toEqual(["002_b"]);
  });

  it("테이블 누락이 아닌 다른 조회 실패는 pending으로 오인하지 않고 그대로 던진다", async () => {
    const executor: SqlExecutor = {
      exec: () => Promise.reject(new Error("사용 안 함")),
      query: () => Promise.reject(new Error("연결이 끊어졌습니다(시뮬레이션)")),
    };

    await expect(
      checkPendingMigrations(executor, [migration("001_a", "create table a (id int)")]),
    ).rejects.toThrow("연결이 끊어졌습니다");
  });
});
