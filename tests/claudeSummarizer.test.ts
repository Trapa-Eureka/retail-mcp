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
      storeName: "본점",
      items: [
        {
          variantId: "var_cola",
          name: "코카콜라 500ml",
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
  warnings: ["stale: 마지막 동기화가 24시간을 넘었습니다."],
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

describe("createClaudeSummarizer — 요청 형태", () => {
  it("모델·system 프롬프트·표 데이터를 담아 Messages API를 호출한다", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(anthropicSuccessResponse("본점에서 코카콜라 재주문이 필요합니다."));

    const summarizer = createClaudeSummarizer({ apiKey: "sk-ant-test", fetchImpl });
    const text = await summarizer.summarize(REPORT);

    expect(text).toBe("본점에서 코카콜라 재주문이 필요합니다.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/messages");

    const body = JSON.parse(init.body as string) as {
      model: string;
      system: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("claude-opus-5");
    // 표의 사실(매장명·품목명·수치)이 실제로 프롬프트에 실린다
    expect(body.messages[0]?.content).toContain("본점");
    expect(body.messages[0]?.content).toContain("코카콜라 500ml");
    expect(body.messages[0]?.content).toContain("37");
  });

  it("요청 본문에 API 키·이메일·원시 영수증 필드가 없다 (TESTING §7)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicSuccessResponse("요약."));
    const apiKey = "sk-ant-super-secret-key-should-never-leak";
    const summarizer = createClaudeSummarizer({ apiKey, fetchImpl });
    await summarizer.summarize(REPORT);

    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const bodyText = init.body as string;

    // ReorderReport(LLM 경계 타입)에는 애초에 recipient/email/token/원시 영수증 필드가 없다
    // — 이 테스트는 그 구조적 보장이 실제 HTTP 요청 본문에서도 깨지지 않는지 확인한다.
    expect(bodyText).not.toContain(apiKey);
    expect(bodyText).not.toMatch(/@/); // 이메일 주소 패턴
    expect(bodyText).not.toMatch(/receipt_number|line_items|gross_total_money/); // Lv* 원시 필드명

    // x-api-key 헤더로만 전달되고 본문에는 없어야 한다(Anthropic SDK는 Headers 인스턴스를 쓴다).
    const headers = init.headers as Headers;
    expect(headers.get("x-api-key")).toBe(apiKey);
  });

  it("system 프롬프트에 '수치 생성 금지'와 '표의 사실만'이 명시되어 있다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicSuccessResponse("요약."));
    const summarizer = createClaudeSummarizer({ apiKey: "sk-ant-test", fetchImpl });
    await summarizer.summarize(REPORT);

    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string) as { system: string };

    expect(body.system).toMatch(/수치.*(만들어내지 않|생성하지 않)/);
    expect(body.system).toMatch(/표에 있는 사실.*만 언급/);
    expect(body.system).toMatch(/2~3문장/);
  });

  it("커스텀 model 옵션을 그대로 요청에 반영한다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicSuccessResponse("요약."));
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

describe("createClaudeSummarizer — 오류 처리", () => {
  it("응답에 text 블록이 없으면 명확한 에러를 던진다", async () => {
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
    await expect(summarizer.summarize(REPORT)).rejects.toThrow(/텍스트 블록/);
  });

  describe("ANTHROPIC_API_KEY 누락", () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it("원인과 해결법이 담긴 에러를 생성 시점에 던진다", () => {
      delete process.env["ANTHROPIC_API_KEY"];
      expect(() => createClaudeSummarizer({})).toThrow(/ANTHROPIC_API_KEY/);
    });
  });
});
