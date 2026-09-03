-- 008_agent_send_log_unknown_status.sql — 발송 결과 불확실 상태(OPS-004)
-- 진실의 원천: docs/007_RUNTIME_RELIABILITY_REVIEW.md OPS-004, docs/TASKS.md T34.
--
-- Resend 요청이 타임아웃되면 "이미 발송됐을 수도, 안 됐을 수도" 있다 — 예전엔 이런 경우도
-- 그냥 'failed'로 기록해 "확실히 발송되지 않았다"와 구분이 안 됐다. 이제 이 애매한 경우만
-- 'unknown'으로 따로 기록한다(src/adapters/resendProvider.ts가 타임아웃에 한해
-- `AmbiguousSendError`를 던지고, agent/folderScan.ts·agent/reorder.ts가 그 이름을 보고
-- status='unknown'으로 남긴다). 'failed'와 마찬가지로 부분 유니크 인덱스
-- (agent_send_log_run_id_active_idx, status in ('sending','sent'))의 대상이 아니므로 같은
-- run_id로 재시도할 수 있다 — 재시도 자체는 Resend Idempotency-Key(같은 run_id를 키로 사용,
-- resendProvider.ts)로 중복 발송을 막는다.
alter table agent_send_log drop constraint agent_send_log_status_check;
alter table agent_send_log add constraint agent_send_log_status_check
  check (status in ('no_suggestions', 'dry_run', 'sending', 'sent', 'failed', 'unchanged', 'unknown'));
