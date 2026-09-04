-- 003_product_low_stock_threshold.sql — per-product low-stock threshold (CSV/Excel channel)
-- Source of truth: the optional low-stock threshold column (per-product override) in docs/SPEC.md §12 "Column layout" ·
-- "No sales history: threshold fallback". T16 (the CSV/Excel parser) parses this column but had nowhere to
-- store it; this fills that schema gap (TASKS.md T16).
--
-- Attached to the products table — SPEC §12 explicitly says "per-product override", so it is per product,
-- not per store. The Loyverse path never uses this column, so it is always null there. Actually reading
-- this value for threshold decisions is T17's job — this migration only opens the write path.
alter table products add column low_stock_threshold numeric;
