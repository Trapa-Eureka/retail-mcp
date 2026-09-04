import { describe, expect, it } from "vitest";
import { validateReadOnlySql } from "../src/core/sqlValidator.js";

describe("validateReadOnlySql (explore_sql first line of defense, TASKS T27)", () => {
  it("passes a simple select and returns it with the trailing semicolon removed", () => {
    expect(validateReadOnlySql("select 1;")).toBe("select 1");
    expect(validateReadOnlySql("select * from stores")).toBe("select * from stores");
  });

  it("also passes a query starting with with (CTE)", () => {
    const sql = "with t as (select 1 as x) select * from t";
    expect(validateReadOnlySql(sql)).toBe(sql);
  });

  it("is case-insensitive", () => {
    expect(() => validateReadOnlySql("SELECT * FROM stores")).not.toThrow();
    expect(() => validateReadOnlySql("With t As (Select 1) Select * From t")).not.toThrow();
  });

  it("rejects an empty or whitespace-only string", () => {
    expect(() => validateReadOnlySql("")).toThrow(/empty/);
    expect(() => validateReadOnlySql("   ")).toThrow(/empty/);
  });

  it("rejects SQL that does not start with select/with", () => {
    expect(() => validateReadOnlySql("show tables")).toThrow(/select.*with/);
    expect(() => validateReadOnlySql("explain select 1")).toThrow(/select.*with/);
  });

  it("rejects multiple statements chained with semicolons", () => {
    expect(() => validateReadOnlySql("select 1; select 2")).toThrow(/single SQL statement/);
    expect(() => validateReadOnlySql("select 1; drop table stores")).toThrow(
      /single SQL statement/,
    );
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
  ])("rejects SQL containing a forbidden keyword: %s", (sql) => {
    expect(() => validateReadOnlySql(sql)).toThrow();
  });

  it("rejects data-modifying CTEs in disguise (catches insert/delete in the body even when it starts with WITH)", () => {
    expect(() =>
      validateReadOnlySql("with x as (delete from stores returning *) select * from x"),
    ).toThrow(/delete/);
    expect(() =>
      validateReadOnlySql("with x as (insert into stores values (1) returning *) select * from x"),
    ).toThrow(/insert/);
  });

  it("does not false-positive on forbidden keywords inside comments (comments are stripped for validation only)", () => {
    expect(() =>
      validateReadOnlySql("select 1 -- this looks like it could drop a table\n"),
    ).not.toThrow();
    expect(() => validateReadOnlySql("select 1 /* insert update delete */")).not.toThrow();
  });

  it("does not false-positive when a forbidden keyword is only a substring of a column/identifier name (word boundary)", () => {
    // "created_at" contains "create", "settings" contains "set" and "resetting" contains
    // "reset" as substrings, but word-boundary matching must not reject them.
    expect(() => validateReadOnlySql("select created_at, settings from stores")).not.toThrow();
  });

  it("passes legitimate column names as-is", () => {
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
  ])(
    "rejects function calls forbidden for security reasons (TASKS T30, SEC-001/002): %s",
    (sql) => {
      expect(() => validateReadOnlySql(sql)).toThrow(/forbidden for security reasons/);
    },
  );

  it('advisory lock functions used to bypass the word-boundary blocklist ("lock") because of the underscore — blocked by the function-name blocklist (SEC-001 reproduction)', () => {
    // The word "lock" itself is in FORBIDDEN_KEYWORDS, but \block\b cannot catch it because
    // there is no word boundary before "_lock" in "advisory_lock" (underscore is also \w) —
    // exactly the bypass demonstrated in 005.
    expect(() => validateReadOnlySql("select pg_try_advisory_lock(727100104)")).toThrow(
      /pg_try_advisory_lock/,
    );
  });

  it("cannot bypass the function blocklist with a schema qualifier (pg_catalog.), mixed case or whitespace", () => {
    expect(() => validateReadOnlySql("select pg_catalog.pg_advisory_lock(1)")).toThrow();
    expect(() => validateReadOnlySql("select PG_ADVISORY_LOCK(1)")).toThrow();
    expect(() => validateReadOnlySql("select pg_advisory_lock  (1)")).toThrow();
  });

  it("does not false-positive when a forbidden function name is merely the suffix of another identifier (a different real function call)", () => {
    // "my_set_config(1)" is syntactically a function call, but its name is "my_set_config",
    // not "set_config" — the "_" (\w) before the word boundary must distinguish it from the
    // real set_config.
    expect(() => validateReadOnlySql("select my_set_config(1) from stores")).not.toThrow();
    expect(() => validateReadOnlySql("select my_set_config_backup from stores")).not.toThrow();
  });
});
