/**
 * 마이그레이션 러너 CLI 진입점.
 *
 * `npm run migrate`로 실행하면 DATABASE_URL 대상 Postgres에 migrations/*.sql을
 * 파일명 순서대로, 아직 적용되지 않은 것만 적용한다. 적용 이력은 schema_migrations
 * 테이블에 기록하며, 이미 적용된 마이그레이션은 건너뛰므로 여러 번 실행해도 안전하다(멱등).
 *
 * 동시 실행 안전성: 실행 전체를 advisory lock(pg_advisory_lock)으로 감싸 두 프로세스가
 * 동시에 시작해도 한쪽만 실제로 DDL을 적용한다. 각 마이그레이션은 BEGIN/COMMIT으로
 * 감싸며, 실패 시 명시적으로 ROLLBACK한 뒤 에러를 던진다 — 이 모든 SQL은 pool이 아니라
 * 하나로 고정한 client에서만 실행해 트랜잭션 상태가 커넥션 풀 사이에서 흩어지지 않게 한다.
 *
 * 프로덕션 DATABASE_URL 대상 실행은 사람만 한다 (CLAUDE.md 가드레일 5).
 *
 * 러너 핵심 로직(loadMigrations/runMigrations/executor)은 `src/adapters/migrationRunner.ts`에
 * 있다(T14 — 프로덕션 코드도 필요해지며 옮겼다). 이 파일은 그걸 가져다 쓰는 CLI 껍데기다.
 */
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { withAdvisoryLock } from "../src/adapters/advisoryLock.js";
import {
  createPgExecutor,
  loadMigrations,
  runMigrations,
} from "../src/adapters/migrationRunner.js";

export { withAdvisoryLock, type LockClient } from "../src/adapters/advisoryLock.js";
export {
  MIGRATIONS_DIR,
  computeChecksum,
  createPgExecutor,
  createPgliteExecutor,
  loadMigrations,
  runMigrations,
  type Migration,
  type RunMigrationsResult,
  type SqlExecutor,
} from "../src/adapters/migrationRunner.js";

/**
 * 이 레포의 마이그레이션 실행 전용 advisory lock 키. 값 자체에 의미는 없고 "고정되어 있고
 * 다른 용도와 우연히 겹치지 않을 만큼 임의적"이면 된다.
 */
const MIGRATION_LOCK_KEY = 727_100_104;

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL이 없습니다. Neon/Supabase에서 발급한 Postgres 연결 문자열을 .env에 추가하세요.",
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client: PoolClient = await pool.connect();
  try {
    const result = await withAdvisoryLock(client, MIGRATION_LOCK_KEY, async () => {
      const executor = createPgExecutor(client);
      const migrations = await loadMigrations();
      return runMigrations(executor, migrations);
    });
    console.log(
      `마이그레이션 완료 — 적용 ${result.applied.length}건 (${result.applied.join(", ") || "없음"}), ` +
        `건너뜀 ${result.skipped.length}건`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
