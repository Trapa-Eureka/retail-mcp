/**
 * Resend REST API email adapter.
 * Origin: sheet_mcp `src/adapters/resendProvider.ts` (ported as of 2026-09-02, listed in the CLAUDE.md stack).
 * Difference from the origin: sheet_mcp sends per sheet row, so it "returns" per-rowKey/channel
 * failures as `{ok:false, error}` in SendResult, whereas retail-mcp sends a single report email per
 * run and core/types.ts's SendResult only has the success shape (messageId) — failures throw an error
 * with a clear cause, like the other adapters in this repo. The double timeout defense
 * (AbortSignal.timeout + withTimeout race) is carried over as-is — a real request cancels the socket
 * itself, and a mock fetch that ignores the signal still produces a result within timeoutMs in tests.
 */
import { z } from "zod";
import type { NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_RESEND_TIMEOUT_MS = 30_000;
/**
 * Second adversarial review SR2-MAIL-003 — the retention period during which Resend dedupes the
 * same `Idempotency-Key` without sending twice (resend.com API docs "Idempotency keys expire after
 * 24 hours", verified 2026-09-03). Exposed as `NotificationProvider.dedupeTtlMs` so the agent allows
 * a retry of the same run_id after `unknown`/`sending` only within this period
 * (`core/sendRetryPolicy.ts` — the safety margin is subtracted there).
 */
export const RESEND_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Resend request did not respond within ${timeoutMs}ms.`);
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Second adversarial review SR2-MAIL-002 — network error codes for which "the request had zero
 * chance of reaching Resend". DNS resolution failure (ENOTFOUND/EAI_AGAIN) and connection refused
 * (ECONNREFUSED) mean the TCP connection itself was never established, so the request body cannot
 * have reached the server → definitely `failed`. Every pre-response error **not** in this list
 * (ECONNRESET, EPIPE, undici's UND_ERR_SOCKET "other side closed", unknown errors without a code,
 * etc.) may have lost only the response after the connection was established, so it is
 * conservatively classified as `AmbiguousSendError`. Previously it was the other way round: only
 * timeouts were ambiguous and everything else was `failed` — which could mistake a real send
 * whose socket dropped for "definitely not sent", causing the next run to resend under a new run_id.
 * Reproduced directly with Node 24 undici: closed port → `cause.code === "ECONNREFUSED"`,
 * non-existent host → `"ENOTFOUND"`, server that connects then drops without responding →
 * `"UND_ERR_SOCKET"`. Real fetch wraps these in `TypeError("fetch failed")` with the cause in
 * `cause`, so we walk the cause chain to find the code.
 */
const DEFINITELY_NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

/** Finds the first string `code` in the cause chain (at most 5 levels — cycle protection). */
function findErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

const resendSuccessSchema = z.object({ id: z.string() });
// The error response shape may vary by Resend version, so only message is tried loosely; falls back to the HTTP status when absent.
const resendErrorLikeSchema = z.object({ message: z.string() }).partial();

export interface ResendEmailProviderOptions {
  /** Default: environment variable RESEND_API_KEY */
  apiKey?: string;
  /** Default: environment variable MAIL_FROM */
  from?: string;
  /** Hook to inject a mock fetch in tests. Default: the global fetch */
  fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default DEFAULT_RESEND_TIMEOUT_MS (30 seconds). */
  timeoutMs?: number;
}

export function createResendEmailProvider(
  options: ResendEmailProviderOptions = {},
): NotificationProvider {
  const apiKey = options.apiKey ?? process.env["RESEND_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set. Create one in the Resend dashboard and add it to .env.",
    );
  }
  const from = options.from ?? process.env["MAIL_FROM"];
  if (!from) {
    throw new Error(
      "MAIL_FROM is not set. Add the email address to use as the sender to MAIL_FROM in .env.",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESEND_TIMEOUT_MS;

  return {
    channel: "email",
    dedupeTtlMs: RESEND_IDEMPOTENCY_TTL_MS,

    async send(msg: OutboundMessage): Promise<SendResult> {
      let response: Response;
      try {
        response = await withTimeout(
          fetchImpl(RESEND_ENDPOINT, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              // OPS-004 (review 007, TASKS T34) — requests with the same key are deduped by Resend
              // within 24 hours without a duplicate send (verified in the resend.com API docs,
              // 2026-09-03). The agent passes the runId through as-is — even if a human retries
              // with the same runId after a timeout, only one email actually goes out. When absent
              // (e.g. a caller that does not supply idempotencyKey) the header itself is omitted —
              // Resend treats each request as a new send (same as the previous behavior).
              ...(msg.idempotencyKey !== undefined
                ? { "Idempotency-Key": msg.idempotencyKey }
                : {}),
            },
            body: JSON.stringify({
              from,
              to: [msg.to],
              subject: msg.subject,
              text: msg.text,
              ...(msg.html !== undefined ? { html: msg.html } : {}),
            }),
            // With real fetch this cancels the socket itself. The withTimeout() race exists so that
            // tests using a mock fetch unaware of the signal still get a result within timeoutMs.
            signal: AbortSignal.timeout(timeoutMs),
          }),
          timeoutMs,
        );
      } catch (err) {
        // Reaching here means the failure happened before an HTTP response was received. OPS-004
        // (review 007, TASKS T34) — the callers (agent/folderScan.ts, agent/reorder.ts) use the
        // name `AmbiguousSendError` to distinguish a "definite failure" (failed) from "unknown
        // whether it was sent" (unknown) in agent_send_log.
        //
        // SR2-MAIL-002 (second adversarial review) — the classification was flipped from "only
        // timeouts are ambiguous" to "only cases where the connection was definitely never
        // established are failed; every other pre-response error is ambiguous" (see the
        // DEFINITELY_NOT_SENT_CODES comment). The cost of misclassification is asymmetric:
        // recording an email that actually went out as failed makes the next run send a duplicate
        // under a new run_id (= new Idempotency-Key), whereas recording an email that actually did
        // not go out as unknown only costs a human one look at the dashboard.
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        const code = findErrorCode(err);
        const definitelyNotSent =
          !isTimeout && code !== undefined && DEFINITELY_NOT_SENT_CODES.has(code);
        const detail = err instanceof Error ? err.message : String(err);

        let message: string;
        if (isTimeout) {
          message =
            `Resend request did not respond within ${timeoutMs}ms and was treated as a timeout. ` +
            "It may already have been sent, so check in the Resend dashboard whether this recipient received it before retrying.";
        } else if (definitelyNotSent) {
          message =
            `Could not connect to Resend (${code}): ${detail}. ` +
            "The request never reached the server, so nothing was sent — check the network/DNS status and try again.";
        } else {
          message =
            `Resend request failed before a response was received (${code ?? "no code"}): ${detail}. ` +
            "The request may already have reached the server and been sent, so check in the Resend dashboard whether this recipient received it before retrying.";
        }

        const wrapped = new Error(message, { cause: err });
        if (!definitelyNotSent) {
          wrapped.name = "AmbiguousSendError";
        }
        throw wrapped;
      }

      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const parsedError = resendErrorLikeSchema.safeParse(payload);
        const message =
          parsedError.success && parsedError.data.message
            ? parsedError.data.message
            : `Resend API error (HTTP ${response.status})`;
        throw new Error(`Failed to send email: ${message}`);
      }

      const parsedSuccess = resendSuccessSchema.safeParse(payload);
      if (!parsedSuccess.success) {
        throw new Error("Resend response has no id (unexpected response format).");
      }

      return { messageId: parsedSuccess.data.id };
    },
  };
}
