/**
 * The **first line of defense** with which `explore_sql` (v0.2 backlog, the pre-approved
 * guardrail 4 exception that DESIGN §6 announced by name) filters user SQL before execution.
 * **It is not the real line of defense** — that is `adapters/exploreSqlExecutor.ts` running the
 * SQL only inside a `BEGIN READ ONLY` transaction (the Postgres engine itself rejects every
 * write in it, including advancing sequences). The validation here is blocklist-based and known
 * to be imperfect — its purpose is to improve UX by rejecting "obviously wrong requests" with a
 * fast, clear error before execution, not to pretend to be the only safeguard (defense in depth
 * — in the same spirit as the CLAUDE.md error message convention, it states the cause
 * specifically).
 *
 * No external IO — pure string inspection only (core/ principle).
 */

const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "vacuum",
  "reindex",
  "call",
  "execute",
  "merge",
  "do",
  "listen",
  "notify",
  "unlisten",
  "refresh",
  "security",
  "lock",
  "reset",
  "discard",
  "prepare",
  "deallocate",
  "cluster",
] as const;

/**
 * Blocks **function calls** with session side effects by full function name (TASKS T30,
 * SEC-001/002 response). Review 005 demonstrated that the `\bword\b` matching of
 * `FORBIDDEN_KEYWORDS` lets names joined by underscores such as `pg_advisory_lock` through —
 * no word boundary forms around "lock" (`_` is also regex `\w`). Here the full function name
 * is matched exactly to block that bypass.
 *
 * - advisory lock family: `BEGIN READ ONLY` blocks table/sequence writes but not this
 *   session-level side effect (demonstrated in 005 — the lock remained after rollback). READ
 *   ONLY alone is therefore not safe, so it is blocked here.
 * - `set_config`: the executor itself uses it to set `statement_timeout`
 *   (exploreSqlExecutor.ts) — user SQL calling the same function again could revert that value
 *   (005 SEC-002). The function is blocked for users entirely — it is not needed for read-only
 *   queries.
 * - file/remote access family (`lo_import`/`lo_export`/`dblink*`/`pg_read_file` etc.): side
 *   effects outside the scope of a READ ONLY transaction (disk IO, network connections), so
 *   blocked.
 * - backend control family (`pg_terminate_backend`/`pg_cancel_backend`/`pg_reload_conf`/
 *   `pg_rotate_logfile`): affects other sessions/server processes.
 *
 * **This list is not complete either** — volatile functions not listed here (e.g. `nextval`)
 * still pass, and in that case `BEGIN READ ONLY` is the final line of defense (demonstrated by
 * test, `tests/exploreSqlExecutor.test.ts`). The real line of defense is not this blocklist but a
 * dedicated DB role without permission to execute dangerous functions (SPEC §18, DESIGN §12.4)
 * — this list is merely a low-cost extra layer that blocks two known concrete bypasses.
 */
const FORBIDDEN_FUNCTION_CALLS = [
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_advisory_unlock",
  "pg_advisory_unlock_all",
  "pg_advisory_unlock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_xact_lock_shared",
  "pg_try_advisory_lock",
  "pg_try_advisory_lock_shared",
  "pg_try_advisory_xact_lock",
  "pg_try_advisory_xact_lock_shared",
  "set_config",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "lo_import",
  "lo_export",
  "dblink",
  "dblink_connect",
  "dblink_exec",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
] as const;

/** Strips comments for validation only — the SQL text used for actual execution is preserved as-is (the original is returned). */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Validates that `sql` is a single SELECT/WITH (CTE) query statement. On success returns the
 * SQL with any trailing semicolon removed; on violation throws an error carrying the cause.
 */
export function validateReadOnlySql(sql: string): string {
  const trimmed = sql.trim();
  if (trimmed === "") {
    throw new Error("SQL is empty. Enter a query statement starting with select or with.");
  }

  const analyzed = stripSqlComments(trimmed).trim();
  const withoutTrailingSemicolon = analyzed.replace(/;\s*$/, "");

  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error(
      "Only a single SQL statement is allowed — multiple statements cannot be chained with " +
        "semicolons. Keep only one statement and run again.",
    );
  }

  if (!/^(select|with)\b/i.test(withoutTrailingSemicolon)) {
    throw new Error(
      'Only query statements starting with "select" or "with" (CTE) are allowed — explore_sql ' +
        "is read-only.",
    );
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(withoutTrailingSemicolon)) {
      throw new Error(
        `The SQL contains a forbidden keyword ("${keyword}") — explore_sql allows only ` +
          "SELECT/WITH queries that do not change data. Remove that part and run again.",
      );
    }
  }

  for (const fn of FORBIDDEN_FUNCTION_CALLS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, "i").test(withoutTrailingSemicolon)) {
      throw new Error(
        `The SQL contains a function call forbidden for security reasons ("${fn}(...)") — ` +
          "advisory lock, session setting and file/remote access functions cannot be called " +
          "from explore_sql (TASKS T30, SEC-001/002). Remove that part and run again.",
      );
    }
  }

  return trimmed.replace(/;\s*$/, "");
}
