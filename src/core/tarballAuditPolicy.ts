/**
 * 게시 tarball 기준 `npm audit` 판정(순수) — `scripts/verifyPack.ts` 6단계가 쓴다.
 *
 * 배경(2026-09-04, T37 직후): 같은 날 npm advisory 엔드포인트가 간헐적으로 죽어 PR #72·#73·#74가
 * 차례로 머지 불가가 됐다. `verify:pack`은 CI `test` matrix(매 PR, 4 job)와 실제 게시 경로
 * (`prepublishOnly`) 양쪽에서 똑같이 "audit 불능 = 실패(fail-closed)"였기 때문이다 — 문서 한 줄
 * 고치는 PR도 레지스트리가 살아날 때까지 기다려야 했다. SR2-AUD-001의 수정 기준은 원래 "PR 편의
 * gate와 release gate를 **분리**한다 — release/T37에서는 audit 불능을 실패로"였으므로 그 분리를
 * 여기서 데이터로 만든다.
 *
 * 정책(`AuditUnavailablePolicy`):
 * - `fail`(기본, 실제 게시 경로): 유효한 리포트가 없으면 실패. 게시 직전 판단은 "모른다"를 통과시키지
 *   않는다.
 * - `warn`(CI PR gate 전용, `ci.yml`이 명시적으로 켠다): 유효한 리포트가 **없을 때만** 경고로 통과.
 *   리포트가 있고 승인되지 않은 취약점·기한 지난 예외가 나오면 정책과 무관하게 **항상 실패**한다 —
 *   완화되는 건 "확인 불가"뿐이지 "취약점 발견"이 아니다.
 *
 * 왜 안전한가: 이 경로로 새 취약점이 게시에 도달하려면 ① 레지스트리가 죽은 동안 PR이 머지되고
 * ② `prepublishOnly`(정책 `fail`)의 audit까지 통과해야 하는데 ②는 유효한 리포트 없이는 절대
 * 통과하지 않는다. lockfile 기준 audit job(`auditLockfile.ts`)은 이미 같은 fail-open이라 PR gate
 * 안에서도 정책이 일관된다. 남는 차이는 "PR 머지 시점에 tarball 트리의 취약점을 조금 늦게 알 수
 * 있다"는 것이고, 그 시점은 게시 전(prepublishOnly)으로 상한이 잡혀 있다.
 */
import {
  ACCEPTED_ADVISORIES,
  checkAdvisoriesAgainstAllowlist,
  extractAdvisoryUrls,
  isValidAuditReport,
  type AcceptedAdvisory,
  type ExpiredAdvisory,
} from "./auditAllowlist.js";

export type AuditUnavailablePolicy = "fail" | "warn";

export const AUDIT_UNAVAILABLE_FLAG = "audit-unavailable";

/** `--audit-unavailable=<값>` 파싱 — 없으면 `fail`(게시 경로 기본값), 알 수 없는 값은 오류(조용히 완화되면 안 된다). */
export function parseAuditUnavailablePolicy(raw: string | undefined): AuditUnavailablePolicy {
  if (raw === undefined || raw === "fail") return "fail";
  if (raw === "warn") return "warn";
  throw new Error(
    `--${AUDIT_UNAVAILABLE_FLAG} 값이 올바르지 않습니다: "${raw}". "fail"(기본, 게시 경로) 또는 ` +
      `"warn"(CI PR gate 전용)만 허용합니다.`,
  );
}

export type TarballAuditVerdict =
  /** 유효한 리포트 + 승인 범위 안. `noneFound`면 승인 예외가 더 이상 필요 없을 수 있다는 신호. */
  | { kind: "pass"; noneFound: boolean }
  /** 유효한 리포트를 얻지 못했다 — 정책에 따라 실패(fail) 또는 경고 통과(warn). */
  | { kind: "unavailable"; reason: "no_output" | "not_json" | "invalid_report"; detail: string }
  /** 승인되지 않은 취약점 — 정책과 무관하게 항상 실패. */
  | { kind: "unexpected"; urls: string[] }
  /** 승인 예외의 재검토 기한 경과(SR2-AUD-003) — 정책과 무관하게 항상 실패. */
  | { kind: "expired"; expired: ExpiredAdvisory[] };

/**
 * `npm audit --json` stdout(재시도 뒤 마지막 결과, 실행 실패면 null)을 판정한다. `now`는 승인 예외
 * 만료 판정의 기준 시각 — 호출자가 명시적으로 넘긴다(CLAUDE.md: 날짜 판정에 로컬 시계 암묵 의존 금지).
 */
export function evaluateTarballAudit(
  stdout: string | null,
  now: Date,
  allowlist: readonly AcceptedAdvisory[] = ACCEPTED_ADVISORIES,
): TarballAuditVerdict {
  if (stdout === null) {
    return {
      kind: "unavailable",
      reason: "no_output",
      detail:
        "npm audit 실행 자체가 재시도 후에도 실패했습니다(레지스트리 접근 불가·시간 초과 등으로 추정).",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      kind: "unavailable",
      reason: "not_json",
      detail: `npm audit 출력이 JSON으로 파싱되지 않습니다: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isValidAuditReport(parsed)) {
    // SR2-AUD-001/002 — {"error": {...}} 같은 무효 응답을 "취약점 0건"으로 오인하지 않는다.
    return {
      kind: "unavailable",
      reason: "invalid_report",
      detail:
        "npm audit 출력이 유효한 취약점 리포트 형식이 아닙니다(레지스트리 오류 응답 등으로 추정): " +
        JSON.stringify(parsed).slice(0, 500),
    };
  }
  const { unexpected, expired, noneFound } = checkAdvisoriesAgainstAllowlist(
    extractAdvisoryUrls(parsed),
    allowlist,
    now,
  );
  if (unexpected.length > 0) return { kind: "unexpected", urls: unexpected };
  if (expired.length > 0) return { kind: "expired", expired };
  return { kind: "pass", noneFound };
}

/**
 * 판정 + 정책 → 게이트를 막아야 하는가. `unavailable`만 정책의 영향을 받는다 — 나머지는 항상 막는다.
 * 호출자(verifyPack.ts)는 이 함수가 true를 주면 던지고, false면 (unavailable일 때) 경고를 남긴다.
 */
export function shouldBlock(verdict: TarballAuditVerdict, policy: AuditUnavailablePolicy): boolean {
  switch (verdict.kind) {
    case "pass":
      return false;
    case "unavailable":
      return policy === "fail";
    case "unexpected":
    case "expired":
      return true;
  }
}
