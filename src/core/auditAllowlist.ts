/**
 * `npm audit --json` 결과에서 advisory URL을 뽑아 승인 목록과 비교하는 순수 로직.
 *
 * 원래 `scripts/verifyPack.ts`(release gate 5단계, 실제 게시 tarball 기준)에만 있던 것을
 * TASKS T35(QA-006)에서 여기로 옮겼다 — `scripts/auditLockfile.ts`(CI 매 PR, dev
 * lockfile 기준)도 같은 판정 로직이 필요해져서다. 두 스크립트는 **검사 대상**이 다르다
 * (하나는 tarball 설치 디렉터리, 하나는 저장소 lockfile) — npm의 `overrides`가 tarball
 * 소비자에게는 적용되지 않는다는 걸 T32가 실증했기 때문에 둘 중 하나로 합치지 않는다.
 * 판정 로직(advisory URL 추출 + 승인 목록 비교)만 공유한다.
 */

export interface NpmAuditReport {
  vulnerabilities?: Record<string, { via?: unknown[] }>;
}

/**
 * `npm audit --json`이 실제로 유효한 취약점 리포트를 냈는지 확인한다. 레지스트리 접근
 * 실패 등으로 audit 자체가 실행되지 않으면 npm은 `{"error": {...}}` 형태의 JSON을 낸다 —
 * `vulnerabilities` 키가 아예 없어서 예전 코드는 이걸 파싱만 성공하면 그대로 "취약점
 * 0건"으로 오인했다(2차 적대적 검수 SR2-AUD-002 — `checkAdvisoriesAgainstAllowlist(
 * extractAdvisoryUrls({error: {...}}))`가 `noneFound: true`를 내는 걸 직접 재현·확인).
 * 실제 성공 응답은 항상 `vulnerabilities`를 객체로 갖는다(npm 11.6.2 실측: `{
 * auditReportVersion, vulnerabilities, metadata }`) — `error` 필드가 있거나
 * `vulnerabilities`가 객체가 아니면 무효로 판정한다. 호출자는 무효 판정을 "확인 불가"로
 * 다뤄야지 "안전"으로 다루면 안 된다(fail-open/closed 정책은 호출자마다 다르다 —
 * `src/adapters/auditLockfile.ts`/`scripts/verifyPack.ts` 참고).
 */
export function isValidAuditReport(value: unknown): value is NpmAuditReport {
  if (typeof value !== "object" || value === null) return false;
  if ("error" in value) return false;
  const vulnerabilities = (value as { vulnerabilities?: unknown }).vulnerabilities;
  return typeof vulnerabilities === "object" && vulnerabilities !== null;
}

/**
 * 승인된 audit 예외 하나 — 2차 적대적 검수 SR2-AUD-003: 예전엔 URL 문자열 배열이었고 재검토
 * 기한은 **주석에만** 있어서 기한이 지나도 CI가 같은 advisory를 계속 자동 승인했다. 이제
 * 기한(`expiresAt`)과 근거(`rationale`)가 데이터라서 `checkAdvisoriesAgainstAllowlist`가 기준
 * 시각으로 만료를 기계적으로 집행한다.
 */
export interface AcceptedAdvisory {
  url: string;
  /** `YYYY-MM-DD`(UTC 달력일). 이 날짜의 UTC 00:00부터 만료로 본다 — "만료일 당일부터 실패". */
  expiresAt: string;
  rationale: string;
}

/**
 * SEC-006(005 검수, TASKS T32)의 승인된 예외 — exceljs@4.4.0이 고정한 `uuid@^8.3.0`은
 * GHSA-w5hq-g745-h8pq(uuid v3/v5/v6 bounds check 결함)에 걸리지만, exceljs는 `uuidv4()`를
 * 인자 없이만 호출해 실제 취약 코드 경로를 타지 않는다.
 */
