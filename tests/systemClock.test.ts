import { describe, expect, it } from "vitest";
import { createSystemClock } from "../src/adapters/systemClock.js";

describe("createSystemClock", () => {
  it("now()는 호출 시점에 가까운 실제 Date를 반환한다", () => {
    const before = Date.now();
    const clock = createSystemClock();
    const now = clock.now();
    const after = Date.now();

    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });

  it("호출할 때마다 새 Date 인스턴스를 만든다(캐시된 고정값이 아님)", async () => {
    const clock = createSystemClock();
    const first = clock.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = clock.now();

    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });
});
