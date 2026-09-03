/**
 * `explore_sql`(v0.2 대기열, DESIGN §6이 이름으로 미리 예고해둔 가드레일 4의 사전 승인된 예외)
 * 전용 실행기 — 사용자가 MCP 도구 인자로 준 임의 SQL 텍스트를 실행하는 **유일한** 코드 경로다.
 * 나머지 모든 Warehouse 메서드(파라미터라이즈드 고정 쿼리)와 의도적으로 분리했다 — "임의 SQL이
 * 실행되는 곳"을 감사(audit)하려는 사람이 이 파일 하나만 보면 되게 하기 위해서다.
 *
 * 방어선 2단계(심층 방어):
 * 1) `core/sqlValidator.ts` — 명백히 잘못된 요청을 실행 전에 빠르게 걸러내는 UX 계층
 *    (블록리스트, 완벽하지 않음을 안다).
 * 2) 여기 — 검증을 통과한 SQL도 반드시 `BEGIN READ ONLY` 트랜잭션 안에서 실행한다. Postgres
 *    엔진 자체가 이 모드의 모든 쓰기 시도(시퀀스 nextval 진행 포함)를 거부한다 — 검증기를
 *    우회하는 SQL이 있어도 여기서 최종적으로 막힌다. 이게 "진짜" 방어선이라 이 트랜잭션을
 *    실행하는 DB 롤 자체가 쓰기 권한을 갖고 있어도 안전하다(운영 읽기 전용 롤 분리는 여전히
 *    권장하지만, 이 도구의 안전성이 그것에 의존하지는 않는다). 끝나면 항상 ROLLBACK한다
 *    (읽기 전용이라 COMMIT과 결과 차이는 없다 — 흔적을 안 남기는 관례).
 *
 * 결과 행수 제한은 사용자 SQL을 파싱·재작성하지 않고, 바깥에서 서브쿼리로 감싸 안전하게
 * 적용한다(`select * from (<검증된 SQL>) as t limit $1`) — LIMIT은 파라미터 바인딩,
 * statement_timeout은 `set_config()`로 파라미터 바인딩해 어느 쪽도 SQL 텍스트에 값을 직접
 * 보간하지 않는다.
 *
 * **알려진 한계(임베디드 PGlite 전용, 실 Postgres/Neon은 해당 없음)**: 스파이크로 확인한 결과
 * PGlite(단일 프로세스 WASM 임베디드 Postgres)는 `statement_timeout`을 실제로 집행하지
 * 않는다 — `set_config()` 호출 자체는 성공하지만 오래 걸리는 쿼리를 취소하지 않는다(백그라운드
 * 인터럽트 처리가 없는 구조적 한계로 추정). `BEGIN READ ONLY`(위 2번, 이 도구의 진짜 안전
 * 장치)는 PGlite에서도 정상 동작을 직접 확인했다 — 영향받는 건 "느린 쿼리를 자동으로 끊는"
 * 기능뿐이고, "쓰기를 막는" 안전성은 두 백엔드 모두 동일하게 보장된다. 상세는
 * `docs/SPEC.md` §17.
 */
import { validateReadOnlySql } from "../core/sqlValidator.js";
import type { ExploreSqlExecutor, ExploreSqlOptions, ExploreSqlResult } from "../core/types.js";
import { withSession, type DbConnectionProvider } from "./pgWarehouse.js";

export const EXPLORE_SQL_DEFAULT_LIMIT = 200;
export const EXPLORE_SQL_MAX_LIMIT = 1000;
export const EXPLORE_SQL_DEFAULT_TIMEOUT_MS = 5000;
export const EXPLORE_SQL_MAX_TIMEOUT_MS = 30000;

function resolveLimit(limit: number | undefined): number {
  const value = limit ?? EXPLORE_SQL_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`limit은 1 이상의 정수여야 합니다. 받은 값: ${limit}.`);
  }
  return Math.min(value, EXPLORE_SQL_MAX_LIMIT);
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? EXPLORE_SQL_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`timeoutMs는 1 이상의 정수여야 합니다. 받은 값: ${timeoutMs}.`);
  }
  return Math.min(value, EXPLORE_SQL_MAX_TIMEOUT_MS);
}

function isTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|canceling statement/i.test(message);
}

export function createExploreSqlExecutor(provider: DbConnectionProvider): ExploreSqlExecutor {
  return {
    async execute(sql: string, opts: ExploreSqlOptions = {}): Promise<ExploreSqlResult> {
      const validatedSql = validateReadOnlySql(sql);
      const limit = resolveLimit(opts.limit);
      const timeoutMs = resolveTimeoutMs(opts.timeoutMs);

      return withSession(provider, async (session) => {
        await session.query("begin read only");
        try {
          // SET은 파라미터 바인딩이 안 되는 GUC 명령이라, 검증된 정수를 set_config()로
          // 바인딩한다(SQL 텍스트에 값을 직접 보간하지 않는다).
          await session.query("select set_config('statement_timeout', $1, true)", [
            String(timeoutMs),
          ]);
          const { rows } = await session.query<Record<string, unknown>>(
            `select * from (${validatedSql}) as explore_sql_subquery limit $1`,
            [limit + 1], // +1로 잘렸는지(truncated) 판정한다.
          );
          const truncated = rows.length > limit;
          const resultRows = truncated ? rows.slice(0, limit) : rows;
          return {
            columns: resultRows.length > 0 ? Object.keys(resultRows[0]!) : [],
            rows: resultRows,
            rowCount: resultRows.length,
            truncated,
            timeoutMs,
          };
        } catch (err) {
          if (isTimeoutError(err)) {
            throw new Error(
              `쿼리가 ${timeoutMs}ms 안에 끝나지 않아 취소했습니다 — WHERE 절을 좁히거나 ` +
                "timeoutMs를 늘려 다시 시도하세요.",
              { cause: err },
            );
          }
          throw err;
        } finally {
          try {
            await session.query("rollback");
          } catch {
            // 롤백 자체 실패는 무시 — 읽기 전용 트랜잭션이라 커밋할 것도 없다. 원본 에러(있다면)는
            // 위 catch/재throw 또는 try 블록 자체에서 이미 호출자에게 전파된다.
          }
        }
      });
    },
  };
}
