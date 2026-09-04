# Changelog

This project follows the [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.

For the implementation/test evidence behind each entry, see the corresponding task (Txx) section in `docs/TASKS.md`; for the per-finding resolution/test cross-reference of the pre-release adversarial reviews, see `docs/010_FINDING_TEST_CROSSREF.md`. Publishing happens only by pushing a `v*` tag → GitHub Actions (`release.yml`) runs the full checks and then `npm publish --provenance`.

## [Unreleased]

(Changes for the next release accumulate here.)

## [0.2.0] - 2026-09-04

English-only release. The package, its README on npmjs.com and every message the tools print are now English. The input file format changed (see **Breaking** below), hence the minor bump.

### Added

- `retail-mcp-onboard` asks for the store/branch name (question 3, default `Main Store`) and writes it into the `store` column of the generated example template. Store and product names are row data in your inventory file, never fixed in the tool.
- Migration runner reports `rebaselined` ids (see Changed) so operators can tell a one-time checksum rewrite from a real content change.

### Changed

- All documentation, code comments, log/error messages, CLI prompts, email templates and test data are now English.
- **Breaking**: the CSV/Excel inventory template and the SCM receipts CSV use English column names. Files with the previous Korean headers are no longer accepted — regenerate the template with `retail-mcp-onboard` (or rename the header row) and re-export SCM receipts with the new headers.
  - Inventory template: `매장명` → `store`, `상품명` → `product`, `SKU` → `sku`, `재고수량` → `stock_qty`, `판매수량` → `sales_qty`, `판매기간시작일` → `period_start`, `판매기간종료일` → `period_end`, `단가` → `unit_price`, `통화` → `currency`, `저재고임계치` → `low_stock_threshold`, `포장수량` → `pack_size`.
  - SCM receipts CSV: `일자` → `date`, `구분` → `type`, `상품코드` → `sku`, `상품명` → `product`, `수량` → `qty`, `단가` → `unit_price`, `거래처` → `vendor`; the `type` values `입고`/`출고` → `inbound`/`outbound`.
- Snapshot export header row is now English (`store,product,sku,stock_qty,sales_qty,period_start,period_end,low_stock_threshold,pack_size`).
- Migration runner: checksums are now computed over the SQL with full-line `--` comments and blank lines removed, and the recorded checksums of the eight 0.1.0 migrations are re-baselined automatically on first run (the SQL files changed only in their comments, which were translated) — no user action needed.

## [0.1.0] - 2026-09-04

First public publish (`@shiz_son/retail-mcp@0.1.0`). Includes both v0.1 (Loyverse path, production deployment on hold) and v0.2 (CSV/Excel channel).

### Added

- Five MCP query tools (`sell_through`/`inventory_status`/`stockout_risk`/`reorder_suggestions`/`sync_status`) + conditional `sync_now`/`explore_sql` (disabled by default in production).
- Reorder suggestion agent (`agent/reorder.ts`, Loyverse path) — dry-run by default, `SEND_MODE=live && --confirm` double gate.
- CSV/Excel folder-watch channel (v0.2, the next actual release target) — branch mode (low-stock alerts + guaranteed daily digest) and HQ mode (multi-branch consolidated queries), interactive onboarding CLI (`npm run onboard`).
- SCM receipts reconciliation (inventory consistency verification, CSV fallback), pack-size rounding.
- Embedded PGlite adopted as the default warehouse — works without `DATABASE_URL` (no need to create a Neon or similar account).
- Five executable commands for npm-installed users — `retail-mcp` (MCP server), `retail-mcp-onboard` (setup), `retail-mcp-scan` (inventory file scan + low-stock alerts), `retail-mcp-reorder` (Loyverse reorder suggestions), `retail-mcp-migrate` (external DB migration). `retail-mcp-scan`/`retail-mcp-reorder` were added after the pre-publish check found the gap that "after installing, there is no command to run the core functionality" (2026-09-04).
- `retail-mcp-onboard` also asks for email sending settings (Resend API key and sender address) as an optional step — if left empty, it explains that only preview (dry-run) is available.
- `explore_sql` (arbitrary read-only SQL query tool) — function blocklist + `BEGIN READ ONLY` double defense, disabled by default in production.
- CI (`.github/workflows/ci.yml`) — supported OS/Node matrix, coverage threshold, real Postgres component tests, dependency audit/secret scan/SBOM.

### Changed

- Warehouse retention policy (`agent_send_log`/`inventory_snapshots`) consolidated into `npm run cleanup` (dry-run by default, `--confirm` double gate).
- Permission/isolation policy for `explore_sql`/`sync_now` strengthened to require a dedicated DB role.

### Fixed

Resolved the issues found in the adversarial review in preparation for npm publish (`docs/004`~`008`, 33 findings) — for the full list and the per-finding resolution commit/test cross-reference, see `docs/010_FINDING_TEST_CROSSREF.md`:

- **Packaging**: removed `private`, registered `bin`/`main`, allowlist-based tarball (97→63 files), license/metadata, fresh-install verification of the published tarball.
- **Security**: blocked `explore_sql` READ ONLY bypasses (advisory locks/`set_config`), CSV/XLSX size/row/cell limits, CSV formula injection escape, atomic `.env` write with 0600, approved-exception management for dependency vulnerabilities.
- **Data accuracy**: pack size preserved round-trip through snapshot export/import, tombstones for vanished SKUs/stores (no physical deletion), no re-sending on repeated runs over the same file + guaranteed at least one digest per day, atomic snapshot write that is safe even if the process dies mid-write, precise three-state distinction for nullable fields (not specified / explicit deletion / value), suppression of definitive warnings when SCM opening inventory or periods mismatch.
- **Operational reliability**: file lock release guaranteed even when `db.close()` fails, prevention of PID-reuse/other-host lock misjudgment, deterministic selection among files with identical mtime, separate `unknown` status for email send timeouts + idempotency key, structured JSON logs.
- **Test/release gates**: coverage threshold extended to risky modules outside core (explore_sql/warehouseFactory/provider/CLI), real Postgres service component tests in CI, clean tarball install verification on the supported OS/Node matrix, automated dependency audit (fail-open/fail-closed policy), secret scan, and SBOM.

### Security

- `explore_sql` function blocklist (advisory locks/`set_config`/backend control/file and remote access) — closes session side-effect bypasses that a `BEGIN READ ONLY` transaction alone cannot stop.
- Size/row/cell-length limits for large and zip-bomb CSV/XLSX files, formula injection escape.
- `.env` written atomically with 0600 permissions — secrets are neither committed nor exposed to other users.
- `npm audit` against the published tarball (release gate) + lockfile-based `npm audit` (CI on every PR, explicit fail-open/fail-closed policy) + committed-secret pattern scan + SBOM (CycloneDX) generation.
