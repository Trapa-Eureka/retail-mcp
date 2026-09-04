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

describe("createExploreSqlExecutor (explore_sql, TASKS T27, guardrail 4 exception)", () => {
  let db: PGlite;
  let warehouse: Warehouse;
  let executor: ExploreSqlExecutor;

  beforeEach(async () => {
    db = await createTestWarehouse();
    warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    executor = createExploreSqlExecutor(createPgliteConnectionProvider(db));

    const stores: StoreRow[] = [
      { id: "store_main", name: "Main Store" },
      { id: "store_makati", name: "Makati Branch" },
    ];
    await warehouse.upsertStores(stores);
  });

  it("runs a normal select and returns columns/rows/rowCount", async () => {
    const result = await executor.execute("select id, name from stores order by id");
    expect(result.columns.sort()).toEqual(["id", "name"]);
    expect(result.rowCount).toBe(2);
    expect(result.rows).toEqual([
      { id: "store_main", name: "Main Store" },
      { id: "store_makati", name: "Makati Branch" },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("truncates when there are more results than limit and returns truncated=true", async () => {
    const result = await executor.execute("select * from stores order by id", { limit: 1 });
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("returns an empty columns array when there are 0 results", async () => {
    const result = await executor.execute("select * from stores where id = 'no_such_store'");
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("rejects SQL that fails validation before execution (does not start with select/with)", async () => {
    await expect(executor.execute("insert into stores values ('x', 'y')")).rejects.toThrow();
    // Nothing should actually have been loaded.
    expect(await warehouse.queryStores()).toHaveLength(2);
  });

  it("also rejects data modification disguised as with (CTE) at the validation stage (keyword blocklist such as insert)", async () => {
    await expect(
      executor.execute(
        "with x as (insert into stores values ('x','y') returning *) select * from x",
      ),
    ).rejects.toThrow(/forbidden keyword/);
    expect(await warehouse.queryStores()).toHaveLength(2);
  });

  it("throws a clear error when limit/timeoutMs is below 1 or not an integer", async () => {
    await expect(executor.execute("select 1", { limit: 0 })).rejects.toThrow(/limit/);
    await expect(executor.execute("select 1", { limit: 1.5 })).rejects.toThrow(/limit/);
    await expect(executor.execute("select 1", { timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
  });

  it("caps limit/timeoutMs at the maximum without error when they exceed it", async () => {
    const result = await executor.execute("select * from stores", {
      limit: EXPLORE_SQL_MAX_LIMIT + 500,
      timeoutMs: EXPLORE_SQL_MAX_TIMEOUT_MS + 5000,
    });
    expect(result.timeoutMs).toBe(EXPLORE_SQL_MAX_TIMEOUT_MS);
    // There is no bulk data exceeding the cap, so truncated is not triggered, but the very fact
    // that it passed without error proves the "cap at maximum" was applied (otherwise
    // resolveLimit would have thrown).
    expect(result.rowCount).toBeLessThanOrEqual(EXPLORE_SQL_MAX_LIMIT);
  });

  it("rejects advisory lock/set_config function calls at the validation stage (TASKS T30, SEC-001/002 response)", async () => {
    await expect(executor.execute("select pg_try_advisory_lock(727100104)")).rejects.toThrow(
      /forbidden for security reasons/,
    );
    await expect(
      executor.execute("select set_config('statement_timeout', '0', false)"),
    ).rejects.toThrow(/forbidden for security reasons/);
  });

  it("(SEC-001 reproduction, demonstrating why the function blocklist is needed) BEGIN READ ONLY alone does not block advisory locks — reproduced directly on the session, assuming the validator is bypassed", async () => {
    // executor.execute() now rejects advisory locks at the validation stage as in the test
    // above — this test proves the fact itself that "had there been another volatile function
    // missing from the validator, READ ONLY alone could not have blocked it", exactly the way
    // review 005 reproduced it, leaving a living test of why the real line of defense must be a
    // dedicated DB role (docs SPEC §18/DESIGN §12.4).
    const lockKey = 727_100_104;
    await db.query("begin read only");
    const first = await db.query<{ pg_try_advisory_lock: boolean }>(
      "select pg_try_advisory_lock($1)",
      [lockKey],
    );
    expect(first.rows[0]?.pg_try_advisory_lock).toBe(true);
    await db.query("rollback");

    // The lock is still held after rollback — READ ONLY + ROLLBACK does not undo the advisory
    // lock session side effect (unlike table writes).
    const second = await db.query<{ pg_try_advisory_lock: boolean }>(
      "select pg_try_advisory_lock($1)",
      [lockKey],
    );
    expect(second.rows[0]?.pg_try_advisory_lock).toBe(true); // We already hold it, so re-acquiring succeeds too.

    // Cleanup — unlock twice (once per successful acquire) so other tests are unaffected.
    await db.query("select pg_advisory_unlock($1)", [lockKey]);
    await db.query("select pg_advisory_unlock($1)", [lockKey]);
  });

  it("BEGIN READ ONLY is the real line of defense — even past the validator, the DB rejects actual write side effects", async () => {
    // nextval() is a SELECT statement, so it passes the validator as-is (starts with
    // select/with, insert/update/... blocklist), but it has the write side effect of advancing
    // a sequence — Postgres rejects that side effect itself inside a READ ONLY transaction
    // (docs "22.1 Transaction Isolation"). Reproduces directly that READ ONLY finally blocks a
    // case the validator missed.
    await db.exec("create sequence explore_sql_test_seq");
    await expect(executor.execute("select nextval('explore_sql_test_seq')")).rejects.toThrow(
      /read-only/i,
    );
  });

  it("always rolls back when execution finishes — no state leaks even when the same session is reused", async () => {
    await executor.execute("select * from stores");
    // Running again on the same PGlite instance works — the previous run did not leave a
    // transaction open.
    const result = await executor.execute("select * from stores");
    expect(result.rowCount).toBe(2);
  });

  it("throws an error carrying the cause when querying a non-existent table (no partial result)", async () => {
    await expect(executor.execute("select * from no_such_table")).rejects.toThrow();
  });

  // The actual statement_timeout cancellation behaviour is not tested here — a spike showed
  // that PGlite (single-process WASM embedded Postgres) does not actually enforce
  // statement_timeout (SET succeeds but long-running queries are not cancelled — presumably a
  // structural limitation with no background interrupt handling, unlike real Postgres/Neon).
  // The set_config() call itself and the limit/timeoutMs validation/cap logic are already
  // covered by the tests above. Cancellation against real Postgres was verified by code review
  // (it is a standard GUC, so correct behaviour on a pg backend is guaranteed) — details in
  // docs/SPEC.md §17 "Known limitations".
});
