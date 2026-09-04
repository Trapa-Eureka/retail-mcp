import { describe, expect, it } from "vitest";
import { createMockSummarizer } from "../src/mocks/mockSummarizer.js";
import type { ReorderReport } from "../src/core/types.js";

const REPORT: ReorderReport = {
  generatedAt: new Date("2026-09-01T07:00:00Z"),
  timezone: "Asia/Manila",
  dataLastSyncedAt: new Date("2026-09-01T06:00:00Z"),
  stores: [],
  warnings: [],
};

describe("createMockSummarizer", () => {
  it("returns a fixed string by default", async () => {
    const summarizer = createMockSummarizer();
    await expect(summarizer.summarize(REPORT)).resolves.toBeTypeOf("string");
  });

  it("returns fixedText when specified", async () => {
    const summarizer = createMockSummarizer({ fixedText: "Custom summary" });
    await expect(summarizer.summarize(REPORT)).resolves.toBe("Custom summary");
  });

  it("rejects like an LLM outage when fail:true", async () => {
    const summarizer = createMockSummarizer({ fail: true });
    await expect(summarizer.summarize(REPORT)).rejects.toThrow(/outage/);
  });
});
