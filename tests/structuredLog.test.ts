import { afterEach, describe, expect, it, vi } from "vitest";
import { logStructured } from "../src/adapters/structuredLog.js";

describe("logStructured (007 OPS-005, TASKS T34)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one JSON-parseable line via console.log — including runId/status/event-specific fields", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logStructured({
      event: "folder_scan_completed",
      runId: "run-123",
      status: "sent",
      alertCount: 2,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0] as string;
    const parsed: unknown = JSON.parse(line); // Parsing itself must succeed (structured log contract).
    expect(parsed).toMatchObject({
      event: "folder_scan_completed",
      runId: "run-123",
      status: "sent",
      alertCount: 2,
    });
    expect(typeof (parsed as { loggedAt: unknown }).loggedAt).toBe("string");
  });
});