export const ACCEPTED_ADVISORIES: readonly AcceptedAdvisory[] = [
  {
    url: "https://github.com/advisories/GHSA-w5hq-g745-h8pq",
    expiresAt: "2027-03-03",
    rationale:
      "exceljs 경유 uuid<11.1.1 — advisory는 v3/v5/v6에 buf를 넘길 때의 bounds check 결함이고 " +
      "exceljs는 v4()를 인자 없이만 호출해 취약 경로를 타지 않음(docs/005 SEC-006). 기한까지 exceljs가 " +
      "자체 uuid 의존성을 올렸는지 재확인 — 안 올렸으면 패치/대체 라이브러리 재검토.",
  },
];

/** URL만 필요한 호출자용 파생 목록(구조화 이전 API와의 호환). */
export const ACCEPTED_ADVISORY_URLS: readonly string[] = ACCEPTED_ADVISORIES.map((a) => a.url);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `expiresAt`(UTC 달력일)이 기준 시각 `now` 이하이면 만료다 — 만료일 당일 UTC 00:00부터 실패.
 * 형식이 잘못된 날짜는 "만료"로 취급한다(승인 데이터의 오타가 조용히 영구 승인이 되면 안 된다).
 */
export function isAdvisoryExpired(expiresAt: string, now: Date): boolean {
  if (!ISO_DATE.test(expiresAt)) return true;
  const expiryMs = Date.parse(`${expiresAt}T00:00:00.000Z`);
  if (Number.isNaN(expiryMs)) return true;
  return now.getTime() >= expiryMs;
}

/** `npm audit --json` 리포트에서 advisory URL 집합을 뽑는다(패키지명이 아니라 URL로 비교하는 이유는 아래 checkAdvisoriesAgainstAllowlist 참고). */
export function extractAdvisoryUrls(report: NpmAuditReport): string[] {
  const advisoryUrls = new Set<string>();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === "object" && via !== null && "url" in via && typeof via.url === "string") {
        advisoryUrls.add(via.url);
      }
    }
  }
  return [...advisoryUrls];
}

export interface ExpiredAdvisory {
  url: string;
  expiresAt: string;
}

export interface AdvisoryCheckResult {
  /** 승인 목록에 없는 advisory URL — 하나라도 있으면 게이트를 막아야 한다. */
  unexpected: string[];
  /** 승인 목록에 있지만 기준 시각 기준으로 기한이 지난 advisory — 하나라도 있으면 게이트를
   * 막아야 한다(SR2-AUD-003). 재검토 후 기한을 연장하거나 근본 해결해야 통과한다. */
  expired: ExpiredAdvisory[];
  /** 발견된 advisory가 하나도 없는 경우 — 승인된 예외가 더 이상 필요 없을 수 있다는 신호. */
  noneFound: boolean;
}

/**
 * advisory URL 목록을 승인 목록과 비교한다. **패키지 이름이 아니라 advisory URL(GHSA ID)로
 * 비교한다** — `npm audit` 결과 트리는 감사 대상 프로젝트 자신도 "영향받음" 루트 항목으로
 * 함께 나열하므로(설치하는 프로젝트마다 이름이 다를 수 있음), 실제 취약점의 정체를 정확히
 * 가리키는 advisory URL로 비교해야 이름 우연 일치/불일치에 흔들리지 않는다.
 *
 * `now`는 호출자가 명시적으로 넘긴다(CLAUDE.md 구현 해석 보충 — 날짜 판정에 로컬 머신 시계를
 * 암묵적으로 쓰지 않는다) — 테스트는 고정 시각을, 실제 게이트는 시스템 시계를 넘긴다.
 */
export function checkAdvisoriesAgainstAllowlist(
  advisoryUrls: string[],
  allowlist: readonly AcceptedAdvisory[],
  now: Date,
): AdvisoryCheckResult {
  const byUrl = new Map(allowlist.map((a) => [a.url, a]));
  const unexpected: string[] = [];
  const expired: ExpiredAdvisory[] = [];
  for (const url of advisoryUrls) {
    const accepted = byUrl.get(url);
    if (accepted === undefined) {
      unexpected.push(url);
    } else if (isAdvisoryExpired(accepted.expiresAt, now)) {
      expired.push({ url, expiresAt: accepted.expiresAt });
    }
  }
  return { unexpected, expired, noneFound: advisoryUrls.length === 0 };
}
