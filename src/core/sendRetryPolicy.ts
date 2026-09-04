/**
 * Same-run_id retry policy — a state machine based on the provider's dedupe retention window
 * (second adversarial review SR2-MAIL-003, DESIGN §11.5).
 *
 * Background: one run_id in `agent_send_log` ends as `sending → sent | failed | unknown`. `failed`
 * means "the request definitely never reached the provider" (SR2-MAIL-002), so retrying with the
 * same run_id at any time carries no duplicate risk. `unknown` (lost response) and `sending`
 * (process crash after reservation), on the other hand, "may already have gone out" — the only
 * thing that makes a same-run_id retry safe then is that the provider dedupes the same
 * Idempotency-Key (= run_id) **within its retention window** (Resend: 24 hours). Once the window
 * has passed, the same key is treated as a new send and a second email simply goes out — the old
 * code never checked this expiry (the README only said "within 24 hours" and the code did not
 * enforce it).
 *
 * This module only makes the decision (no external IO, CLAUDE.md `core/` rule). The inputs
 * (previous attempts, current time, provider retention window) are gathered and passed in by
 * `agent/sendRetryGate.ts`.
 *
 * The anchor time is the **oldest** `sentAt` among that run_id's `unknown`/`sending` rows — the
 * earliest moment the provider could have first seen the key, hence the most conservative (a
 * retry is not assumed to extend the retention window). A safety margin
 * (`DEDUPE_SAFETY_MARGIN_MS`) is added on top — to absorb clock skew between us and the provider,
 * the time the request itself takes (30-second timeout), and the fact that the "retention window"
 * is not defined to the second in the provider docs. At the boundary we refuse (equal = refuse) —
 * the cost of a wrong call is asymmetric: refusing one safe retry only costs a person re-running
 * with a new run_id, while allowing a retry with an expired key sends the customer the same email
 * twice.
 */
import type { AgentSendEntry, AgentSendStatus } from "./types.js";

/** Safety margin subtracted from the provider retention window — 1 hour. See the module doc above. */
export const DEDUPE_SAFETY_MARGIN_MS = 60 * 60 * 1000;

/** Statuses considered for same-run_id retry — only attempts that "may already have gone out". */
const AMBIGUOUS_STATUSES: ReadonlySet<AgentSendStatus> = new Set<AgentSendStatus>([
  "unknown",
  "sending",
]);

export type SendRetryDecision =
  /** No unknown/sending attempts — first attempt, or a retry after failed/dry_run. Reserve as usual. */
  | { kind: "fresh" }
  /** Retry within the retention window — proceed. `staleSendingCount` sending rows must first be closed as unknown. */
  | {
      kind: "retry_within_ttl";
      anchorAt: Date;
      lastStatus: AgentSendStatus;
      staleSendingCount: number;
      /** Time left (ms) after subtracting the safety margin. For human-readable guidance. */
      remainingMs: number;
    }
  /** The provider does not support idempotency dedupe (no dedupeTtlMs) — a same-run_id retry is always a duplicate risk. */
  | { kind: "refuse_no_dedupe"; anchorAt: Date; lastStatus: AgentSendStatus }
  /** The retention window (including the safety margin) has passed — a same-run_id retry risks a duplicate send. */
  | {
      kind: "refuse_ttl_expired";
      anchorAt: Date;
      lastStatus: AgentSendStatus;
      dedupeTtlMs: number;
      elapsedMs: number;
    };

export interface SendRetryPolicyInput {
  /** All previous send-log rows of this run_id (any order). */
  attempts: readonly AgentSendEntry[];
  now: Date;
  /** The provider's Idempotency-Key retention window (ms). undefined = not supported. */
  dedupeTtlMs: number | undefined;
}

export function decideSameRunRetry(input: SendRetryPolicyInput): SendRetryDecision {
  const ambiguous = input.attempts.filter((a) => AMBIGUOUS_STATUSES.has(a.status));
  if (ambiguous.length === 0) return { kind: "fresh" };

  let anchorAt = ambiguous[0]!.sentAt;
  let last = ambiguous[0]!;
  for (const a of ambiguous) {
    if (a.sentAt.getTime() < anchorAt.getTime()) anchorAt = a.sentAt;
    if (a.sentAt.getTime() >= last.sentAt.getTime()) last = a;
  }
  const staleSendingCount = ambiguous.filter((a) => a.status === "sending").length;

  if (input.dedupeTtlMs === undefined) {
    return { kind: "refuse_no_dedupe", anchorAt, lastStatus: last.status };
  }

  const elapsedMs = input.now.getTime() - anchorAt.getTime();
  const remainingMs = input.dedupeTtlMs - DEDUPE_SAFETY_MARGIN_MS - elapsedMs;
  if (remainingMs <= 0) {
    return {
      kind: "refuse_ttl_expired",
      anchorAt,
      lastStatus: last.status,
      dedupeTtlMs: input.dedupeTtlMs,
      elapsedMs,
    };
  }
  return {
    kind: "retry_within_ttl",
    anchorAt,
    lastStatus: last.status,
    staleSendingCount,
    remainingMs,
  };
}

function formatHours(ms: number): string {
  return (ms / (60 * 60 * 1000)).toFixed(1);
}

/**
 * Turns a refusal decision into an error carrying the cause + how to fix it (CLAUDE.md error
 * message convention). Why no automatic remote lookup is offered as an alternative: `unknown`
 * means no response was received, so there is no message_id, and the Resend API offers no
 * endpoint to look up an already-sent email by Idempotency-Key (checked 2026-09-04) — a person
 * checking the dashboard by addressee and time is the only route.
 */
export class SendRetryRefusedError extends Error {
  constructor(
    public readonly runId: string,
    public readonly decision: Extract<
      SendRetryDecision,
      { kind: "refuse_no_dedupe" | "refuse_ttl_expired" }
    >,
    recipient: string | null,
  ) {
    const who = recipient !== null ? `to ${recipient} ` : "";
    const prior =
      `run_id="${runId}" has a previous send attempt started at ${decision.anchorAt.toISOString()} ` +
      `whose last status is '${decision.lastStatus}' (unknown whether it was sent` +
      `${decision.lastStatus === "sending" ? " — the process did not record the result after reserving" : ""}).`;
    const why =
      decision.kind === "refuse_no_dedupe"
        ? " This notification provider does not support Idempotency-Key deduplication, so resending with the same run_id cannot prevent a duplicate send."
        : ` The provider's deduplication retention window of ${formatHours(decision.dedupeTtlMs)} hours (minus a safety margin of ` +
          `${formatHours(DEDUPE_SAFETY_MARGIN_MS)} hours) has passed (elapsed ${formatHours(decision.elapsedMs)} hours) — ` +
          "resending with the same run_id may deliver a duplicate because the Idempotency-Key has expired.";
    const remedy =
      ` This retry is therefore refused. Check in the provider dashboard whether an email went out ${who}around that time; ` +
      "if it did not, run again without --run-id (with a new run_id). If it did, no retry is needed. " +
      "(An attempt without a response has no message_id and the provider API offers no way to look up an email " +
      "by Idempotency-Key, so this check cannot be automated.)";
    super(prior + why + remedy);
    this.name = "SendRetryRefusedError";
  }
}
