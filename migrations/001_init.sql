-- 001_init.sql — initial schema
-- Source of truth: DESIGN.md §2 (base DDL) + §11 (schema clarifications). Since nothing has been
-- deployed yet, the §11 corrections are folded into this file instead of being split into follow-up migrations.

create table stores (
  id text primary key,
  name text not null
);

-- Products flattened to the Loyverse variant level.
create table products (
  variant_id text primary key,
  item_id text not null,
  name text not null,
  sku text,
  category text
);

-- Sales records at receipt-line granularity.
-- qty: refunds are negative. The raw net sold quantity is preserved as-is — the max(0, qty) policy
-- is applied at the core layer boundary during calculation, not erased at write time (SPEC §9).
create table sales_lines (
  receipt_id text not null,
  line_no int not null,
  store_id text not null references stores (id),
  variant_id text not null references products (variant_id),
  qty numeric not null,
  gross numeric not null,
  discount numeric not null default 0,
  sold_at timestamptz not null,
  primary key (receipt_id, line_no)
);
create index sales_lines_store_variant_sold_at_idx on sales_lines (store_id, variant_id, sold_at);

-- Current stock. Upserted on every sync so that only the latest state is kept.
-- Negative in_stock is a data-quality warning target — the raw value is stored and clamped to 0 during calculation (SPEC §9).
create table inventory_levels (
  store_id text not null references stores (id),
  variant_id text not null references products (variant_id),
  in_stock numeric not null,
  updated_at timestamptz not null,
  primary key (store_id, variant_id)
);

-- Inventory snapshot loaded on every sync — the starting point of the time series.
-- run_id: a run identifier fixed for one sync execution (DESIGN §11.2). Even if a run is repeated at
-- the same snapped_at, run_id is part of the PK, so snapshot PKs do not collide and runs stay distinguishable.
create table inventory_snapshots (
  run_id text not null,
  snapped_at timestamptz not null,
  store_id text not null references stores (id),
  variant_id text not null references products (variant_id),
  in_stock numeric not null,
  primary key (run_id, store_id, variant_id)
);
create index inventory_snapshots_snapped_at_idx on inventory_snapshots (snapped_at);

-- Per-resource sync progress.
-- The watermark (= the cursor column) stores only the "incremental start point of a completed resource".
-- The API pagination token (pageCursor) is not stored here — it lives in memory only, and the
-- watermark is committed only after every page of the resource has succeeded (DESIGN §11.1, CLAUDE.md implementation notes).
create table sync_state (
  resource text primary key, -- receipts | items | inventory | stores
  cursor text, -- watermark value, e.g. the last fully processed timestamp or a serialized (updated_at, id) string
  last_synced_at timestamptz
);

-- Agent run/send log.
-- status distinguishes no_suggestions/dry_run/sending/sent/failed (DESIGN §11.5).
--
-- Duplicate sends are prevented with a reservation pattern: T8 must commit a status='sending' row
-- before calling provider.send(). A partial unique index allows at most one sending/sent row per
-- run_id, so this INSERT itself acts as an atomic lock — if the insert fails with a unique
-- violation, a send is already in progress or completed, so nothing is re-sent.
-- On success the same row is UPDATEd to 'sent', on failure to 'failed' ('failed' is not covered by
-- the unique index, so a retry can reserve a new 'sending' row again).
-- The policy for stale rows stuck in 'sending' (e.g. after a process crash) is decided in T8.
create table agent_send_log (
  id bigserial primary key,
  run_id text not null,
  sent_at timestamptz not null,
  status text not null check (status in ('no_suggestions', 'dry_run', 'sending', 'sent', 'failed')),
  recipient text, -- null allowed in non-send states (no_suggestions etc.)
  subject text,
  suggestion_count int not null,
  message_id text,
  dry_run boolean not null,
  error_code text
);
create unique index agent_send_log_run_id_active_idx
  on agent_send_log (run_id)
  where status in ('sending', 'sent');
