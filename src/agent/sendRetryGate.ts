/**
 * Same-run_id retry gate (second adversarial review SR2-MAIL-003) — called by both
 * `agent/reorder.ts` and `agent/folderScan.ts` **right before** the status='sending' reservation.
 * The decision itself is made by `core/sendRetryPolicy.ts` (pure); this file is the thin
 * orchestration that gathers its inputs (previous attempts, current time, provider retention
 * window), passes them in and enforces the decision.
 *
 * Enforcement:
 * - Refusal (`refuse_*`) → throws `SendRetryRefusedError`. `sending`/`unknown` rows are left as
 *   they are (the documented procedure is for a person to check the dashboard and run again with
 *   a new run_id — README "Email send retry").
 * - Retry within the retention window → any row stuck in `sending` is closed as `unknown`
 *   (error_code `stale_sending`) so the following `sending` reservation INSERT is not blocked by
 *   the partial unique index. This closing happens **only on the path where a person explicitly
 *   retried with `--run-id`** — in normal operation, where cron runs with a fresh run_id every
 *   time, this gate is always `fresh` and changes nothing (the DESIGN §11.5 principle "recovery is
 *   not automated" stands).
 * - `fresh` → does nothing.
 *
 * This gate does not replace the partial unique index (`agent_send_log_run_id_active_idx`) — a
 * run_id that is already `sent`, or a concurrently live `sending`, is still blocked atomically by
 * that index.
 */
import { decideSameRunRetry, SendRetryRefusedError } from "../core/sendRetryPolicy.js";
import type { NotificationProvider, Warehouse } from "../core/types.js";

export interface SendRetryGateDeps {
  warehouse: Warehouse;
  notificationProvider: NotificationProvider;
}

export interface SendRetryGateResult {
  /** Number of stale `sending` rows this call closed as `unknown` (0 = nothing closed). */
  closedStaleSending: number;
}

export async function enforceSameRunRetryPolicy(
  deps: SendRetryGateDeps,
  params: { runId: string; now: Date; recipient: string | null },
): Promise<SendRetryGateResult> {
  const attempts = await deps.warehouse.listAgentSendAttempts(params.runId);
  const decision = decideSameRunRetry({
    attempts,
    now: params.now,
    dedupeTtlMs: deps.notificationProvider.dedupeTtlMs,
  });

  switch (decision.kind) {
    case "fresh":
      return { closedStaleSending: 0 };
    case "refuse_no_dedupe":
    case "refuse_ttl_expired":
      throw new SendRetryRefusedError(params.runId, decision, params.recipient);
    case "retry_within_ttl": {
      let closed = 0;
      if (decision.staleSendingCount > 0) {
        closed = await deps.warehouse.markStaleSendingUnknown(params.runId);
        console.error(
          `run_id="${params.runId}" has ${closed} 'sending' reservation row(s) left without a result (the previous ` +
            "run appears to have exited before recording the send result); closing them as 'unknown' (stale_sending) " +
            "and retrying with the same run_id — within the provider's deduplication retention window, so only one email actually goes out.",
        );
      }
      return { closedStaleSending: closed };
    }
  }
}
