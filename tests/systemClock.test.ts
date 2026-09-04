import { describe, expect, it } from "vitest";
import { createSystemClock } from "../src/adapters/systemClock.js";

describe("createSystemClock", () => {
  it("now() returns a real Date close to the time of the call", () => {
    const before = Date.now();
    const clock = createSystemClock();
    const now = clock.now();
    const after = Date.now();

    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });

  it("creates a new Date instance on every call (not a cached fixed value)", async () => {
    const clock = createSystemClock();
    const first = clock.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = clock.now();

    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });
});
