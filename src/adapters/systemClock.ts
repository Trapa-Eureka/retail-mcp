/**
 * 실제 시계 어댑터. `core/`와 `agent/reorder.ts`는 이 파일을 거치지 않고 `new Date()`를
 * 직접 부르지 않는다 — 시계도 다른 외부 IO(POS, DB, 발송)처럼 인터페이스 뒤에 둔다
 * (CLAUDE.md 컨벤션). 테스트는 `src/mocks/fixedClock.ts`의 `createFixedClock()`을 쓴다.
 */
import type { Clock } from "../core/types.js";

export function createSystemClock(): Clock {
  return {
    now: () => new Date(),
  };
}
