import { describe, expect, it, vi } from "vitest";
import { createSlidingWindowRateLimiter } from "../src/adapters/rateLimiter.js";

describe("createSlidingWindowRateLimiter", () => {
  it("does not wait while there is room in the window", async () => {
    let now = 1000;
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const limiter = createSlidingWindowRateLimiter(3, 1000, { nowFn: () => now, sleepFn });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("when over the limit, waits until the oldest request leaves the window", async () => {
    let now = 0;
    const sleepFn = vi.fn().mockImplementation((ms: number) => {
      now += ms; // mimic sleep by actually advancing the clock
      return Promise.resolve();
    });
    const limiter = createSlidingWindowRateLimiter(2, 1000, { nowFn: () => now, sleepFn });

    await limiter.acquire(); // now=0 → slot[0]
    now = 100;
    await limiter.acquire(); // now=100 → slot[1] (limit of 2 reached)

    now = 200;
    await limiter.acquire(); // over the limit → must wait until slot[0] (now=0) expires at 1000ms

    expect(sleepFn).toHaveBeenCalledTimes(1);
    // After waiting, now must be at least 1000 (= slot0 expiry time).
    expect(now).toBeGreaterThanOrEqual(1000);
  });

  it("multiple acquires consume exactly one slot each in order even while waiting", async () => {
    let now = 0;
    const sleepFn = vi.fn().mockImplementation((ms: number) => {
      now += ms;
      return Promise.resolve();
    });
    const limiter = createSlidingWindowRateLimiter(1, 1000, { nowFn: () => now, sleepFn });

    await limiter.acquire(); // now=0
    await limiter.acquire(); // limit 1 → after waiting now>=1000
    await limiter.acquire(); // limit again → after waiting now>=2000

    expect(now).toBeGreaterThanOrEqual(2000);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("invalid maxRequests/windowMs throw an error with the cause at creation time", () => {
    expect(() => createSlidingWindowRateLimiter(0, 1000)).toThrow(/maxRequests/);
    expect(() => createSlidingWindowRateLimiter(1, 0)).toThrow(/windowMs/);
    expect(() => createSlidingWindowRateLimiter(1.5, 1000)).toThrow(/maxRequests/);
  });
});
