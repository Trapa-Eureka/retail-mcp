/**
 * fetch 기반 Loyverse 실어댑터. 토큰 헤더, 커서 페이지네이션, 429/5xx 지수 백오프 +
 * `Retry-After` 존중, 요청 타임아웃, 상한 있는 재시도를 담당한다.
 * 응답은 loyverseSchemas.ts의 zod 스키마로 파싱한 뒤 공유 매퍼로 내부 Lv* 타입으로 좁힌다.
 * 에러 메시지에는 토큰이나 원문 응답 본문을 포함하지 않는다(SPEC §10, CLAUDE.md 가드레일 6).
 */
import type { LoyverseClient } from "../core/types.js";
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
/** Loyverse API의 페이지당 최대 허용치(공식 문서: limit 기본 50, 최대 250). */
const DEFAULT_PAGE_LIMIT = 250;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

export interface LoyverseClientOptions {
  apiToken: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  pageLimit?: number;
  /** 테스트 주입용. 기본값은 전역 fetch. */
  fetchFn?: typeof fetch;
  /** 테스트 주입용(백오프 지연 시뮬레이션). 기본값은 실제 setTimeout 기반 대기. */
  sleepFn?: (ms: number) => Promise<void>;
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

/** 문서화된 Loyverse 에러 코드(고정 enum)만 안전하게 추출한다. 원문 details/본문은 절대 노출하지 않는다. */
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
    // 본문이 JSON이 아니거나 파싱 실패 — 원문은 에러에 포함하지 않는다.
  }
  return null;
}

function errorHint(status: number): string {
  if (status === 401)
    return "LOYVERSE_API_TOKEN이 유효한지 Loyverse 백오피스 > 액세스 토큰에서 확인하세요.";
  if (status === 403) return "이 토큰에 필요한 권한(scope)이 있는지 확인하세요.";
  if (status === 404) return "요청한 리소스(경로·id)가 존재하는지 확인하세요.";
  if (status === 429) return "요청 빈도를 낮추거나 나중에 다시 시도하세요.";
  if (status >= 500) return "Loyverse 서버 오류입니다. 잠시 후 다시 시도하세요.";
  return "요청 파라미터를 확인하세요.";
}

interface RetryConfig {
  fetchFn: typeof fetch;
  sleepFn: (ms: number) => Promise<void>;
  requestTimeoutMs: number;
  maxRetries: number;
}

async function fetchWithRetry(url: string, init: RequestInit, cfg: RetryConfig): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    try {
      let res: Response;
      try {
        res = await cfg.fetchFn(url, { ...init, signal: controller.signal });
      } catch {
        if (attempt >= cfg.maxRetries) {
          throw new Error(
            `Loyverse API 요청이 네트워크 오류/타임아웃으로 ${cfg.maxRetries}회 재시도 후에도 실패했습니다. ` +
              "네트워크 연결과 LOYVERSE_REQUEST_TIMEOUT_MS 설정을 확인하세요.",
          );
        }
        attempt++;
        await cfg.sleepFn(backoffDelayMs(attempt));
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= cfg.maxRetries) {
          throw new Error(
            `Loyverse API가 HTTP ${res.status}을(를) ${cfg.maxRetries}회 재시도 후에도 반환했습니다. ` +
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
      "LOYVERSE_API_TOKEN이 없습니다. Loyverse 백오피스 > 액세스 토큰에서 발급해 .env에 추가하세요.",
    );
  }
  const apiToken = opts.apiToken;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const pageLimit = opts.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const retryConfig: RetryConfig = {
    fetchFn: opts.fetchFn ?? fetch,
    sleepFn: opts.sleepFn ?? defaultSleep,
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
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
        `Loyverse API 요청이 실패했습니다 (HTTP ${res.status}${code ? `, ${code}` : ""}). ${errorHint(res.status)}`,
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
      // sinceISO는 실제 API의 updated_at_min 파라미터에 대응한다(core/types.ts 문서 참고).
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
      `${envVarName} 값이 올바르지 않습니다: "${value}". 1 이상의 정수를 지정하거나 .env에서 지우세요.`,
    );
  }
  return n;
}

/** 환경변수(.env)에서 설정을 읽어 실어댑터를 만든다 — server.ts/agent/reorder.ts 조립 계층에서 쓴다. */
export function createLoyverseClientFromEnv(): LoyverseClient {
  const apiToken = process.env["LOYVERSE_API_TOKEN"];
  if (!apiToken) {
    throw new Error(
      "LOYVERSE_API_TOKEN이 없습니다. Loyverse 백오피스 > 액세스 토큰에서 발급해 .env에 추가하세요.",
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
  return createLoyverseClient({
    apiToken,
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  });
}
