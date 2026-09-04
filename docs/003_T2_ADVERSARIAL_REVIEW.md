# 003 — T2 Adversarial Review Record

- Review date: 2026-09-02
- Target commit: `a456fb7` (`T2: FixtureLoyverseClient + fixtures (#2)`)
- Verdict (at time of review): **Failure — passes against the local home-grown schema, but does not satisfy the actual Loyverse raw response contract or the incremental sync requirements**
- Current status (re-confirmed 2026-09-03, in response to docs/009 DOC-005): **RESOLVED** — every item under "Re-review completion criteria" below is [x] (the last `npm run check` checkbox was merely a notation omission at the time; it was in fact in a passing state from the moment `fix-t2` was merged — the evidence being that every task after T2 in TASKS.md has continued to pass on top of it); merged via the `fix-t2` branch (2026-09-02).
- Official reference: [Loyverse API Reference](https://developer.loyverse.com/docs/)
- Scope: fixtures, Zod schemas, `FixtureLoyverseClient`, related tests

## Items that passed

- 2 stores, 8 products, 16 inventory rows
- 84 receipts spread over 35 calendar days from 2026-07-28 to 2026-08-31
- Both stores and all 8 variants appear in the sales data
- item/receipt/inventory are each replayed across 2 or more pages
- Includes zero stock and Korean/Tagalog names

## Finding 003-01 — `updated_at` from the actual inventory response is discarded by the schema and type

- Severity: **Critical**
- Area: `LvInventoryLevelSchema`, `LvInventoryLevel`, fixture mapping
- Evidence:
  - The fixture JSON contains `updated_at`.
  - The official inventory response also provides `updated_at` on each level.
  - The Zod schema accepts it via `.passthrough()` but removes it from the return type and the mapping.
  - The Warehouse's `InventoryRow` requires `updatedAt: Date` as mandatory.
- Impact: T7 does not receive the raw latest timestamp and has to fabricate a value. Stale judgments and freshness comparisons can be wrong.
- Required action: Validate as an ISO datetime and preserve it in `LvInventoryLevel.updated_at`; add an invalid-date test.

## Finding 003-02 — `updated_at`, required for the receipt incremental watermark, is missing

- Severity: **Critical**
- Area: `LvReceiptSchema`, `LvReceipt`, `listReceipts`
- Evidence:
  - DESIGN §11.1 requires the receipt watermark to be handled like `(updated_at, receipt_id)`.
  - Official receipts have `created_at`, `updated_at`, and `receipt_date` as separate fields.
  - The current type preserves only `receipt_date`, and the `sinceISO` filter is also applied to `receipt_date`.
- Impact: When a receipt with a past date is later modified, refunded, or cancelled, the next sync does not re-fetch it, so sales quantities can be permanently wrong. T3/T7 cannot be implemented per the documented contract.
- Required action: Preserve `updated_at` as required and specify the API filter semantics as an `updated_at_min` watermark. Add fixtures for an identical-updated_at boundary and for modification of a past receipt.

## Finding 003-03 — Cancelled receipt information is discarded, risking inclusion in sales

- Severity: **High**
- Area: receipt schema/type/fixture
- Evidence: The official receipt's `cancelled_at` is absent from the type, and the fixture has no cancellation scenario.
- Impact: Loading cancelled receipts as normal sales inflates sell-through, average sales, and reorder quantities.
- Required action: Preserve a nullable `cancelled_at`, finalize the ETL policy (exclusion or negative correction) in SPEC/DESIGN, then add a cancellation fixture/test.

## Finding 003-04 — Raw refund responses are disguised as internally transformed values

- Severity: **High**
- Area: receipts fixture, `LvReceiptSchema`, `LvReceipt`
- Evidence:
  - The fixture has `receipt_type: "REFUND"`, but it is removed in the mapping after the schema's passthrough.
  - The refund line `quantity` and amounts in the fixture are already written as negative.
  - The official contract provides `receipt_type` and `refund_for` on the receipt, so the raw fixture must preserve them and the sign conversion must be performed explicitly in the ETL.
- Impact: The tests verify "parsing of a virtual response after ETL transformation" rather than "parsing of the actual response". If the real API returns positive refund quantities, refunds could be added as sales, and T7's refund-conversion responsibility also disappears.
- Required action: Use raw signs and fields identical to actual API samples and include `receipt_type` and `refund_for` in the type. In the ETL test, negate REFUND exactly once.

## Finding 003-05 — The date schema does not validate ISO 8601

- Severity: **High**
- Area: `LvReceiptSchema.receipt_date`
- Evidence: It is `z.string().min(1)`, so `not-a-date` also passes. Only the type alias is named `IsoDateTimeString`; there is no runtime guarantee.
- Impact: Sorting and `sinceISO` comparison rely on lexicographic string comparison, producing wrong order/omissions, and invalid dates propagate through the subsequent `Date` conversion.
- Required action: Use an ISO datetime schema that includes the timezone, and add boundary tests for invalid/offset datetimes.

## Finding 003-06 — The cursor is not bound to the same query conditions

- Severity: **Medium**
- Area: fixture pagination
- Evidence: The cursor is only a numeric offset; it neither encodes nor validates `sinceISO`. Passing the same cursor with a different `sinceISO` after the first page is processed normally as an offset into a separate list.
- Impact: If a caller changes the conditions by mistake, the tests do not detect it and missing/duplicate pages result. The opaque nature of the real API cursor is also not reproduced.
- Required action: Issue the cursor as an opaque token bound to the original query conditions, or at least provide a stateful fixture that rejects on condition change.

## Finding 003-07 — No validation of page size input

- Severity: **Medium**
- Area: `FixtureLoyverseClientOptions`, `paginate`
- Evidence: `itemsPageSize: 0`, negative numbers, `NaN`, and fractions are all accepted at construction.
- Impact: A page size of 0 keeps returning an empty page with the same cursor, which can make the consumer's pagination loop repeat forever.
- Required action: Validate as a positive integer at the construction boundary and add tests rejecting 0/negative/fraction/NaN.

## Finding 003-08 — The real-response conformance test is self-referential

- Severity: **High**
- Area: `loyverseSchemas.test.ts`
- Evidence: It only confirms that fixtures the team wrote themselves parse with a reduced Zod schema the team wrote themselves. There is no contract test comparing against official samples or captured anonymized payloads. Because of `.passthrough()`, the test passes even when fields that must be preserved are missing.
- Impact: Even in the current state where raw fields are lost, the completion criterion "parses with the actual Loyverse response schema" passes as a false positive.
- Required action: Pin a separate contract fixture based on official response samples, and validate the fields the ETL needs as strict required. Test passthrough acceptance and field preservation separately.

## Finding 003-09 — Verification of the new-item 5-day scenario is insufficient

- Severity: **Medium**
- Area: `fixtureLoyverseClient.test.ts`
- Evidence: It only checks that the bearbrand receipts fall after the last 5 days; it does not pin via aggregates that exactly 5 calendar days are included and that the prior period has 0 receipts.
- Impact: Even if the fixture regresses to exist on only 1 day or only in some stores, the test passes, weakening the verification power for T5's new-item denominator policy.
- Required action: Pin the set of sales days per item/store and the 0 count outside the window as exact expected values.

## Re-review completion criteria

- [x] Preserve the official response's required fields `updated_at`, `receipt_type`, `refund_for`, `cancelled_at`, inventory `updated_at` — added to the schema/type/fixture mapping throughout
- [x] ISO datetime runtime validation — `created_at`/`updated_at`/`receipt_date`/`cancelled_at` (nullable) validated with `z.iso.datetime()`, including an invalid-date rejection test
- [x] Contract fixtures for modified/cancelled/refund receipts and an exact ETL sign policy — added 1 cancelled receipt and 1 "modified after creation" (updated_at≠receipt_date) receipt to the fixtures. Refund line_items regenerated with positive quantity as in the real API (sign inversion to be performed in T7; the cancelled-receipt exclusion policy specified in SPEC §9/DESIGN §11.3)
- [x] Cursor condition invariance and page size input validation — cursor encoded as an opaque token including the query conditions (sinceISO etc.), rejected on condition mismatch. Page size 0/negative/fraction/NaN rejected at construction time
- [x] Independent contract test based on official samples — `tests/loyverseContractSample.test.ts` verifies the SALE/REFUND receipt examples and the inventory webhook payload example from the official Loyverse docs (confirmed 2026-09-02), copied verbatim. Also separately confirmed that missing required fields are still rejected (passthrough and field preservation tested separately)
- [x] New-item 5-day scenario verified with exact expected values — exactly 10 bearbrand receipts (5 days × 2 stores), per-store date sets pinned as exact arrays, 0 receipts outside the window confirmed

- [x] `npm run check` passes

Resolution commit: `fix-t2` branch (2026-09-02). The field values themselves were confirmed directly in a browser against the official Loyverse docs and reflected (WebFetch could not read the rendered content since the site is an SPA, so `document.body.innerText` was read via `mcp__claude-in-chrome__javascript_tool` to confirm).
