/**
 * Sliding-window request rate limiter. The official Loyverse API docs (developer.loyverse.com/docs,
 * "API rate limits" section, verified 2026-09-03) state a per-account limit of "300 requests per
 * 300 sec"; loyverseClient.ts throttles itself through this module right before each real fetch
 * call so that limit is never exceeded — a proactive defense where the client slows down before
 * Loyverse rejects it with 429 (the existing 429/Retry-After backoff stays as the reactive defense).
 */

export interface RateLimiter {
  /** Waits until there is room in the window, then returns — the moment of return is the new request slot. */
  acquire(): Promise<void>;
}

export interface RateLimiterOptions {
  /** Test injection hook. Default: Date.now. */
  nowFn?: () => number;
  /** Test injection hook. Default: a real setTimeout-based wait. */
  sleepFn?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Allows at most `maxRequests` within the last `windowMs`. When the window is full, waits until
 * the oldest request leaves the window (the time is re-checked while waiting — even when several
 * acquire() calls wait concurrently, each consumes exactly one slot when its turn comes).
 */
export function createSlidingWindowRateLimiter(
  maxRequests: number,
  windowMs: number,
  opts: RateLimiterOptions = {},
): RateLimiter {
  if (!Number.isInteger(maxRequests) || maxRequests <= 0) {
    throw new Error(`maxRequests must be an integer of 1 or more. Received: ${maxRequests}.`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`windowMs must be greater than 0. Received: ${windowMs}.`);
  }
  const now = opts.nowFn ?? Date.now;
  const sleep = opts.sleepFn ?? defaultSleep;
  /** Request timestamps treated as being inside the window (kept in ascending order). */
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
