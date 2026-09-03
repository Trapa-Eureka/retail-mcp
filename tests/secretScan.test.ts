import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanContentForSecrets } from "../src/core/secretScan.js";

/**
 * 2차 적대적 검수 SR2-SEC-002 — 이 파일은 더 이상 `scripts/secretScan.ts`의 스캔 대상에서
 * 제외되지 않는다(예전엔 `SELF_EXCLUDE`로 파일 전체를 빼서, 여기에 진짜 자격증명이 들어가도
 * CI가 구조적으로 못 보는 영구 blind spot이었다). 대신 모든 픽스처를 **런타임에 조합**한다 —
 * 이 파일의 어느 한 줄에도 완성된 시크릿 패턴이 문자 그대로 남아 있지 않게. 조합 결과는
 * 런타임에만 존재하므로 스캐너는 소스 텍스트에서 아무것도 찾지 못하고, 그 사실 자체를 맨
 * 아래 "자기 검증" 테스트가 assert한다 — 누가 완성된 리터럴을 다시 넣으면 CI secret-scan
 * 이전에 단위 테스트가 먼저 실패한다.
 *
 * 유일한 예외는 `secretscan-allow` 마커 테스트 — 마커가 같은 줄에 있는 완성 리터럴은 스캐너가
 * 의도적으로 건너뛰는 승인된 좁은 허용 메커니즘이라 그대로 둔다(자기 검증 테스트도 그 줄은
 * 스캐너 규칙대로 통과시킨다).
 */
const assemble = (...parts: string[]): string => parts.join("");

/** AWS Access Key ID 형태(AKIA + 대문자/숫자 16자) — 조합으로만 만든다. */
const awsKey = (suffix16 = "ABCDEFGHIJKLMNOP"): string => assemble("AKIA", suffix16);
const pemHeader = (algo: string): string => assemble("-----BEGIN ", algo, " PRIVATE", " KEY-----");
const pemFooter = (algo: string): string => assemble("-----END ", algo, " PRIVATE", " KEY-----");
const anthropicKey = (): string => assemble("sk-ant-", "api03-realLookingSecretValue1234567890");
const resendKey = (): string => assemble("re_", "1234567890abcdefghijklmnop");
const pgUrl = (user: string, pass: string, hostAndDb: string): string =>
  assemble("postgres://", user, ":", pass, "@", hostAndDb);

