import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // PGlite(인프로세스 Postgres) 기동이 CI/공유 CPU 환경에서 기본 5000ms를 넘기는 경우가
    // 실측됐다(특히 --coverage의 v8 계측 오버헤드와 겹칠 때) — 여유 있게 20초로 늘린다.
    // 50k행 성능 가드 자체는 이 값과 별개로 테스트 안에서 5초 기준을 직접 assert한다.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
