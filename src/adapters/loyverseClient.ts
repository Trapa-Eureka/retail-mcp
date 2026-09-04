/**
 * fetch-based real Loyverse adapter. Handles the token header, cursor pagination, 429/5xx
 * exponential backoff honoring `Retry-After`, request timeouts, and bounded retries.
 * Responses are parsed with the zod schemas in loyverseSchemas.ts and then narrowed to the
 * internal Lv* types via the shared mappers.
 * Error messages never include the token or the raw response body (SPEC §10, CLAUDE.md guardrail 6).
 */
import type { LoyverseClient } from "../core/types.js";
import { createSlidingWindowRateLimiter, type RateLimiter } from "./rateLimiter.js";
import {
  LvInventoryResponseSchema,
  LvItemsResponseSchema,
  LvReceiptsResponseSchema,
  LvStoresResponseSchema,
  toLvInventoryLevel,
  toLvItem,
  toLvReceipt,
  toLvStore,
} from "./loyverseSchemas.js";

const DEFAULT_BASE_URL = "https://api.loyverse.com/v1.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 5;
/** Maximum allowed page size of the Loyverse API (official docs: limit default 50, max 250). */
const DEFAULT_PAGE_LIMIT = 250;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
/**
 * The per-account limit in the official Loyverse docs (developer.loyverse.com/docs "API rate
 * limits", verified 2026-09-03) is "300 requests per 300 sec". It is an account-level limit
 * regardless of free/paid plan, so to leave room for other callers using the same account at
 * the same time (Postman, other scripts, etc.) the default is set below that limit
 * (250/300 s) — adjustable via env.
 */
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 250;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 300_000;

export interface LoyverseClientOptions {
  apiToken: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  pageLimit?: number;
  /** Maximum requests within the sliding window. Default DEFAULT_RATE_LIMIT_MAX_REQUESTS (250). */
  rateLimitMaxRequests?: number;
  /** Sliding window length (ms). Default DEFAULT_RATE_LIMIT_WINDOW_MS (300_000 = 5 minutes). */
  rateLimitWindowMs?: number;
  /** Test injection hook. Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Test injection hook (simulates backoff/rate-limit delays). Defaults to a real setTimeout-based wait. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Test injection hook (rate limiter clock). Defaults to Date.now. */
  nowFn?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Safely extracts only the documented Loyverse error code (a fixed enum). Never exposes raw details/body. */
async function extractErrorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "errors" in body) {
      const errors = body.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first: unknown = errors[0];
        if (typeof first === "object" && first !== null && "code" in first) {
          const code = first.code;
          if (typeof code === "string") return code;
        }
      }
    }
  } catch {
    // Body is not JSON or failed to parse — the raw body is never included in the error.
  }
  return null;
}

function errorHint(status: number): string {
  if (status === 401)
    return "Check that LOYVERSE_API_TOKEN is valid in Loyverse Back Office > Access tokens.";
  if (status === 403) return "Check that this token has the required permission (scope).";
  if (status === 404) return "Check that the requested resource (path/id) exists.";
  if (status === 429) return "Reduce the request rate or try again later.";
  if (status >= 500) return "Loyverse server error. Try again in a moment.";
  return "Check the request parameters.";
}

interface RetryConfig {
  fetchFn: typeof fetch;
  sleepFn: (ms: number) => Promise<void>;
  requestTimeoutMs: number;
  maxRetries: number;
  rateLimiter: RateLimiter;
}

