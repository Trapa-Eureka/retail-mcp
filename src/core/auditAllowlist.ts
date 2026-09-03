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
 * SEC-006(005 검수, TASKS T32)의 승인된 예외 — exceljs@4.4.0이 고정한 `uuid@^8.3.0`은
 * GHSA-w5hq-g745-h8pq(uuid v3/v5/v6 bounds check 결함)에 걸리지만, exceljs는 `uuidv4()`를
 * 인자 없이만 호출해 실제 취약 코드 경로를 타지 않는다. 재검토 기한: 2027-03-03.
 */
export const ACCEPTED_ADVISORY_URLS: readonly string[] = [
  "https://github.com/advisories/GHSA-w5hq-g745-h8pq",
];

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

export interface AdvisoryCheckResult {
  /** 승인 목록에 없는 advisory URL — 하나라도 있으면 게이트를 막아야 한다. */
  unexpected: string[];
  /** 발견된 advisory가 하나도 없는 경우 — 승인된 예외가 더 이상 필요 없을 수 있다는 신호. */
  noneFound: boolean;
}

/**
 * advisory URL 목록을 승인 목록과 비교한다. **패키지 이름이 아니라 advisory URL(GHSA ID)로
 * 비교한다** — `npm audit` 결과 트리는 감사 대상 프로젝트 자신도 "영향받음" 루트 항목으로
 * 함께 나열하므로(설치하는 프로젝트마다 이름이 다를 수 있음), 실제 취약점의 정체를 정확히
 * 가리키는 advisory URL로 비교해야 이름 우연 일치/불일치에 흔들리지 않는다.
 */
export function checkAdvisoriesAgainstAllowlist(
  advisoryUrls: string[],
  allowlist: readonly string[] = ACCEPTED_ADVISORY_URLS,
): AdvisoryCheckResult {
  const allowed = new Set(allowlist);
  const unexpected = advisoryUrls.filter((url) => !allowed.has(url));
  return { unexpected, noneFound: advisoryUrls.length === 0 };
}
