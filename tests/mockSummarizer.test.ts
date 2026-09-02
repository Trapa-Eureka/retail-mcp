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
  it("기본적으로 고정 문자열을 반환한다", async () => {
    const summarizer = createMockSummarizer();
    await expect(summarizer.summarize(REPORT)).resolves.toBeTypeOf("string");
  });

  it("fixedText를 지정하면 그 값을 반환한다", async () => {
    const summarizer = createMockSummarizer({ fixedText: "커스텀 요약" });
    await expect(summarizer.summarize(REPORT)).resolves.toBe("커스텀 요약");
  });

  it("fail:true면 LLM 장애처럼 reject된다", async () => {
    const summarizer = createMockSummarizer({ fail: true });
    await expect(summarizer.summarize(REPORT)).rejects.toThrow(/장애/);
  });
});
