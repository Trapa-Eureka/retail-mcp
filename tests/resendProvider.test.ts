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

  it("idempotencyKey가 있으면 Idempotency-Key 헤더로 전달한다(OPS-004, TASKS T34)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "email_1" }));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    await provider.send({ ...MSG, idempotencyKey: "run-abc-123" });
    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("run-abc-123");
  });

  it("idempotencyKey가 없으면 헤더 자체를 생략한다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "email_1" }));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    await provider.send(MSG);
    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
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

  it("타임아웃 에러의 name은 AmbiguousSendError다(OPS-004, TASKS T34 — 호출자가 failed/unknown을 구분하는 신호)", async () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>(() => {}));
    const provider = createResendEmailProvider({
      apiKey: "k",
      from: "a@b.com",
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(provider.send(MSG)).rejects.toMatchObject({ name: "AmbiguousSendError" });
  });

  // SR2-MAIL-002(2차 적대적 검수) — 응답-이전 네트워크 오류의 failed/ambiguous 분류.
  // 아래 픽스처는 Node 24 undici가 실제로 던지는 형태(`TypeError("fetch failed")` + `cause`에
  // `code`)를 직접 재현해 그대로 옮긴 것이다.
  function undiciFetchFailed(code: string | undefined, causeMessage: string): TypeError {
    const cause = new Error(causeMessage);
    if (code !== undefined) (cause as { code?: string }).code = code;
    return new TypeError("fetch failed", { cause });
  }

  it("연결 거부(ECONNREFUSED)는 요청이 서버에 닿지 않은 게 확실하므로 AmbiguousSendError가 아니다(failed)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(undiciFetchFailed("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443"));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("AmbiguousSendError");
    expect((err as Error).message).toMatch(/발송되지 않았습니다/);
  });

  it("DNS 실패(ENOTFOUND)도 확실한 failed다", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(undiciFetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND api.resend.com"));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).not.toBe("AmbiguousSendError");
  });

  it("연결 후 응답 없이 소켓이 끊기면(UND_ERR_SOCKET) 본문이 이미 도달했을 수 있으므로 AmbiguousSendError다(SR2-MAIL-002 핵심 회귀)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(undiciFetchFailed("UND_ERR_SOCKET", "other side closed"));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AmbiguousSendError");
    expect((err as Error).message).toMatch(/발송됐을 수 있으니/);
  });

  it("ECONNRESET도 AmbiguousSendError다", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(undiciFetchFailed("ECONNRESET", "socket hang up"));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AmbiguousSendError");
  });

  it("코드가 없는 알 수 없는 응답-이전 오류는 보수적으로 AmbiguousSendError로 분류한다", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(undiciFetchFailed(undefined, "something odd"));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AmbiguousSendError");
    expect((err as Error).message).toMatch(/코드 없음/);
  });

  it("cause 체인이 깊어도(2단계) code를 찾아 분류한다", async () => {
    const inner = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    const middle = new Error("wrapped", { cause: inner });
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: middle }));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).not.toBe("AmbiguousSendError");
  });

  it("HTTP 오류 응답(요청은 도달)은 AmbiguousSendError가 아니다 — 확실한 실패다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "bad" }, 422));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).not.toBe("AmbiguousSendError");
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
