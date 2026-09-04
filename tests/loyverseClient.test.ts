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

describe("createLoyverseClient — request shape (LoyverseClient contract)", () => {
  it("listStores: requests with the Authorization header + correct path/query and maps the response", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ stores: [{ id: "s1", name: "Main Store" }] }));
    const client = createLoyverseClient({ apiToken: "secret-token", fetchFn });

    const stores = await client.listStores();

    expect(stores).toEqual([{ id: "s1", name: "Main Store" }]);
    const call = fetchFn.mock.calls[0] as [string, RequestInit];
    const url = new URL(call[0]);
    expect(url.origin + url.pathname).toBe("https://api.loyverse.com/v1.0/stores");
    expect(url.searchParams.get("limit")).toBe("250");
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-token");
  });

  it("listItems: cursor is omitted from the query when absent and passed through as-is when present", async () => {
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

  it("listReceipts: sends sinceISO as the updated_at_min query parameter", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ receipts: [] }));
    const client = createLoyverseClient({ apiToken: "tok", fetchFn });

    await client.listReceipts("2026-07-28T00:00:00.000Z");

    const url = new URL((fetchFn.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe("/v1.0/receipts");
    expect(url.searchParams.get("updated_at_min")).toBe("2026-07-28T00:00:00.000Z");
  });

  it("listInventory: maps the response to LvInventoryLevel[] and preserves updated_at", async () => {
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

describe("createLoyverseClient — 429/5xx retries", () => {
  it("retries with exponential backoff on 429 and then succeeds", async () => {
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

  it("prefers the Retry-After header of a 429 response over exponential backoff", async () => {
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

  it("5xx responses are retried too", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ stores: [] }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const client = createLoyverseClient({ apiToken: "tok", fetchFn, sleepFn });
    await client.listStores();

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("stops with a clear error once the retry cap is exceeded (no infinite retries)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const client = createLoyverseClient({ apiToken: "tok", fetchFn, sleepFn, maxRetries: 2 });
    await expect(client.listStores()).rejects.toThrow(/retries/);
    expect(fetchFn).toHaveBeenCalledTimes(3); // initial call + 2 retries
  });

  it("non-transient errors such as 400/404 are not retried", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const client = createLoyverseClient({ apiToken: "tok", fetchFn, sleepFn });
    await expect(client.listStores()).rejects.toThrow(/404/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("[fake timer] the default sleepFn (setTimeout based) also actually waits before retrying", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(jsonResponse({ stores: [] }));
      // sleepFn is not injected — this verifies the real production path (setTimeout-based defaultSleep).
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

describe("createLoyverseClient — rate limiting (official Loyverse limit: 300 req/300 s, DESIGN §10)", () => {
  it("requests beyond rateLimitMaxRequests wait via sleepFn before fetchFn is called", async () => {
    const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ stores: [] })));
    let now = 0;
    const sleepFn = vi.fn().mockImplementation((ms: number) => {
      now += ms;
      return Promise.resolve();
    });

    const client = createLoyverseClient({
      apiToken: "tok",
      fetchFn,
      sleepFn,
      nowFn: () => now,
      rateLimitMaxRequests: 2,
      rateLimitWindowMs: 1000,
    });

    await client.listStores(); // 1st
    await client.listStores(); // 2nd — limit reached, no wait yet
    expect(sleepFn).not.toHaveBeenCalled();

    await client.listStores(); // 3rd — over the limit, must wait
    expect(sleepFn).toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("the default rate limit (250/300 s) causes no waiting at typical test call volumes", async () => {
    const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ stores: [] })));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const client = createLoyverseClient({ apiToken: "tok", fetchFn, sleepFn });

    for (let i = 0; i < 5; i++) await client.listStores();

    expect(sleepFn).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });
});

describe("createLoyverseClient — secret-free error messages", () => {
  it("on a 401 response includes only the documented error code, without the token or raw response body", async () => {
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

  it("throws an error with the cause and the fix when LOYVERSE_API_TOKEN is missing", () => {
    delete process.env["LOYVERSE_API_TOKEN"];
    expect(() => createLoyverseClientFromEnv()).toThrow(/LOYVERSE_API_TOKEN/);
  });

  it("throws a clear error when LOYVERSE_REQUEST_TIMEOUT_MS is invalid", () => {
    process.env["LOYVERSE_API_TOKEN"] = "tok";
    process.env["LOYVERSE_REQUEST_TIMEOUT_MS"] = "not-a-number";
    expect(() => createLoyverseClientFromEnv()).toThrow(/LOYVERSE_REQUEST_TIMEOUT_MS/);
  });

  it("creates the client when the values are valid", () => {
    process.env["LOYVERSE_API_TOKEN"] = "tok";
    process.env["LOYVERSE_REQUEST_TIMEOUT_MS"] = "5000";
    process.env["LOYVERSE_MAX_RETRIES"] = "3";
    process.env["LOYVERSE_RATE_LIMIT_MAX_REQUESTS"] = "200";
    process.env["LOYVERSE_RATE_LIMIT_WINDOW_MS"] = "300000";
    expect(() => createLoyverseClientFromEnv()).not.toThrow();
  });

  it("throws a clear error when LOYVERSE_RATE_LIMIT_MAX_REQUESTS is invalid", () => {
    process.env["LOYVERSE_API_TOKEN"] = "tok";
    process.env["LOYVERSE_RATE_LIMIT_MAX_REQUESTS"] = "0";
    expect(() => createLoyverseClientFromEnv()).toThrow(/LOYVERSE_RATE_LIMIT_MAX_REQUESTS/);
  });
});
