import { describe, expect, it } from "vitest";
import { createMockNotificationProvider } from "../src/mocks/mockNotificationProvider.js";
import type { OutboundMessage } from "../src/core/types.js";

const MSG: OutboundMessage = { to: "owner@example.com", subject: "Subject", text: "Body" };

describe("createMockNotificationProvider", () => {
  it("records successful sends in order", async () => {
    const provider = createMockNotificationProvider();
    const result = await provider.send(MSG);
    expect(result.messageId).toMatch(/^mock-/);
    expect(provider.sent).toEqual([MSG]);
  });

  it("send() rejects for recipients registered in failFor", async () => {
    const provider = createMockNotificationProvider({ failFor: ["blocked@example.com"] });
    await expect(provider.send({ ...MSG, to: "blocked@example.com" })).rejects.toThrow(
      /blocked@example\.com/,
    );
    expect(provider.sent).toHaveLength(0);
  });

  it("recipients not in failFor are sent normally", async () => {
    const provider = createMockNotificationProvider({ failFor: ["blocked@example.com"] });
    await expect(provider.send(MSG)).resolves.toBeDefined();
    expect(provider.sent).toHaveLength(1);
  });

  it("channel is email", () => {
    expect(createMockNotificationProvider().channel).toBe("email");
  });
});
