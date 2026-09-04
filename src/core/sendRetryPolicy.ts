/**
 * 같은 run_id 재시도 정책 — provider dedupe 보존 기간 기반 상태 머신(2차 적대적 검수
 * SR2-MAIL-003, DESIGN §11.5).
 *
 * 배경: `agent_send_log`의 한 run_id는 `sending → sent | failed | unknown`으로 끝난다. `failed`는
 * "요청이 provider에 닿지 않은 게 확실"(SR2-MAIL-002)해서 언제든 같은 run_id로 다시 시도해도
 * 중복 위험이 없다. 반면 `unknown`(응답 유실)과 `sending`(예약 뒤 프로세스 크래시)은 "이미
 * 나갔을 수도 있다" — 이때 같은 run_id 재시도가 안전한 유일한 근거는 provider가 같은
 * Idempotency-Key(=run_id)를 **보존 기간 안에서** dedupe해 준다는 것이다(Resend 24시간). 보존
 * 기간이 지나면 같은 키라도 새 발송으로 취급되어 그대로 두 번째 메일이 나간다 — 예전 코드는 이
 * 만료를 전혀 확인하지 않았다(README는 "24시간 이내"라고만 적어 두고 코드가 집행하지 않았다).
 *
 * 이 모듈은 순수 판정만 한다(외부 IO 없음, CLAUDE.md `core/` 규칙). 판정 재료(이전 시도 목록,
 * 현재 시각, provider의 보존 기간)는 `agent/sendRetryGate.ts`가 모아서 넘긴다.
 *
 * 기준 시각(anchor)은 그 run_id의 `unknown`/`sending` 행 중 **가장 오래된** `sentAt`이다 —
 * provider가 그 키를 처음 봤을 수 있는 가장 이른 시점이라 가장 보수적이다(재시도가 보존 기간을
 * 연장한다고 가정하지 않는다). 여기에 안전 여유(`DEDUPE_SAFETY_MARGIN_MS`)를 더한다 — 우리
 * 시계와 provider 시계의 차이, 요청 자체가 걸리는 시간(타임아웃 30초), "보존 기간"이 provider
 * 문서에 초 단위로 정의돼 있지 않다는 점을 흡수하기 위한 값이다. 경계에서는 거부한다(같으면
 * 거부) — 오판 비용이 비대칭이다: 안전한 재시도를 한 번 거부하면 사람이 새 run_id로 다시
 * 실행하는 비용만 들지만, 만료된 키로 재시도를 허용하면 고객에게 같은 메일이 두 번 간다.
 */
import type { AgentSendEntry, AgentSendStatus } from "./types.js";

/** provider 보존 기간에서 빼는 안전 여유 — 1시간. 위 모듈 주석 참고. */
export const DEDUPE_SAFETY_MARGIN_MS = 60 * 60 * 1000;

/** 같은 run_id 재시도 가능성을 따지는 대상 상태 — "이미 나갔을 수도 있는" 시도만. */
const AMBIGUOUS_STATUSES: ReadonlySet<AgentSendStatus> = new Set<AgentSendStatus>([
  "unknown",
  "sending",
]);

export type SendRetryDecision =
  /** unknown/sending 시도가 없다 — 첫 시도 또는 failed/dry_run 뒤의 재시도. 그대로 예약한다. */
  | { kind: "fresh" }
  /** 보존 기간 안의 재시도 — 진행한다. `staleSendingCount`개의 sending 행은 먼저 unknown으로 마감해야 한다. */
  | {
      kind: "retry_within_ttl";
      anchorAt: Date;
      lastStatus: AgentSendStatus;
      staleSendingCount: number;
      /** 안전 여유를 뺀 뒤 남은 시간(ms). 사람이 읽는 안내용. */
      remainingMs: number;
    }
  /** provider가 idempotency dedupe를 지원하지 않는다(dedupeTtlMs 없음) — 같은 run_id 재시도는 항상 중복 위험. */
  | { kind: "refuse_no_dedupe"; anchorAt: Date; lastStatus: AgentSendStatus }
  /** 보존 기간(안전 여유 포함)이 지났다 — 같은 run_id 재시도는 중복 발송 위험. */
  | {
      kind: "refuse_ttl_expired";
      anchorAt: Date;
      lastStatus: AgentSendStatus;
      dedupeTtlMs: number;
      elapsedMs: number;
    };

export interface SendRetryPolicyInput {
  /** 이 run_id의 이전 발송 로그 행 전부(순서 무관). */
  attempts: readonly AgentSendEntry[];
  now: Date;
  /** provider의 Idempotency-Key 보존 기간(ms). undefined = 지원 안 함. */
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
 * 거부 결정을 원인 + 수정 방법이 담긴 에러로 만든다(CLAUDE.md 에러 메시지 컨벤션). 자동 원격
 * 조회를 대안으로 제시하지 않는 이유: `unknown`은 응답을 못 받은 상태라 message_id가 없고,
 * Resend API는 Idempotency-Key로 이미 보낸 메일을 조회하는 엔드포인트를 제공하지 않는다
 * (2026-09-04 확인) — 사람이 대시보드에서 수신자·시각으로 확인하는 것이 유일한 경로다.
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
    const who = recipient !== null ? `수신자 ${recipient}에게 ` : "";
    const prior =
      `run_id="${runId}"에는 ${decision.anchorAt.toISOString()}에 시작된 이전 발송 시도가 있고 ` +
      `마지막 상태가 '${decision.lastStatus}'입니다(발송됐는지 알 수 없는 상태` +
      `${decision.lastStatus === "sending" ? " — 예약 뒤 프로세스가 결과를 기록하지 못했습니다" : ""}).`;
    const why =
      decision.kind === "refuse_no_dedupe"
        ? " 이 알림 provider는 Idempotency-Key 중복 방지를 지원하지 않아 같은 run_id로 다시 보내도 중복 발송을 막을 수 없습니다."
        : ` provider의 중복 방지 보존 기간 ${formatHours(decision.dedupeTtlMs)}시간(안전 여유 ` +
          `${formatHours(DEDUPE_SAFETY_MARGIN_MS)}시간 차감)이 지났습니다(경과 ${formatHours(decision.elapsedMs)}시간) — ` +
          "같은 run_id로 다시 보내면 Idempotency-Key가 만료돼 중복 발송될 수 있습니다.";
    const remedy =
      ` 그래서 이 재시도를 거부합니다. 발송처 대시보드에서 그 시각 전후에 ${who}메일이 나갔는지 확인한 뒤, ` +
      "나가지 않았으면 --run-id 없이(새 run_id로) 다시 실행하세요. 이미 나갔으면 재시도하지 않아도 됩니다. " +
      "(응답을 못 받은 시도는 message_id가 없고 provider API가 Idempotency-Key로 메일을 조회하는 " +
      "기능을 제공하지 않아 이 확인은 자동화할 수 없습니다.)";
    super(prior + why + remedy);
    this.name = "SendRetryRefusedError";
  }
}
