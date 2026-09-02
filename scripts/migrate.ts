/**
 * 마이그레이션 러너.
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
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type Pool as PoolType, type PoolClient } from "pg";

const MIGRATIONS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../migrations");

/** 마이그레이션 파일명 규칙: `{순번3자리}_{설명}.sql` (예: 001_init.sql). id는 확장자 제외 파일명. */
const MIGRATION_ID_PATTERN = /^[0-9]{3}_[a-z0-9_]+$/;

/**
 * 이 레포의 마이그레이션 실행 전용 advisory lock 키. 값 자체에 의미는 없고 "고정되어 있고
 * 다른 용도와 우연히 겹치지 않을 만큼 임의적"이면 된다.
 */
const MIGRATION_LOCK_KEY = 727_100_104;

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
}

/** SQL 실행기 — pg(Pool/PoolClient)와 PGlite(테스트)를 동일한 형태로 다루기 위한 최소 인터페이스. */
export interface SqlExecutor {
  /** 파라미터 없는 SQL(여러 statement 가능)을 실행한다. 결과 행은 사용하지 않는다. */
  exec(sql: string): Promise<void>;
  /** 결과 행이 필요한 단일 조회를 실행한다. */
  query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>;
}

/** pg의 Pool과 PoolClient는 동일한 query() 시그니처를 공유한다. */
type PgQueryable = Pick<PoolType, "query">;

export function createPgExecutor(client: PgQueryable): SqlExecutor {
  return {
    async exec(sql) {
      await client.query(sql);
    },
    async query<T extends Record<string, unknown>>(sql: string) {
      const result = await client.query<T>(sql);
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

export function computeChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
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
    migrations.push({ id, sql, checksum: computeChecksum(sql) });
  }
  return migrations;
}

export interface RunMigrationsResult {
  applied: string[];
  skipped: string[];
}

/**
 * 마이그레이션을 순서대로 적용한다. 이미 schema_migrations에 기록된 id는 checksum이
 * 일치할 때만 건너뛴다 — 적용 후 파일 내용이 바뀌면 명확한 에러로 중단한다.
 * 각 마이그레이션은 BEGIN → SQL 적용 → 이력 기록 → COMMIT을 별도 문으로 실행하고,
 * 실패 시 명시적으로 ROLLBACK한다. 호출자는 이 함수 전체를 하나의 커넥션(client)에서
 * 실행해야 한다 — pool에서 매번 다른 커넥션을 받으면 BEGIN과 COMMIT/ROLLBACK이 서로 다른
 * 세션에 걸릴 수 있다.
 */
export async function runMigrations(
  executor: SqlExecutor,
  migrations: Migration[],
): Promise<RunMigrationsResult> {
  await executor.exec(
    `create table if not exists schema_migrations (
       id text primary key,
       checksum text not null,
       applied_at timestamptz not null default now()
     )`,
  );

  const { rows } = await executor.query<{ id: string; checksum: string }>(
    "select id, checksum from schema_migrations",
  );
  const appliedChecksumById = new Map(rows.map((r) => [r.id, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    const existingChecksum = appliedChecksumById.get(migration.id);
    if (existingChecksum !== undefined) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(
          `이미 적용된 마이그레이션 "${migration.id}"의 내용이 변경되었습니다 ` +
            `(기록된 checksum과 현재 파일의 checksum이 다릅니다). ` +
            `적용된 마이그레이션 파일은 수정하지 말고, 변경 사항은 새 번호의 마이그레이션 파일로 추가하세요.`,
        );
      }
      skipped.push(migration.id);
      continue;
    }

    try {
      await executor.exec("begin");
      await executor.exec(migration.sql);
      await executor.exec(
        `insert into schema_migrations (id, checksum) values ('${migration.id}', '${migration.checksum}')`,
      );
      await executor.exec("commit");
      applied.push(migration.id);
    } catch (err) {
      try {
        await executor.exec("rollback");
      } catch {
        // rollback 자체의 실패는 무시한다 — 아래에서 원본 에러를 던져 원인을 보존한다.
      }
      throw err;
    }
  }

  return { applied, skipped };
}

/** advisory lock 호출에 필요한 최소 시그니처 — pg의 Pool/PoolClient와 테스트용 fake가 함께 만족한다. */
export interface LockClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/** advisory lock 획득 → fn 실행 → advisory lock 해제. 실패해도 해제는 반드시 시도한다. */
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
