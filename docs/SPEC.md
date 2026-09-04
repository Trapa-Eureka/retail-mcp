# SPEC — retail-mcp v0.1

Written: 2026-09-02 · Status: finalized (when anything changes, update this document first)

## 1. Background

Multi-branch retail in the Philippines (convenience-style stores, general goods, beauty, building materials, etc.) rings up sales on Loyverse-type POS systems, but runs "what sells well (sell-through) and what is about to run out (stockout risk)" on gut feeling. Since the reality is that even if you build them a dashboard they will not go and look at it:

> ⚠️ **2026-09-03 re-review and decision**: The premise above ("they already use a Loyverse-type POS") was an assumption, not a confirmed pilot customer. POS devices themselves have been observed, but the brand (= whether an API exists) is unconfirmed, and there are signals that Excel / in-house ERP / manual inventory management may actually be more common. §1~§10 below are **a verbatim record of v0.1 (Loyverse), which is already implemented and complete**; with production deployment on hold, **the decision is that the next actual release prioritizes developing a CSV/Excel upload data source** (promoted to v0.2; §7 roadmap, §11 details). Loyverse will be reactivated in a later version bump when a pilot confirms use of an API-type POS — the data source sits behind the `LoyverseClient` interface (DESIGN §1), so core / ETL orchestration / MCP tools / agent are reused regardless of data source replacement.

- **BI that answers when asked** — MCP query tools you ask Claude in natural language
- **BI that comes to you** — an agent that computes stockout risk and pushes reorder suggestions

Both are layered on one core. The division of roles follows a settled principle: **querying = MCP, forecasting and sending = agent. Detection and calculation are deterministic code; the LLM does interpretation and wording only.**

## 2. v0.1 Metric Definitions (Source of Truth)

Because receipt (purchase) history is hard to obtain reliably from the Loyverse API, v0.1 uses **approximation formulas computable from sales quantity + current stock alone**. The approximation is not hidden; it is stated explicitly in tool responses and reports.

| Metric | v0.1 definition | Notes |
|---|---|---|
| Sell-through rate (approx.) | Period sales qty ÷ (period sales qty + ending stock) | The canonical definition (sales ÷ (opening stock + receipts)) comes in v0.2 once receipt data is available |
| Average daily sales | Last 28 days sales qty ÷ 28 (calendar days, including no-sale days) | The window is adjustable via a tool argument |
| Days of cover | Current stock ÷ average daily sales | If average daily sales is 0, treat as ∞ (marked separately) |
| Stockout risk | Days of cover < lead time + safety days | Default lead time 7 days, safety 3 days (adjustable via arguments) |
| Reorder suggestion qty | max(0, ⌈target days of cover × average daily sales − current stock⌉) | Default target cover 21 days. Pack size rounding is v0.2 |

## 3. v0.1 Goals

1. **ETL**: Incrementally sync stores, products, receipt lines, and current stock from Loyverse into Postgres. Leave an inventory snapshot on every sync to start building a time series.
2. **6 MCP tools**: `sell_through`, `inventory_status`, `stockout_risk`, `reorder_suggestions` (query type), `sync_now`, `sync_status` — natural-language querying from Claude Code/Desktop.
3. **Reorder agent**: run `npm run agent:reorder` once → compute stockout-risk items → exit if 0 suggestions → the LLM writes a 2~3 sentence summary (figures come only from the table) → send email (adapter ported from sheet_mcp) → send log. Registering with cron is just a matter of hooking up this script.
4. The numbers from the two paths (tool query / agent report) on the same data always match (same core functions are used).

## 4. v0.1 Non-Goals

- CSV/Excel upload-based inventory data source — out of v0.1 scope (promoted to v0.2, see §7 roadmap. Originally a secondary goal as a "fallback for other POS such as StoreHub", but the 2026-09-03 decision raised its priority to the primary data source of the next actual release)
- SCM sheet (purchase order / receipt) integration — v0.2 (planning to reuse the sheet_mcp sheet client)
- Free-form SQL query tool (`explore_sql`) — v0.2 (assumes a read-only role + SELECT validation)
- Webhook real-time updates, anomaly detection (voids / discounts) agent — v0.3
- Looker Studio templates / Linking API provisioning — handled separately in the higher-level bi initiative
- Multi-tenancy, self-serve, SMS sending, margin metrics (until cost data quality is verified)

## 5. Representative Scenarios

1. **Query (MCP)** — Owner: "Bottom 10 sell-through over the last 30 days, main store only." → `sell_through(store, period_days=30, order=asc, top=10)` returns a table.
2. **Query (MCP)** — "What looks like it'll run out next week?" → `stockout_risk(lead_time_days=7)` → at-risk items + projected depletion dates.
3. **Agent** — runs every Monday 07:00 → email with a per-branch reorder suggestion table + 2-sentence summary (English/Taglish). No send in weeks with 0 suggestions.

## 6. Success Criteria (v0.1 completion judgment)

- Manual smoke test passes with 1 real Loyverse account (test store data): sync → tool query → agent dry-run report.
- Running sync twice in a row produces 0 duplicate loads (idempotent upsert).
- Figures for the same item match between tool responses and the agent report.
- `npm run check` passes, `src/core/` coverage 90% or higher.

## 7. Roadmap

**2026-09-03 realignment**: The CSV/Excel data source is pulled forward as the next actual release target, and Loyverse is deferred until a pilot confirms use of an API-type POS (§11 decision). v0.1 (Loyverse) code is complete but production deployment is on hold — the data source is isolated as an adapter, so this is a standby state, not a discard.

| Version | Content | Prerequisite |
|---|---|---|
| v0.1 | Loyverse ETL + 6 MCP tools + reorder agent (email) — **implementation complete (T0~T11), production deployment on hold (pilot unconfirmed)** | — |
| **v0.2** | **CSV/Excel upload-based inventory data source (next actual release target)** — folder watch channel (periodic cron scan), embedded PGlite warehouse + own file lock (§12) | New backlog (TASKS.md) designed |
| v0.3 | **Reactivate the Loyverse (and other API-type POS) adapter**, webhook real-time, anomaly detection agent (voids / discounts / inventory mismatches) | Pilot confirms API-type POS use |
| v0.4 | Extract the notification layer into a shared package (shared with sheet_mcp), multi-branch comparison weekly report, decide on generalizing bi_mcp | Both repos stabilized |

## 8. Open Items

