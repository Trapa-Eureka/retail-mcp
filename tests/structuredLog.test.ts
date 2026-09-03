import { afterEach, describe, expect, it, vi } from "vitest";
import { logStructured } from "../src/adapters/structuredLog.js";

describe("logStructured (007 OPS-005, TASKS T34)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("console.log에 JSON 파싱 가능한 한 줄을 남긴다 — runId/status/이벤트별 필드 포함", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logStructured({
      event: "folder_scan_completed",
      runId: "run-123",
      status: "sent",
      alertCount: 2,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0] as string;
    const parsed: unknown = JSON.parse(line); // 파싱 자체가 성공해야 한다(구조화 로그 계약).
    expect(parsed).toMatchObject({
      event: "folder_scan_completed",
      runId: "run-123",
      status: "sent",
      alertCount: 2,
    });
    expect(typeof (parsed as { loggedAt: unknown }).loggedAt).toBe("string");
  });
});
