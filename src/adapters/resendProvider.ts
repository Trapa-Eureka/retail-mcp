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

    async send(msg: OutboundMessage): Promise<SendResult> {
      let response: Response;
      try {
        response = await withTimeout(
          fetchImpl(RESEND_ENDPOINT, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
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
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        throw new Error(
          isTimeout
            ? `Resend 요청이 ${timeoutMs}ms 내에 응답하지 않아 타임아웃 처리했습니다. ` +
                "이미 발송됐을 수 있으니 재시도 전에 Resend 대시보드에서 이 수신자에게 발송됐는지 확인하세요."
            : `Resend 요청 자체가 실패했습니다: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
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
