/**
 * `src/cli/migrate.ts`(npm 배포 bin `retail-mcp-migrate`, 2차 적대적 검수 SR2-REL-001)의
 * 순수 함수만 여기서 단위 테스트한다 — 실제 DB 적용/점검(`applyMigrationsToDatabaseUrl`/
 * `checkPendingMigrationsForDatabaseUrl`)은 real Postgres가 필요해 tests/component/**에서
 * 검증한다(가드레일 2, 이 파일은 기본 게이트).
 */
import { describe, expect, it } from "vitest";
import { describeTarget } from "../src/cli/migrate.js";

describe("describeTarget(SR2-REL-001)", () => {
  it("host·port·db명만 남기고 자격증명(user/password)은 뺀다", () => {
    const url = "postgres://myuser:mysecretpassword@ep-example.neon.tech:5432/mydb"; // secretscan-allow: 테스트 픽스처, 실제 키 아님
    expect(describeTarget(url)).toBe("ep-example.neon.tech:5432/mydb");
  });

  it("포트가 없으면 포트 없이 표시한다", () => {
    const url = "postgres://user:pw@db.example.com/mydb"; // secretscan-allow: 테스트 픽스처, 실제 키 아님
    expect(describeTarget(url)).toBe("db.example.com/mydb");
  });

  it("자격증명이 결과 문자열 어디에도 남지 않는다", () => {
    const url = "postgres://very-secret-user:very-secret-password@host/db"; // secretscan-allow: 테스트 픽스처, 실제 키 아님
    const result = describeTarget(url);
    expect(result).not.toContain("very-secret-user");
    expect(result).not.toContain("very-secret-password");
  });

  it("URL로 해석할 수 없는 값이면 예외를 던지지 않고 안내 문구로 대체한다", () => {
    expect(describeTarget("이건-연결-문자열이-아님")).toBe(
      "(연결 문자열을 해석할 수 없어 대상을 표시할 수 없습니다)",
    );
  });
});
