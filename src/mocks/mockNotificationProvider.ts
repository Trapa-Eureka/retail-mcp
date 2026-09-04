/**
 * NotificationProvider 목 구현 — 발송 기록 + failFor 강제 실패 (TESTING.md §2).
 * 원본: sheet_mcp `src/mocks/mockNotificationProvider.ts` (2026-09-02 기준 이식).
 * 원본과의 차이: sheet_mcp는 시트 행(rowKey) 단위로 failFor를 매칭하지만, retail-mcp에는
 * rowKey 개념이 없으므로(실행당 리포트 메일 한 통) 수신자 주소(msg.to)로 매칭한다. 또한
 * core/types.ts의 send()는 실패를 {ok:false}로 반환하지 않고 던지므로 그에 맞춘다.
 */
import type { NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

/** 기본값은 실 Resend와 같은 24시간 — 에이전트 테스트가 실제 운영 설정과 같은 조건으로 돈다. */
export const MOCK_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

export interface MockNotificationProviderOptions {
  /** 이 수신자로 보내려 하면 send()가 강제로 reject된다(sheet_mcp의 failFor와 동일 패턴). */
  failFor?: string[];
  /**
   * SR2-MAIL-003 — `NotificationProvider.dedupeTtlMs`로 노출할 값. 기본 MOCK_DEDUPE_TTL_MS(24시간).
   * `null`이면 필드 자체를 생략해 "idempotency dedupe를 지원하지 않는 provider"를 흉내낸다.
   */
  dedupeTtlMs?: number | null;
}

export interface MockNotificationProvider extends NotificationProvider {
  /** 성공으로 처리된 메시지만 호출 순서대로 기록된다. */
  readonly sent: readonly OutboundMessage[];
}

export function createMockNotificationProvider(
  options: MockNotificationProviderOptions = {},
): MockNotificationProvider {
  const failFor = new Set(options.failFor ?? []);
  const sent: OutboundMessage[] = [];
  let counter = 0;
  const dedupeTtlMs = options.dedupeTtlMs === undefined ? MOCK_DEDUPE_TTL_MS : options.dedupeTtlMs;

  return {
    channel: "email",
    // exactOptionalPropertyTypes: null(미지원)이면 `dedupeTtlMs: undefined`를 넣지 않고 필드를 뺀다.
    ...(dedupeTtlMs !== null ? { dedupeTtlMs } : {}),
    sent,
    send(msg: OutboundMessage): Promise<SendResult> {
      if (failFor.has(msg.to)) {
        return Promise.reject(
          new Error(
            `MockNotificationProvider: ${msg.to}로의 발송이 failFor에 의해 강제 실패했습니다.`,
          ),
        );
      }
      sent.push(msg);
      counter += 1;
      return Promise.resolve({ messageId: `mock-${counter}` });
    },
  };
}
