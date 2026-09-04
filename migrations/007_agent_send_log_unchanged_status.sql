-- 007_agent_send_log_unchanged_status.sql — new status for the daily digest policy (DATA-003)
-- Source of truth: docs/SPEC.md §18 "Repeat send policy", docs/DESIGN.md §12.3.
--
-- When a CSV/Excel branch scan (agent/folderScan.ts) finds that the current file's content hash matches the one
-- at the last send and the daily digest cap (24 hours) has not been hit either, it does nothing —
-- this is recorded in the audit log as status='unchanged', distinct from the existing no_suggestions/dry_run/sending/sent/failed
-- (TASKS T31; also tied to OPS-005 observability — "I never received any notification" and "it really did
-- exit quietly" must be distinguishable).
alter table agent_send_log drop constraint agent_send_log_status_check;
alter table agent_send_log add constraint agent_send_log_status_check
  check (status in ('no_suggestions', 'dry_run', 'sending', 'sent', 'failed', 'unchanged'));
