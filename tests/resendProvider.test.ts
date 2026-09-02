import { afterEach, describe, expect, it, vi } from "vitest";
import { createResendEmailProvider } from "../src/adapters/resendProvider.js";
import type { OutboundMessage } from "../src/core/types.js";

const MSG: OutboundMessage = {
  to: "owner@example.com",
  subject: "재주문 제안",
  text: "이번 주 제안 표를 확인하세요.",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createResendEmailProvider — 요청 형태", () => {
  it("Authorization 헤더, 엔드포인트, 본문 필드가 올바르다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "email_123" }));
    const provider = createResendEmailProvider({
      apiKey: "secret-resend-key",
      from: "no-reply@retail-mcp.test",
      fetchImpl,
    });

    const result = await provider.send(MSG);
    expect(result).toEqual({ messageId: "email_123" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-resend-key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body: unknown = JSON.parse(init.body as string);
    expect(body).toEqual({
      from: "no-reply@retail-mcp.test",
      to: ["owner@example.com"],
      subject: "재주문 제안",
      text: "이번 주 제안 표를 확인하세요.",
    });
  });

  it("html이 있으면 본문에 포함된다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "email_1" }));
    const provider = createResendEmailProvider({
      apiKey: "k",
      from: "a@b.com",
      fetchImpl,
    });
    await provider.send({ ...MSG, html: "<p>hi</p>" });
    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const body: unknown = JSON.parse(init.body as string);
    expect((body as { html?: string }).html).toBe("<p>hi</p>");
  });

  it("channel은 항상 email이다", () => {
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com" });
    expect(provider.channel).toBe("email");
  });
});

describe("createResendEmailProvider — 실패 처리", () => {
  it("HTTP 오류 응답이면 원인이 담긴 에러를 던진다", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "Invalid `to` field" }, 422));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    await expect(provider.send(MSG)).rejects.toThrow(/Invalid `to` field/);
  });

  it("성공 응답에 id가 없으면 명확한 에러를 던진다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    await expect(provider.send(MSG)).rejects.toThrow(/id가 없습니다/);
  });

  it("응답이 timeoutMs 안에 오지 않으면 타임아웃으로 처리한다", async () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>(() => {})); // 절대 응답하지 않음
    const provider = createResendEmailProvider({
      apiKey: "k",
      from: "a@b.com",
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(provider.send(MSG)).rejects.toThrow(/타임아웃/);
  });

  describe("환경변수 누락", () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it("apiKey/from이 없으면 원인과 해결법이 담긴 에러를 생성 시점에 던진다", () => {
      delete process.env["RESEND_API_KEY"];
      delete process.env["MAIL_FROM"];
      expect(() => createResendEmailProvider({})).toThrow(/RESEND_API_KEY/);
      expect(() => createResendEmailProvider({ apiKey: "k" })).toThrow(/MAIL_FROM/);
    });
  });
});
