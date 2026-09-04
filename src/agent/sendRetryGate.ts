/**
 * 같은 run_id 재시도 게이트(2차 적대적 검수 SR2-MAIL-003) — `agent/reorder.ts`와
 * `agent/folderScan.ts`가 status='sending' 예약 **직전**에 공통으로 호출한다. 판정 자체는
 * `core/sendRetryPolicy.ts`(순수)가 하고, 이 파일은 그 재료(이전 시도 목록·현재 시각·provider
 * 보존 기간)를 모아 넘기고 결정을 집행하는 얇은 오케스트레이션이다.
 *
 * 집행 내용:
 * - 거부(`refuse_*`) → `SendRetryRefusedError`를 던진다. `sending`/`unknown` 행은 그대로 남긴다
 *   (사람이 대시보드 확인 후 새 run_id로 실행하는 것이 문서화된 절차 — README "이메일 발송 재시도").
 * - 보존 기간 안의 재시도 → `sending`에 멈춘 행이 있으면 `unknown`(error_code `stale_sending`)으로
 *   마감해 이어지는 `sending` 예약 INSERT가 부분 unique 인덱스에 막히지 않게 한다. 이 마감은
 *   **사람이 `--run-id`로 명시 재시도한 경로에서만** 일어난다 — cron이 매번 새 run_id로 도는
 *   정상 운영에서는 이 게이트가 항상 `fresh`라 아무것도 바꾸지 않는다(DESIGN §11.5 "회수는
 *   자동화하지 않는다"는 원칙은 그대로다).
 * - `fresh` → 아무것도 하지 않는다.
 *
 * 이 게이트는 부분 unique 인덱스(`agent_send_log_run_id_active_idx`)를 대체하지 않는다 — 이미
 * `sent`인 run_id나 동시에 살아 있는 `sending`은 여전히 그 인덱스가 원자적으로 막는다.
 */
import { decideSameRunRetry, SendRetryRefusedError } from "../core/sendRetryPolicy.js";
import type { NotificationProvider, Warehouse } from "../core/types.js";

export interface SendRetryGateDeps {
  warehouse: Warehouse;
  notificationProvider: NotificationProvider;
}

export interface SendRetryGateResult {
  /** 이번 호출이 `unknown`으로 마감한 stale `sending` 행 수(0이면 마감 없음). */
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
          `run_id="${params.runId}"의 'sending' 예약 행 ${closed}건이 결과 없이 남아 있어(이전 실행이 ` +
            "발송 결과를 기록하기 전에 종료된 것으로 보임) 'unknown'(stale_sending)으로 마감하고 " +
            "같은 run_id로 재시도합니다 — provider 중복 방지 보존 기간 안이라 실제로는 한 통만 나갑니다.",
        );
      }
      return { closedStaleSending: closed };
    }
  }
}
