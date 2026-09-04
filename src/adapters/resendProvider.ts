/**
 * Resend REST API 이메일 어댑터.
 * 원본: sheet_mcp `src/adapters/resendProvider.ts` (2026-09-02 기준 이식, CLAUDE.md 스택 명시).
 * 원본과의 차이: sheet_mcp는 시트 행 단위 발송이라 rowKey/channel별 실패를 SendResult에
 * `{ok:false, error}`로 "반환"하지만, retail-mcp는 한 실행당 리포트 메일 한 통만 보내고
 * core/types.ts의 SendResult에는 성공 형태(messageId)만 있다 — 실패는 이 레포의 다른
 * 어댑터와 동일하게 명확한 원인이 담긴 에러를 던진다. 타임아웃 이중 방어(AbortSignal.timeout +
 * withTimeout 레이스)는 원본 그대로 가져왔다 — 실제 요청은 소켓 자체를 취소하고, mock fetch가
 * signal을 무시하는 테스트에서도 timeoutMs 안에 결과가 나오게 한다.
 */
import { z } from "zod";
import type { NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_RESEND_TIMEOUT_MS = 30_000;
/**
 * 2차 적대적 검수 SR2-MAIL-003 — Resend가 같은 `Idempotency-Key`를 중복 발송 없이 dedupe해
 * 주는 보존 기간(resend.com API 문서 "Idempotency keys expire after 24 hours", 2026-09-03 확인).
 * 이 값을 `NotificationProvider.dedupeTtlMs`로 노출해 에이전트가 `unknown`/`sending` 이후 같은
 * run_id 재시도를 이 기간 안에서만 허용한다(`core/sendRetryPolicy.ts` — 안전 여유는 거기서 뺀다).
 */
export const RESEND_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Resend 요청이 ${timeoutMs}ms 내에 응답하지 않았습니다.`);
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
 * 2차 적대적 검수 SR2-MAIL-002 — "요청이 Resend에 닿았을 가능성이 0인" 네트워크 오류 코드.
 * DNS 해석 실패(ENOTFOUND/EAI_AGAIN)와 연결 거부(ECONNREFUSED)는 TCP 연결 자체가 성립하지
 * 않은 것이라 요청 본문이 서버에 도달했을 수 없다 → 확실한 `failed`. 이 목록에 **없는** 모든
 * 응답-이전 오류(ECONNRESET, EPIPE, undici의 UND_ERR_SOCKET "other side closed", 코드 없는
 * 알 수 없는 오류 등)는 연결이 성립된 뒤 응답만 유실됐을 수 있으므로 보수적으로
 * `AmbiguousSendError`로 분류한다. 예전엔 반대로 타임아웃만 ambiguous였고 나머지는 전부
 * `failed`였다 — 그러면 소켓이 끊긴 실제 발송을 "확실히 안 나감"으로 오인해 다음 실행이
 * 새 run_id로 재발송할 수 있다. Node 24 undici로 직접 재현: 닫힌 포트 → `cause.code ===
 * "ECONNREFUSED"`, 없는 호스트 → `"ENOTFOUND"`, 연결 후 응답 없이 끊는 서버 →
 * `"UND_ERR_SOCKET"`. 실제 fetch는 `TypeError("fetch failed")`로 감싸고 `cause`에 원인을
 * 두므로 cause 체인을 따라가며 code를 찾는다.
 */
const DEFINITELY_NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

/** cause 체인(최대 5단계 — 순환 방어)에서 첫 번째 문자열 `code`를 찾는다. */
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
// 에러 응답 형태는 Resend 버전에 따라 달라질 수 있어 message만 느슨하게 시도하고, 없으면 HTTP 상태로 대체한다.
const resendErrorLikeSchema = z.object({ message: z.string() }).partial();

export interface ResendEmailProviderOptions {
  /** 기본값: 환경변수 RESEND_API_KEY */
  apiKey?: string;
  /** 기본값: 환경변수 MAIL_FROM */
  from?: string;
  /** 테스트에서 mock fetch를 주입하기 위한 훅. 기본값: 전역 fetch */
  fetchImpl?: typeof fetch;
  /** 요청 타임아웃(ms). 기본 DEFAULT_RESEND_TIMEOUT_MS(30초). */
  timeoutMs?: number;
}

export function createResendEmailProvider(
  options: ResendEmailProviderOptions = {},
): NotificationProvider {
  const apiKey = options.apiKey ?? process.env["RESEND_API_KEY"];
  if (!apiKey) {
    throw new Error("RESEND_API_KEY가 없습니다. Resend 대시보드에서 발급해 .env에 추가하세요.");
  }
  const from = options.from ?? process.env["MAIL_FROM"];
  if (!from) {
    throw new Error(
      "MAIL_FROM이 없습니다. 발신자로 쓸 이메일 주소를 .env의 MAIL_FROM에 추가하세요.",
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
              // OPS-004(007 검수, TASKS T34) — 같은 키의 요청은 24시간 내 Resend가 중복
              // 발송 없이 dedupe한다(resend.com API 문서 확인, 2026-09-03). 에이전트가
              // runId를 그대로 넘긴다 — 타임아웃 후 사람이 같은 runId로 재시도해도 실제로는
              // 한 통만 나간다. 없으면(예: idempotencyKey를 안 주는 호출자) 헤더 자체를
              // 생략한다 — Resend 쪽에서 매번 새 발송으로 취급된다(기존 동작과 동일).
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
            // 실제 fetch에서는 소켓 자체를 취소한다. withTimeout()의 레이스는 signal을 모르는
            // mock fetch를 쓰는 테스트에서도 timeoutMs 안에 결과가 나오게 하기 위한 것이다.
            signal: AbortSignal.timeout(timeoutMs),
          }),
          timeoutMs,
        );
      } catch (err) {
        // 여기 도달했다는 건 HTTP 응답을 받기 전에 실패했다는 뜻이다. OPS-004(007 검수, TASKS
        // T34) — 호출자(agent/folderScan.ts, agent/reorder.ts)가 `AmbiguousSendError`라는
        // 이름으로 "확실한 실패"(failed)와 "발송됐는지 알 수 없음"(unknown)을 구분해
        // agent_send_log에 남긴다.
        //
        // SR2-MAIL-002(2차 적대적 검수) — 분류 기준을 "타임아웃만 ambiguous"에서 "연결이
        // 성립조차 안 된 게 확실한 경우만 failed, 나머지 응답-이전 오류는 전부 ambiguous"로
        // 뒤집었다(DEFINITELY_NOT_SENT_CODES 주석 참고). 오분류의 비용이 비대칭이기 때문이다:
        // 실제로는 나간 메일을 failed로 기록하면 다음 실행이 새 run_id(=새 Idempotency-Key)로
        // 중복 발송하는 반면, 실제로는 안 나간 메일을 unknown으로 기록하면 사람이 대시보드를
        // 한 번 확인하는 비용만 든다.
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        const code = findErrorCode(err);
        const definitelyNotSent =
          !isTimeout && code !== undefined && DEFINITELY_NOT_SENT_CODES.has(code);
        const detail = err instanceof Error ? err.message : String(err);

        let message: string;
        if (isTimeout) {
          message =
            `Resend 요청이 ${timeoutMs}ms 내에 응답하지 않아 타임아웃 처리했습니다. ` +
            "이미 발송됐을 수 있으니 재시도 전에 Resend 대시보드에서 이 수신자에게 발송됐는지 확인하세요.";
        } else if (definitelyNotSent) {
          message =
            `Resend에 연결할 수 없었습니다(${code}): ${detail}. ` +
            "요청이 서버에 닿지 않았으므로 발송되지 않았습니다 — 네트워크/DNS 상태를 확인한 뒤 다시 시도하세요.";
        } else {
          message =
            `Resend 요청이 응답을 받기 전에 실패했습니다(${code ?? "코드 없음"}): ${detail}. ` +
            "요청이 이미 서버에 도달해 발송됐을 수 있으니 재시도 전에 Resend 대시보드에서 이 수신자에게 발송됐는지 확인하세요.";
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
            : `Resend API 오류 (HTTP ${response.status})`;
        throw new Error(`이메일 발송에 실패했습니다: ${message}`);
      }

      const parsedSuccess = resendSuccessSchema.safeParse(payload);
      if (!parsedSuccess.success) {
        throw new Error("Resend 응답에 id가 없습니다 (예상치 못한 응답 형식).");
      }

      return { messageId: parsedSuccess.data.id };
    },
  };
}