- [x] **(Decided 2026-09-03)** Data source priority: develop CSV/Excel upload first, defer Loyverse to a version bump (§7·§11). The order was set on the judgment that "Excel / manual is likely more common" without waiting to confirm the pilot's actual POS / inventory management method — if a pilot later confirms API-type POS use, reactivate the Loyverse adapter (implementation complete).
- [x] **(Decided 2026-09-03)** CSV/Excel layout and channel scope finalized — folder watch channel only, fixed template, automatic encoding detection, sell-through / threshold branching depending on presence of sales history, embedded PGlite warehouse. Details in §12.
- [x] **(Decided 2026-09-03)** Execution model: settled on **periodic scan (cron)**, the same as the existing `agent:reorder` — an always-on watcher (daemon) burdens non-developer operators with new operational load such as restarts and crash recovery, whereas there is no need to reflect stock changes in real time (reorder decisions are already designed on a weekly cadence, §5). Details in §12.
- [x] **(Decided 2026-09-03)** Multi-branch head-office consolidated view: settled on HQ collecting per-branch output. Details in §12 "Multi-branch head-office consolidated view".
- [x] **(2026-09-03 spike result)** PGlite multi-process concurrent access: actual reproduction shows that overlapping opens raise no error and instead **the writes of the process that opened later are silently lost** (silent data loss, not a lock rejection). Decided that retail-mcp blocks concurrent access with its own file lock (PID + timestamp) — confirmed as an implementation requirement. Details and reproduction method in §12.
- [ ] Loyverse cost field data quality → whether to include margin metrics (re-review when the Loyverse adapter is reactivated)
- [ ] A way to give different lead times per supplier (v0.1 is a global default + argument)
- [ ] Reorder report recipients: single owner vs split per branch manager (v0.1 is a single recipient)
- [ ] Confirm pilot store candidates (2 or more branches)

## 9. v0.1 Operating Assumptions and Judgment Rules

- **Deployment unit**: One deployment and one DB serve exactly one business. Multi-tenant isolation is out of v0.1 scope.
- **Time basis**: Raw timestamps are stored in UTC. Calendar-day boundaries for "last N days" and report display are based on the business timezone (default `Asia/Manila`), and the configured value is shown in the report.
- **Sales quantity**: Use net sales quantity combining sales and refunds, but feed the metric calculations `max(0, net sales qty)` so that periods where refunds exceed sales do not produce negative demand or negative reorder quantities. The raw net sales quantity is returned as a separate field so data anomalies are not hidden.
- **Cancelled receipts**: Receipts with `cancelled_at` (transactions cancelled regardless of Loyverse `receipt_type`) are included in neither the sales nor the refund aggregates — they are incomplete transactions, so they are excluded entirely from sell-through, days of cover, and reorder quantity calculations (no impact on stockout risk etc.). This exclusion is performed in ETL (T7).
- **Inventory exceptions**: Negative current stock is flagged as a data-quality warning and 0 is used in calculations. Sales lines whose item or store reference is missing fail the sync to prevent silent omissions.
- **Amounts and currency**: The v0.1 core metrics are quantity-based. When displaying revenue, the Loyverse currency code is returned alongside, and different currencies are never summed together.
- **Data freshness**: Every query and report includes the timestamp of the last successful sync. If the allowed freshness threshold is exceeded, results are not hidden; a `stale` warning is attached.
- **Nature of suggestions**: The reorder quantity is a purchase order draft, not automatic ordering. The report states explicitly that outstanding orders, supplier minimum order quantities, and pack sizes are not included in the v0.1 calculation.

## 10. v0.1 Additional Non-Functional Criteria

- API tokens and personal data are not included in logs, tool responses, or LLM input. Only the item names and deterministic results needed to write the reorder table are passed to the LLM.
- External APIs must support timeouts, bounded retries, and 429 `Retry-After`, and must not retry indefinitely. Loyverse states a per-account "300 requests per 300 sec" limit in its official docs (developer.loyverse.com/docs "API rate limits", confirmed 2026-09-03, an account-level limit independent of plan) — rather than reactively receiving a 429 after hitting this limit, the client proactively throttles itself with sliding-window rate limiting (default 250 requests/300 seconds, adjustable via `LOYVERSE_RATE_LIMIT_MAX_REQUESTS`/`LOYVERSE_RATE_LIMIT_WINDOW_MS`).
- On sync failure, the last successful data remains queryable, but the `stale` status and the failure cause are exposed. A partial load must never appear as a successful sync.

## 11. Re-review of Usage and Data Source (2026-09-03)

Conclusions reached after completing the existing T0~T11 implementation (merged to main), while examining "where is this MCP + agent actually going to be connected and used". No code changes; this records the rationale for subsequent prioritization.

### Usage channels

- The **6 MCP query tools** are regarded as primarily a channel for **developers/operators** using Claude Code (local stdio connection, DESIGN §9). The scenario where a store owner installs Claude Code/Desktop directly and asks in natural language remains as an example in §5, but it is not a confirmed use case — we judge it unlikely that a non-developer store owner will install and configure a paid desktop app.
- **The reorder agent's email report is effectively the only channel on the store owner's side** — no installation or login required. The "BI that comes to you" (agent) is the product's real owner touchpoint, and the "BI that answers when asked" (MCP) is closer to an internal tool for operators to verify and analyze data.
- If owner-facing expansion becomes necessary (web dashboard, messenger notifications, etc.), design it separately from the MCP layer — this decision does not eliminate the need for the MCP tools themselves (they remain valid as an operator channel).

### Data source re-review

- v0.1 was implemented and completed as a Loyverse ETL, but that was an assumption chosen with no confirmed pilot candidate. There are observation-based signals that the actual target (an unspecified population of multi-branch retail stores / head offices) is **more likely to use Excel / in-house ERP / manual inventory management** than an API-type POS such as Loyverse (top-priority item in §8 open items).
- Fortunately, the `LoyverseClient` interface (`core/types.ts`) isolates POS-dependent logic behind an adapter (DESIGN §1 architecture). Even if the data source is replaced or augmented with a CSV/Excel upload parser or similar, `core/metrics.ts` (metric calculation), `etl/sync.ts` (sync orchestration), the 6 MCP tools, and the reorder agent are reused as-is — meaning most of the T0~T11 work remains valid regardless of data source. This re-review does not invalidate the existing implementation.
- **The next decision is customer confirmation first, not code**: after checking the inventory management method of 2~3 actual pilot candidates, decide whether to (a) adopt the Loyverse adapter as-is, or (b) prioritize developing the CSV/Excel upload adapter now instead of deferring it to v0.2. Until confirmation, do not invest further deeply in either direction.

### Decision (2026-09-03)

**(b) Develop the CSV/Excel upload data source first, and add (a) Loyverse in a later version bump.** The priority was fixed while the pilot candidates' inventory management method is still unidentified — not "decide after confirmation" but ordering first on the judgment that "Excel / manual management is likely more common", and if an actual pilot is confirmed to use an API-type POS (Loyverse etc.), reactivate the Loyverse adapter (T0~T11, already implemented and complete) at that point. Reflected in the §7 roadmap. The detailed data format (which CSV/Excel layouts to support) is still undecided — to be designed as a separate task.

## 12. v0.2 CSV/Excel Channel Design (2026-09-03)

Decisions made after the §11 decision while fleshing out "what onboarding connects things after installation". No code changes; this records the rationale for subsequent task design.

### Connection channel: folder watch only

Of the three channels the user proposed (folder / local or Google Excel original / ERP integration), v0.2 builds **folder watch only**.

