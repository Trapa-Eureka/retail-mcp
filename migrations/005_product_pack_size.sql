-- 005_product_pack_size.sql — pack-size rounding (docs/SPEC.md §14)
--
-- The minimum pack/case unit the supplier ships in. Null when absent (items that can be bought individually) — the
-- reorder suggestion is used as-is (no rounding). This is a source-neutral field (not CSV/Excel-specific) —
-- whichever channel fills it, the rounding post-processing function in core/metrics.ts consumes it.
alter table products
  add column pack_size numeric check (pack_size is null or pack_size > 0);