async function fetchWithRetry(url: string, init: RequestInit, cfg: RetryConfig): Promise<Response> {
  let attempt = 0;
  for (;;) {
    // Every actual HTTP attempt (the initial call plus each retry) counts toward the Loyverse
    // request quota, so acquire a slot before each attempt — we slow down ourselves before
    // Loyverse rejects us with 429.
    await cfg.rateLimiter.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    try {
      let res: Response;
      try {
        res = await cfg.fetchFn(url, { ...init, signal: controller.signal });
      } catch {
        if (attempt >= cfg.maxRetries) {
          throw new Error(
            `Loyverse API request still failed with a network error/timeout after ${cfg.maxRetries} retries. ` +
              "Check the network connection and the LOYVERSE_REQUEST_TIMEOUT_MS setting.",
          );
        }
        attempt++;
        await cfg.sleepFn(backoffDelayMs(attempt));
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= cfg.maxRetries) {
          throw new Error(
            `Loyverse API still returned HTTP ${res.status} after ${cfg.maxRetries} retries. ` +
              errorHint(res.status),
          );
        }
        const retryAfterSec = Number(res.headers.get("retry-after"));
        const delayMs =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1000
            : backoffDelayMs(attempt + 1);
        attempt++;
        await cfg.sleepFn(delayMs);
        continue;
      }

      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createLoyverseClient(opts: LoyverseClientOptions): LoyverseClient {
  if (!opts.apiToken) {
    throw new Error(
      "LOYVERSE_API_TOKEN is not set. Create one in Loyverse Back Office > Access tokens and add it to .env.",
    );
  }
  const apiToken = opts.apiToken;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const pageLimit = opts.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const rateLimiter = createSlidingWindowRateLimiter(
    opts.rateLimitMaxRequests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS,
    opts.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    { sleepFn, ...(opts.nowFn !== undefined ? { nowFn: opts.nowFn } : {}) },
  );
  const retryConfig: RetryConfig = {
    fetchFn: opts.fetchFn ?? fetch,
    sleepFn,
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    rateLimiter,
  };

  async function requestJson(
    path: string,
    params: Record<string, string | undefined>,
  ): Promise<unknown> {
    const url = buildUrl(baseUrl, path, params);
    const res = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" } },
      retryConfig,
    );

    if (!res.ok) {
      const code = await extractErrorCode(res);
      throw new Error(
        `Loyverse API request failed (HTTP ${res.status}${code ? `, ${code}` : ""}). ${errorHint(res.status)}`,
      );
    }
    return res.json();
  }

  return {
    async listStores() {
      const raw = LvStoresResponseSchema.parse(
        await requestJson("stores", { limit: String(pageLimit) }),
      );
      return raw.stores.map(toLvStore);
    },

    async listItems(cursor?: string) {
      const raw = LvItemsResponseSchema.parse(
        await requestJson("items", { limit: String(pageLimit), cursor }),
      );
      return { items: raw.items.map(toLvItem), cursor: raw.cursor ?? null };
    },

    async listReceipts(sinceISO: string, cursor?: string) {
      // sinceISO maps to the real API's updated_at_min parameter (see the core/types.ts docs).
      const raw = LvReceiptsResponseSchema.parse(
        await requestJson("receipts", {
          limit: String(pageLimit),
          updated_at_min: sinceISO,
          cursor,
        }),
      );
      return { items: raw.receipts.map(toLvReceipt), cursor: raw.cursor ?? null };
    },

    async listInventory(cursor?: string) {
      const raw = LvInventoryResponseSchema.parse(
        await requestJson("inventory", { limit: String(pageLimit), cursor }),
      );
      return { items: raw.inventory_levels.map(toLvInventoryLevel), cursor: raw.cursor ?? null };
    },
  };
}

function parseOptionalPositiveInt(
  envVarName: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${envVarName} has an invalid value: "${value}". Set an integer of 1 or more, or remove it from .env.`,
    );
  }
  return n;
}

/** Builds the real adapter from environment variables (.env) — used by the server.ts/agent/reorder.ts assembly layer. */
export function createLoyverseClientFromEnv(): LoyverseClient {
  const apiToken = process.env["LOYVERSE_API_TOKEN"];
  if (!apiToken) {
    throw new Error(
      "LOYVERSE_API_TOKEN is not set. Create one in Loyverse Back Office > Access tokens and add it to .env.",
    );
  }
  const requestTimeoutMs = parseOptionalPositiveInt(
    "LOYVERSE_REQUEST_TIMEOUT_MS",
    process.env["LOYVERSE_REQUEST_TIMEOUT_MS"],
  );
  const maxRetries = parseOptionalPositiveInt(
    "LOYVERSE_MAX_RETRIES",
    process.env["LOYVERSE_MAX_RETRIES"],
  );
  const rateLimitMaxRequests = parseOptionalPositiveInt(
    "LOYVERSE_RATE_LIMIT_MAX_REQUESTS",
    process.env["LOYVERSE_RATE_LIMIT_MAX_REQUESTS"],
  );
  const rateLimitWindowMs = parseOptionalPositiveInt(
    "LOYVERSE_RATE_LIMIT_WINDOW_MS",
    process.env["LOYVERSE_RATE_LIMIT_WINDOW_MS"],
  );
  return createLoyverseClient({
    apiToken,
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(rateLimitMaxRequests !== undefined ? { rateLimitMaxRequests } : {}),
    ...(rateLimitWindowMs !== undefined ? { rateLimitWindowMs } : {}),
  });
}
