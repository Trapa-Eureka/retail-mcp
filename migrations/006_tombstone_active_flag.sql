-- 006_tombstone_active_flag.sql — inventory_levels/sales_period_agg tombstone 플래그
-- 진실의 원천: docs/SPEC.md §18 "데이터 보존 정책", docs/DESIGN.md §12.2, docs/006 DATA-002.
--
-- CSV/Excel authoritative 스캔에서 이번 파일에 더 이상 없는 (매장,SKU) 행을 물리 삭제하지
-- 않고 active=false로만 표시한다(TASKS T31) — 재주문·저재고 계산과 기본 조회는 active=true
-- 행만 보되, 이력은 DB에 그대로 남아 감사·재활성화(다시 파일에 나타나면 자동 재활성화,
-- upsert 경로)가 가능하다.
--
-- Loyverse 경로(sales_lines/etl/sync.ts)는 이 컬럼을 비활성화하는 쪽으로는 쓰지 않는다 —
-- 매 동기화가 항상 active=true로 upsert하므로 기존 동작과 완전히 동일하다(tombstone은
-- CSV/Excel 채널의 agent/folderScan.ts에서만 호출).
alter table inventory_levels add column active boolean not null default true;
alter table sales_period_agg add column active boolean not null default true;

create index on inventory_levels (store_id, active);
create index on sales_period_agg (store_id, active);
