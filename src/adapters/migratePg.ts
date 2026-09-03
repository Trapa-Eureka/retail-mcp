/**
 * `DATABASE_URL` 대상 Postgres에 advisory lock으로 감싸 안전하게 마이그레이션을 적용/점검하는
 * 공용 로직 — `scripts/migrate.ts`(저장소 전용, 가드레일 5: "프로덕션 마이그레이션은 사람만")와
 * `src/cli/migrate.ts`(npm 배포 bin `retail-mcp-migrate`, 2차 적대적 검수 SR2-REL-001)가
 * 공유한다.
 *
 * 원래 pool 생성·client 확보·advisory lock 배선·정리는 `scripts/migrate.ts`에만 있었다 — 두
 * 진입점이 같은 lock key(MIGRATION_LOCK_KEY)로 같은 DB를 겨냥할 수 있는데, 그 값이 두 파일에
 * 따로 하드코딩돼 있으면 한쪽만 고치고 다른 쪽을 잊는 사고가 난다. 이 모듈로 한 곳에 모았다.
 */
import { Pool, type PoolClient } from "pg";
import { withAdvisoryLock } from "./advisoryLock.js";
import {
  checkPendingMigrations,
  createPgExecutor,
  loadMigrations,
  runMigrations,
  type PendingMigrationsStatus,
  type RunMigrationsResult,
} from "./migrationRunner.js";

/** 마이그레이션 실행 전용 advisory lock 키. 값 자체엔 의미가 없고 "고정되어 있고 다른 용도와
 * 우연히 겹치지 않을 만큼 임의적"이면 된다. */
export const MIGRATION_LOCK_KEY = 727_100_104;

/** advisory lock으로 동시 실행을 막으며 대기 중인 마이그레이션을 전부 적용한다. */
export async function applyMigrationsToDatabaseUrl(
  databaseUrl: string,
): Promise<RunMigrationsResult> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client: PoolClient = await pool.connect();
  try {
    return await withAdvisoryLock(client, MIGRATION_LOCK_KEY, async () => {
      const executor = createPgExecutor(client);
      const migrations = await loadMigrations();
      return runMigrations(executor, migrations);
    });
  } finally {
    client.release();
    await pool.end();
  }
}

/** 아무것도 적용하지 않고(읽기 전용) 대기 중인 마이그레이션 id만 확인한다 —
 * `retail-mcp-migrate`의 기본 dry-run 모드가 쓴다. */
export async function checkPendingMigrationsForDatabaseUrl(
  databaseUrl: string,
): Promise<PendingMigrationsStatus> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const executor = createPgExecutor(pool);
    const migrations = await loadMigrations();
    return await checkPendingMigrations(executor, migrations);
  } finally {
    await pool.end();
  }
}
