/**
 * 커밋된 소스에 실제 시크릿(CLAUDE.md 가드레일 6: `LOYVERSE_API_TOKEN`/`DATABASE_URL`/
 * `RESEND_API_KEY`/`ANTHROPIC_API_KEY`류)이 섞여 들어갔는지 훑는 경량 스캐너 (QA-006,
 * TASKS T35).
 *
 * gitleaks/truffleHog 같은 외부 도구를 CI 액션으로 얹는 대신 이 저장소 안에서 직접
 * 만든 이유는 이 세션의 다른 결정들과 같다(예: OPS-002의 PID 재사용 완화가 네이티브
 * 모듈 없이 `ps` 하나로 해결된 것) — 패턴이 몇 개 안 되고, 순수 함수라 vitest로 직접
 * 단위 테스트할 수 있으며(외부 액션은 로컬에서 검증할 방법이 없다), 새 시크릿 종류가
 * 생기면 패턴 하나 추가하는 것으로 끝난다.
 *
 * 완벽한 시크릿 탐지가 목표가 아니다(엔트로피 분석 등은 하지 않는다) — 이 프로젝트가
 * 실제로 다루는 시크릿 형태(클라우드 키 접두사, PEM 블록, DB 연결 문자열의 자격증명)에
 * 한정한 목적 지향적 검사다.
 */

export interface SecretPattern {
  name: string;
  /** 전역(g) 플래그가 있어야 한다 — matchAll로 파일당 여러 건을 찾는다. */
  regex: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: "AWS Access Key ID", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "PEM 개인키 블록", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "Anthropic API 키", regex: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g },
  { name: "Resend API 키", regex: /\bre_[A-Za-z0-9]{20,}\b/g },
  {
    name: "Postgres 연결 문자열(자격증명 포함)",
    regex: /\bpostgres(?:ql)?:\/\/[^:\s'"]+:[^@\s'"]+@[^\s'"]+/g,
  },
];

/** 이 마커가 매치된 줄에 있으면 테스트 픽스처/예시로 보고 건너뛴다(고의로 넣은 가짜 값). */
const PLACEHOLDER_LINE_MARKER =
  /fake|example|placeholder|dummy|changeme|xxx|your_|should[-_ ]never|not[-_]?real|시뮬레이션|가짜|예시/i;

/** localhost/127.0.0.1 대상 연결 문자열은 자격증명이 진짜여도 유출 위험이 사실상 없다(원격 접근 불가) — 항상 건너뛴다. */
function isLocalhostConnectionString(match: string): boolean {
  return /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(match);
}

export interface SecretFinding {
  file: string;
  patternName: string;
  line: number;
  /** 매치된 값 전체는 로그·리포트에 남기지 않는다(그 자체가 유출이 될 수 있다) — 앞 8자만. */
  matchPreview: string;
}

/** 파일 하나의 내용을 스캔한다. filePath는 리포트용 표시 이름일 뿐 파일을 직접 읽지 않는다(IO와 분리). */
export function scanContentForSecrets(filePath: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");

  for (const pattern of SECRET_PATTERNS) {
    // matchAll은 regex가 g 플래그를 가져야 하고, lastIndex 상태를 공유하지 않게 매번 새로
    // 만든다(같은 RegExp 객체를 여러 파일에 재사용하면 lastIndex가 누적돼 오탐/누락이 생긴다).
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    for (const match of content.matchAll(regex)) {
      const matchedText = match[0];
      if (pattern.name.startsWith("Postgres") && isLocalhostConnectionString(matchedText)) {
        continue;
      }
      const upToMatch = content.slice(0, match.index).split("\n");
      const lineNumber = upToMatch.length;
      const lineText = lines[lineNumber - 1] ?? "";
      if (PLACEHOLDER_LINE_MARKER.test(lineText)) {
        continue;
      }
      findings.push({
        file: filePath,
        patternName: pattern.name,
        line: lineNumber,
        matchPreview: `${matchedText.slice(0, 8)}...`,
      });
    }
  }

  return findings;
}
