import { afterEach, describe, expect, it, vi } from "vitest";
import { createResendEmailProvider } from "../src/adapters/resendProvider.js";
import type { OutboundMessage } from "../src/core/types.js";

const MSG: OutboundMessage = {
  to: "owner@example.com",
  subject: "Reorder suggestions",
  text: "Please review this week's suggestion table.",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createResendEmailProvider — request shape", () => {
  it("Authorization header, endpoint and body fields are correct", async () => {
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
      subject: "Reorder suggestions",
      text: "Please review this week's suggestion table.",
    });
  });

  it("includes html in the body when present", async () => {
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

  it("channel is always email", () => {
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com" });
    expect(provider.channel).toBe("email");
  });

  it("passes idempotencyKey as the Idempotency-Key header when present (OPS-004, TASKS T34)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "email_1" }));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    await provider.send({ ...MSG, idempotencyKey: "run-abc-123" });
    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("run-abc-123");
  });

  it("omits the header entirely when idempotencyKey is absent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "email_1" }));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    await provider.send(MSG);
    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });
});

describe("createResendEmailProvider — failure handling", () => {
  it("throws an error with the cause on an HTTP error response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "Invalid `to` field" }, 422));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    await expect(provider.send(MSG)).rejects.toThrow(/Invalid `to` field/);
  });

  it("throws a clear error when the success response has no id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    await expect(provider.send(MSG)).rejects.toThrow(/has no id/);
  });

  it("treats a response that does not arrive within timeoutMs as a timeout", async () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>(() => {})); // never responds
    const provider = createResendEmailProvider({
      apiKey: "k",
      from: "a@b.com",
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(provider.send(MSG)).rejects.toThrow(/timeout/);
  });

  it("the timeout error's name is AmbiguousSendError (OPS-004, TASKS T34 — the signal callers use to distinguish failed/unknown)", async () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>(() => {}));
    const provider = createResendEmailProvider({
      apiKey: "k",
      from: "a@b.com",
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(provider.send(MSG)).rejects.toMatchObject({ name: "AmbiguousSendError" });
  });

  // SR2-MAIL-002 (second adversarial review) — failed/ambiguous classification of pre-response network errors.
  // The fixture below reproduces the exact shape Node 24 undici actually throws
  // (`TypeError("fetch failed")` + `code` on `cause`).
  function undiciFetchFailed(code: string | undefined, causeMessage: string): TypeError {
    const cause = new Error(causeMessage);
    if (code !== undefined) (cause as { code?: string }).code = code;
    return new TypeError("fetch failed", { cause });
  }

  it("connection refused (ECONNREFUSED) is definitely a request that never reached the server, so it is not AmbiguousSendError (failed)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(undiciFetchFailed("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443"));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("AmbiguousSendError");
    expect((err as Error).message).toMatch(/nothing was sent/);
  });

  it("DNS failure (ENOTFOUND) is also a definite failed", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(undiciFetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND api.resend.com"));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).not.toBe("AmbiguousSendError");
  });

  it("a socket dropped after connecting without a response (UND_ERR_SOCKET) means the body may already have arrived, so it is AmbiguousSendError (SR2-MAIL-002 core regression)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(undiciFetchFailed("UND_ERR_SOCKET", "other side closed"));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AmbiguousSendError");
    expect((err as Error).message).toMatch(/may already have reached the server and been sent/);
  });

  it("ECONNRESET is also AmbiguousSendError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(undiciFetchFailed("ECONNRESET", "socket hang up"));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AmbiguousSendError");
  });

  it("an unknown pre-response error without a code is conservatively classified as AmbiguousSendError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(undiciFetchFailed(undefined, "something odd"));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AmbiguousSendError");
    expect((err as Error).message).toMatch(/no code/);
  });

  it("finds the code and classifies even with a deep (2-level) cause chain", async () => {
    const inner = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    const middle = new Error("wrapped", { cause: inner });
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: middle }));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).not.toBe("AmbiguousSendError");
  });

  it("an HTTP error response (request arrived) is not AmbiguousSendError — it is a definite failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "bad" }, 422));
    const provider = createResendEmailProvider({ apiKey: "k", from: "a@b.com", fetchImpl });
    const err = await provider.send(MSG).catch((e: unknown) => e);
    expect((err as Error).name).not.toBe("AmbiguousSendError");
  });

  describe("missing environment variables", () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it("throws an error with the cause and the fix at creation time when apiKey/from are missing", () => {
      delete process.env["RESEND_API_KEY"];
      delete process.env["MAIL_FROM"];
      expect(() => createResendEmailProvider({})).toThrow(/RESEND_API_KEY/);
      expect(() => createResendEmailProvider({ apiKey: "k" })).toThrow(/MAIL_FROM/);
    });
  });
});
