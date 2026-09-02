import { describe, expect, it } from "vitest";
import { createMockNotificationProvider } from "../src/mocks/mockNotificationProvider.js";
import type { OutboundMessage } from "../src/core/types.js";

const MSG: OutboundMessage = { to: "owner@example.com", subject: "제목", text: "본문" };

describe("createMockNotificationProvider", () => {
  it("성공한 발송을 순서대로 기록한다", async () => {
    const provider = createMockNotificationProvider();
    const result = await provider.send(MSG);
    expect(result.messageId).toMatch(/^mock-/);
    expect(provider.sent).toEqual([MSG]);
  });

  it("failFor에 등록된 수신자는 send()가 reject된다", async () => {
    const provider = createMockNotificationProvider({ failFor: ["blocked@example.com"] });
    await expect(provider.send({ ...MSG, to: "blocked@example.com" })).rejects.toThrow(
      /blocked@example\.com/,
    );
    expect(provider.sent).toHaveLength(0);
  });

  it("failFor에 없는 수신자는 정상 발송된다", async () => {
    const provider = createMockNotificationProvider({ failFor: ["blocked@example.com"] });
    await expect(provider.send(MSG)).resolves.toBeDefined();
    expect(provider.sent).toHaveLength(1);
  });

  it("channel은 email이다", () => {
    expect(createMockNotificationProvider().channel).toBe("email");
  });
});
