-- 007_agent_send_log_unchanged_status.sql — 일일 다이제스트 정책(DATA-003)의 새 상태
-- 진실의 원천: docs/SPEC.md §18 "반복 발송 정책", docs/DESIGN.md §12.3.
--
-- CSV/Excel 지점 스캔(agent/folderScan.ts)이 이번 파일의 content hash가 마지막 발송 시점과
-- 같고 하루 다이제스트 상한(24시간)에도 걸리지 않으면 아무것도 하지 않는다 —
-- status='unchanged'로 기존 no_suggestions/dry_run/sending/sent/failed와 구분해 감사 로그에
-- 남긴다(TASKS T31, OPS-005 관측성과도 연결 — "아무 알림도 못 받았다"와 "정말 조용히
-- 종료했다"를 구분할 수 있어야 한다).
alter table agent_send_log drop constraint agent_send_log_status_check;
alter table agent_send_log add constraint agent_send_log_status_check
  check (status in ('no_suggestions', 'dry_run', 'sending', 'sent', 'failed', 'unchanged'));
