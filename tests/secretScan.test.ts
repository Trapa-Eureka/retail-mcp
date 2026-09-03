import { describe, expect, it } from "vitest";
import { scanContentForSecrets } from "../src/core/secretScan.js";

describe("scanContentForSecrets (QA-006, TASKS T35)", () => {
  it("AWS Access Key ID를 찾는다", () => {
    const findings = scanContentForSecrets("a.ts", 'const key = "AKIAABCDEFGHIJKLMNOP";');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.patternName).toBe("AWS Access Key ID");
    expect(findings[0]?.line).toBe(1);
  });

  it("PEM 개인키 블록을 찾는다", () => {
    const content =
      "line1\n-----BEGIN RSA PRIVATE KEY-----\nMIIExxxx\n-----END RSA PRIVATE KEY-----";
    const findings = scanContentForSecrets("key.pem", content);
    expect(findings.some((f) => f.patternName === "PEM 개인키 블록")).toBe(true);
    expect(findings.find((f) => f.patternName === "PEM 개인키 블록")?.line).toBe(2);
  });

  it("Anthropic API 키를 찾는다", () => {
    const findings = scanContentForSecrets(
      "a.ts",
      'const k = "sk-ant-api03-realLookingSecretValue1234567890";',
    );
    expect(findings.some((f) => f.patternName === "Anthropic API 키")).toBe(true);
  });

  it("Resend API 키를 찾는다", () => {
    const findings = scanContentForSecrets(
      "a.ts",
      'process.env.RESEND_API_KEY = "re_1234567890abcdefghijklmnop";',
    );
    expect(findings.some((f) => f.patternName === "Resend API 키")).toBe(true);
  });

  it("자격증명이 담긴 postgres 연결 문자열을 찾는다(localhost 제외)", () => {
    const findings = scanContentForSecrets(
      "a.ts",
      'DATABASE_URL = "postgres://realuser:S3cr3tPass@db.neon.tech:5432/mydb";',
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
      'env: { DATABASE_URL: "postgres://user:pass@localhost:1/nonexistent" }',
    );
    expect(findings).toEqual([]);
  });

  it("같은 줄에 fake/example/placeholder류 표시가 있으면 건너뛴다", () => {
    const findings = scanContentForSecrets(
      "tests/x.test.ts",
      'const apiKey = "sk-ant-super-secret-key-should-never-leak"; // fake',
    );
    expect(findings).toEqual([]);
  });

  it("여러 파일·여러 줄에 걸쳐도 매치가 서로 섞이지 않는다(RegExp lastIndex 격리)", () => {
    const first = scanContentForSecrets("a.ts", 'const a = "AKIAABCDEFGHIJKLMNOP";');
    const second = scanContentForSecrets("b.ts", "no secrets here");
    const third = scanContentForSecrets("c.ts", 'const b = "AKIAZZZZZZZZZZZZZZZZ";');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(1);
  });

  it("시크릿이 없으면 빈 배열을 반환한다", () => {
    expect(scanContentForSecrets("a.ts", "export const x = 1;")).toEqual([]);
  });

  it("matchPreview는 매치 전체가 아니라 앞부분만 담는다(리포트 자체가 유출이 되지 않도록)", () => {
    const findings = scanContentForSecrets("a.ts", 'const k = "AKIAABCDEFGHIJKLMNOP";');
    expect(findings[0]?.matchPreview).toBe("AKIAABCD...");
    expect(findings[0]?.matchPreview).not.toContain("MNOP");
  });
});
