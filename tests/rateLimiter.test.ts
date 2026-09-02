import { describe, expect, it, vi } from "vitest";
import { createSlidingWindowRateLimiter } from "../src/adapters/rateLimiter.js";

describe("createSlidingWindowRateLimiter", () => {
  it("윈도우 안에 여유가 있으면 기다리지 않는다", async () => {
    let now = 1000;
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const limiter = createSlidingWindowRateLimiter(3, 1000, { nowFn: () => now, sleepFn });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("한도를 넘으면 가장 오래된 요청이 윈도우를 벗어날 때까지 기다린다", async () => {
    let now = 0;
    const sleepFn = vi.fn().mockImplementation((ms: number) => {
      now += ms; // sleep을 흉내내며 시계를 실제로 전진시킨다
      return Promise.resolve();
    });
    const limiter = createSlidingWindowRateLimiter(2, 1000, { nowFn: () => now, sleepFn });

    await limiter.acquire(); // now=0 → 슬롯[0]
    now = 100;
    await limiter.acquire(); // now=100 → 슬롯[1] (한도 2 도달)

    now = 200;
    await limiter.acquire(); // 한도 초과 → 슬롯[0](now=0)이 1000ms 시점에 빠질 때까지 대기해야 함

    expect(sleepFn).toHaveBeenCalledTimes(1);
    // 대기 후 now는 최소 1000(=slot0 만료 시점) 이상이어야 한다.
    expect(now).toBeGreaterThanOrEqual(1000);
  });

  it("대기 중에도 여러 acquire가 순서대로 슬롯을 하나씩만 소비한다", async () => {
    let now = 0;
    const sleepFn = vi.fn().mockImplementation((ms: number) => {
      now += ms;
      return Promise.resolve();
    });
    const limiter = createSlidingWindowRateLimiter(1, 1000, { nowFn: () => now, sleepFn });

    await limiter.acquire(); // now=0
    await limiter.acquire(); // 한도 1 → 대기 후 now>=1000
    await limiter.acquire(); // 다시 한도 → 대기 후 now>=2000

    expect(now).toBeGreaterThanOrEqual(2000);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("잘못된 maxRequests/windowMs는 생성 시점에 원인이 담긴 에러를 던진다", () => {
    expect(() => createSlidingWindowRateLimiter(0, 1000)).toThrow(/maxRequests/);
    expect(() => createSlidingWindowRateLimiter(1, 0)).toThrow(/windowMs/);
    expect(() => createSlidingWindowRateLimiter(1.5, 1000)).toThrow(/maxRequests/);
  });
});
