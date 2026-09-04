-- 008_agent_send_log_unknown_status.sql — ambiguous send outcome status (OPS-004)
-- Source of truth: docs/007_RUNTIME_RELIABILITY_REVIEW.md OPS-004, docs/TASKS.md T34.
--
-- When a Resend request times out, the message "may or may not have been sent" — previously such cases were
-- simply recorded as 'failed', indistinguishable from "definitely not sent". Now only this ambiguous case is
-- recorded separately as 'unknown' (src/adapters/resendProvider.ts throws `AmbiguousSendError` on timeouts only,
-- and agent/folderScan.ts · agent/reorder.ts recognize that name and record status='unknown').
-- Like 'failed', it is not covered by the partial unique index
-- (agent_send_log_run_id_active_idx, status in ('sending','sent')), so the same run_id can be retried —
-- the retry itself relies on the Resend Idempotency-Key (the same run_id is used as the key,
-- resendProvider.ts) to prevent duplicate sends.
alter table agent_send_log drop constraint agent_send_log_status_check;
alter table agent_send_log add constraint agent_send_log_status_check
  check (status in ('no_suggestions', 'dry_run', 'sending', 'sent', 'failed', 'unchanged', 'unknown'));
