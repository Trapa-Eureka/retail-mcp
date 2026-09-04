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
 *
 * 커버 범위의 기준(2차 적대적 검수 SR2-SEC-005): `.env.example`의 시크릿 4종(가드레일 6 —
 * `LOYVERSE_API_TOKEN`/`DATABASE_URL`/`RESEND_API_KEY`/`ANTHROPIC_API_KEY`) + CI/publish 흐름이
 * 취급하는 자격증명(npm publish 토큰, GitHub 토큰, Actions 로그에 찍힐 수 있는 Bearer 헤더) +
 * SCM 시트 연동에서 만날 수 있는 Google 자격증명(API 키, 서비스 계정 JSON). 이 저장소가 쓰지
 * 않는 서비스(Slack 등)는 넣지 않는다 — 패턴은 "이 프로젝트가 실제로 다루는 것"에 한정한다는
 * 원칙을 유지한다. 형식이 공개돼 있지 않은 Loyverse 토큰은 값 형태가 아니라 **대입식**
 * (`LOYVERSE_API_TOKEN=<값>`)으로 잡는다 — 그래서 `.env.example`의 빈 값은 매치되지 않는다.
 * 한계(SECURITY.md에도 명시): 알려진 접두사·대입식만 본다. 형식 없는 임의 문자열 시크릿
 * (예: 변수명 없이 붙여 넣은 hex 토큰)은 잡지 못한다.
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
  // ── SR2-SEC-005 추가분 ──────────────────────────────────────────────────
  // Loyverse 액세스 토큰은 공개된 접두사/길이 형식이 없다(백오피스에서 발급하는 불투명 문자열).
  // 그래서 값 형태 대신 "환경변수 이름에 실제 값을 대입한 줄"을 잡는다 — `.env`가 실수로
  // 커밋되거나 문서/테스트에 진짜 값을 붙여 넣는 경우가 이 프로젝트에서 현실적인 유출 경로다.
  // 값은 16자 이상만(짧은 placeholder·빈 값 제외), 따옴표는 있어도 없어도 된다. 공백은
  // `[ \t]`로만 — `\s`는 줄바꿈까지 포함해서 `LOYVERSE_API_TOKEN=`(빈 값) 다음 줄의 텍스트를
  // 값으로 오인했다(착수 중 docs/DESIGN.md의 .env 예시에서 실제 오탐 → 회귀 테스트).
  {
    name: "LOYVERSE_API_TOKEN 대입(실제 값)",
    regex: /\bLOYVERSE_API_TOKEN[ \t]*[=:][ \t]*['"]?[A-Za-z0-9._~+/=-]{16,}/g,
  },
  // GitHub 토큰 — classic PAT/OAuth/user-to-server/server-to-server/refresh(접두사 + 36자)와
  // fine-grained PAT(`github_pat_` + 82자, 여기서는 22자 이상으로 느슨하게).
  { name: "GitHub 토큰", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { name: "GitHub fine-grained PAT", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  // npm 액세스 토큰(granular/automation/publish 공통 접두사 `npm_` + 36자).
  { name: "npm 액세스 토큰", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // Google — API 키(`AIza` + 35자)와 서비스 계정 JSON(고유 키 이름 `private_key_id`가 있는 JSON
  // 객체. 그 파일엔 PEM 개인키도 함께 들어 있어 위 PEM 패턴도 같이 걸리지만, PEM이 여러 줄로
  // 쪼개져 있거나 escape된 `\n` 형태면 PEM 패턴은 놓칠 수 있어 키 이름으로도 잡는다).
  { name: "Google API 키", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "Google 서비스 계정 JSON", regex: /"private_key_id"[ \t]*:[ \t]*"[0-9a-f]{20,}"/g },
  // HTTP Authorization 헤더에 하드코딩된 Bearer 토큰(20자 이상). 코드의 `Bearer ${token}`
  // 템플릿은 `$`가 문자 클래스에 없어 매치되지 않는다 — 실제 값이 붙어 있을 때만. 공백은
  // 같은 줄로 한정(위 LOYVERSE 패턴과 같은 이유).
  { name: "Bearer 토큰(하드코딩)", regex: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/g },
];

/**
 * 이 정확한 문자열이 매치와 같은 줄에 있어야만 테스트 픽스처로 보고 건너뛴다.
 *
 * 예전엔 `fake|example|placeholder|dummy|...` 같은 흔한 영단어 아무거나 하나만 있어도
 * 건너뛰었다 — 이건 실제 시크릿과 같은 줄에 우연히(또는 의도적으로) 그런 단어가 있으면
 * 그대로 우회된다(2차 적대적 검수 SR2-SEC-001, `const productionKey = "sk-ant-실제키"; //
 * example` 로 직접 재현·확인). 흔한 단어 대신 우연히 나올 일이 없는 전용 마커 하나로
 * 좁혔다 — 필요하면 뒤에 사유를 자유롭게 붙인다(`// secretscan-allow: 테스트 픽스처`).
 */
const EXPLICIT_ALLOW_MARKER = "secretscan-allow";

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
      if (lineText.includes(EXPLICIT_ALLOW_MARKER)) {
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
