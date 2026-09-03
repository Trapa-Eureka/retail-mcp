import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // tests/component/**는 실 Postgres가 필요한 별도 스위트다(QA-004, TASKS T35,
    // vitest.component.config.ts + `npm run test:pg-component` 전용) — 기본 게이트(가드레일
    // 2: 테스트 네트워크 호출 0건)에서 명시적으로 제외한다. skipIf로도 안전하지만(실행은
    // 되되 스킵됨), exclude로 애초에 이 파일 자체를 보지 않게 하는 게 "기본 게이트는 이
    // 디렉터리를 아예 모른다"는 의도를 정확히 반영한다.
    exclude: [...defaultExclude, "tests/component/**"],
    // PGlite(인프로세스 Postgres) 기동이 CI/공유 CPU 환경에서 기본 5000ms를 넘기는 경우가
    // 실측됐다(특히 --coverage의 v8 계측 오버헤드와 겹칠 때) — 여유 있게 20초로 늘린다.
    // 50k행 성능 가드 자체는 이 값과 별개로 테스트 안에서 5초 기준을 직접 assert한다.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      // core 전용이던 범위를 QA-003(008 검수, TASKS T35)에 맞춰 확장한다 — publish/보안상
      // 중요한 IO 경계(explore_sql, warehouseFactory, provider, CLI 진입점)에도 강제 기준을
      // 둔다. src/etl·src/mocks는 core 순수 로직이 아니라 오케스트레이션/테스트 헬퍼라 제외.
      include: [
        "src/core/**/*.ts",
        "src/adapters/**/*.ts",
        "src/agent/**/*.ts",
        "src/mcp/**/*.ts",
        "src/cli/**/*.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      // 전역 기준(plain key)은 include 전체를 합산한 바닥선이고, glob 키는 그 하위집합에
      // 개별로 적용된다(둘 다 동시에 만족해야 함) — Vitest coverage.thresholds 문서의
      // "Thresholds for utilities" 패턴. 숫자는 현재 실측치(TASKS T35 측정, 2026-09-03)에서
      // 약간의 여유만 두고 잡았다 — "지금 수준 아래로 못 내려간다"는 회귀 방지가 목적이지
      // 이상적인 목표치가 아니다. core는 기존 기준(90/90/90/85)을 그대로 유지한다.
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 80,
        lines: 80,
        "src/core/**/*.ts": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "src/adapters/**/*.ts": { statements: 80, branches: 65, functions: 80, lines: 85 },
        // explore_sql은 가드레일 4가 사전 승인한 유일한 임의 SQL 실행 경로라 별도로 더 높게
        // 잡는다(SEC-001/002 회귀 방지, docs/005).
        "src/adapters/exploreSqlExecutor.ts": {
          statements: 90,
          branches: 80,
          functions: 95,
          lines: 90,
        },
        // db.close()/lock.release() 이중 실패 처리(OPS-001)가 있는 파일 — 회귀 시 소리 없이
        // 락이 안 풀리는 사고로 이어진다.
        "src/adapters/warehouseFactory.ts": {
          statements: 80,
          branches: 70,
          functions: 95,
          lines: 80,
        },
        // Idempotency-Key/AmbiguousSendError(OPS-004) 분기가 있는 유일한 발송 어댑터.
        "src/adapters/resendProvider.ts": {
          statements: 90,
          branches: 85,
          functions: 85,
          lines: 95,
        },
        "src/agent/**/*.ts": { statements: 65, branches: 50, functions: 65, lines: 65 },
        "src/mcp/**/*.ts": { statements: 75, branches: 60, functions: 80, lines: 85 },
        "src/cli/**/*.ts": { statements: 60, branches: 55, functions: 60, lines: 55 },
      },
    },
  },
});
