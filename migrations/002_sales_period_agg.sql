-- 002_sales_period_agg.sql — period-aggregated sales data for the CSV/Excel channel
-- Source of truth: docs/SPEC.md §12 "Column layout" · "No sales history: threshold fallback".
--
-- CSV/Excel carries no receipt-level history — it gives only a single period total: "during this period,
-- this store sold N units of this SKU in total". Forcing that into sales_lines (receipt-line granularity,
-- receipt_id+line_no PK, with gross/discount) would require fabricating fake receipts, so it is kept in a
-- separate table and the transaction-level accuracy of the Loyverse path is not polluted by CSV approximations
-- (docs/TASKS.md T12; LoyverseClient/etl/sync.ts remain a Loyverse-only path).
--
-- Same model as inventory_levels: upserted with the latest values on every scan (SPEC §12 "Execution model") —
-- per-period history is not accumulated; only "the period total seen by the most recent scan" is kept.
create table sales_period_agg (
  store_id text not null references stores (id),
  variant_id text not null references products (variant_id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  -- Total quantity sold within the period. CSV does not express refunds separately, so negatives are not allowed
  -- (unlike qty in Loyverse sales_lines, this is the source total as-is, not a net-sales approximation).
  sold_qty numeric not null check (sold_qty >= 0),
  primary key (store_id, variant_id)
);
