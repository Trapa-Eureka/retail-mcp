/**
 * 테스트 전용 PGlite 웨어하우스 헬퍼 (TESTING.md §2).
 * 테스트마다 새 인프로세스 Postgres 인스턴스를 만들고 migrations/*.sql을 순서대로 적용해
 * 운영(Postgres)과 동일한 스키마를 보장한다. 네트워크 호출 없음.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../migrations");

export async function createTestWarehouse(): Promise<PGlite> {
  const db = new PGlite();
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.exec(sql);
  }
  return db;
}
