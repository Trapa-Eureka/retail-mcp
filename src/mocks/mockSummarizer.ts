/**
 * Summarizer 목 구현 — 고정 문자열 반환, fail:true로 LLM 장애 재현 (TESTING.md §2).
 */
import type { ReorderReport, Summarizer } from "../core/types.js";

export interface MockSummarizerOptions {
  fixedText?: string;
  /** true면 summarize()가 LLM 장애를 흉내내며 reject된다. */
  fail?: boolean;
}

const DEFAULT_TEXT = "This week's reorder suggestions are ready — please review the table below.";

export function createMockSummarizer(options: MockSummarizerOptions = {}): Summarizer {
  return {
    summarize(_input: ReorderReport): Promise<string> {
      if (options.fail) {
        return Promise.reject(
          new Error("MockSummarizer: fail:true로 설정되어 LLM 장애를 재현합니다."),
        );
      }
      return Promise.resolve(options.fixedText ?? DEFAULT_TEXT);
    },
  };
}
