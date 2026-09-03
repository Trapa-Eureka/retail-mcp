/**
 * `Warehouse` 생성의 공용 진입점 — `server.ts`/`agent/reorder.ts`(그리고 향후 CSV/Excel 폴더
 * 스캔, TASKS T18)가 각자 중복해서 갖고 있던 "`DATABASE_URL` 없으면 에러" 로직을 대체한다.
 *
 * `DATABASE_URL`이 있으면 기존처럼 pg.Pool로 Neon/Supabase 등 네트워크 Postgres에 붙는다.
 * 없으면 **임베디드·파일 영속 PGlite**(기본 경로 `.retail-mcp/data/`)를 기본값으로 쓴다 —
 * CSV/Excel 채널의 비개발자 사용자에게 Neon 계정 생성·연결 문자열 설정을 요구하지 않기
 * 위해서다(SPEC.md §12 "웨어하우스" 결정).
 *
 * PGlite는 같은 데이터 디렉터리를 여러 프로세스가 동시에 열어도 에러 없이 나중에 연 쪽의
 * 쓰기를 조용히 잃는다(SPEC §12 스파이크 결과) — 그래서 임베디드 경로를 열기 전에 반드시
 * `fileLock.ts`(T13)로 배타 접근을 확보한다. 이미 다른 살아있는 프로세스가 그 디렉터리를
 * 쓰고 있으면 `FileLockBusyError`(원인+조치 포함)로 시작을 거부한다.
 *
 * 이 모듈이 하는 로컬 PGlite 자동 마이그레이션은 CLAUDE.md 가드레일 5("프로덕션
 * `DATABASE_URL` 마이그레이션은 사람만")의 대상이 아니다 — 원격 프로덕션 DB가 아니라
 * 로컬 임베디드 DB 초기화다.
 */
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import type { Warehouse } from "../core/types.js";
import { acquireFileLock, type FileLock } from "./fileLock.js";
import { loadMigrations, runMigrations, createPgliteExecutor } from "./migrationRunner.js";
import {
  createPgConnectionProvider,
  createPgliteConnectionProvider,
  createPgWarehouse,
  type DbConnectionProvider,
} from "./pgWarehouse.js";

/** `DATABASE_URL` 미설정 시 임베디드 PGlite 데이터를 저장할 기본 경로(프로세스 작업 디렉터리 기준). */
export const DEFAULT_EMBEDDED_DATA_DIR = ".retail-mcp/data";

export interface WarehouseHandle {
  warehouse: Warehouse;
  kind: "pg" | "pglite";
  /**
   * kind === "pg"일 때만 존재한다 — `sync_now`의 advisory lock(pg_try_advisory_lock)처럼
   * Postgres 전용 기능에 필요하다(DESIGN §11.4). 임베디드 PGlite 경로에는 이 값이 없다.
   */
  pgPool?: Pool;
  /**
   * `warehouse`를 만들 때 쓴 것과 같은 연결 제공자 — pg/pglite 어느 쪽이든 항상 존재한다.
   * `explore_sql`(TASKS T27)처럼 Warehouse의 고정 쿼리 계약 밖에서 세션이 필요한 극소수
   * 예외 용도(현재는 explore_sql 하나뿐)로만 쓴다.
   */
  connectionProvider: DbConnectionProvider;
  /** 열어둔 자원(pg.Pool 연결 또는 PGlite 인스턴스+파일 락)을 전부 정리한다. */
  close(): Promise<void>;
}

export interface CreateWarehouseOptions {
  /** 테스트 주입용. 기본값: process.env. */
  env?: NodeJS.ProcessEnv;
  /** 임베디드 경로 override. 기본값: env RETAIL_MCP_DATA_DIR 또는 DEFAULT_EMBEDDED_DATA_DIR. */
  dataDir?: string;
}

async function createEmbeddedWarehouse(dataDir: string): Promise<WarehouseHandle> {
  const lock: FileLock = await acquireFileLock(dataDir);
  try {
    const db = new PGlite(dataDir);
    try {
      const executor = createPgliteExecutor(db);
      const migrations = await loadMigrations();
      await runMigrations(executor, migrations);
    } catch (err) {
      await db.close();
      throw err;
    }

    const connectionProvider = createPgliteConnectionProvider(db);
    const warehouse = createPgWarehouse(connectionProvider);
    return {
      warehouse,
      kind: "pglite",
      connectionProvider,
      async close() {
        await db.close();
        await lock.release();
      },
    };
  } catch (err) {
    await lock.release();
    throw err;
  }
}

function createNetworkWarehouse(databaseUrl: string): WarehouseHandle {
  const pool = new Pool({ connectionString: databaseUrl });
  const connectionProvider = createPgConnectionProvider(pool);
  const warehouse = createPgWarehouse(connectionProvider);
  return {
    warehouse,
    kind: "pg",
    pgPool: pool,
    connectionProvider,
    close: () => pool.end(),
  };
}

/**
 * `DATABASE_URL`이 있으면 pg, 없으면 임베디드 PGlite(자동 마이그레이션 포함)로 `Warehouse`를
 * 만든다. 호출자는 사용이 끝나면 반드시 `handle.close()`를 호출해야 한다(pg.Pool 연결 반환
 * 또는 PGlite 인스턴스+파일 락 해제).
 */
export async function createWarehouseFromEnv(
  opts: CreateWarehouseOptions = {},
): Promise<WarehouseHandle> {
  const env = opts.env ?? process.env;
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl) return createNetworkWarehouse(databaseUrl);

  const dataDir = opts.dataDir ?? env["RETAIL_MCP_DATA_DIR"] ?? DEFAULT_EMBEDDED_DATA_DIR;
  return createEmbeddedWarehouse(dataDir);
}
