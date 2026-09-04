import { describe, expect, it } from "vitest";
import {
  DEDUPE_SAFETY_MARGIN_MS,
  decideSameRunRetry,
  SendRetryRefusedError,
} from "../src/core/sendRetryPolicy.js";
import type { AgentSendEntry, AgentSendStatus } from "../src/core/types.js";

const TTL_24H = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-09-01T00:00:00.000Z");

function attempt(status: AgentSendStatus, sentAt: Date, extra: Partial<AgentSendEntry> = {}) {
  return {
    runId: "run-x",
    sentAt,
    status,
    recipient: "owner@example.com",
    subject: "s",
    suggestionCount: 1,
    messageId: null,
    dryRun: false,
    errorCode: null,
    ...extra,
  } satisfies AgentSendEntry;
}

describe("decideSameRunRetry — provider dedupe TTL state machine (second adversarial review SR2-MAIL-003)", () => {
  it("no previous attempt → fresh", () => {
    expect(decideSameRunRetry({ attempts: [], now: T0, dedupeTtlMs: TTL_24H })).toEqual({
      kind: "fresh",
    });
  });

  it("only failed/dry_run/no_suggestions → fresh — attempts that definitely never went out can be retried regardless of TTL", () => {
    const attempts = [
      attempt("dry_run", new Date(T0.getTime() - 100 * HOUR)),
      attempt("failed", new Date(T0.getTime() - 50 * HOUR), { errorCode: "ECONNREFUSED" }),
    ];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H })).toEqual({
      kind: "fresh",
    });
  });

  it("retry right after unknown (within TTL) is allowed — remaining time is TTL − safety margin − elapsed", () => {
    const attempts = [attempt("unknown", new Date(T0.getTime() - 2 * HOUR))];
    const d = decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H });
    expect(d).toMatchObject({
      kind: "retry_within_ttl",
      lastStatus: "unknown",
      staleSendingCount: 0,
      remainingMs: TTL_24H - DEDUPE_SAFETY_MARGIN_MS - 2 * HOUR,
    });
  });

  it("boundary: elapsed + safety margin equal to TTL is refused, 1ms short is allowed (conservative — equal = refuse)", () => {
    const exactly = new Date(T0.getTime() - (TTL_24H - DEDUPE_SAFETY_MARGIN_MS));
    expect(
      decideSameRunRetry({ attempts: [attempt("unknown", exactly)], now: T0, dedupeTtlMs: TTL_24H })
        .kind,
    ).toBe("refuse_ttl_expired");

    const oneMsInside = new Date(exactly.getTime() + 1);
    expect(
      decideSameRunRetry({
        attempts: [attempt("unknown", oneMsInside)],
        now: T0,
        dedupeTtlMs: TTL_24H,
      }),
    ).toMatchObject({ kind: "retry_within_ttl", remainingMs: 1 });
  });

  it("TTL passed → refuse_ttl_expired — returns elapsed time together with the TTL", () => {
    const attempts = [attempt("unknown", new Date(T0.getTime() - 30 * HOUR))];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H })).toEqual({
      kind: "refuse_ttl_expired",
      anchorAt: new Date(T0.getTime() - 30 * HOUR),
      lastStatus: "unknown",
      dedupeTtlMs: TTL_24H,
      elapsedMs: 30 * HOUR,
    });
  });

  it("provider without dedupe support (no dedupeTtlMs) → retry after unknown is refused regardless of time", () => {
    const attempts = [attempt("unknown", new Date(T0.getTime() - 1))];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: undefined })).toEqual({
      kind: "refuse_no_dedupe",
      anchorAt: new Date(T0.getTime() - 1),
      lastStatus: "unknown",
    });
  });

  it("a row stuck in sending is treated like unknown and its count is reported via staleSendingCount", () => {
    const attempts = [attempt("sending", new Date(T0.getTime() - 3 * HOUR))];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H })).toMatchObject({
      kind: "retry_within_ttl",
      lastStatus: "sending",
      staleSendingCount: 1,
    });
  });

  it("the anchor is the oldest unknown/sending attempt — a retry is not assumed to extend the TTL", () => {
    // First unknown 23.5h ago, second unknown 1h ago. Looking at the second alone it would be
    // allowed, but based on the first attempt 23.5h + 1h margin > 24h → must refuse.
    const first = new Date(T0.getTime() - 23.5 * HOUR);
    const second = new Date(T0.getTime() - 1 * HOUR);
    const attempts = [attempt("unknown", first), attempt("unknown", second)];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H })).toMatchObject({
      kind: "refuse_ttl_expired",
      anchorAt: first,
      lastStatus: "unknown",
    });
  });

  it("with failed attempts mixed in, the anchor still only looks at unknown/sending rows", () => {
    const attempts = [
      attempt("failed", new Date(T0.getTime() - 40 * HOUR)), // old but a definite failure — ignored
      attempt("unknown", new Date(T0.getTime() - 1 * HOUR)),
    ];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H })).toMatchObject({
      kind: "retry_within_ttl",
      anchorAt: new Date(T0.getTime() - 1 * HOUR),
    });
  });
});

describe("SendRetryRefusedError — cause + how to fix", () => {
  it("TTL expired: carries previous attempt time/status, expiry reason, dashboard check then new run_id guidance, and why the lookup cannot be automated", () => {
    const err = new SendRetryRefusedError(
      "run-abc",
      {
        kind: "refuse_ttl_expired",
        anchorAt: new Date("2026-09-01T00:00:00.000Z"),
        lastStatus: "unknown",
        dedupeTtlMs: TTL_24H,
        elapsedMs: 30 * HOUR,
      },
      "owner@example.com",
    );
    expect(err.name).toBe("SendRetryRefusedError");
    expect(err.message).toContain('run_id="run-abc"');
    expect(err.message).toContain("2026-09-01T00:00:00.000Z");
    expect(err.message).toContain("'unknown'");
    expect(err.message).toContain("24.0 hours");
    expect(err.message).toContain("30.0 hours");
    expect(err.message).toContain("owner@example.com");
    expect(err.message).toContain("without --run-id");
    expect(err.message).toContain("cannot be automated");
  });

  it("no dedupe support: states that the provider does not support deduplication, and sending adds the crash explanation", () => {
    const err = new SendRetryRefusedError(
      "run-abc",
      { kind: "refuse_no_dedupe", anchorAt: T0, lastStatus: "sending" },
      null,
    );
    expect(err.message).toContain("does not support Idempotency-Key deduplication");
    expect(err.message).toContain("process did not record the result");
    expect(err.message).not.toContain("recipient");
  });
});
