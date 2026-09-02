/**
 * 슬라이딩 윈도우 요청 속도 제한기. Loyverse API 공식 문서(developer.loyverse.com/docs,
 * "API rate limits" 절, 2026-09-03 확인)가 명시하는 계정당 한도 "300 requests per 300 sec"를
 * 넘기지 않도록 loyverseClient.ts가 실제 fetch 호출 직전에 이 모듈로 스스로를 제한한다 —
 * Loyverse가 429로 거부하기 전에 클라이언트가 먼저 속도를 늦추는 능동적 방어다(기존
 * 429/Retry-After 백오프는 반응적 방어로 그대로 유지된다).
 */

export interface RateLimiter {
  /** 윈도우 안에 여유가 생길 때까지 기다린 뒤 반환한다 — 호출한 시점이 새 요청 슬롯이 된다. */
  acquire(): Promise<void>;
}

export interface RateLimiterOptions {
  /** 테스트 주입용. 기본값: Date.now. */
  nowFn?: () => number;
  /** 테스트 주입용. 기본값: 실제 setTimeout 기반 대기. */
  sleepFn?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 최근 `windowMs` 안에 `maxRequests`건까지만 허용한다. 윈도우가 꽉 차 있으면 가장 오래된
 * 요청이 윈도우를 벗어날 때까지 기다린다(대기 중에도 계속 시각을 재확인 — 여러 acquire()가
 * 동시에 대기 중이어도 각자 자기 차례가 되면 슬롯을 하나씩만 소비한다).
 */
export function createSlidingWindowRateLimiter(
  maxRequests: number,
  windowMs: number,
  opts: RateLimiterOptions = {},
): RateLimiter {
  if (!Number.isInteger(maxRequests) || maxRequests <= 0) {
    throw new Error(`maxRequests는 1 이상의 정수여야 합니다. 받은 값: ${maxRequests}.`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`windowMs는 0보다 커야 합니다. 받은 값: ${windowMs}.`);
  }
  const now = opts.nowFn ?? Date.now;
  const sleep = opts.sleepFn ?? defaultSleep;
  /** 윈도우 안에 있는 것으로 취급 중인 요청 시각들(오름차순 유지). */
  const timestamps: number[] = [];

  return {
    async acquire(): Promise<void> {
      for (;;) {
        const cutoff = now() - windowMs;
        while (timestamps.length > 0 && timestamps[0]! <= cutoff) timestamps.shift();

        if (timestamps.length < maxRequests) {
          timestamps.push(now());
          return;
        }

        const waitMs = timestamps[0]! + windowMs - now();
        await sleep(Math.max(waitMs, 1));
      }
    },
  };
}
