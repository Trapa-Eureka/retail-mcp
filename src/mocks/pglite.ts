/**
 * 테스트 전용 PGlite 웨어하우스 헬퍼 (TESTING.md §2).
 * 테스트마다 새 인프로세스 Postgres 인스턴스를 만들고, adapters/migrationRunner.ts의 공용
 * runner(loadMigrations/runMigrations)로 migrations/*.sql을 적용해 운영(Postgres)과
 * 동일한 스키마 + 동일한 러너 동작(파일명 검증, 이력 테이블, checksum)을 보장한다.
 * 네트워크 호출 없음.
 */
import { PGlite } from "@electric-sql/pglite";
import {
  createPgliteExecutor,
  loadMigrations,
  runMigrations,
} from "../adapters/migrationRunner.js";

export async function createTestWarehouse(): Promise<PGlite> {
  const db = new PGlite();
  const executor = createPgliteExecutor(db);
  const migrations = await loadMigrations();
  await runMigrations(executor, migrations);
  return db;
}
