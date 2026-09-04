-- 004_purchase_receipts.sql — receipt (inbound) records from the SCM sheet integration (docs/SPEC.md §13)
--
-- The source is the "type = inbound" rows of the Google Sheet "inbound/outbound history" tab (order/receipt data sample, verified 2026-09-03).
-- The "type = outbound" rows of the same sheet are deliberately not loaded — retail-mcp's sales source is the
-- Loyverse/CSV channel, and loading the SCM sheet's outbound rows through a separate pipeline would count
-- the same sales twice (SPEC §13 "Scope decision").
--
-- The "ordered" state (ordered but not yet received) is not handled — the sample sheet we checked has no
-- order-status column at all (only receipt records). This table is strictly a ledger of "receipts already received".
create table purchase_receipts (
  store_id text not null references stores (id),
  variant_id text not null references products (variant_id),
  received_at date not null,
  -- Received quantity. Return receipts (negative) etc. are out of v0.1 scope.
  received_qty numeric not null check (received_qty > 0),
  -- Purchase unit cost (optional, for audit trail) — not used in inventory reconciliation or in the sell-through calculation itself.
  unit_cost numeric,
  currency text,
  vendor text,
  check ((unit_cost is null) = (currency is null)),
  -- If the same store·SKU·date has multiple receipts, the last value overwrites (no summation) —
  -- a v0.1 limitation because the source sheet has no per-event sequence number. Add a sequence column if needed.
  primary key (store_id, variant_id, received_at)
);
