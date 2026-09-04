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

describe("decideSameRunRetry — provider dedupe TTL 상태 머신(2차 적대적 검수 SR2-MAIL-003)", () => {
  it("이전 시도가 없으면 fresh", () => {
    expect(decideSameRunRetry({ attempts: [], now: T0, dedupeTtlMs: TTL_24H })).toEqual({
      kind: "fresh",
    });
  });

  it("failed/dry_run/no_suggestions만 있으면 fresh — 확실히 안 나간 시도는 TTL과 무관하게 재시도 가능", () => {
    const attempts = [
      attempt("dry_run", new Date(T0.getTime() - 100 * HOUR)),
      attempt("failed", new Date(T0.getTime() - 50 * HOUR), { errorCode: "ECONNREFUSED" }),
    ];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H })).toEqual({
      kind: "fresh",
    });
  });

  it("unknown 직후(TTL 안) 재시도는 허용 — 남은 시간은 TTL − 안전 여유 − 경과", () => {
    const attempts = [attempt("unknown", new Date(T0.getTime() - 2 * HOUR))];
    const d = decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H });
    expect(d).toMatchObject({
      kind: "retry_within_ttl",
      lastStatus: "unknown",
      staleSendingCount: 0,
      remainingMs: TTL_24H - DEDUPE_SAFETY_MARGIN_MS - 2 * HOUR,
    });
  });

  it("경계: 경과 + 안전 여유가 TTL과 같으면 거부, 1ms 모자라면 허용(보수적 — 같으면 거부)", () => {
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

  it("TTL이 지났으면 refuse_ttl_expired — 경과 시간과 TTL을 함께 돌려준다", () => {
    const attempts = [attempt("unknown", new Date(T0.getTime() - 30 * HOUR))];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H })).toEqual({
      kind: "refuse_ttl_expired",
      anchorAt: new Date(T0.getTime() - 30 * HOUR),
      lastStatus: "unknown",
      dedupeTtlMs: TTL_24H,
      elapsedMs: 30 * HOUR,
    });
  });

  it("provider가 dedupe를 지원하지 않으면(dedupeTtlMs 없음) unknown 뒤 재시도는 시각과 무관하게 거부", () => {
    const attempts = [attempt("unknown", new Date(T0.getTime() - 1))];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: undefined })).toEqual({
      kind: "refuse_no_dedupe",
      anchorAt: new Date(T0.getTime() - 1),
      lastStatus: "unknown",
    });
  });

  it("sending에 멈춘 행은 unknown과 같은 취급이고 staleSendingCount로 개수를 알려준다", () => {
    const attempts = [attempt("sending", new Date(T0.getTime() - 3 * HOUR))];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H })).toMatchObject({
      kind: "retry_within_ttl",
      lastStatus: "sending",
      staleSendingCount: 1,
    });
  });

  it("기준 시각(anchor)은 unknown/sending 중 가장 오래된 시도 — 재시도가 TTL을 연장한다고 가정하지 않는다", () => {
    // 첫 unknown이 23.5h 전, 두 번째 unknown이 1h 전. 두 번째만 보면 허용이지만 첫 시도 기준으로
    // 23.5h + 1h 여유 > 24h → 거부해야 한다.
    const first = new Date(T0.getTime() - 23.5 * HOUR);
    const second = new Date(T0.getTime() - 1 * HOUR);
    const attempts = [attempt("unknown", first), attempt("unknown", second)];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H })).toMatchObject({
      kind: "refuse_ttl_expired",
      anchorAt: first,
      lastStatus: "unknown",
    });
  });

  it("failed 시도가 섞여 있어도 anchor는 unknown/sending 행만 본다", () => {
    const attempts = [
      attempt("failed", new Date(T0.getTime() - 40 * HOUR)), // 오래됐지만 확실한 실패 — 무시
      attempt("unknown", new Date(T0.getTime() - 1 * HOUR)),
    ];
    expect(decideSameRunRetry({ attempts, now: T0, dedupeTtlMs: TTL_24H })).toMatchObject({
      kind: "retry_within_ttl",
      anchorAt: new Date(T0.getTime() - 1 * HOUR),
    });
  });
});

describe("SendRetryRefusedError — 원인 + 수정 방법", () => {
  it("TTL 만료: 이전 시도 시각·상태, 만료 이유, 대시보드 확인 후 새 run_id 안내, 자동 조회 불가 이유를 담는다", () => {
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
    expect(err.message).toContain("24.0시간");
    expect(err.message).toContain("30.0시간");
    expect(err.message).toContain("owner@example.com");
    expect(err.message).toContain("--run-id 없이");
    expect(err.message).toContain("자동화할 수 없습니다");
  });

  it("dedupe 미지원: provider가 중복 방지를 지원하지 않는다는 이유를 담고, sending은 크래시 설명을 덧붙인다", () => {
    const err = new SendRetryRefusedError(
      "run-abc",
      { kind: "refuse_no_dedupe", anchorAt: T0, lastStatus: "sending" },
      null,
    );
    expect(err.message).toContain("중복 방지를 지원하지 않아");
    expect(err.message).toContain("프로세스가 결과를 기록하지 못했습니다");
    expect(err.message).not.toContain("수신자");
  });
});
