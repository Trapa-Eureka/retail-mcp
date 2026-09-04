import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeSummarizer } from "../src/adapters/claudeSummarizer.js";
import type { ReorderReport } from "../src/core/types.js";

const REPORT: ReorderReport = {
  generatedAt: new Date("2026-09-01T07:00:00Z"),
  timezone: "Asia/Manila",
  dataLastSyncedAt: new Date("2026-09-01T06:00:00Z"),
  stores: [
    {
      storeId: "store_main",
      storeName: "Main Store",
      items: [
        {
          variantId: "var_cola",
          name: "Coca-Cola 500ml",
          inStock: 5,
          avgDailySales: 2,
          daysOfCover: 2.5,
          reorderQty: 37,
          packSize: null,
          finalOrderQty: 37,
          packCount: null,
        },
      ],
    },
  ],
  warnings: ["stale: the last sync is more than 24 hours old."],
};

function anthropicSuccessResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      container: null,
      model: "claude-opus-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      content: [{ type: "text", text }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("createClaudeSummarizer — request shape", () => {
  it("calls the Messages API with the model, system prompt and table data", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(anthropicSuccessResponse("Main Store needs a Coca-Cola reorder."));

    const summarizer = createClaudeSummarizer({ apiKey: "sk-ant-test", fetchImpl });
    const text = await summarizer.summarize(REPORT);

    expect(text).toBe("Main Store needs a Coca-Cola reorder.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/messages");

    const body = JSON.parse(init.body as string) as {
      model: string;
      system: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("claude-opus-5");
    // The facts in the table (store name, item name, numbers) actually appear in the prompt
    expect(body.messages[0]?.content).toContain("Main Store");
    expect(body.messages[0]?.content).toContain("Coca-Cola 500ml");
    expect(body.messages[0]?.content).toContain("37");
  });

  it("the request body contains no API key, email or raw receipt fields (TESTING §7)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicSuccessResponse("Summary."));
    const apiKey = "sk-ant-super-secret-key-should-never-leak"; // secretscan-allow: test fixture, not a real key
    const summarizer = createClaudeSummarizer({ apiKey, fetchImpl });
    await summarizer.summarize(REPORT);

    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const bodyText = init.body as string;

    // ReorderReport (the LLM boundary type) has no recipient/email/token/raw receipt fields to
    // begin with — this test checks that structural guarantee also holds in the actual HTTP request body.
    expect(bodyText).not.toContain(apiKey);
    expect(bodyText).not.toMatch(/@/); // email address pattern
    expect(bodyText).not.toMatch(/receipt_number|line_items|gross_total_money/); // Lv* raw field names

    // Must be passed only via the x-api-key header and not in the body (the Anthropic SDK uses a Headers instance).
    const headers = init.headers as Headers;
    expect(headers.get("x-api-key")).toBe(apiKey);
  });

  it("the system prompt explicitly states 'do not invent numbers' and 'only the facts in the table'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicSuccessResponse("Summary."));
    const summarizer = createClaudeSummarizer({ apiKey: "sk-ant-test", fetchImpl });
    await summarizer.summarize(REPORT);

    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string) as { system: string };

    expect(body.system).toMatch(/Do not (calculate or invent|invent) numbers/);
    expect(body.system).toMatch(/Mention only the facts in the table/);
    expect(body.system).toMatch(/2-3 sentences/);
  });

  it("reflects a custom model option in the request as-is", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicSuccessResponse("Summary."));
    const summarizer = createClaudeSummarizer({
      apiKey: "sk-ant-test",
      fetchImpl,
      model: "claude-haiku-4-5",
    });
    await summarizer.summarize(REPORT);
    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("claude-haiku-4-5");
  });
});

describe("createClaudeSummarizer — error handling", () => {
  it("throws a clear error when the response has no text block", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_x",
          type: "message",
          role: "assistant",
          container: null,
          model: "claude-opus-5",
          stop_reason: "tool_use",
          stop_sequence: null,
          stop_details: null,
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const summarizer = createClaudeSummarizer({ apiKey: "sk-ant-test", fetchImpl });
    await expect(summarizer.summarize(REPORT)).rejects.toThrow(/text block/);
  });

  describe("missing ANTHROPIC_API_KEY", () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it("throws an error with the cause and the fix at creation time", () => {
      delete process.env["ANTHROPIC_API_KEY"];
      expect(() => createClaudeSummarizer({})).toThrow(/ANTHROPIC_API_KEY/);
    });
  });
});
