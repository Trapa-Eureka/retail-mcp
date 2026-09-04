/**
 * Postgres advisory lock helpers. Reused in several places (scripts/migrate.ts, sync_now in
 * src/mcp/tools.ts) for "only one of the concurrent runs gets through" — originally lived only
 * in scripts/migrate.ts and was moved here in T9 (to avoid the wrong dependency direction of
 * src depending on scripts — scripts may depend on src, but not the other way round).
 */

/** Minimal signature needed for advisory lock calls — satisfied by pg's Pool/PoolClient and by test fakes alike. */
export interface LockClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/** Acquire advisory lock (blocking) → run fn → release advisory lock. The release is always attempted even on failure. */
export async function withAdvisoryLock<T>(
  client: LockClient,
  key: number,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("select pg_advisory_lock($1)", [key]);
  try {
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock($1)", [key]);
  }
}

/** Minimal signature needed by withTryAdvisoryLock — wider than LockClient because result rows must be read. */
export interface QueryClient {
  query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export class AdvisoryLockBusyError extends Error {
  constructor(key: number) {
    super(`The advisory lock (key=${key}) is already held by another run.`);
    this.name = "AdvisoryLockBusyError";
  }
}

/**
 * Non-blocking advisory lock: if another session already holds the lock, it does not wait and
 * immediately throws `AdvisoryLockBusyError`. Used where "only one of the concurrent calls runs
 * and the rest immediately return an already-running error" is required, like `sync_now`
 * (TESTING.md §7, DESIGN §11.4). When waiting and sequential execution is needed (e.g.
 * migrations), use `withAdvisoryLock`.
 */
export async function withTryAdvisoryLock<T>(
  client: QueryClient,
  key: number,
  fn: () => Promise<T>,
): Promise<T> {
  const { rows } = await client.query<{ locked: boolean }>(
    "select pg_try_advisory_lock($1) as locked",
    [key],
  );
  if (rows[0]?.locked !== true) {
    throw new AdvisoryLockBusyError(key);
  }
  try {
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock($1)", [key]);
  }
}
