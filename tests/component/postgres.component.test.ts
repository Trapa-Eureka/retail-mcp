/**
 * 실 Postgres 서비스 컨테이너 전용 컴포넌트 테스트 (QA-004, TASKS T35).
 *
 * `npm run test`/`npm run check`(가드레일 2: 테스트 네트워크 호출 0건, DB는 항상 PGlite)의
 * 기본 게이트에는 **포함되지 않는다** — `vitest.config.ts`가 이 디렉터리를 exclude하고,
 * `vitest.component.config.ts`(tests/component 디렉터리 전용)로만 실행되고,
 * `npm run test:pg-component`(CI의 `postgres-component` job 전용, TEST_DATABASE_URL이
 * 가리키는 **일회용** Postgres 서비스 컨테이너 대상)로만 돈다 — explore_sql이 가드레일 4의
 * 사전 승인된 유일한 예외인 것과 같은 패턴: "네트워크 0건" 원칙 자체를 깨지 않고, 명시적으로
 * opt-in한 별도 스위트로 분리했다.
 *
 * **TEST_DATABASE_URL을 실제 운영/공유 DB에 절대 가리키지 말 것** — 이 스위트는 매 실행마다
 * migrations/*.sql 전체를 그대로 적용하고 임의 advisory lock key/임시 테이블을 만든다.
 * TEST_DATABASE_URL이 없으면 스위트 전체를 스킵한다(로컬에 실 Postgres가 없어도
 * `npm run test:pg-component`가 에러 없이 "스킵됨"으로 끝난다).
 *
 * PGlite와 실 Postgres의 이미 알려진 차이(`docs/SPEC.md` §17 — PGlite는 statement_timeout을
 * 실제로 집행하지 않음)가 실 Postgres에서는 재현되지 않는다는 걸 여기서 직접 확인한다.
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

describe.skipIf(!TEST_DATABASE_URL)("Postgres 컴포넌트 테스트(QA-004, TASKS T35)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("migration — 실 Postgres에서의 멱등성·checksum 검증", () => {
    it("두 번 연속 실행해도 같은 마이그레이션 집합을 안전하게 건너뛴다", async () => {
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

    it("이미 적용된 마이그레이션의 checksum이 바뀌면 명확한 에러로 막는다", async () => {
      const client = await pool.connect();
      try {
        const executor = createPgExecutor(client);
        const migrations = await loadMigrations();
        await runMigrations(executor, migrations); // 전부 적용된 상태를 보장

        const tampered: Migration[] = migrations.map((m, i) =>
          i === 0 ? { ...m, checksum: "tampered-checksum" } : m,
        );
        await expect(runMigrations(executor, tampered)).rejects.toThrow(/변경되었습니다/);
      } finally {
        client.release();
      }
    });
  });

  describe("transaction rollback — 실패한 마이그레이션은 흔적을 남기지 않는다", () => {
    it("문법 오류가 있는 마이그레이션은 롤백되고 schema_migrations에도 기록되지 않는다", async () => {
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

  describe("advisory lock cleanup — 세션 종료 없이도 unlock 즉시 반영된다", () => {
    it("withAdvisoryLock 보유 중엔 다른 커넥션이 획득 못 하고, 해제 후엔 즉시 획득 가능하다", async () => {
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

    it("withTryAdvisoryLock: 이미 잠긴 key는 대기하지 않고 AdvisoryLockBusyError로 실패한다", async () => {
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

  describe("READ ONLY 트랜잭션(explore_sql 2차 방어선, SEC-001) — 실 Postgres에서 재확인", () => {
    it("BEGIN READ ONLY 안에서는 쓰기가 거부된다", async () => {
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

  describe("explore_sql statement_timeout — PGlite에서는 검증 불가능했던 부분(§17)", () => {
    it("실 Postgres에서는 statement_timeout이 오래 걸리는 쿼리를 실제로 취소한다", async () => {
      const executor = createExploreSqlExecutor(createPgConnectionProvider(pool));
      await expect(
        executor.execute("select pg_sleep(2), 1 as x", { timeoutMs: 200 }),
      ).rejects.toThrow(/취소했습니다/);
    }, 10_000);

    it("timeoutMs 안에 끝나는 쿼리는 정상적으로 결과를 반환한다(회귀 방지 — 취소가 과하게 걸리지 않음)", async () => {
      const executor = createExploreSqlExecutor(createPgConnectionProvider(pool));
      const result = await executor.execute("select 1 as x", { timeoutMs: 5000 });
      expect(result.rows).toEqual([{ x: 1 }]);
    });
  });

  // SR2-REL-001(2차 적대적 검수) — npm 배포 migration CLI(`retail-mcp-migrate`)와 network
  // Postgres 시작 시 사전 점검을 real Postgres 기준으로 확인한다. PGlite 단위 테스트
  // (tests/migrateRunner.test.ts, tests/warehouseFactory.test.ts)가 이미 로직 자체를
  // 검증했으므로, 여기서는 "real pg.Pool 배선이 실제로 동작하는가"만 추가로 확인한다.
  describe("network Postgres migration CLI/사전 점검(SR2-REL-001) — real Postgres 배선 확인", () => {
    it("빈 스키마(별도 임시 schema)에서는 checkPendingMigrations가 전체를 pending으로 본다 — SQLSTATE 42P01 감지가 PGlite뿐 아니라 real Postgres에서도 동작", async () => {
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

    it("applyMigrationsToDatabaseUrl/checkPendingMigrationsForDatabaseUrl: 적용 후 pending이 비고 재실행해도 멱등하다(retail-mcp-migrate가 실제로 쓰는 pg.Pool 배선)", async () => {
      const migrations = await loadMigrations();

      const result = await applyMigrationsToDatabaseUrl(TEST_DATABASE_URL as string);
      expect(result.applied.length + result.skipped.length).toBe(migrations.length);

      const status = await checkPendingMigrationsForDatabaseUrl(TEST_DATABASE_URL as string);
      expect(status.pending).toEqual([]);

      // 멱등성 — 이미 다 적용된 상태에서 다시 적용해도 전부 건너뛴다.
      const second = await applyMigrationsToDatabaseUrl(TEST_DATABASE_URL as string);
      expect(second.applied).toEqual([]);
    });

    it("ensureNetworkMigrationsApplied: createWarehouseFromEnv(DATABASE_URL)로 만든 real pg 웨어하우스가 스키마 적용 후 통과한다", async () => {
      // 위 테스트가 이미 public 스키마에 전체 마이그레이션을 적용해뒀다.
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