- **ERP integration is not treated as a channel.** ERPs differ per product in whether an API exists and what shape it takes, so "integration" is not a single feature but a separate integration project per system. The realistic path is "export from ERP to CSV/Excel → feed into the folder channel", in which case it is absorbed as one use case of the folder channel.
- **Adding a new sheet to the user's local Excel original is not adopted.** If the user has that file open in Excel, there is a risk of write conflicts and corruption, and having a program directly modify the user's original working file is itself a trust risk. Originals are treated as read-only, and results go out as separate output.
- **Google Drive Excel integration is deferred.** It would add the entire Google Sheets API OAuth authentication flow, greatly expanding scope.

### Column layout: fixed template

Instead of "free mapping" that takes the user's file as-is and infers columns, retail-mcp provides a template file with column names it defines, and the user fills it in to fit that frame. The parser becomes simpler and onboarding faster.

| Column | Required | Description |
|---|---|---|
| `store` | Required | Branch identifier |
| `product` | Required | Item name |
| `sku` | Required | Must be unique per store+SKU |
| `stock_qty` | Required | Current stock |
| `sales_qty` | Optional | If present, sell-through / average daily sales can be computed (§2 approximation). If absent, threshold fallback (below) |
| `period_start`/`period_end` | Optional (required if `sales_qty` is present) | Because this is a period total rather than receipt-level history, the period over which `sales_qty` was summed must be stated for average daily sales to be computable |
| `unit_price`/`currency` | Optional | For displaying revenue. Amounts are not summed without a currency code (same principle as §9) |
| `low_stock_threshold` | Optional | Per-product override. If absent, the global default is used |
| `pack_size` | Optional (§14) | Units per pack/box, greater than 0. When present, the suggested reorder quantity is rounded up to a whole number of packs |

### Encoding: auto-detect + fallback

UTF-8 is not assumed by default. Korean Windows Excel saves are commonly CP949/EUC-KR, and files mixing Filipino/Tagalog text can vary widely. Attempt automatic detection with a library, and if confidence is low, let the user pick from a list during onboarding (a confirmation question is better than silent mojibake).

### When there is no sales history: threshold fallback

A file without the `sales_qty` (and period) columns cannot compute sell-through, average daily sales, or days of cover (§2) — without sales history, an inventory snapshot alone gives no "sales velocity". In this case:

- **Skip the sell-through calculation** (display the metric as "no sales history"; do not silently treat it as 0).
- **Send a low-stock alert only when `stock_qty < threshold`** (global default or per-item `low_stock_threshold`) — a simple rule separate from the §2 approximate sell-through logic.
- Files with sales history apply the existing §2 approximation as-is. This means that within the same v0.2 deployment the two modes can be mixed per branch, or even per point in time for the same branch — MCP responses and reports must indicate which mode the calculation used.

### Execution model: periodic scan (cron)

Folder watch is settled as a **periodic scan**, the same as the existing `agent:reorder` — an always-on watcher (a daemon detecting filesystem events in real time) requires managing a newly always-running process (crash recovery, restart registration, log management). That is an operational burden hard to impose on non-developer operators, whereas there is no reason to reflect stock changes in real time — reorder decisions are already designed on a weekly cadence (§5 representative scenarios), and the frequency at which manual/Excel stock is updated is itself far from real time.

- Register the folder-scan script in the same way as the README's cron/launchd registration example (`agent:reorder`), following the same pattern.
- A single scan run completes "parse the folder's current files → warehouse upsert → low-stock alert (if needed) → (if a branch instance) refresh the snapshot file" in one go — one script does everything with no separate trigger, so the freshness of the snapshot a branch sends to HQ automatically matches this scan cadence (resolving the "unresolved" item in the multi-branch section).
- The scan interval itself (e.g. once a day) is set by the cron expression and is not hard-coded in app code — the operator sets it to suit the business.
### Warehouse: embedded PGlite by default, Neon as an option

The original "DB is Neon" decision (before §11) assumed Loyverse adoption. CSV/Excel channel users may be retail operators closer to non-developers, and creating a Neon account, issuing a connection string, and configuring `.env` is a high barrier relative to the expectation of "npm install and point at one folder".

- The v0.2 **default runs PGlite locally in embedded, file-persistent mode** (e.g. `.retail-mcp/data/`) — no separate account signup, no network DB. The `pgWarehouse` adapter is already tested to work against both PGlite and real Postgres (`src/mocks/`), so only "which Postgres instance is used" changes; the adapter contract itself is unchanged.
- If `DATABASE_URL` is specified, a network Postgres such as Neon can be used as before — kept as an option for businesses that want to consolidate multiple branches in one DB (connected to the multi-branch open question below).
- Needs confirmation (§8): PGlite's behavior when multiple processes open the data directory concurrently is not as well verified as real Postgres — since CLI onboarding, the MCP server, and the agent cron could open the same directory concurrently on the local machine, verify with a spike when implementation starts.

### Multi-branch head-office consolidated view

If each branch loads into a local PGlite, data is separated per branch. For HQ to see multiple branches at once the results must be gathered, and rather than requiring branches to upload to a shared Neon, the decision is **HQ collects per-branch output files** — consistent with the warehouse section's principle of "do not require non-developer branch users to be issued DB accounts".

- **Branch instances** operate as designed so far — process their own inventory file via folder watch, load into local PGlite, and send that branch's own low-stock alerts.
- A branch instance also exports its processing results as a **snapshot file in the same fixed template format as the §12 column layout**. Since `store` is already a required column, it is reused as-is with no schema change — this snapshot is not a human-readable summary but a machine-readable output that can be read back in.
- The **HQ instance** is a separate installation of the same retail-mcp in "consolidated view" mode, observing a "collection folder" where each branch's snapshot files gather, via the identical folder watch channel. The transport by which branch snapshots reach that folder (shared-drive sync the business already uses, manually saving email attachments, USB, manual copy, etc.) is not prescribed by this design — no new sync service is built; it rides on means already in use.
- Because the HQ instance loads multiple branches' snapshots into the same schema (store name is already the discriminator), the branch filtering the existing MCP tools and agent already support (§5 "main store only" example) serves multi-branch comparison and consolidated queries as-is with no schema change.
- Loading is an upsert per (store, SKU) as of the snapshot time. A branch file is not a transaction log but a full inventory/sales summary at that point in time, so the HQ ETL commits that branch's watermark only after the branch's snapshot file has been fully and successfully parsed — the principle of not advancing the watermark in a partially parsed state (CLAUDE.md implementation interpretation supplement) is upheld at the branch level as well.
- The HQ instance's warehouse choice follows the same criteria as the "Warehouse" section above — if viewed from one office and one device, local PGlite suffices; if multiple people on multiple devices need to view it, choose Neon via `DATABASE_URL`.
- This design means onboarding needs a mode selection: "branch (single store)" vs "HQ (multi-branch consolidated)" — the detailed steps of the onboarding wizard are decided in the actual implementation task.
- No separate snapshot transfer cadence is defined — per the "Execution model" section above, a branch's single scan includes the snapshot refresh, so it automatically equals the branch's folder watch cadence.

### PGlite multi-process concurrent access (spike result, 2026-09-03)

