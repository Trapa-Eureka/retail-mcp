/**
 * 마이그레이션 러너.
 *
 * `npm run migrate`로 실행하면 DATABASE_URL 대상 Postgres에 migrations/*.sql을
 * 파일명 순서대로, 아직 적용되지 않은 것만 적용한다. 적용 이력은 schema_migrations
 * 테이블에 기록하며, 이미 적용된 마이그레이션은 건너뛰므로 여러 번 실행해도 안전하다(멱등).
 *
 * 프로덕션 DATABASE_URL 대상 실행은 사람만 한다 (CLAUDE.md 가드레일 5).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const MIGRATIONS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../migrations");

/** 마이그레이션 파일명 규칙: `{순번3자리}_{설명}.sql` (예: 001_init.sql). id는 확장자 제외 파일명. */
const MIGRATION_ID_PATTERN = /^[0-9]{3}_[a-z0-9_]+$/;

export interface Migration {
  id: string;
  sql: string;
}

/** SQL 실행기 — pg.Pool과 PGlite(테스트)를 동일한 형태로 다루기 위한 최소 인터페이스. */
export interface SqlExecutor {
  /** 파라미터 없는 SQL(여러 statement 가능)을 실행한다. 결과 행은 사용하지 않는다. */
  exec(sql: string): Promise<void>;
  /** 결과 행이 필요한 단일 조회를 실행한다. */
  query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>;
}

export function createPgExecutor(pool: Pool): SqlExecutor {
  return {
    async exec(sql) {
      await pool.query(sql);
    },
    async query<T extends Record<string, unknown>>(sql: string) {
      const result = await pool.query<T>(sql);
      return { rows: result.rows };
    },
  };
}

/** PGlite 인스턴스(테스트)를 SqlExecutor로 감싼다. 인터페이스만 맞으면 되므로 구체 타입은 unknown으로 받는다. */
export function createPgliteExecutor(db: {
  exec(sql: string): Promise<unknown>;
  query(sql: string): Promise<{ rows: unknown[] }>;
}): SqlExecutor {
  return {
    async exec(sql) {
      await db.exec(sql);
    },
    async query<T extends Record<string, unknown>>(sql: string) {
      const result = await db.query(sql);
      return { rows: result.rows as T[] };
    },
  };
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    if (!MIGRATION_ID_PATTERN.test(id)) {
      throw new Error(
        `마이그레이션 파일명이 규칙에 맞지 않습니다: ${file}. ` +
          `{순번3자리}_{설명}.sql 형식(예: 001_init.sql)으로 이름을 바꾸세요.`,
      );
    }
    const sql = await readFile(path.join(dir, file), "utf8");
    migrations.push({ id, sql });
  }
  return migrations;
}

export interface RunMigrationsResult {
  applied: string[];
  skipped: string[];
}

/**
 * 마이그레이션을 순서대로 적용한다. 이미 schema_migrations에 기록된 id는 건너뛴다.
 * 각 마이그레이션은 BEGIN/COMMIT으로 감싸 SQL 적용과 이력 기록을 한 트랜잭션에서 처리한다 —
 * 중간에 실패하면 롤백되어 다음 실행에서 안전하게 재시도된다.
 */
export async function runMigrations(
  executor: SqlExecutor,
  migrations: Migration[],
): Promise<RunMigrationsResult> {
  await executor.exec(
    `create table if not exists schema_migrations (
       id text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const { rows } = await executor.query<{ id: string }>("select id from schema_migrations");
  const appliedIds = new Set(rows.map((r) => r.id));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    await executor.exec(
      `begin;\n${migration.sql}\ninsert into schema_migrations (id) values ('${migration.id}');\ncommit;`,
    );
    applied.push(migration.id);
  }

  return { applied, skipped };
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL이 없습니다. Neon/Supabase에서 발급한 Postgres 연결 문자열을 .env에 추가하세요.",
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const executor = createPgExecutor(pool);
    const migrations = await loadMigrations();
    const result = await runMigrations(executor, migrations);
    console.log(
      `마이그레이션 완료 — 적용 ${result.applied.length}건 (${result.applied.join(", ") || "없음"}), ` +
        `건너뜀 ${result.skipped.length}건`,
    );
  } finally {
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