describe("scanContentForSecrets (QA-006, TASKS T35)", () => {
  it("AWS Access Key ID를 찾는다", () => {
    const findings = scanContentForSecrets("a.ts", `const key = "${awsKey()}";`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.patternName).toBe("AWS Access Key ID");
    expect(findings[0]?.line).toBe(1);
  });

  it("PEM 개인키 블록을 찾는다", () => {
    const content = ["line1", pemHeader("RSA"), "MIIExxxx", pemFooter("RSA")].join("\n");
    const findings = scanContentForSecrets("key.pem", content);
    expect(findings.some((f) => f.patternName === "PEM 개인키 블록")).toBe(true);
    expect(findings.find((f) => f.patternName === "PEM 개인키 블록")?.line).toBe(2);
  });

  it("Anthropic API 키를 찾는다", () => {
    const findings = scanContentForSecrets("a.ts", `const k = "${anthropicKey()}";`);
    expect(findings.some((f) => f.patternName === "Anthropic API 키")).toBe(true);
  });

  it("Resend API 키를 찾는다", () => {
    const findings = scanContentForSecrets(
      "a.ts",
      `process.env.RESEND_API_KEY = "${resendKey()}";`,
    );
    expect(findings.some((f) => f.patternName === "Resend API 키")).toBe(true);
  });

  it("자격증명이 담긴 postgres 연결 문자열을 찾는다(localhost 제외)", () => {
    const findings = scanContentForSecrets(
      "a.ts",
      `DATABASE_URL = "${pgUrl("realuser", "S3cr3tPass", "db.neon.tech:5432/mydb")}";`,
    );
    expect(findings.some((f) => f.patternName.startsWith("Postgres"))).toBe(true);
  });

  it("일반 식별자(EXPLORE_SQL_ALLOW_PGLITE 등)는 re_ 패턴에 오탐하지 않는다", () => {
    const findings = scanContentForSecrets(
      "a.ts",
      "if (env.EXPLORE_SQL_ALLOW_PGLITE !== 'true') throw new Error();",
    );
    expect(findings).toEqual([]);
  });

  it("localhost 대상 postgres 연결 문자열은 건너뛴다(원격 유출 위험 없음)", () => {
    const findings = scanContentForSecrets(
      "tests/x.test.ts",
      `env: { DATABASE_URL: "${pgUrl("user", "pass", "localhost:1/nonexistent")}" }`,
    );
    expect(findings).toEqual([]);
  });

  it("같은 줄에 secretscan-allow 마커가 있으면 건너뛴다(의도된 테스트 픽스처)", () => {
    // 이 줄은 일부러 완성 리터럴이다 — 마커 메커니즘 자체를 검증하는 테스트라서. 스캐너는
    // 마커가 같은 줄에 있으므로 건너뛰고, 아래 자기 검증 테스트도 같은 규칙으로 통과한다.
    const findings = scanContentForSecrets(
      "tests/x.test.ts",
      'const apiKey = "sk-ant-super-secret-key-should-never-leak"; // secretscan-allow: 테스트 픽스처',
    );
    expect(findings).toEqual([]);
  });

  it("흔한 단어(fake/example/placeholder 등)만으로는 더 이상 우회되지 않는다(2차 적대적 검수 SR2-SEC-001 회귀)", () => {
    // 예전엔 이 5개 케이스 전부 findings가 비어 있었다 — 실제 시크릿과 같은 줄에 우연히
    // 흔한 영단어 하나만 있어도 통째로 건너뛰는 결함이었다. 이제는 전용 마커
    // (secretscan-allow)가 없으면 반드시 발견돼야 한다.
    const trailingComments = [
      "// example",
      "// fake value below, this one is real though",
      "// placeholder for now",
      "// dummy? no",
      "// your_real_key_here",
    ];
    for (const comment of trailingComments) {
      const content = `const productionKey = "${awsKey()}"; ${comment}`;
      const findings = scanContentForSecrets("a.ts", content);
      expect(findings, `놓친 줄: ${content}`).toHaveLength(1);
    }
  });

  it("여러 파일·여러 줄에 걸쳐도 매치가 서로 섞이지 않는다(RegExp lastIndex 격리)", () => {
    const first = scanContentForSecrets("a.ts", `const a = "${awsKey()}";`);
    const second = scanContentForSecrets("b.ts", "no secrets here");
    const third = scanContentForSecrets("c.ts", `const b = "${awsKey("ZZZZZZZZZZZZZZZZ")}";`);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(1);
  });

  it("시크릿이 없으면 빈 배열을 반환한다", () => {
    expect(scanContentForSecrets("a.ts", "export const x = 1;")).toEqual([]);
  });

  it("matchPreview는 매치 전체가 아니라 앞부분만 담는다(리포트 자체가 유출이 되지 않도록)", () => {
    const findings = scanContentForSecrets("a.ts", `const k = "${awsKey()}";`);
    expect(findings[0]?.matchPreview).toBe("AKIAABCD...");
    expect(findings[0]?.matchPreview).not.toContain("MNOP");
  });

  it("자기 검증: 이 테스트 파일의 소스 자체를 스캔하면 발견 0건이다(SR2-SEC-002 — SELF_EXCLUDE 없이도 CI를 통과해야 한다)", () => {
    // scripts/secretScan.ts가 이 파일을 다른 파일과 똑같이 스캔한다. 여기서 실패하면
    // 누군가 완성된 시크릿 리터럴을 픽스처로 다시 넣었다는 뜻이다 — 위 assemble()류 헬퍼로
    // 조합하도록 바꿔야 한다(파일 제외로 되돌리지 말 것, 그게 원래 결함이었다).
    const selfPath = fileURLToPath(import.meta.url);
    const selfSource = readFileSync(selfPath, "utf8");
    expect(scanContentForSecrets("tests/secretScan.test.ts", selfSource)).toEqual([]);
  });
});
