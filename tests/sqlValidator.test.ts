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
});
