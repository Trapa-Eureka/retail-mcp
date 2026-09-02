import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLoyverseClient,
  createLoyverseClientFromEnv,
} from "../src/adapters/loyverseClient.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("createLoyverseClient — 요청 형태 (LoyverseClient 계약)", () => {
  it("listStores: Authorization 헤더 + 올바른 경로/쿼리로 요청하고 응답을 매핑한다", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ stores: [{ id: "s1", name: "본점" }] }));
    const client = createLoyverseClient({ apiToken: "secret-token", fetchFn });

    const stores = await client.listStores();

    expect(stores).toEqual([{ id: "s1", name: "본점" }]);
    const call = fetchFn.mock.calls[0] as [string, RequestInit];
    const url = new URL(call[0]);
    expect(url.origin + url.pathname).toBe("https://api.loyverse.com/v1.0/stores");
    expect(url.searchParams.get("limit")).toBe("250");
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-token");
  });

  it("listItems: cursor 없으면 쿼리에 안 실리고, 있으면 그대로 실린다", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], cursor: "next-1" }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    const client = createLoyverseClient({ apiToken: "tok", fetchFn });

    const page1 = await client.listItems();
    expect(page1.cursor).toBe("next-1");
    const url1 = new URL((fetchFn.mock.calls[0] as [string])[0]);
    expect(url1.searchParams.has("cursor")).toBe(false);

    await client.listItems("next-1");
    const url2 = new URL((fetchFn.mock.calls[1] as [string])[0]);
    expect(url2.searchParams.get("cursor")).toBe("next-1");
  });

  it("listReceipts: sinceISO를 updated_at_min 쿼리 파라미터로 보낸다", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ receipts: [] }));
    const client = createLoyverseClient({ apiToken: "tok", fetchFn });

    await client.listReceipts("2026-07-28T00:00:00.000Z");

    const url = new URL((fetchFn.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe("/v1.0/receipts");
    expect(url.searchParams.get("updated_at_min")).toBe("2026-07-28T00:00:00.000Z");
  });

  it("listInventory: 응답을 LvInventoryLevel[]로 매핑하고 updated_at을 보존한다", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        inventory_levels: [
          { variant_id: "v1", store_id: "s1", in_stock: 3, updated_at: "2026-09-01T00:00:00Z" },
        ],
      }),
    );
    const client = createLoyverseClient({ apiToken: "tok", fetchFn });

    const page = await client.listInventory();
    expect(page.items).toEqual([
      { variant_id: "v1", store_id: "s1", in_stock: 3, updated_at: "2026-09-01T00:00:00Z" },
    ]);
    expect(page.cursor).toBeNull();
  });
});

describe("createLoyverseClient — 429/5xx 재시도", () => {
  it("429 응답이면 지수 백오프로 재시도한 뒤 성공한다", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ stores: [] }));
    const delays: number[] = [];
    const sleepFn = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };

    const client = createLoyverseClient({ apiToken: "tok", fetchFn, sleepFn, maxRetries: 5 });
    await client.listStores();

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]);
  });

  it("429 응답의 Retry-After 헤더를 지수 백오프보다 우선한다", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "3" } }))
      .mockResolvedValueOnce(jsonResponse({ stores: [] }));
    const delays: number[] = [];
    const sleepFn = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };

    const client = createLoyverseClient({ apiToken: "tok", fetchFn, sleepFn });
    await client.listStores();

    expect(delays).toEqual([3000]);
  });

  it("5xx 응답도 재시도 대상이다", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ stores: [] }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const client = createLoyverseClient({ apiToken: "tok", fetchFn, sleepFn });
    await client.listStores();

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("재시도 상한을 넘으면 명확한 에러로 중단한다 (무한 재시도 없음)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const client = createLoyverseClient({ apiToken: "tok", fetchFn, sleepFn, maxRetries: 2 });
    await expect(client.listStores()).rejects.toThrow(/재시도/);
    expect(fetchFn).toHaveBeenCalledTimes(3); // 최초 1회 + 재시도 2회
  });

  it("400/404 등 비일시적 오류는 재시도하지 않는다", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const client = createLoyverseClient({ apiToken: "tok", fetchFn, sleepFn });
    await expect(client.listStores()).rejects.toThrow(/404/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("[fake timer] 기본 sleepFn(setTimeout 기반)으로도 백오프가 실제로 대기 후 재시도한다", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(jsonResponse({ stores: [] }));
      // sleepFn을 주입하지 않는다 — 실제 프로덕션 경로(setTimeout 기반 defaultSleep)를 검증한다.
      const client = createLoyverseClient({ apiToken: "tok", fetchFn });

      const promise = client.listStores();
      await vi.advanceTimersByTimeAsync(500);
      const stores = await promise;

      expect(stores).toEqual([]);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createLoyverseClient — 시크릿 없는 에러 메시지", () => {
  it("401 응답 시 토큰이나 원문 응답 본문 없이 문서화된 에러 코드만 포함한다", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { errors: [{ code: "UNAUTHORIZED", details: "internal detail that must not leak" }] },
          401,
        ),
      );
    const client = createLoyverseClient({ apiToken: "super-secret-token-value", fetchFn });

    await expect(client.listStores()).rejects.toThrow(/UNAUTHORIZED/);
    try {
      await client.listStores();
      throw new Error("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("super-secret-token-value");
      expect(message).not.toContain("internal detail that must not leak");
    }
  });
});

describe("createLoyverseClientFromEnv", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("LOYVERSE_API_TOKEN이 없으면 원인과 해결법이 담긴 에러를 던진다", () => {
    delete process.env["LOYVERSE_API_TOKEN"];
    expect(() => createLoyverseClientFromEnv()).toThrow(/LOYVERSE_API_TOKEN/);
  });

  it("LOYVERSE_REQUEST_TIMEOUT_MS가 유효하지 않으면 명확한 에러를 던진다", () => {
    process.env["LOYVERSE_API_TOKEN"] = "tok";
    process.env["LOYVERSE_REQUEST_TIMEOUT_MS"] = "not-a-number";
    expect(() => createLoyverseClientFromEnv()).toThrow(/LOYVERSE_REQUEST_TIMEOUT_MS/);
  });

  it("유효한 값이면 클라이언트를 만든다", () => {
    process.env["LOYVERSE_API_TOKEN"] = "tok";
    process.env["LOYVERSE_REQUEST_TIMEOUT_MS"] = "5000";
    process.env["LOYVERSE_MAX_RETRIES"] = "3";
    expect(() => createLoyverseClientFromEnv()).not.toThrow();
  });
});
