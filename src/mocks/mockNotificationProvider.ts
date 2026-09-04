/**
 * Mock NotificationProvider — records sends + forces failures via failFor (TESTING.md §2).
 * Origin: sheet_mcp `src/mocks/mockNotificationProvider.ts` (ported as of 2026-09-02).
 * Difference from the origin: sheet_mcp matches failFor per sheet row (rowKey), but retail-mcp has
 * no rowKey concept (one report email per run), so it matches on the recipient address (msg.to).
 * Also, core/types.ts's send() throws on failure instead of returning {ok:false}, so this follows suit.
 */
import type { NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

/** Default is the same 24 hours as real Resend — agent tests run under the same conditions as production settings. */
export const MOCK_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

export interface MockNotificationProviderOptions {
  /** Attempting to send to one of these recipients makes send() reject (same pattern as sheet_mcp's failFor). */
  failFor?: string[];
  /**
   * SR2-MAIL-003 — the value to expose as `NotificationProvider.dedupeTtlMs`. Default MOCK_DEDUPE_TTL_MS (24 hours).
   * `null` omits the field entirely to mimic a "provider that does not support idempotency dedupe".
   */
  dedupeTtlMs?: number | null;
}

export interface MockNotificationProvider extends NotificationProvider {
  /** Only messages handled as successful are recorded, in call order. */
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
    // exactOptionalPropertyTypes: when null (unsupported), omit the field instead of setting `dedupeTtlMs: undefined`.
    ...(dedupeTtlMs !== null ? { dedupeTtlMs } : {}),
    sent,
    send(msg: OutboundMessage): Promise<SendResult> {
      if (failFor.has(msg.to)) {
        return Promise.reject(
          new Error(`MockNotificationProvider: send to ${msg.to} was forced to fail by failFor.`),
        );
      }
      sent.push(msg);
      counter += 1;
      return Promise.resolve({ messageId: `mock-${counter}` });
    },
  };
}
