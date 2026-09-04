/**
 * Executor dedicated to `explore_sql` (v0.2 backlog, the pre-approved guardrail 4 exception that
 * DESIGN §6 announced by name) — the **only** code path that executes arbitrary SQL text given
 * by a user as an MCP tool argument. Deliberately separated from every other Warehouse method
 * (parameterized fixed queries) so that anyone auditing "where arbitrary SQL gets executed" only
 * needs to look at this one file.
 *
 * Two lines of defense (defense in depth):
 * 1) `core/sqlValidator.ts` — a UX layer that quickly rejects obviously wrong requests before
 *    execution (a blocklist; known to be imperfect).
 * 2) Here — even SQL that passed validation always runs inside a `BEGIN READ ONLY` transaction.
 *    The Postgres engine itself rejects every write attempt in this mode (including advancing a
 *    sequence via nextval) — SQL that bypasses the validator is finally stopped here. Because
 *    this is the "real" line of defense, it is safe even if the DB role running the transaction
 *    has write privileges (a separate read-only role in production is still recommended, but the
 *    tool's safety does not depend on it). Always ROLLBACK at the end (no difference from COMMIT
 *    for a read-only transaction — the convention of leaving no trace).
 *
 * The row limit is applied safely by wrapping the user SQL in an outer subquery rather than
 * parsing/rewriting it (`select * from (<validated SQL>) as t limit $1`) — LIMIT is a bound
 * parameter and statement_timeout is bound via `set_config()`, so neither value is interpolated
 * directly into the SQL text.
 *
 * **Known limitation (embedded PGlite only; real Postgres/Neon is not affected)**: a spike showed
 * that PGlite (single-process WASM embedded Postgres) does not actually enforce
 * `statement_timeout` — the `set_config()` call itself succeeds but long-running queries are
 * not cancelled (presumably a structural limitation: no background interrupt handling).
 * `BEGIN READ ONLY` (item 2 above, the tool's real safeguard) was verified to work correctly on
 * PGlite too — only the "automatically cut off slow queries" feature is affected, and the
 * "block writes" safety is guaranteed identically on both backends. Details in
 * `docs/SPEC.md` §17.
 */
import { validateReadOnlySql } from "../core/sqlValidator.js";
import type { ExploreSqlExecutor, ExploreSqlOptions, ExploreSqlResult } from "../core/types.js";
import { withSession, type DbConnectionProvider } from "./pgWarehouse.js";

export const EXPLORE_SQL_DEFAULT_LIMIT = 200;
export const EXPLORE_SQL_MAX_LIMIT = 1000;
export const EXPLORE_SQL_DEFAULT_TIMEOUT_MS = 5000;
export const EXPLORE_SQL_MAX_TIMEOUT_MS = 30000;

function resolveLimit(limit: number | undefined): number {
  const value = limit ?? EXPLORE_SQL_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`limit must be an integer >= 1. Received: ${limit}.`);
  }
  return Math.min(value, EXPLORE_SQL_MAX_LIMIT);
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? EXPLORE_SQL_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`timeoutMs must be an integer >= 1. Received: ${timeoutMs}.`);
  }
  return Math.min(value, EXPLORE_SQL_MAX_TIMEOUT_MS);
}

function isTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|canceling statement/i.test(message);
}

export function createExploreSqlExecutor(provider: DbConnectionProvider): ExploreSqlExecutor {
  return {
    async execute(sql: string, opts: ExploreSqlOptions = {}): Promise<ExploreSqlResult> {
      const validatedSql = validateReadOnlySql(sql);
      const limit = resolveLimit(opts.limit);
      const timeoutMs = resolveTimeoutMs(opts.timeoutMs);

      return withSession(provider, async (session) => {
        await session.query("begin read only");
        try {
          // SET is a GUC command that does not accept parameter binding, so the validated
          // integer is bound via set_config() (never interpolated directly into the SQL text).
          await session.query("select set_config('statement_timeout', $1, true)", [
            String(timeoutMs),
          ]);
          const { rows } = await session.query<Record<string, unknown>>(
            `select * from (${validatedSql}) as explore_sql_subquery limit $1`,
            [limit + 1], // +1 to detect truncation.
          );
          const truncated = rows.length > limit;
          const resultRows = truncated ? rows.slice(0, limit) : rows;
          return {
            columns: resultRows.length > 0 ? Object.keys(resultRows[0]!) : [],
            rows: resultRows,
            rowCount: resultRows.length,
            truncated,
            timeoutMs,
          };
        } catch (err) {
          if (isTimeoutError(err)) {
            throw new Error(
              `The query did not finish within ${timeoutMs}ms and was cancelled — narrow the ` +
                "WHERE clause or increase timeoutMs and try again.",
              { cause: err },
            );
          }
          throw err;
        } finally {
          try {
            await session.query("rollback");
          } catch {
            // Ignore a failure of the rollback itself — it is a read-only transaction, so there
            // is nothing to commit. The original error (if any) is already propagated to the
            // caller by the catch/rethrow above or by the try block itself.
          }
        }
      });
    },
  };
}
