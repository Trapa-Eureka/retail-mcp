import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createExploreSqlExecutor,
  EXPLORE_SQL_MAX_LIMIT,
  EXPLORE_SQL_MAX_TIMEOUT_MS,
} from "../src/adapters/exploreSqlExecutor.js";
import { createPgliteConnectionProvider, createPgWarehouse } from "../src/adapters/pgWarehouse.js";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import type { ExploreSqlExecutor, StoreRow, Warehouse } from "../src/core/types.js";

describe("createExploreSqlExecutor (explore_sql, TASKS T27, 가드레일 4 예외)", () => {
  let db: PGlite;
  let warehouse: Warehouse;
  let executor: ExploreSqlExecutor;

  beforeEach(async () => {
    db = await createTestWarehouse();
    warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    executor = createExploreSqlExecutor(createPgliteConnectionProvider(db));

    const stores: StoreRow[] = [
      { id: "store_main", name: "본점" },
      { id: "store_makati", name: "마카티점" },
    ];
    await warehouse.upsertStores(stores);
  });

  it("정상 select를 실행하고 columns/rows/rowCount를 반환한다", async () => {
    const result = await executor.execute("select id, name from stores order by id");
    expect(result.columns.sort()).toEqual(["id", "name"]);
    expect(result.rowCount).toBe(2);
    expect(result.rows).toEqual([
      { id: "store_main", name: "본점" },
      { id: "store_makati", name: "마카티점" },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("limit보다 결과가 많으면 잘라내고 truncated=true를 반환한다", async () => {
    const result = await executor.execute("select * from stores order by id", { limit: 1 });
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("결과가 0건이면 columns도 빈 배열이다", async () => {
    const result = await executor.execute("select * from stores where id = 'no_such_store'");
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("검증을 통과 못하는 SQL은 실행 전에 거부한다(select/with로 시작 안 함)", async () => {
    await expect(executor.execute("insert into stores values ('x', 'y')")).rejects.toThrow();
    // 실제로 적재되지 않았어야 한다.
    expect(await warehouse.queryStores()).toHaveLength(2);
  });

  it("with(CTE)로 위장한 데이터 변형도 검증 단계에서 거부한다(insert 등 키워드 블록리스트)", async () => {
    await expect(
      executor.execute(
        "with x as (insert into stores values ('x','y') returning *) select * from x",
      ),
    ).rejects.toThrow(/허용되지 않는 키워드/);
    expect(await warehouse.queryStores()).toHaveLength(2);
  });

  it("limit/timeoutMs가 1 미만이거나 정수가 아니면 명확한 에러를 던진다", async () => {
    await expect(executor.execute("select 1", { limit: 0 })).rejects.toThrow(/limit/);
    await expect(executor.execute("select 1", { limit: 1.5 })).rejects.toThrow(/limit/);
    await expect(executor.execute("select 1", { timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
  });

  it("limit/timeoutMs가 상한을 넘으면 에러 없이 상한으로 캡한다", async () => {
    const result = await executor.execute("select * from stores", {
      limit: EXPLORE_SQL_MAX_LIMIT + 500,
      timeoutMs: EXPLORE_SQL_MAX_TIMEOUT_MS + 5000,
    });
    expect(result.timeoutMs).toBe(EXPLORE_SQL_MAX_TIMEOUT_MS);
    // 실제로 상한을 넘는 대량 데이터가 없어 truncated는 안 걸리지만, 에러 없이 통과했다는
    // 사실 자체가 "상한으로 캡"이 적용됐다는 증거다(적용 안 됐다면 resolveLimit이 던졌을 것).
    expect(result.rowCount).toBeLessThanOrEqual(EXPLORE_SQL_MAX_LIMIT);
  });

  it("advisory lock/set_config 함수 호출은 검증 단계에서 거부된다(TASKS T30, SEC-001/002 대응)", async () => {
    await expect(executor.execute("select pg_try_advisory_lock(727100104)")).rejects.toThrow(
      /보안상 금지된 함수/,
    );
    await expect(
      executor.execute("select set_config('statement_timeout', '0', false)"),
    ).rejects.toThrow(/보안상 금지된 함수/);
  });

  it("(SEC-001 재현, 왜 함수 블록리스트가 필요한지 실증) BEGIN READ ONLY만으로는 advisory lock을 막지 못한다 — 검증기를 우회한다고 가정하고 세션에 직접 재현", async () => {
    // executor.execute()는 이제 위 테스트처럼 advisory lock을 검증 단계에서 거부한다 — 이
    // 테스트는 "만약 검증기에 없는 다른 volatile 함수가 있었다면 READ ONLY 혼자로는 못 막았을
    // 것"이라는 사실 자체를 005 검수가 실제로 재현한 방법 그대로 증명해, 진짜 방어선이
    // 전용 DB role이어야 하는 이유를 살아있는 테스트로 남긴다(문서 SPEC §18/DESIGN §12.4).
    const lockKey = 727_100_104;
    await db.query("begin read only");
    const first = await db.query<{ pg_try_advisory_lock: boolean }>(
      "select pg_try_advisory_lock($1)",
      [lockKey],
    );
    expect(first.rows[0]?.pg_try_advisory_lock).toBe(true);
    await db.query("rollback");

    // rollback 뒤에도 lock이 여전히 잡혀 있다 — READ ONLY+ROLLBACK이 advisory lock 세션
    // 부수효과를 되돌리지 않는다는 뜻이다(테이블 쓰기와 달리).
    const second = await db.query<{ pg_try_advisory_lock: boolean }>(
      "select pg_try_advisory_lock($1)",
      [lockKey],
    );
    expect(second.rows[0]?.pg_try_advisory_lock).toBe(true); // 이미 우리가 들고 있으니 재획득도 성공

    // 정리 — 다른 테스트에 영향 없도록 두 번(각 성공한 acquire만큼) unlock한다.
    await db.query("select pg_advisory_unlock($1)", [lockKey]);
    await db.query("select pg_advisory_unlock($1)", [lockKey]);
  });

  it("BEGIN READ ONLY가 진짜 방어선이다 — 검증기를 통과해도 실제 쓰기 부작용은 DB가 거부한다", async () => {
    // nextval()은 SELECT 구문이라 검증기(select/with로 시작, insert/update/... 블록리스트)를
    // 그대로 통과하지만, 시퀀스를 진행시키는 쓰기 부작용이 있다 — Postgres는 READ ONLY
    // 트랜잭션 안에서 이 부작용 자체를 거부한다(문서 "22.1 Transaction Isolation"). 검증기가
    // 놓친 사례를 READ ONLY가 최종적으로 막는다는 걸 직접 재현해 증명한다.
    await db.exec("create sequence explore_sql_test_seq");
    await expect(executor.execute("select nextval('explore_sql_test_seq')")).rejects.toThrow(
      /read-only/i,
    );
  });

  it("실행이 끝나면 항상 롤백한다 — 같은 세션을 재사용해도 상태가 새지 않는다", async () => {
    await executor.execute("select * from stores");
    // 같은 PGlite 인스턴스로 다시 실행해도 정상 — 이전 실행이 트랜잭션을 열어둔 채 남기지 않는다.
    const result = await executor.execute("select * from stores");
    expect(result.rowCount).toBe(2);
  });

  it("존재하지 않는 테이블을 조회하면 원인이 담긴 에러를 던진다(부분 결과 없음)", async () => {
    await expect(executor.execute("select * from no_such_table")).rejects.toThrow();
  });

  // statement_timeout 실제 취소 동작은 여기서 테스트하지 않는다 — 스파이크로 확인한 결과
  // PGlite(단일 프로세스 WASM 임베디드 Postgres)는 statement_timeout을 실제로 집행하지
  // 않는다(SET은 성공하지만 오래 걸리는 쿼리를 취소하지 않음 — 백그라운드 인터럽트 처리가
  // 없는 구조적 한계로 추정, 실 Postgres/Neon과 다른 동작). set_config() 호출 자체와
  // limit/timeoutMs 검증·상한 로직은 위 테스트들로 이미 커버된다. 실 Postgres 대상 취소
  // 동작은 코드 리뷰로 확인했다(표준 GUC이므로 pg 백엔드에서는 정상 동작이 보장된다) —
  // 상세는 docs/SPEC.md §17 "알려진 한계".
});
