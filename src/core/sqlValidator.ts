/**
 * `explore_sql`(v0.2 대기열, DESIGN §6이 이름으로 미리 예고해둔 가드레일 4의 사전 승인된
 * 예외)이 실행 전 사용자 SQL을 걸러내는 **1차 방어선**이다. **진짜 방어선이 아니다** — 진짜
 * 방어선은 `adapters/exploreSqlExecutor.ts`가 이 SQL을 `BEGIN READ ONLY` 트랜잭션 안에서만
 * 실행하는 것이다(Postgres 엔진 자체가 그 안의 모든 쓰기 — 시퀀스 진행 포함 — 를 거부한다).
 * 여기 검증은 블록리스트 기반이라 완벽하지 않다는 걸 안다 — 목적은 "명백히 잘못된 요청"을
 * 실행 전에 빠르고 명확한 에러로 걸러 UX를 개선하는 것이지, 유일한 안전장치인 척하지 않는다
 * (심층 방어 원칙 — CLAUDE.md 에러 메시지 컨벤션과 같은 정신으로 원인을 구체적으로 알려준다).
 *
 * 외부 IO 없음 — 순수 문자열 검사만 한다(core/ 원칙).
 */

const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "vacuum",
  "reindex",
  "call",
  "execute",
  "merge",
  "do",
  "listen",
  "notify",
  "unlisten",
  "refresh",
  "security",
  "lock",
  "reset",
  "discard",
  "prepare",
  "deallocate",
  "cluster",
] as const;

/**
 * 세션 부수효과가 있는 **함수 호출**을 함수명 단위로 막는다(TASKS T30, SEC-001/002 대응).
 * `FORBIDDEN_KEYWORDS`의 `\b단어\b` 매칭은 `pg_advisory_lock`처럼 언더스코어로 이어진 이름의
 * "lock" 앞뒤에 단어 경계가 안 생겨(`_`도 정규식 `\w`다) 통과시킨다는 걸 005가 실증했다 — 여기는
 * 함수 전체 이름을 정확히 매치해 그 우회를 막는다.
 *
 * - advisory lock류: `BEGIN READ ONLY`가 테이블/시퀀스 쓰기는 막지만 이 세션 수준 부수효과는
 *   막지 않는다(005 실증 — rollback 후에도 lock이 남았다). READ ONLY만으로는 안전하지 않다는
 *   뜻이라 여기서 막는다.
 * - `set_config`: executor 자신이 `statement_timeout`을 이걸로 설정한다(exploreSqlExecutor.ts) —
 *   사용자 SQL이 같은 함수를 다시 호출하면 그 값을 되돌릴 수 있다(005 SEC-002). 사용자에게는
 *   이 함수를 아예 막는다 — 읽기 전용 조회에 필요한 함수가 아니다.
 * - 파일/원격 접근류(`lo_import`/`lo_export`/`dblink*`/`pg_read_file`류): READ ONLY 트랜잭션
 *   범위 밖의 부수효과(디스크 IO, 네트워크 연결)라 막는다.
 * - 백엔드 제어류(`pg_terminate_backend`/`pg_cancel_backend`/`pg_reload_conf`/`pg_rotate_logfile`):
 *   다른 세션·서버 프로세스에 영향을 준다.
 *
 * **이 목록도 완전하지 않다** — 여기 없는 volatile 함수(예: `nextval`)는 여전히 통과하고,
 * 그 경우 `BEGIN READ ONLY`가 최종 방어선이 된다(테스트로 실증, `tests/exploreSqlExecutor.test.ts`).
 * 진짜 방어선은 이 블록리스트가 아니라 위험 함수 실행 권한이 없는 전용 DB role이다(SPEC §18,
 * DESIGN §12.4) — 이 목록은 알려진 구체적 우회 두 가지를 막는 저비용 추가 계층일 뿐이다.
 */
const FORBIDDEN_FUNCTION_CALLS = [
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_advisory_unlock",
  "pg_advisory_unlock_all",
  "pg_advisory_unlock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_xact_lock_shared",
  "pg_try_advisory_lock",
  "pg_try_advisory_lock_shared",
  "pg_try_advisory_xact_lock",
  "pg_try_advisory_xact_lock_shared",
  "set_config",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "lo_import",
  "lo_export",
  "dblink",
  "dblink_connect",
  "dblink_exec",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
] as const;

/** 검증용으로만 주석을 지운다 — 실제 실행에 쓰는 SQL 텍스트는 그대로 보존한다(원본 반환). */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * `sql`이 단일 SELECT/WITH(CTE) 조회문인지 검증한다. 통과하면 트레일링 세미콜론을 뗀 SQL을
 * 반환하고, 위반이면 원인을 담은 에러를 던진다.
 */
export function validateReadOnlySql(sql: string): string {
  const trimmed = sql.trim();
  if (trimmed === "") {
    throw new Error("SQL이 비어 있습니다. select 또는 with로 시작하는 조회문을 입력하세요.");
  }

  const analyzed = stripSqlComments(trimmed).trim();
  const withoutTrailingSemicolon = analyzed.replace(/;\s*$/, "");

  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error(
      "SQL은 한 문장만 허용됩니다 — 세미콜론으로 여러 문장을 이어붙일 수 없습니다. " +
        "문장을 하나만 남기고 다시 실행하세요.",
    );
  }

  if (!/^(select|with)\b/i.test(withoutTrailingSemicolon)) {
    throw new Error(
      'SQL은 "select" 또는 "with"(CTE)로 시작하는 조회문만 허용됩니다 — explore_sql은 읽기 ' +
        "전용입니다.",
    );
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(withoutTrailingSemicolon)) {
      throw new Error(
        `SQL에 허용되지 않는 키워드("${keyword}")가 포함돼 있습니다 — explore_sql은 데이터를 ` +
          "바꾸지 않는 SELECT/WITH 조회만 허용합니다. 그 부분을 지우고 다시 실행하세요.",
      );
    }
  }

  for (const fn of FORBIDDEN_FUNCTION_CALLS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, "i").test(withoutTrailingSemicolon)) {
      throw new Error(
        `SQL에 보안상 금지된 함수 호출("${fn}(...)")이 포함돼 있습니다 — advisory lock·세션 ` +
          "설정 변경·파일/원격 접근 함수는 explore_sql에서 호출할 수 없습니다(TASKS T30, " +
          "SEC-001/002). 그 부분을 지우고 다시 실행하세요.",
      );
    }
  }

  return trimmed.replace(/;\s*$/, "");
}
