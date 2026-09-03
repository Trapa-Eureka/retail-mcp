/**
 * 마이그레이션 러너 CLI 진입점.
 *
 * `npm run migrate`로 실행하면 DATABASE_URL 대상 Postgres에 migrations/*.sql을
 * 파일명 순서대로, 아직 적용되지 않은 것만 적용한다. 적용 이력은 schema_migrations
 * 테이블에 기록하며, 이미 적용된 마이그레이션은 건너뛰므로 여러 번 실행해도 안전하다(멱등).
 *
 * 동시 실행 안전성: 실행 전체를 advisory lock(pg_advisory_lock)으로 감싼다(두 프로세스가
 * 동시에 시작해도 한쪽만 실제로 DDL을 적용) — 실제 배선(pool/client/lock)은
 * `src/adapters/migratePg.ts`에 있다(`src/cli/migrate.ts`, npm 배포 bin
 * `retail-mcp-migrate`, SR2-REL-001과 공유 — 같은 lock key가 두 파일에 따로 하드코딩돼
 * 있으면 한쪽만 고치고 다른 쪽을 잊는 사고가 난다).
 *
 * 프로덕션 DATABASE_URL 대상 실행은 사람만 한다 (CLAUDE.md 가드레일 5).
 *
 * 러너 핵심 로직(loadMigrations/runMigrations/executor)은 `src/adapters/migrationRunner.ts`에
 * 있다(T14 — 프로덕션 코드도 필요해지며 옮겼다). 이 파일은 그걸 가져다 쓰는 CLI 껍데기다.
 */
import { fileURLToPath } from "node:url";
import { applyMigrationsToDatabaseUrl } from "../src/adapters/migratePg.js";

export { withAdvisoryLock, type LockClient } from "../src/adapters/advisoryLock.js";
export {
  MIGRATIONS_DIR,
  checkPendingMigrations,
  computeChecksum,
  createPgExecutor,
  createPgliteExecutor,
  loadMigrations,
  runMigrations,
  type Migration,
  type PendingMigrationsStatus,
  type RunMigrationsResult,
  type SqlExecutor,
} from "../src/adapters/migrationRunner.js";
export {
  MIGRATION_LOCK_KEY,
  applyMigrationsToDatabaseUrl,
  checkPendingMigrationsForDatabaseUrl,
} from "../src/adapters/migratePg.js";

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL이 없습니다. Neon/Supabase에서 발급한 Postgres 연결 문자열을 .env에 추가하세요.",
    );
  }

  const result = await applyMigrationsToDatabaseUrl(databaseUrl);
  console.log(
    `마이그레이션 완료 — 적용 ${result.applied.length}건 (${result.applied.join(", ") || "없음"}), ` +
      `건너뜀 ${result.skipped.length}건`,
  );
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
