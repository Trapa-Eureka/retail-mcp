import { defineConfig } from "vitest/config";

/**
 * 실 Postgres 컴포넌트 테스트 전용 설정(QA-004, TASKS T35) — `vitest.config.ts`(기본 게이트,
 * `tests/**`, 가드레일 2: 네트워크 0건)와 의도적으로 분리했다. `tests/component/**`만 보므로
 * `npm run test`/`npm run check`는 이 파일이 존재하는지도 모른다 — `npm run test:pg-component`
 * (CI 전용, TEST_DATABASE_URL 필요)로만 실행된다.
 */
export default defineConfig({
  test: {
    include: ["tests/component/**/*.test.ts"],
    // pg_sleep 기반 timeout 테스트 + 실 네트워크 왕복이 섞여 기본 20초보다 여유를 둔다.
    testTimeout: 30_000,
    // coverage는 기본 게이트(vitest.config.ts)에서만 측정한다 — 여긴 대상이 아니다.
    coverage: { enabled: false },
  },
});
