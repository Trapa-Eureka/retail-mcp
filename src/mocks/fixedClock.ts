/**
 * 테스트용 고정 시계 (TESTING.md §2). 모든 날짜 계산은 이 Clock을 통해서만 "지금"을 얻는다 —
 * 머신 로컬 시각에 의존하지 않고 결정론적으로 만든다.
 */
import type { Clock } from "../core/types.js";

export function createFixedClock(iso: string): Clock {
  const fixed = new Date(iso);
  if (Number.isNaN(fixed.getTime())) {
    throw new Error(
      `유효하지 않은 ISO 시각입니다: "${iso}". FixedClock에는 파싱 가능한 날짜 문자열을 넘기세요.`,
    );
  }
  return {
    now: () => new Date(fixed.getTime()),
  };
}
