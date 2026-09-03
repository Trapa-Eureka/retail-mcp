import { describe, expect, it } from "vitest";
import { validateReadOnlySql } from "../src/core/sqlValidator.js";

describe("validateReadOnlySql (explore_sql 1차 방어선, TASKS T27)", () => {
  it("단순 select는 통과하고 트레일링 세미콜론을 뗀 값을 반환한다", () => {
    expect(validateReadOnlySql("select 1;")).toBe("select 1");
    expect(validateReadOnlySql("select * from stores")).toBe("select * from stores");
  });

  it("with(CTE)로 시작하는 조회문도 통과한다", () => {
    const sql = "with t as (select 1 as x) select * from t";
    expect(validateReadOnlySql(sql)).toBe(sql);
  });

  it("대소문자를 가리지 않는다", () => {
    expect(() => validateReadOnlySql("SELECT * FROM stores")).not.toThrow();
    expect(() => validateReadOnlySql("With t As (Select 1) Select * From t")).not.toThrow();
  });

  it("빈 문자열/공백만 있으면 거부한다", () => {
    expect(() => validateReadOnlySql("")).toThrow(/비어/);
    expect(() => validateReadOnlySql("   ")).toThrow(/비어/);
  });

  it("select/with로 시작하지 않으면 거부한다", () => {
    expect(() => validateReadOnlySql("show tables")).toThrow(/select.*with/);
    expect(() => validateReadOnlySql("explain select 1")).toThrow(/select.*with/);
  });

  it("세미콜론으로 여러 문장을 이어붙이면 거부한다", () => {
    expect(() => validateReadOnlySql("select 1; select 2")).toThrow(/한 문장만/);
    expect(() => validateReadOnlySql("select 1; drop table stores")).toThrow(/한 문장만/);
  });

  it.each([
    "insert into stores values (1)",
    "update stores set name = 'x'",
    "delete from stores",
    "drop table stores",
    "alter table stores add column x text",
    "create table x (id int)",
    "truncate stores",
    "grant select on stores to public",
    "revoke select on stores from public",
    "copy stores to '/tmp/x'",
    "vacuum stores",
    "do $$ begin end $$",
  ])("금지 키워드가 있으면 거부한다: %s", (sql) => {
    expect(() => validateReadOnlySql(sql)).toThrow();
  });

  it("데이터 변형 CTE로 위장해도 거부한다(WITH로 시작해도 본문의 insert/delete를 잡는다)", () => {
    expect(() =>
      validateReadOnlySql("with x as (delete from stores returning *) select * from x"),
    ).toThrow(/delete/);
    expect(() =>
      validateReadOnlySql("with x as (insert into stores values (1) returning *) select * from x"),
    ).toThrow(/insert/);
  });

  it("주석 안의 금지 키워드는 오탐하지 않는다(검증용으로만 주석을 지운다)", () => {
    expect(() =>
      validateReadOnlySql("select 1 -- this looks like it could drop a table\n"),
    ).not.toThrow();
    expect(() => validateReadOnlySql("select 1 /* insert update delete */")).not.toThrow();
  });

  it("컬럼/식별자 이름에 금지 키워드가 부분 문자열로 섞여 있어도 오탐하지 않는다(단어 경계)", () => {
    // "created_at"에는 "create"가, "settings"에는 "set"이, "resetting"에는 "reset"이 부분
    // 문자열로 들어있지만 단어 경계 매칭이라 거부되지 않아야 한다.
    expect(() => validateReadOnlySql("select created_at, settings from stores")).not.toThrow();
  });

  it("정당한 컬럼 이름은 그대로 통과한다", () => {
    expect(() =>
      validateReadOnlySql("select store_id, variant_id from inventory_levels limit 10"),
    ).not.toThrow();
  });

  it.each([
    "select pg_advisory_lock(1)",
    "select pg_advisory_lock_shared(1)",
    "select pg_advisory_unlock(1)",
    "select pg_advisory_unlock_all()",
    "select pg_advisory_xact_lock(1)",
    "select pg_try_advisory_lock(1)",
    "select pg_try_advisory_lock_shared(1)",
    "select pg_try_advisory_xact_lock(1)",
    "select set_config('statement_timeout', '0', false)",
    "select pg_terminate_backend(123)",
    "select pg_cancel_backend(123)",
    "select pg_reload_conf()",
    "select lo_import('/etc/passwd')",
    "select dblink('host=evil.example', 'select 1')",
    "select pg_read_file('/etc/passwd')",
    "select pg_ls_dir('.')",
  ])("보안상 금지된 함수 호출은 거부한다(TASKS T30, SEC-001/002 대응): %s", (sql) => {
    expect(() => validateReadOnlySql(sql)).toThrow(/보안상 금지된 함수/);
  });

  it('advisory lock 함수는 언더스코어 때문에 단어 경계 블록리스트("lock")를 우회했었다 — 함수명 블록리스트로 막는다(SEC-001 재현)', () => {
    // "lock"이라는 단어 자체는 FORBIDDEN_KEYWORDS에 있지만 \block\b는 "advisory_lock"의
    // "_lock" 앞에 단어 경계가 없어(밑줄도 \w) 못 잡는다 — 005가 실증한 정확히 그 우회다.
    expect(() => validateReadOnlySql("select pg_try_advisory_lock(727100104)")).toThrow(
      /pg_try_advisory_lock/,
    );
  });

  it("스키마 한정자(pg_catalog.)나 대소문자·공백을 섞어도 함수 블록리스트를 우회하지 못한다", () => {
    expect(() => validateReadOnlySql("select pg_catalog.pg_advisory_lock(1)")).toThrow();
    expect(() => validateReadOnlySql("select PG_ADVISORY_LOCK(1)")).toThrow();
    expect(() => validateReadOnlySql("select pg_advisory_lock  (1)")).toThrow();
  });

  it("금지된 함수 이름이 다른 식별자의 접미사일 뿐이면(다른 실제 함수 호출) 오탐하지 않는다", () => {
    // "my_set_config(1)"은 문법상 함수 호출이지만 "set_config"가 아니라 "my_set_config"라는
    // 별개 이름이다 — 단어 경계 앞에 "_"(\w)가 있어 진짜 set_config와 구분돼야 한다.
    expect(() => validateReadOnlySql("select my_set_config(1) from stores")).not.toThrow();
    expect(() => validateReadOnlySql("select my_set_config_backup from stores")).not.toThrow();
  });
});
