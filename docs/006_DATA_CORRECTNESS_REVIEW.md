# 006 — Data Correctness and Business Logic Adversarial Review

- Review date: 2026-09-03
- Scope: CSV/Excel branch/HQ flows, snapshot, SCM reconciliation
- Verdict: **Release blocked — the normal tests pass, but operational data can be silently lost, left stale, or notified in duplicate**
- Status: **RESOLVED (T31 PR #42 — DATA-001~004, T33 PR #44 — DATA-005~008, 2026-09-03)** — DATA-001~008 all resolved. The full re-review will be conducted in T37. The tombstone/daily digest policy is reflected in `docs/SPEC.md` §18 and `docs/DESIGN.md` §12.2~12.3; nullable clear/SCM insufficient_data/scm_status/receipt aggregation are reflected in `docs/DESIGN.md` §12.7.

## DATA-001 — snapshot export loses `pack_size`

- Severity: **Critical**
- Area: `src/core/snapshotExport.ts`
- Reproduction: Exporting a ProductRow with `packSize: "24"` yields no `pack_size` anywhere in the header or the rows.
- Impact: In branch mode, the alert is sent after rounding up to the pack size, but in HQ consolidated mode, which reads the branch snapshot, the pack size becomes null. T19's round-trip guarantee and T24/T25's pack size feature were not joined together.
- Fix criteria: Include `pack_size` in the snapshot schema/header/row and add a regression test that packSize is identical after `parse → export → parse`.
- **Resolution (T31)**: Added `pack_size` to `COLUMNS`/the row mapping in `core/snapshotExport.ts`. Re-verified by including raw rows with `pack_size` mixed in within the round-trip test.

## DATA-002 — SKUs/stores that disappeared from files persist in the DB permanently

- Severity: **Critical**
- Area: `runFolderScan`, `runConsolidatedScan`, Warehouse upsert model
- Evidence: Each scan only upserts the current file's rows and does not remove/deactivate the `inventory_levels` and `sales_period_agg` that were in the previous scan but are absent from the new file.
- Impact: The file-based current state and the MCP query DB diverge. Discontinued, disposed, or branch-withdrawn items remain exposed as stale inventory/sales volumes and can be mixed into reorder suggestions.
- Fix criteria: Store the authoritative snapshot boundary per source/branch and tombstone or delete the missing rows in the same transaction. If the input is not "missing=deleted", require an explicit active-state column.
- **Resolution (T31)**: `active` column on `inventory_levels`/`sales_period_agg` (migrations/006) + `Warehouse.deactivateMissingCsvRows()` — both `runFolderScan`/`runConsolidatedScan` deactivate the (store, SKU) pairs absent from this scan inside the same transaction as the upsert. No physical deletion (history preserved), automatic reactivation on reappearance. Details in DESIGN §12.2.

## DATA-003 — The same latest file is reprocessed and re-sent on every cron run

- Severity: **Critical**
- Area: branch `runFolderScan`
- Evidence: It neither looks up nor compares a path/mtime/hash watermark for the latest file, and generates a random `runId` on every run. A new send reservation is possible even for the same file.
- Impact: The same low-stock email is sent repeatedly every cron cycle even when the user has not updated the file. The existing runId idempotency only prevents retries of the same runId and does not prevent this.
- Fix criteria: Atomically record source identity + content hash/mtime watermark so that unchanged input terminates as `unchanged`. If the notification policy is a repeated reminder, define it with a separate cadence and an explicit opt-in.
- **Resolution (T31)**: Store `{contentHash, lastSentAt}` in `sync_state` under the key `csv_branch_digest:<watchDir>`, and check the 24-hour cap (`shouldSkipAsUnchanged`) only on the actual send-attempt path — `no_suggestions`/`dry_run` are always processed regardless of this policy (a deliberate scope reduction so as not to suppress a person's repeated manual checks; basis in DESIGN §12.3). A send failure does not update the watermark, so an immediate retry is possible.

## DATA-004 — snapshot file writes are not atomic

- Severity: **High**
- Area: `folderScan.ts`
- Evidence: Overwrites the fixed filename `snapshot.csv` directly with `writeFile`. There is no lock for the HQ collection/sync process or for the snapshot directory.
- Impact: If the process dies mid-write or the HQ process reads concurrently, a truncated CSV may be observed. The previous good snapshot is also overwritten, making recovery difficult.
- Fix criteria: Write to a temp file in the same directory, flush, then atomic rename. Also give the HQ hand-off process a convention such as excluding `.partial` or a ready marker.
- **Resolution (T31)**: `src/adapters/atomicFile.ts` (new) `writeFileAtomic()` — temp file→fsync→rename. The temp filename does not end in `.csv`/`.xlsx`, so the existing file-discovery filter ignores it naturally (no separate ready marker needed).

## DATA-005 — product nullable attributes cannot be removed, so stale values remain

- Severity: **High**
- Area: `pgWarehouse.upsertProductsOn`
- Evidence: `low_stock_threshold` and `pack_size` are updated with `coalesce(excluded, existing)`. Even if the cell is emptied in a new authoritative CSV, the existing value is not cleared.
- Impact: Even after stopping pack-size purchasing or resetting the threshold to the default, the past settings keep applying and produce incorrect order quantities/warnings.
- Fix criteria: Distinguish "field not provided" from "explicitly cleared with null" in the type, or define per-source priority/ownership. Regression-test the clear behavior.
- **Resolution (T33, 2026-09-03)**: The three states of `ProductRow.lowStockThreshold`/`packSize` (a type that was already `?: Numeric | null`) — `undefined` (no information)/`null` (explicitly cleared)/a value — are now actually distinguished and reflected (`core/types.ts` documentation updated). `mapRowsToDomain` in `csvExcelParser.ts` decides by whether the raw row had that column key (csv-parse creates the key even for empty cells when a header exists) — for XLSX, `parseExcelFile` pre-seeds every header column as `undefined` on each row before overwriting with the actual cell values, giving it the same property (discovered during the work — `eachCell({includeEmpty:false})` skipped empty cells, so before this "no column" and "empty cell" could not be distinguished). `upsertProductsOn` in `pgWarehouse.ts` decides only "does any row at all in the batch (one file) carry any information for this field" for the batch as a whole, and chooses the SET clause itself accordingly — if so, `excluded.x` (null is reflected as-is, i.e. clear); if not, `products.x` (existing value preserved). The design exploits the property that column presence is a file-header-level attribute and does not vary row by row within one batch. Tests: `tests/csvExcelParser.test.ts` (new describe, for both CSV/XLSX the 3 cases no-column/empty-cell/value + rejection of inconsistency across SKUs), `tests/pgWarehouse.test.ts` (new describe with 4 tests, clear/mixed-batch cases).

## DATA-006 — SCM reconciliation uses opening stock 0 and period mismatch as if they were normal input

- Severity: **High**
- Area: `ingestScmReceipts`, the `computeStockReconciliation` call
- Evidence: Opening stock is not provided, so the default 0 is used, and it does not validate that the SCM file period equals the sales period. SPEC §16 also lists this as a known limitation, but the results are included in actual email warnings.
- Impact: Comparing inventory that existed before operations began, and receipts/sales from different periods, can send a large volume of false "theft, damage, count error" warnings.
- Fix criteria: Without an opening snapshot and a common reconciliation period, do not compute the reconciliation and mark it `insufficient_data`. Validate that the periods overlap, and phrase the warning as a discrepancy fact rather than a confirmed cause.
- **Resolution (T33, 2026-09-03)**: New `insufficientData: boolean` + `insufficientDataReasons: string[]` on `StockReconciliationRow` in `core/metrics.ts`. For opening stock, if `openingStock` has no entry for that (store,variant) key (the onboarding physical-count input flow is still a later task, so it is always absent for now), `insufficientData: true`; for the period, likewise if the new `periodsOverlap` option (the caller compares the SCM receipt period and the sales period directly and passes it in; pure function `periodsOverlap()`) is `false`. The `discrepancy` number itself is still computed for reference (not hidden entirely), but when `insufficientData`, phrasing that asserts a confirmed cause, such as "check for theft, damage or count error", is not put into `warnings`. `agent/folderScan.ts` keeps only confirmed discrepancies (`hasDiscrepancy && !insufficientData`) in `FolderScanResult.reconciliation`, and reports whether data was insufficient only as a one-line summary via `scmStatus` (integrated with DATA-007, below), without per-SKU noise. As of today, no caller actually fills in and passes opening stock, so **it is normal for every SCM reconciliation to be insufficientData** — confirmed discrepancies will start appearing once the onboarding physical-count input task exists. Tests: `tests/metrics.test.ts` (2 new describes, for `insufficientData`/`periodsOverlap` respectively), `tests/folderScan.test.ts` (insufficientData e2e, confirms the confirmed-discrepancy send email contains no confirmed-cause phrasing).

## DATA-007 — SCM failures vanish from the structured result

- Severity: **High**
- Area: `ingestScmReceipts`
- Evidence: Folder access, parsing, and DB load errors are all turned into an empty array after a console warning. `FolderScanResult` has no skipped/error status.
- Impact: In an automated execution environment, the user may receive the low-stock email as a normal result and miss the fact that the SCM reconciliation failed. "No data" and "processing failed" are not distinguished.
- Fix criteria: Even while keeping the failure isolation of this auxiliary feature, include `scm_status`, an error code, the file used, and data freshness in the result/email/operational logs.
- **Resolution (T33, 2026-09-03)**: New `ScmStatus` type in `agent/folderScan.ts` (`not_configured`/`no_file`/`failed` (with the error message)/`ok` (with the file used, the receipt count, and DATA-006's `insufficientData`)) — the failures that `ingestScmReceipts` used to swallow into an empty array after `console.warn` are now also returned as a structured value (the console warning is kept as-is — real-time logs continue to be emitted). Exposed via `FolderScanResult.scmStatus` on every return path (no_suggestions/dry_run/unchanged/sent), and when a report is actually sent, `renderAlertText` puts a one-line summary (`[SCM processing failed]`/`[SCM stock consistency note]`) rather than a per-SKU list into the email body as well — this actually prevents the criticism that "an SCM failure gets buried in an email that looks like a normal result". It integrated naturally with DATA-006's `insufficientData` (one field of the same `scmStatus.ok` case). Tests: `tests/folderScan.test.ts` (each of the not_configured/no_file/failed/ok cases, confirms the summary phrase is included in the sent email body).

## DATA-008 — Multiple receipts on the same date are overwritten

- Severity: **High**
- Area: `purchase_receipts` PK
- Evidence: The PK is `(store_id, variant_id, received_at)` with no event id, so two receipts for the same SKU on the same day are upserted with the last value instead of being summed.
- Impact: The actual receipt total is understated, making expected inventory and the consistency calculation wrong. It is a documented limitation, but in a general npm release it leads to silent data loss.
- Fix criteria: Introduce a stable event key such as source row number/document number/content hash, or explicitly sum same-date rows before import and separately guarantee duplicate-file idempotency.
- **Resolution (T33, 2026-09-03)**: Instead of introducing a stable event key (the source SCM sheet simply does not contain that information), the "sum before import" approach was adopted — `mapScmRowsToPurchaseReceipts` in `core/scmSchema.ts` sums quantities per (store, SKU, receipt date) via `aggregateSameDayReceipts()` right before returning. Unit price, currency, and supplier (for the audit trail; not used in the inventory consistency calculation) cannot be summed, so the last row's values are kept. This contract is documented on `upsertPurchaseReceiptsOn` in `pgWarehouse.ts` (stating explicitly that any other caller added must pre-aggregate the same way). Repeated scans of the same file (idempotency) assign the same aggregated result each time (assignment), so there is no duplicate accumulation. Tests: `tests/scmSchema.test.ts` (new describe with 5 tests — summing 2 entries/3 or more entries, last-value audit fields, store separation, SKU separation).

## Data re-review criteria

- [x] pack size snapshot round-trip preserved (T31)
- [x] Missing-row handling policy for authoritative snapshots implemented (T31)
- [x] 0 re-sends for unchanged files (T31 — limited to the actual send-attempt path)
- [x] snapshot atomic write/reader handoff (T31)
- [x] nullable setting clear supported (T33)
- [x] SCM reconciliation includes opening stock, period, and failure status (T33)
- [x] Correct totals for both multiple receipts and re-import (T33)
