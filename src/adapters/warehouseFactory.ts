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
 *
 * network Postgres(DATABASE_URL) 경로는 반대로 아무 마이그레이션도 자동 적용하지 않는다
 * (가드레일 5). 대신 `ensureNetworkMigrationsApplied()`(SR2-REL-001, 2차 적대적 검수)를
 * 호출자(server.ts/agent 진입점)가 명시적으로 실행해, 스키마가 없거나 일부만 적용된 상태를
 * raw Postgres 에러가 아니라 "무엇을 해야 하는지"까지 담은 메시지로 즉시 알린다. 이 점검을
 * `createNetworkWarehouse()` 안에 넣지 않은 건 의도적이다 — `createWarehouseFromEnv()`는
 * DATABASE_URL이 있어도 실제 네트워크 연결을 시도하지 않는다는 게 기존에 이미 보장돼 있던
 * 계약이라(warehouseFactory.test.ts "실제 연결은 시도하지 않음"), 여기서 깨면 안 된다.
 */
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import type { Warehouse } from "../core/types.js";
import { acquireFileLock, type FileLock } from "./fileLock.js";
import {
  checkPendingMigrations,
  loadMigrations,
  runMigrations,
  createPgliteExecutor,
  type QueryOnlyExecutor,
} from "./migrationRunner.js";
import {
  createPgConnectionProvider,
  createPgliteConnectionProvider,
  createPgWarehouse,
  withSession,
  type DbConnectionProvider,
  type DbSession,
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
      // OPS-001(005 검수, TASKS T34) — 예전엔 `await db.close(); await lock.release();` 순서라
      // db.close()가 reject하면 release가 아예 실행되지 않았다. 락이 안 풀리면 프로세스가
      // 죽지 않는 한(또는 사람이 수동으로 지우지 않는 한) 다음 실행이 계속 막힌다 — 그래서
      // release는 항상(db.close() 성공/실패 무관) 시도한다. 두 정리 작업이 각각 독립적으로
      // 실패할 수 있어(예: PGlite 내부 오류 + 그 사이 락 파일이 다른 프로세스에 의해 지워짐)
      // 하나만 던지면 다른 원인이 조용히 사라진다 — 둘 다 실패하면 AggregateError로 둘 다
      // 보존한다.
      async close() {
        const errors: unknown[] = [];
        try {
          await db.close();
        } catch (err) {
          errors.push(err);
        }
        try {
          await lock.release();
        } catch (err) {
          errors.push(err);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(
            errors,
            "웨어하우스 종료 중 오류가 여러 개 발생했습니다(db.close()와 lock.release() 둘 다 " +
              "실패) — errors 배열의 각 원인을 확인하세요.",
          );
        }
      },
    };
  } catch (err) {
    // 초기화(마이그레이션 등) 실패 시에도 락은 항상 풀어야 한다 — 여기서 release()가 또
    // 실패하면(OPS-001과 같은 원칙) 원래 원인(err)을 조용히 가리지 않도록 둘 다 보존한다.
    try {
      await lock.release();
    } catch (releaseErr) {
      throw new AggregateError(
        [err, releaseErr],
        "임베디드 웨어하우스 초기화 실패 + 락 해제도 실패했습니다 — errors 배열의 각 원인을 확인하세요.",
        { cause: releaseErr },
      );
    }
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

function queryOnlyExecutorFromSession(session: DbSession): QueryOnlyExecutor {
  return {
    query: <T extends Record<string, unknown>>(sql: string) => session.query<T>(sql),
  };
}

/**
 * SR2-REL-001(2차 적대적 검수) — network Postgres(`handle.kind === "pg"`) 경로에서 스키마가
 * 없거나 일부만 적용된 상태를 raw Postgres 에러("relation ... does not exist")가 아니라
 * 실행할 명령까지 담은 명확한 메시지로 알린다. 아무것도 쓰지 않는다(읽기 전용, 가드레일 4/5
 * 대상 아님). embedded PGlite 경로(`handle.kind === "pglite"`)는 `createEmbeddedWarehouse`가
 * 기동 시 이미 자동 마이그레이션을 마쳤으므로 이 함수는 그 경우 아무 일도 하지 않는다.
 *
 * `createWarehouseFromEnv()` 자체에는 넣지 않았다 — 그 함수는 DATABASE_URL이 있어도 실제
 * 네트워크 연결을 시도하지 않는다는 기존 계약(warehouseFactory.test.ts 회귀)을 지키기
 * 위해서다. 호출자(server.ts/agent 진입점)가 handle을 얻은 직후 명시적으로 호출한다.
 *
 * `DATABASE_URL` 원문(자격증명 포함)은 이 함수의 어떤 출력에도 남기지 않는다(CLAUDE.md 구현
 * 해석 보충).
 */
export async function ensureNetworkMigrationsApplied(handle: WarehouseHandle): Promise<void> {
  if (handle.kind !== "pg") return;

  const migrations = await loadMigrations();
  const { pending } = await withSession(handle.connectionProvider, (session) =>
    checkPendingMigrations(queryOnlyExecutorFromSession(session), migrations),
  );
  if (pending.length === 0) return;

  throw new Error(
    `DATABASE_URL이 가리키는 데이터베이스에 아직 스키마가 없거나 일부만 적용돼 있습니다 ` +
      `(대기 중인 마이그레이션 ${pending.length}건: ${pending.join(", ")}). ` +
      "npx retail-mcp-migrate로 대상과 대기 중인 마이그레이션을 먼저 확인(dry-run)한 뒤, " +
      "npx retail-mcp-migrate --confirm으로 적용하고 다시 실행하세요.",
  );
}