This was not something to settle on paper; it needed actual reproduction, so it was verified with a spike. Method: two different Node processes (A, B) open the same file-persistent PGlite data directory with overlap — A opens first, inserts one row, and keeps the connection for 6 seconds (mimicking a long-running MCP server); 1.5 seconds later B opens the same directory and inserts its own row. After both A and B exit, a third process C reopens the directory to check the final state. Repeated twice to confirm reproducibility.

**Result — PGlite neither raises an error nor blocks on overlapping opens. Instead, the writes of the process that opened later (B) silently disappear.** Within its own session, B's insert appeared to succeed (the row it inserted was visible to its own SELECT), and no error occurred at all. Yet when C reopened after A and B had both finished, **B's row was gone and only A's row remained** — not a rejection from lock contention, but the later process's writes lost without ever being made durable. The PGlite README also states "single user/connection" (confirmed 2026-09-03, local package docs). Silent data loss is more dangerous than a lock conflict — no error message, and from that process's perspective it looks like success.

**Response (confirmed as a v0.2 implementation requirement)**: Do not rely on PGlite's own concurrency guarantees; retail-mcp maintains **its own external lock** — before opening the PGlite data directory, check a lock file containing PID + timestamp, and if a still-alive process is using that directory, **refuse to start** (error message including cause + remedy, CLAUDE.md convention). The goal is to prevent CLI onboarding, the MCP server, and the agent cron scan from opening the same directory concurrently; the §12 "Execution model" decision (one-shot scan script, not an always-on daemon) shortens the overlap window but does not eliminate it entirely (e.g. the next cron overlapping before a slow scan finishes, or a person re-running onboarding in the middle of a scan).

### Actual usage procedure (implementation complete, 2026-09-03, TASKS T12~T22)

The entire design above has been implemented — this section is not a new decision but a reference connecting the design to the actual commands/files that implement it. The human-run procedure is laid out with actual commands in the README "CSV/Excel channel quickstart" — here we only briefly note how those commands correspond to the design sections above.

- **Onboarding** (`npm run onboard`, `src/cli/onboard.ts`) — interactively implements the "branch/HQ mode selection" from the "Connection channel: folder watch only" and "Multi-branch head-office consolidated view" sections. Choosing branch mode creates an example template CSV in the watched folder with headers exactly identical to the "Column layout" table above (reusing the snapshot export function rather than rebuilding it arbitrarily — structurally, the two outputs cannot diverge).
- **Branch scan** (`npm run agent:folder-scan`, `CSV_MODE=branch` default) — implements the "Execution model" section's "one scan = parse → load → alert → snapshot refresh" as-is. The sales-history branching ("When there is no sales history: threshold fallback") is recorded in the result as `mode: "history" | "no_history"`, and the report also shows which mode the calculation used.
- **HQ consolidated scan** (`CSV_MODE=consolidated`, `CSV_COLLECT_DIR`) — implements the "Multi-branch head-office consolidated view" section's "commit a branch's watermark only after its snapshot file has been fully and successfully parsed" as independent per-branch transactions. The snapshot transport itself (shared drive / email attachment / USB) is still not prescribed by this project — it only assumes the files have arrived in the collection folder.
- **Concurrent access prevention** — the response from the "PGlite multi-process concurrent access" section above (own file lock) is implemented in `src/adapters/fileLock.ts` + `src/adapters/warehouseFactory.ts` (a shared path that every entry point opening the embedded PGlite route goes through).
- **e2e verification** (`tests/e2eCsvChannel.test.ts`) — passes the branch-standalone scenario (file → parse → load → actual send) and the HQ consolidated scenario (two mutually independent warehouses each produce real snapshot files, which a third independent warehouse collects and queries filtered by store name) end to end on a real filesystem and PGlite.

## 13. SCM Sheet Integration + Stock Reconciliation Check (2026-09-03, v0.2 queue started)

The "SCM sheet integration" and "canonical sell-through" items from the "v0.2 queue" in `docs/TASKS.md` are designed and started based on the actual sample Google Sheet the user provided (purchase order / receipt data, 5 tabs: "Product List", "In/Out History", "Stock Status", "Sales Summary", "Dashboard").

### Scope decision — what is done now / what is deferred

- **Done**: a schema and warehouse layer that loads **only rows with `type=inbound`** from the sheet's "In/Out History" tab into a new table (`purchase_receipts`), plus a pure function (`computeStockReconciliation`) that computes "canonical sell-through" and "stock reconciliation check" from those receipt actuals.
- **Rows with `type=outbound` are not loaded.** retail-mcp's sales source is the Loyverse/CSV channel — loading the SCM sheet's outbound rows through a separate pipeline would double-count the same sales.
- **The "purchase order" state (ordered but not yet received) is not handled.** The sample sheet examined has no purchase order status column at all — all it has is "receipt actuals" that have already arrived. The feature that "SCM sheet integration" originally targeted, "subtract outstanding orders from reorder suggestions", becomes possible as follow-up work only once that column is added to the sheet.
- **Actual Google Sheets API integration is deferred.** For the app to read the sheet directly it would need new credentials and dependencies such as a service account/OAuth (`googleapis`), which is a new decision not in the CLAUDE.md secrets list, so it was excluded from this scope. For now the sheet snapshot is used only as a test fixture (`tests/fixtures/scm/sample-receipts.csv`, the actual sample sheet values verbatim). The real integration method (service account vs public-link CSV export) is decided in a later separate task.
- **Store mapping**: The sheet itself has no store discriminator (single-business assumption). `mapScmRowsToPurchaseReceipts(rawRows, storeId)` takes `storeId` explicitly from the caller — unlike the CSV channel's required `store` column, this sheet has no such concept to begin with, so it is filled in at the adapter boundary.
- **MCP tool and agent wiring is out of this scope.** What ships now is only the `core/` (schema + metric calculation) and `Warehouse` (load + query) layers — exposing it in an MCP tool such as `sell_through` or having the reorder agent reference it is a task that follows once actual Google Sheets integration is decided.

### Finding — "canonical sell-through" is algebraically identical to the approximation

`sales ÷ (opening stock + receipts)` (canonical) and `sales ÷ (sales + ending stock)` (§2 approximation) yield **the same value**, because as long as inventory is conserved (`opening stock + receipts − sales = ending stock`) the two denominators are always equal. v0.1 used the approximation not because the formula was inaccurate but simply because receipt data itself was unavailable, so it computed from the observable ending stock instead.

