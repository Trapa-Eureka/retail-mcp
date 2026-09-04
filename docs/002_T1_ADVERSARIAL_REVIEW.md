# 002 — T1 Adversarial Review Record

- Review date: 2026-09-02
- Target commit: `585ca4d` (`T1: Migrations + domain types (#1)`)
- Verdict (at time of review): **Failure — basic tests pass, but there are structural defects in the integrity, atomicity, and idempotency guarantees**
- Current status (re-confirmed 2026-09-03, in response to docs/009 DOC-005): **RESOLVED** — every item under "Re-review completion criteria" below is [x]; merged via the `fix-t1` branch (2026-09-02). The two items (actual implementation of the Warehouse transaction, real use of the send reservation pattern) were verified to completion in T4 and T8 respectively, as the footnotes in this document state, and are closed (both DONE, TASKS.md).
- Scope: `migrations/001_init.sql`, `scripts/migrate.ts`, `src/core/types.ts`, PGlite tests

## Finding 002-01 — Referential integrity of `inventory_snapshots` was removed

- Severity: **High**
- Area: DB schema
- Evidence:
  - In the original schema in DESIGN §2, the snapshot's `store_id` and `variant_id` reference `stores` and `products` respectively.
  - The actual `inventory_snapshots` in `001_init.sql` has neither foreign key.
- Impact: Snapshots for non-existent stores/products can be loaded, so time-series aggregates can diverge from current inventory / the product master.
- Required action: Restore both foreign keys and add a migration test in which an orphan insert fails.

## Finding 002-02 — The Warehouse contract cannot express the atomic ETL of DESIGN §11.1

- Severity: **Critical**
- Area: `Warehouse` in `src/core/types.ts`
- Evidence:
  - DESIGN requires that a resource's data upsert and watermark update be committed in the same transaction.
  - The interface only offers `upsert*()` and `setCursor()` as independent calls.
  - There is no transaction callback, unit-of-work, or per-resource atomic method.
- Impact: If T7 uses only the current contract, it cannot prevent the state "data load succeeded, then cursor save failed" or the reverse. Partial-failure resumption and exact incremental sync are not structurally guaranteed.
- Required action: Include the atomicity boundary in the contract — for example `warehouse.transaction(fn)` or `commitResourceSync({ rows, watermark, ... })` — and add a PGlite rollback test.

## Finding 002-03 — The `run_id` unique index does not prevent duplicate email sends

- Severity: **High**
- Area: `agent_send_log`, implementation interpretation of DESIGN §11.5
- Evidence:
  - The unique index rejects a duplicate record only when a log row with `status = 'sent'` already exists in the DB.
  - If the provider succeeds in sending the email and the process dies before the DB log is written, no success row exists.
  - A re-run attempts to write the log only after it has sent the same email again.
- Impact: The "prevention of double sends when log recording fails after provider success" claimed by the docs and the SQL comment does not hold.
- Required action: Atomically claim a reservation state (`sending`) before sending and transition via a state machine, or use an idempotency key supported by the provider. A crash-recovery policy and concurrent-execution tests are needed.

## Finding 002-04 — Race condition in concurrent migration execution

- Severity: **High**
- Area: `runMigrations`
- Evidence:
  - The applied list is queried once, outside the transaction.
  - If two processes start simultaneously, both can judge the same migration as unapplied and execute the DDL.
  - There is no advisory lock or migration-specific lock.
- Impact: When deployment jobs overlap, one run fails with relation already exists / PK conflicts, and with more complex DDL the deployment state becomes hard to predict.
- Required action: Perform the entire run on the same client that acquired a session-level advisory lock, and add a concurrent-execution test.

## Finding 002-05 — No explicit rollback on failure and no same-client guarantee

- Severity: **High**
- Area: `createPgExecutor`, `runMigrations`
- Evidence:
  - `begin; ... commit;` is passed to `pool.query()` as a single SQL string.
  - There is no explicit `ROLLBACK` on the error path.
  - The executor wraps a `Pool`, not a transaction-bound `PoolClient`.
- Impact: When a PostgreSQL error occurs before COMMIT, there is a risk that the session is returned to the pool in an aborted-transaction state, and if subsequent queries use a different connection, neither rollback nor state verification can be guaranteed. Passing on PGlite alone does not prove actual `pg.Pool` behavior.
- Required action: Pin a client with `pool.connect()` and use the `try { BEGIN ... COMMIT } catch { ROLLBACK } finally { release }` pattern. Add a real-Postgres-compatible component test or a call-order test with an injected client.

## Finding 002-06 — Tampering with the content of applied migrations is not detected

- Severity: **Medium**
- Area: `schema_migrations`
- Evidence: The applied history stores only the filename `id`, not a checksum.
- Impact: If an already-applied `001_init.sql` is modified later, it is silently skipped on the production DB, and the schema of new environments diverges from existing ones.
- Required action: Store and verify a SQL checksum, and abort with an error containing the fix instructions when an applied migration's checksum does not match.

## Finding 002-07 — `createTestWarehouse` bypasses the actual migration runner path

- Severity: **Medium**
- Area: `src/mocks/pglite.ts`
- Evidence: The helper runs the SQL files directly with `db.exec()` and does not use `loadMigrations/runMigrations`.
- Impact: Most subsequent tests can be mistaken for production-equivalent without ever passing through migration ordering, filename validation, the history table, or runner defects.
- Required action: Consolidate so the helper uses the shared runner, and verify the `schema_migrations` applied history as well.

## Re-review completion criteria

- [x] Snapshot orphan insert rejected — FKs restored on `inventory_snapshots.store_id`/`variant_id`, test added
- [x] Resource data + watermark atomic commit/rollback test — `Warehouse.transaction(fn)` contract added to `core/types.ts` + `DESIGN.md` §4/§11.1. **Note: this contract is only finalized at the T1 (interface) level. The actual BEGIN/COMMIT/ROLLBACK implementation and verification of its rollback behavior are completed in T4 (pgWarehouse) — T1 has no implementation.**
- [x] Concurrent migration runs are serialized — `withAdvisoryLock` wraps `pg_advisory_lock`/`unlock` and the entire run executes on a single `client` (not the pool). However, PGlite is single-session, so real contention between two separate processes cannot be proven here — only the acquire → run → release order (release even on error) was unit-verified with a fake client; actual serialization of concurrent processes must be confirmed in the T11 smoke that runs `npm run migrate` against real Postgres.
- [x] After failure, rollback on the same client and normal queries possible — reproduced with PGlite: mid-migration failure → explicit ROLLBACK → test that subsequent queries on the same executor work normally
- [x] Migration checksum mismatch detected — added `schema_migrations.checksum` (sha256); on mismatch, aborts with an error containing the cause + fix
- [x] Contract finalized that can achieve 0 duplicate sends under a pre-send crash and concurrent retries — added a `sending` status to `agent_send_log`, implemented the reservation pattern with a partial unique index of at most 1 `sending`/`sent` per `run_id`. **Note: this is a schema-level contract; it only takes effect if T8 actually commits the `sending` insert before `provider.send()` — must be reflected in T8's completion criteria.**
- [x] `npm run check` passes (23 tests passed)

Resolution commit: `fix-t1` branch (2026-09-02). The two items marked in bold above (actual implementation of the Warehouse transaction, real use of the send reservation pattern) are fully closed only after being verified further in T4 and T8 respectively.
