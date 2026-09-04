-- 006_tombstone_active_flag.sql — tombstone flag on inventory_levels/sales_period_agg
-- Source of truth: docs/SPEC.md §18 "Data retention policy", docs/DESIGN.md §12.2, docs/006 DATA-002.
--
-- In a CSV/Excel authoritative scan, (store, SKU) rows that are no longer present in the current file are not
-- physically deleted but only marked active=false (TASKS T31) — reorder/low-stock calculations and default queries
-- only look at active=true rows, while the history stays in the DB for auditing and reactivation (automatically
-- reactivated via the upsert path when the row reappears in a file).
--
-- The Loyverse path (sales_lines/etl/sync.ts) never uses this column to deactivate anything —
-- every sync always upserts active=true, so its behavior is exactly as before (the tombstone is only
-- invoked from agent/folderScan.ts in the CSV/Excel channel).
alter table inventory_levels add column active boolean not null default true;
alter table sales_period_agg add column active boolean not null default true;

create index on inventory_levels (store_id, active);
create index on sales_period_agg (store_id, active);