Therefore the real value of this feature is not "a more accurate sell-through number" but **stock reconciliation checking** — the "Stock Status" tab of the sample sheet examined **computes** `current_stock` as `total inbound − total outbound` rather than from a physical count (stated in the sheet's notes). By contrast, retail-mcp's stock quantity (Loyverse/CSV `stock_qty`) is a **count-based** value reported by the POS. Reconciling the two values (the ledger's computed expected stock vs the actual stock reported by POS/CSV) can catch inventory losses not captured in the ledger, such as theft, damage, or count errors — `computeStockReconciliation` surfaces this via `discrepancy`/`hasDiscrepancy`.

### Implementation

- `migrations/004_purchase_receipts.sql` — `purchase_receipts(store_id, variant_id, received_at, received_qty, unit_cost, currency, vendor)`, PK `(store_id, variant_id, received_at)`. If there are multiple receipts for the same store, SKU, and date, the last value overwrites (not summed) — documented as a v0.1 limitation arising from the source sheet having no event sequence number (add a sequence column if needed).
- `src/core/types.ts` — `PurchaseReceiptRow`, `PurchaseAgg`, `Warehouse.upsertPurchaseReceipts`/`queryPurchaseAgg` (reuses `SalesAggQuery`, symmetric with `querySalesAgg`).
- `src/adapters/pgWarehouse.ts` — implements the two methods above. `received_at` is a `date` column, so period boundaries are compared with `::date` (business-timezone-aware boundary conversion is out of this scope — documented as a known simplification).
- `src/core/scmSchema.ts` — `scmReceiptRowSchema`, which validates with zod the English headers of the sample sheet's "In/Out History" tab (`date`/`type`/`sku`/`product`/`qty`/`unit_price`/`vendor`; `type` is `inbound` or `outbound`), and `mapScmRowsToPurchaseReceipts`, which filters to `type=inbound` rows only and converts them to `PurchaseReceiptRow[]`.
- `src/core/metrics.ts` — `computeStockReconciliation(inventory, purchases, sales, opts)`. Opening stock can be given explicitly via `opts.openingStock` (key `${storeId}:${variantId}`); if absent, 0 (treated as starting the ledger fresh from that point — the flow of entering a one-time count value during onboarding is a later task).
- Tests: `tests/scmSchema.test.ts`, `tests/metrics.test.ts` (`computeStockReconciliation` describe), `tests/pgWarehouse.test.ts` (`purchase_receipts`/`queryPurchaseAgg`) — the golden case numbers (P001: receipts 30 · sales 21 · counted stock 9) are the actual sample sheet values verbatim.

## 14. Pack Size Rounding (2026-09-03, v0.2 queue started)

The "pack size rounding" item from the "v0.2 queue" in `docs/TASKS.md` is started based on a new version of the §13 sample sheet the user uploaded, filled in with a pack-size column and verification calculations (computed suggested qty / final order qty / order pack count).

### Background

The reorder suggestion quantity computed by `reorderQty()` (§2) is in units. Actual ordering is often possible only in the pack/box units set by the supplier — even if the calculation says 27 units are needed, if you can only buy in boxes of 24 you actually have to order 48 (2 boxes). This feature is that post-processing step.

### Implementation

- `migrations/005_product_pack_size.sql` — `products.pack_size` (nullable numeric, `pack_size > 0` check). If absent, the item is treated as purchasable individually.
- `core/types.ts` — `ProductRow.packSize` (optional). Unlike `lowStockThreshold`, it is **source-neutral** (not CSV/Excel-specific) — it does not matter which channel fills it.
- `adapters/pgWarehouse.ts` — `upsertProductsOn` also upserts `pack_size`. Same `coalesce` pattern as `low_stock_threshold` (TASKS T16) — an upsert that does not fill this value does not silently erase a value another channel has already stored.
- `core/metrics.ts` — **`reorderQty()` itself is untouched.** Instead:
  - `roundToPackMultiple(reorderQtyValue, packSize)` — a pure function alongside the 5 pure formulas of §2. If `packSize` is absent, returns the value unchanged without rounding (`packCount: null` — distinguishing "no pack size" from "0 packs needed"). If the suggestion quantity is 0, it is not rounded up to 1 pack even if `packSize` is present (0 packs).
  - `applyPackRounding(rows, products)` — applies `ProductRow.packSize`, joined on `(storeId,variantId)`, to the array produced by `computeReorderMetrics` (or the history rows of `computeCsvReorderMetrics`). Same pattern as TASKS T17 wrapping `computeReorderMetrics` with `computeCsvReorderMetrics` — the original function is unchanged.
- **Also added as an optional column to the CSV/Excel template** — `pack_size` (optional, greater than 0) added to `core/csvSchema.ts`, and `adapters/csvExcelParser.ts` validates value consistency for the same SKU in the same way as `low_stock_threshold` and converts it to `ProductRow.packSize`. Existing templates (files without this column) pass unchanged — backward compatible. **Actually wiring it into T18 folder scan, agent, and MCP tools carried over to T25** — see §15 below (out of scope when this section was written, but started afterwards).
- Tests: `tests/metrics.test.ts` (`roundToPackMultiple`/`applyPackRounding` describes — the golden cases use verbatim the "computed suggested qty → final order qty / order pack count" values for the 8 items the §13 sheet had already computed itself), `tests/csvSchema.test.ts`, `tests/csvExcelParser.test.ts`, `tests/pgWarehouse.test.ts` (`pack_size` upsert / coalesce).

## 15. MCP Tool and Agent Wiring (2026-09-03, T23/T24 follow-up)

Starts the **pack size rounding (§14) portion** of the "MCP tool and agent wiring" that T23 and T24 each deferred. Stock reconciliation checking (§13) is not covered in this section — see "Not done this time" below.

### Wiring targets

- **`buildReorderReport()` in `agent/reorder.ts` (Loyverse path)** — joins the `computeReorderMetrics` result with `ProductRow.packSize` fetched via the newly added `Warehouse.queryProducts(variantIds)` using `applyPackRounding()`, and fills `packSize`/`finalOrderQty`/`packCount` on `ReorderLineItem`. Since the `reorder_suggestions` MCP tool reuses `buildReorderReport()` as-is (T9 decision), **it is wired automatically with no separate tool code change** — the "tool result = agent report" regression guard is preserved intact.
- **CSV channel alerts in `agent/folderScan.ts`** — applies `applyPackRounding()` to the history-mode rows of `computeCsvReorderMetrics` (the CSV parse result already carries `ProductRow.packSize`, T24) and shows "suggested N → final order qty M (K packs)" in the low-stock alert. no_history mode has no sales history and thus no reorder suggestion quantity at all (T17 design), so it is not a target.
- **New `Warehouse.queryProducts(variantIds?)`** — discovered mid-task that the Loyverse path does not hold `ProductRow` in memory (products are upserted to the DB at sync time and that is it) and `queryStock`/`querySalesAgg` select only `name`/`category` — there was simply no way to read `packSize` back. It is a read-only query, so it does not conflict with guardrail 4 ("warehouse writes only via the ETL path").

### Not done this time

- **Stock reconciliation checking (§13, `computeStockReconciliation`) is not connected to either MCP or the agent.** Reason: this calculation takes `Warehouse.queryPurchaseAgg` (SCM receipt actuals) as input, and with no real SCM data ingestion path today, `purchase_receipts` is always empty in production — running the calculation in that state would mistake "0 receipts" for actual receipt history and falsely flag `discrepancy` on every item. Rather than automatically surfacing meaningless warnings, exposure is deferred until a real data ingestion path exists (→ §16).
- No new MCP query tool is added — this wiring is completed purely by reusing the existing 6 tools (including `reorder_suggestions`).

### Implementation

- `core/types.ts` — `Warehouse.queryProducts(variantIds?: string[])` (queries all `ProductRow[]`; omitting variantIds returns all, an empty array returns an empty result), `packSize`/`finalOrderQty`/`packCount` fields added to `ReorderLineItem` (required, not optional — `buildReorderReport()` now always fills them).
- `adapters/pgWarehouse.ts` — `queryProductsOn` implemented.
- `agent/reorder.ts` — `buildReorderReport()` calls `queryProducts` + `applyPackRounding`; `renderReportText`/`renderReportHtml` show pack size rounding via a `formatOrderQty()` helper ("42 → final order qty 48 (2 packs, 24 per pack)").
- `agent/folderScan.ts` — `alertsFrom()` additionally receives `products: ProductRow[]` and applies pack size rounding to history-mode rows; `reorderQty`/`finalOrderQty`/`packCount` added to `FolderScanAlertItem` (optional fields — absent in no_history mode).
- Tests: `tests/pgWarehouse.test.ts` (`queryProducts`), `tests/reorderAgent.test.ts` (golden case with packSize), `tests/claudeSummarizer.test.ts` (report type update), `tests/folderScan.test.ts` (CSV alerts with and without pack size rounding applied). The existing "tool = agent exactly identical" regression guards in `tests/mcpTools.test.ts`/`tests/e2e.test.ts` pass unchanged with no code change because both paths reuse the same function.

## 16. SCM Receipt Actuals — Absorbed via Manual CSV Export (2026-09-03, T23/T25 follow-up)

Makes the stock reconciliation check (§13, §15), which T25 deferred as "meaningless without real Google Sheets integration", actually usable. **Real Google Sheets API integration is not adopted** — the "Approach re-review" below explains why.

### Approach re-review — why not a service account

This project assumes distribution via npm to an unspecified audience (including non-developer retail operators) (SPEC §11 "Usage channels" redefinition and §12 "Warehouse: embedded PGlite by default" have already made several decisions on this premise). Three approaches were re-checked against this premise:

| Approach | What the user has to do every time | Verdict |
|---|---|---|
| Service account + Sheets API | Sign up for Google Cloud Console → create project → enable API → create service account → issue JSON key → share their sheet with that account's email. Cannot be automated by the onboarding CLI (manual console operation, not a browser login) | **Rejected** — a higher barrier than even the Neon DB connection string (already judged in §12 to be "a high barrier", leading to the PGlite default) |
| Public-link CSV export | Switch the sheet to "anyone with the link can view" | **Rejected** — purchase unit costs, vendors, etc. become effectively public on the internet (also contrary to the §9 principle) |
| OAuth (connect with the user's account) | Low user burden, but the maintainer must newly implement OAuth client registration + a local redirect server (`gh`/`gcloud` pattern) + token storage and refresh | **Deferred** — the highest implementation complexity of the three. If real-time automation is confirmed to be actually needed (the same pattern as with Loyverse), review it then in a version bump |
| **Manual CSV export → absorbed by the folder channel** | One "File > Download > CSV", place it in the watched folder | **Adopted** |

**Rationale for adoption**: `docs/SPEC.md` §12 already set the precedent "ERP is not treated as a channel — export from ERP to CSV/Excel → feed into the folder channel". Google Sheets can be treated identically — no new dependencies or secrets at all, and T23's `mapScmRowsToPurchaseReceipts` is already a pure function taking "an array of raw rows parsed by header", so it is reused as-is. It also fits naturally with §12's "Execution model: periodic scan, not an always-on watcher" decision — the folder channel is itself a model of "when a person updates a file, the next scan reads it", so the single manual step of "export" is not out of place.

### Implementation

- **`SCM_RECEIPTS_DIR`** (optional, branch mode only) — if set, `runFolderScan` finds the latest CSV in this folder, parses it with the T23 schema, and loads it via `Warehouse.upsertPurchaseReceipts`. If unset, behavior is completely identical to before (stock reconciliation check skipped).
- **Store attribution**: The SCM sheet itself has no store column (already confirmed in §13). If the inventory file in this scan has exactly one store, it is inferred automatically; if several, it must be specified via `SCM_RECEIPTS_STORE_ID` (or the `scmReceiptsStoreId` option) — otherwise a clear error.
- **SCM failure isolation**: Even if the SCM file is missing or fails to parse, the branch scan's core mission (low-stock alerts) proceeds as usual — only a warning is left and only the stock reconciliation check is skipped. The CSV channel (T18) principle of "abort with a clear error rather than a partial load" applies only to the inventory file itself; SCM is an auxiliary feature and is isolated.
- **Stock reconciliation calculation scope**: computed **only from the SCM file and inventory file just parsed in this scan**, with no DB re-query (the same pattern as T17 avoiding DB re-queries). Because `sales_period_agg` is **replaced** with the latest period on every scan rather than accumulated (TASKS T12), this is **an approximate reconciliation for only the period this scan reports**, not "the full cumulative total since tracking began".
- **insufficient_data when opening stock or period is unconfirmed (006 DATA-006, TASKS T33)**: If opening stock (`openingStock`) is not passed explicitly (entering a count value during onboarding is still a later task — so today it is never passed) or the SCM receipt period and sales period do not overlap, `computeStockReconciliation` marks the row `insufficientData: true` and does not emit a warning that asserts a definite cause such as "theft, damage, or count error" — previously it silently assumed 0 as opening stock, which could produce a flood of false discrepancy warnings (the pre-fix state). `agent/folderScan.ts` keeps only confirmed discrepancies in `reconciliation` and reports insufficientData status in a one-line `scmStatus` summary.
- **Alert consolidation**: Low-stock alerts and stock reconciliation warnings (**only rows with confirmed discrepancies**) are combined into **the same email** (no new separate send pipeline) — even with 0 low-stock alerts, confirmed reconciliation discrepancies alone qualify for a send. insufficientData / SCM processing failures are included only as a separate summary line (DATA-007).

### Implementation files

- `core/scmSchema.ts`/`core/metrics.ts`/`core/types.ts`: reuse what T23 already built as-is (no changes).
- `agent/folderScan.ts`: added `findLatestScmFile` (CSV only), `resolveScmStoreId`, `ingestScmReceipts` (failure isolation), `aggregatePurchases` (sums this scan's file without DB re-query), `salesAggFromCsv` (same pattern as T17's internal mapping). Added `FolderScanOptions.scmReceiptsDir`/`scmReceiptsStoreId`, `FolderScanResult.reconciliation`. `renderAlertText` also renders the stock reconciliation section.
- `.env.example`: added `SCM_RECEIPTS_DIR`/`SCM_RECEIPTS_STORE_ID`.
- Tests: `tests/folderScan.test.ts` (new describe — identical behavior when unset, discrepancy detection golden case, explicit specification required with multiple stores, SCM parse failure isolation, silent skip when file is absent).

## 17. explore_sql — Arbitrary SELECT Queries (2026-09-03, last item of the v0.2 queue)

The last item of the "v0.2 queue" in `docs/TASKS.md`. `docs/DESIGN.md` §6 had already announced this tool by name as "free-form SQL is v0.2 (`explore_sql`, assuming a read-only role)" — it does not violate CLAUDE.md guardrail 4 ("MCP query tools are read-only"); it is the sole exception that guardrail pre-approved. Unlike SCM / pack size, it is a pure security/infrastructure design item unrelated to data or sheets, so it was started without a separate trigger (user confirmed).

### Design — defense in depth

The SQL this tool executes is not a fixed query but **arbitrary text supplied by the user**, so the parameterized-query principle does not apply in the first place (there is no fixed query shape to parameterize — that is the definition of this feature). Therefore the safeguards are designed not as a single layer of "input validation" but as **two layers**:

1. **`core/sqlValidator.ts` (1st layer, UX layer)** — allows only a single statement starting with `select`/`with`, and checks a blocklist such as `insert/update/delete/drop/...` at word boundaries (comments are stripped before validation to avoid false positives). **We know it is not perfect** — blocklist bypass is theoretically possible. Its sole purpose is to improve UX by filtering "obviously wrong requests" with a fast, clear error before execution.
2. **`BEGIN READ ONLY` in `adapters/exploreSqlExecutor.ts` (2nd layer, the real line of defense)** — even SQL that passes validation is executed only inside this transaction mode. The Postgres engine itself rejects every write attempt in this mode (including advancing a sequence with `nextval()`) — even if some SQL bypasses the 1st-layer validator, it is ultimately blocked here. Proven by direct reproduction in tests (`nextval()` is SELECT syntax and passes the blocklist, but the READ ONLY transaction rejects it, `tests/exploreSqlExecutor.test.ts`). This safety holds **even if the executing DB role has write privileges** — separating a read-only role in production (README "Privilege separation") is still recommended, but the tool's safety itself does not depend on it.

> **Correction (2026-09-03, T30, see §18)**: The statement above that "this safety holds even if the executing DB role has write privileges" **was limited to table/sequence writes** — the 005 adversarial review demonstrated that session side effects such as advisory locks and `set_config()` overrides are not blocked by `BEGIN READ ONLY`. §18 reconfirms the policy and adds a function-name blocklist to `sqlValidator.ts` — details in §18 "Tightened explore_sql allow conditions".

The result row limit is applied by wrapping the user's SQL in a subquery from the outside, without parsing or rewriting it (`select * from (<validated SQL>) as t limit $1`) — LIMIT is a bound parameter, and `statement_timeout` is bound as a parameter via `set_config()`, so neither value is interpolated directly into SQL text.

### Known limitation — PGlite does not enforce statement_timeout

Confirmed directly with a spike: embedded PGlite (single-process WASM Postgres) accepts the `set_config('statement_timeout', ...)` call itself, but does **not** actually cancel a long-running query (presumably a structural limitation from having no background interrupt handling) — different behavior from real Postgres/Neon. **Only the "automatically cut off slow queries" feature is affected**; the tool's real safeguard, `BEGIN READ ONLY` (write blocking), was directly confirmed to work normally on PGlite as well — no impact on safety. This limitation is documented in `tests/exploreSqlExecutor.test.ts`, and only the "cancellation behavior" that genuinely cannot be verified on PGlite was removed from the tests (the remaining timeoutMs validation and cap logic is still tested).

### Production defaults and exposure scope

- **Disabled by default** — registered as an MCP tool only when `EXPLORE_SQL_ENABLED=true` (same pattern as `sync_now`'s `SYNC_TOOL_ENABLED`, DESIGN §11.4). Unlike `sync_now`, it does not require `DATABASE_URL` — it does not depend on pg-only features such as advisory locks, so it can be used as-is on the embedded PGlite path.
- The tool description lists the main available tables explicitly so clients do not have to guess the schema.

### Implementation

- `core/types.ts` — `ExploreSqlOptions`/`ExploreSqlResult`/`ExploreSqlExecutor`. An interface deliberately separated from the rest of the `Warehouse` methods (so this one does not blur the fixed-query contract).
- `core/sqlValidator.ts` (new, pure function) — `validateReadOnlySql(sql)`.
- `adapters/exploreSqlExecutor.ts` (new) — `createExploreSqlExecutor(provider)`. Exports and reuses `withSession` from `adapters/pgWarehouse.ts` (same acquire/release pattern).
- `adapters/warehouseFactory.ts` — added `connectionProvider` (common to pg/pglite, always present) to `WarehouseHandle` — a new field in the same position as `pgPool` (pg only, for `sync_now`). For the very few exceptions like explore_sql that need a session outside the Warehouse contract.
- `mcp/tools.ts` — `exploreSqlTool(deps, input)` (the same thin assembly layer as the other 5 tools; logic lives in the executor).
- `server.ts` — `ServerConfig.exploreSqlEnabled`, `RegisterToolsDeps.exploreSqlExecutor`, registered only when `EXPLORE_SQL_ENABLED=true` (clear error if assembly is missing, same pattern as `sync_now`).
- `.env.example` — `EXPLORE_SQL_ENABLED=false`.
- Tests: `tests/sqlValidator.test.ts` (1st-layer unit tests — normal cases, blocklist, semicolon multi-statement, CTE disguise, comment false-positive prevention, identifier partial-match false-positive prevention), `tests/exploreSqlExecutor.test.ts` (2nd layer — READ ONLY demonstration, LIMIT/cap, rollback, nonexistent table error), `tests/mcpTools.test.ts` (thin assembly layer), `tests/server.test.ts` (EXPLORE_SQL_ENABLED gating, symmetric with the `SYNC_TOOL_ENABLED` test), `tests/pgWarehouse.test.ts` (explore_sql case added to T9's "read-only role" test).

## 18. Response to the Pre-npm-Release Adversarial Review — Distribution, Data, and Security Policy Finalized (2026-09-03, TASKS T28)

Immediately after completing the v0.2 queue (§13~§17), a code review (`/code-review`) was run at the user's direction in preparation for npm publish. The verdict was **release blocked** — 40 findings were recorded in `docs/004_NPM_RELEASE_PACKAGING_REVIEW.md`~`docs/008_TEST_AND_RELEASE_GATE_REVIEW.md`, and 5 documentation consistency findings in `docs/009_DOCUMENTATION_CHANGE_STRATEGY.md`. This section corresponds to the "① normative documents first" step recommended by `docs/009` — it contains only policy finalization, not implementation. Finding IDs (REL-\*/SEC-\*/DATA-\*/OPS-\*/QA-\*/DOC-\*) refer to the respective 004~008 documents. Actual implementation proceeds in `docs/TASKS.md` T29~T37.

### npm publish target (REL-001/005/008, DOC-004)

Finalized by user confirmation (2026-09-03, AskUserQuestion):

- **Scope**: `@shiz_son/retail-mcp` — scoped, public distribution. `publishConfig.access=public` is stated explicitly so the scoped package is not accidentally published as the default restricted. **Scope change (2026-09-04, user decision, T37)**: the originally finalized `@trapa-eureka` could not be published as-is because no npm organization by that name exists (`npm org ls trapa-eureka` 403; the publishing account is `shiz_son`). Instead of creating a new organization, the user scope `@shiz_son` owned by the publishing account is used — the principle below, "eliminate name-reuse uncertainty with an account-owned scope", is unchanged. The GitHub repository path (`Trapa-Eureka/retail-mcp`), `author`, and license do not change.
- **Avoiding name-reuse risk**: the unscoped `retail-mcp` is a name with a 2026-01-12 unpublish history (REL-008), so npm may block reuse for a period — using an account-owned scope removes this uncertainty entirely.
- **License**: MIT. Align the LICENSE file with `package.json.license`/`author`/`repository`/`bugs`/`homepage` (REL-005).
- Keep `private: true` until this decision — actually lifting `private` and implementing `bin`/`exports`/`main`/build pipeline/`files` allowlist is T29.

### Data retention policy — SKUs/stores missing from the authoritative snapshot (DATA-002)

The file-based channel (CSV/Excel folder scan, §12) was designed on the premise that "this scan's file is the authoritative source of current state". However, the actual upsert only updates "rows in the current file" and does not remove rows that were in a previous scan but are absent from the new file, so discontinued, disposed, or branch-withdrawn items can remain in the DB permanently and keep getting mixed into reorder suggestions (006 DATA-002).

- **Policy: automatic tombstone.** (store, SKU)/`inventory_levels`/`sales_period_agg` rows that no longer appear in the latest authoritative scan (the latest file in the watched folder in branch mode, the per-branch snapshot in HQ mode) are **marked inactive** — not physically deleted; history is preserved.
- Inactive rows are **excluded** from reorder suggestions, low-stock alerts, and MCP query results (default filter). If they reappear in a file, they are automatically reactivated (same scan upsert path).
- Tombstone judgment is confined to "absent from this scan within the same authoritative boundary (same store, same channel)" — when HQ consolidated mode collects multiple branches' snapshots, another branch's data is not misjudged as missing from this branch's scan (consistent with the independent per-branch transaction principle in §12 "Multi-branch head-office consolidated view").
- Implementation contract in DESIGN §12.2, actual implementation in TASKS T31.

### Repeat-send policy — the problem of reprocessing on every cron even when the file is unchanged (DATA-003)

The branch folder scan generates a new `runId` on every run without comparing the latest file's path/mtime/hash to the previous run — so even if the user does not update the file, the same low-stock email can be sent repeatedly every cron cycle (e.g. daily at 07:00) (006 DATA-003).

- **Policy: guarantee at most one digest per day regardless of whether the file changed, and suppress re-sends within the same day.** Complete silence (never send if unchanged) is not adopted — the user explicitly chose to send at least once a day (AskUserQuestion, 2026-09-03) to avoid the situation where "SCM/file processing fails silently and no alert is ever received" (also connected to DATA-007).
- Judgment criterion: use source identity (watched folder path) + file content hash/mtime to determine "is this scan's input identical to what it was at the last send". If identical, additionally check **whether one day in the business timezone (24 hours or local midnight boundary, to be decided at implementation time, DESIGN §12.3) has passed since the last send** — if not, exit quietly as `unchanged`; if so, send as a digest even with the same content.
- If the file actually changed (content change), send immediately regardless of the daily cap — the cap suppresses only "unchanged repeats".
- **Scope of application finalized (T31)**: the judgment applies only to actual attempts to send email (there are issues and `SEND_MODE=live && --confirm`) — `no_suggestions`/`dry_run` involve no send in the first place, so they are unrelated to this policy and are processed as-is every time (a person's flow of repeatedly checking via dry-run must not be suppressed). Rationale in DESIGN §12.3.
- Implementation contract in DESIGN §12.3, actual implementation in TASKS T31.

### Tightened explore_sql allow conditions (SEC-001/002)

005 demonstrated that the two-layer defense designed in §17 (`sqlValidator` 1st + `BEGIN READ ONLY` 2nd) does actually block **table/sequence writes**, but cannot block session side effects of volatile functions such as `pg_advisory_lock` or `set_config()` overrides inside a user SELECT (e.g. resetting `statement_timeout` to 0) — `BEGIN READ ONLY` means "no writes", not "a side-effect-free sandbox".

- **Policy**: lower §17's design premise that `BEGIN READ ONLY` is the final line of defense — it now guarantees only "writes themselves are blocked", and **production deployments must require a dedicated explore_sql DB role with no permission to execute dangerous functions** (elevating the README "Privilege separation" recommendation to mandatory). The direction of narrowing to queries restricted to allowed schemas/tables instead of permitting arbitrary expressions is not adopted this time — because the very definition of `explore_sql` is "the sole exception with no fixed query shape" (guardrail 4). Instead, defend with role restriction + attack regression tests.
- **PGlite exposure re-review**: PGlite not only does not enforce `statement_timeout` (existing §17 limitation) but does not support role-based function execution restriction at all — enabling explore_sql on embedded PGlite leaves it fully exposed to the DoS path SEC-002 pointed out (no means to cancel a slow query). When `EXPLORE_SQL_ENABLED=true` and the warehouse is on the PGlite path, either expose a **clear warning** (confirming the operator enabled it deliberately) or at minimum state in the docs that the "PGlite + explore_sql" combination is not recommended — whether to block entirely or leave as a warning is finalized at implementation time (T30).
- **Decision (T30)**: finalized as **blocked by default + explicit override**, not a complete block (no exceptions) — if `DATABASE_URL` is absent (PGlite path) and `EXPLORE_SQL_ENABLED=true`, `resolveServerConfig()` refuses to start the server with an error containing cause + remedy, and it is bypassed only by also setting the new env `EXPLORE_SQL_ALLOW_PGLITE=true` — the same "explicit signal that the risk is understood" pattern as guardrail 1 (`SEND_MODE=live && --confirm`). The reason for an override rather than a complete block: to avoid categorically shutting out use cases where role separation is meaningless to begin with, such as purely local/offline demos or trusted single-user environments. `FORBIDDEN_FUNCTION_CALLS` was also added to `sqlValidator.ts`, blocking advisory lock / `set_config` / backend control / file and remote access functions by function name, closing the specific bypass 005 demonstrated where "`\block\b` cannot catch `pg_advisory_lock` because of the underscore" — documenting that this list is not complete either (the real line of defense is still the role restriction).
- Implementation contract in DESIGN §12.4, actual implementation and regression tests in TASKS T30.

### Remaining P0/P1 review items

Apart from the 3 above, the remaining 004~008 items (REL-002~004/006/007, SEC-003~007, DATA-001/004~008, OPS-001~006, QA-001~006) are pure implementation/test hardening requiring no new policy decisions — each review document's "fix criteria" are adopted as-is as the implementation contract, and only the necessary design is added to DESIGN §12. Assigned by priority (P0/P1) to TASKS T29~T35.
