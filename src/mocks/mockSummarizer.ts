/**
 * Mock Summarizer — returns a fixed string; fail:true reproduces an LLM outage (TESTING.md §2).
 */
import type { ReorderReport, Summarizer } from "../core/types.js";

export interface MockSummarizerOptions {
  fixedText?: string;
  /** When true, summarize() rejects to mimic an LLM outage. */
  fail?: boolean;
}

const DEFAULT_TEXT = "This week's reorder suggestions are ready — please review the table below.";

export function createMockSummarizer(options: MockSummarizerOptions = {}): Summarizer {
  return {
    summarize(_input: ReorderReport): Promise<string> {
      if (options.fail) {
        return Promise.reject(
          new Error("MockSummarizer: fail:true is set, reproducing an LLM outage."),
        );
      }
      return Promise.resolve(options.fixedText ?? DEFAULT_TEXT);
    },
  };
}
