/**
 * NotificationProvider 목 구현 — 발송 기록 + failFor 강제 실패 (TESTING.md §2).
 * 원본: sheet_mcp `src/mocks/mockNotificationProvider.ts` (2026-09-02 기준 이식).
 * 원본과의 차이: sheet_mcp는 시트 행(rowKey) 단위로 failFor를 매칭하지만, retail-mcp에는
 * rowKey 개념이 없으므로(실행당 리포트 메일 한 통) 수신자 주소(msg.to)로 매칭한다. 또한
 * core/types.ts의 send()는 실패를 {ok:false}로 반환하지 않고 던지므로 그에 맞춘다.
 */
import type { NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

export interface MockNotificationProviderOptions {
  /** 이 수신자로 보내려 하면 send()가 강제로 reject된다(sheet_mcp의 failFor와 동일 패턴). */
  failFor?: string[];
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

  return {
    channel: "email",
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
