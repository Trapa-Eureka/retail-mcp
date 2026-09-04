/**
 * Claude API based Summarizer — only produces the 2-3 sentence summary text of the reorder report table.
 * LLM boundary (CLAUDE.md guardrail 3): items, quantities and amounts all come from the deterministic
 * calculation result (ReorderReport); this module returns a single string — callers must never parse
 * numbers out of that string and use them in logic.
 * The prompt states explicitly: "do not invent numbers, use only the facts in the provided table".
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ReorderReport, Summarizer } from "../core/types.js";

const DEFAULT_MODEL = "claude-opus-5";
// A short 2-3 sentence summary, so even a generous limit is small — just enough to avoid truncated output that would need a retry.
const MAX_TOKENS = 600;

const SYSTEM_PROMPT = `You write the summary text for a reorder suggestion email sent to a retail store owner.

Rules you must follow:
1. Write exactly 2-3 sentences.
2. Mention only the facts in the table given in the user message below (store names, item names, counts, etc.).
3. Do not calculate or invent numbers (quantities, amounts, days, counts, etc.) yourself — mention a
   number only when quoting a value already in the table verbatim, and never mention a number that is not in the table.
4. Write in natural English or Taglish sentences the store owner can read right away.
5. Do not use any format other than sentences (no headings, lists, code blocks, etc.).`;

function formatCover(daysOfCover: number | null): string {
  return daysOfCover === null ? "∞" : daysOfCover.toFixed(1);
}

function buildUserPrompt(report: ReorderReport): string {
  const lines: string[] = [
    `Generated at: ${report.generatedAt.toISOString()} (business timezone: ${report.timezone})`,
  ];
  if (report.dataLastSyncedAt) {
    lines.push(`Last sync: ${report.dataLastSyncedAt.toISOString()}`);
  } else {
    lines.push("Last sync: unknown");
  }

  for (const store of report.stores) {
    lines.push(`\n[Store: ${store.storeName}] (${store.items.length} items)`);
    for (const item of store.items) {
      lines.push(
        `- ${item.name}: in stock ${item.inStock}, avg daily sales ${item.avgDailySales.toFixed(2)}, ` +
          `days of cover ${formatCover(item.daysOfCover)}, suggested qty ${item.reorderQty}`,
      );
    }
  }

  if (report.warnings.length > 0) {
    lines.push(`\nWarnings: ${report.warnings.join("; ")}`);
  }

  lines.push("\nWrite a 2-3 sentence summary based only on the facts in the table above.");
  return lines.join("\n");
}

export interface ClaudeSummarizerOptions {
  /** Default: environment variable ANTHROPIC_API_KEY */
  apiKey?: string;
  /** Hook to inject a mock fetch in tests. Passed straight through to the Anthropic SDK's custom fetch option. */
  fetchImpl?: typeof fetch;
  model?: string;
}

export function createClaudeSummarizer(options: ClaudeSummarizerOptions = {}): Summarizer {
  const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Create one in the Anthropic Console and add it to .env.",
    );
  }
  const model = options.model ?? DEFAULT_MODEL;
  const client = new Anthropic({
    apiKey,
    ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {}),
  });

  return {
    async summarize(input: ReorderReport): Promise<string> {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        // Turning a table into sentences is a simple task, so low effort reduces cost and latency.
        output_config: { effort: "low" },
        messages: [{ role: "user", content: buildUserPrompt(input) }],
      });

      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text",
      );
      if (!textBlock) {
        throw new Error(
          "Claude response has no text block (unexpected response format — check stop_reason).",
        );
      }
      return textBlock.text.trim();
    },
  };
}
