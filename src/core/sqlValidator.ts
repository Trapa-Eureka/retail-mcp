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

  return trimmed.replace(/;\s*$/, "");
}
