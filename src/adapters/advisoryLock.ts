/**
 * Postgres advisory lock 헬퍼. 여러 곳(scripts/migrate.ts, src/mcp/tools.ts의 sync_now)에서
 * "동시 실행 중 하나만 통과"를 위해 재사용한다 — 원래 scripts/migrate.ts에만 있던 것을
 * T9에서 여기로 옮겼다(src가 scripts에 의존하는 잘못된 방향을 피하려고 — scripts는 src에
 * 의존해도 되지만 반대는 안 된다).
 */

/** advisory lock 호출에 필요한 최소 시그니처 — pg의 Pool/PoolClient와 테스트용 fake가 함께 만족한다. */
export interface LockClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/** advisory lock 획득(블로킹) → fn 실행 → advisory lock 해제. 실패해도 해제는 반드시 시도한다. */
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

/** withTryAdvisoryLock에 필요한 최소 시그니처 — 결과 행을 읽어야 해서 LockClient보다 넓다. */
export interface QueryClient {
  query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export class AdvisoryLockBusyError extends Error {
  constructor(key: number) {
    super(`advisory lock(key=${key})을 다른 실행이 이미 보유하고 있습니다.`);
    this.name = "AdvisoryLockBusyError";
  }
}

/**
 * 논블로킹 advisory lock: 이미 다른 세션이 잠그고 있으면 기다리지 않고 즉시
 * `AdvisoryLockBusyError`를 던진다. `sync_now`처럼 "동시 호출 중 하나만 실행하고 나머지는
 * 즉시 실행 중 오류를 반환"해야 하는 곳에 쓴다(TESTING.md §7, DESIGN §11.4). 대기 후 순차
 * 실행이 필요하면(예: 마이그레이션) `withAdvisoryLock`을 쓴다.
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
