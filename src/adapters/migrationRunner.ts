/**
 * 마이그레이션 러너 핵심 로직 — pg(Postgres)와 PGlite 양쪽에서 재사용한다.
 *
 * 원래 `scripts/migrate.ts`에만 있었으나, T14(임베디드 PGlite 웨어하우스 기본값)가 프로덕션
 * 코드(`server.ts`/`agent/reorder.ts`)에서도 이 로직이 필요해지며 여기로 옮겼다 —
 * `src`가 `scripts`에 의존하는 잘못된 방향을 피하기 위해서다(advisoryLock.ts와 같은 이유로
 * 같은 전례를 따른 것: scripts는 src에 의존해도 되지만 반대는 안 된다). `scripts/migrate.ts`는
 * 이제 이 모듈을 가져다 쓰는 CLI 진입점(사람이 프로덕션 DATABASE_URL에 실행, 가드레일 5)이고,
 * `src/mocks/pglite.ts`(테스트 전용 PGlite 웨어하우스)도 여기서 가져온다.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool as PoolType } from "pg";

export const MIGRATIONS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../migrations");

/** 마이그레이션 파일명 규칙: `{순번3자리}_{설명}.sql` (예: 001_init.sql). id는 확장자 제외 파일명. */
const MIGRATION_ID_PATTERN = /^[0-9]{3}_[a-z0-9_]+$/;

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
}

/** SQL 실행기 — pg(Pool/PoolClient)와 PGlite를 동일한 형태로 다루기 위한 최소 인터페이스. */
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

/** PGlite 인스턴스를 SqlExecutor로 감싼다. 인터페이스만 맞으면 되므로 구체 타입은 unknown으로 받는다. */
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

/** Postgres SQLSTATE — 조회하려는 테이블 자체가 없음. pg와 PGlite 둘 다 같은 코드를 던진다
 * (직접 재현 확인). */
const UNDEFINED_TABLE_SQLSTATE = "42P01";

function isUndefinedTableError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: unknown }).code === UNDEFINED_TABLE_SQLSTATE
  );
}

export interface PendingMigrationsStatus {
  /** 아직 적용되지 않은 마이그레이션 id 목록(파일 순서대로). */
  pending: string[];
}

/**
 * 2차 적대적 검수 SR2-REL-001 — 아무것도 적용하지 않고(읽기 전용) 대기 중인 마이그레이션이
 * 있는지만 확인한다. `warehouseFactory.ts`의 network Postgres 시작 시 사전 점검과
 * `retail-mcp-migrate`의 dry-run 모드가 함께 쓴다 — 목적은 raw Postgres 에러("relation ...
 * does not exist")를 "무엇을 해야 하는지"까지 담은 메시지로 바꾸는 것이다.
 *
 * `schema_migrations` 테이블 자체가 없으면(완전히 빈 DB) 전체를 pending으로 본다. 그 외의
 * 조회 실패(연결 끊김·권한 없음 등)는 "마이그레이션이 필요하다"는 뜻이 전혀 아니므로 그대로
 * 다시 던진다 — 실제 장애를 "migrate를 실행하세요"로 오인시키면 안 된다.
 */
export async function checkPendingMigrations(
  executor: SqlExecutor,
  migrations: readonly Migration[],
): Promise<PendingMigrationsStatus> {
  let rows: { id: string }[];
  try {
    const result = await executor.query<{ id: string }>("select id from schema_migrations");
    rows = result.rows;
  } catch (err) {
    if (isUndefinedTableError(err)) return { pending: migrations.map((m) => m.id) };
    throw err;
  }
  const appliedIds = new Set(rows.map((r) => r.id));
  return { pending: migrations.filter((m) => !appliedIds.has(m.id)).map((m) => m.id) };
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
