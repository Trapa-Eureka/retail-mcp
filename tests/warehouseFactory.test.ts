import { PGlite } from "@electric-sql/pglite";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireFileLock, FileLockBusyError } from "../src/adapters/fileLock.js";
import {
  createPgliteExecutor,
  loadMigrations,
  runMigrations,
} from "../src/adapters/migrationRunner.js";
import { createPgliteConnectionProvider, createPgWarehouse } from "../src/adapters/pgWarehouse.js";
import {
  createWarehouseFromEnv,
  ensureNetworkMigrationsApplied,
  type WarehouseHandle,
} from "../src/adapters/warehouseFactory.js";

describe("createWarehouseFromEnv", () => {
  let dir: string;
  let dataDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-warehouse-"));
    dataDir = join(dir, "data");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts with embedded PGlite when DATABASE_URL is not set and auto-migrates on the first run", async () => {
    const handle = await createWarehouseFromEnv({ env: {}, dataDir });
    try {
      expect(handle.kind).toBe("pglite");
      expect(handle.pgPool).toBeUndefined();

      // Confirm through the warehouse that the migrations were actually applied (an empty query succeeds without error).
      await expect(handle.warehouse.queryStock({ storeId: "no_such_store" })).resolves.toEqual([]);

      // Also confirm that the data directory was actually created as files.
      const files = await readdir(dataDir);
      expect(files.length).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  });

  it("starts even on a completely new path where not even the parent directory of dataDir exists (TASKS T29, found by the QA-001 tarball smoke test — reproduces the first run of a fresh install)", async () => {
    const freshDataDir = join(dir, "not-yet-created", "data");
    const handle = await createWarehouseFromEnv({ env: {}, dataDir: freshDataDir });
    try {
      expect(handle.kind).toBe("pglite");
      await expect(handle.warehouse.queryStock({ storeId: "no_such_store" })).resolves.toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it("starts on the pg path when DATABASE_URL is set (does not attempt a real connection — regression check)", async () => {
    const handle = await createWarehouseFromEnv({
      env: { DATABASE_URL: "postgres://user:pass@localhost:1/nonexistent" },
      dataDir,
    });
    try {
      expect(handle.kind).toBe("pg");
      expect(handle.pgPool).toBeDefined();
    } finally {
      await handle.close();
    }
  });

  it("refuses with FileLockBusyError when the embedded path is already open in another process", async () => {
    const lock = await acquireFileLock(dataDir, { isAlive: () => true });
    try {
      await expect(createWarehouseFromEnv({ env: {}, dataDir })).rejects.toBeInstanceOf(
        FileLockBusyError,
      );
    } finally {
      await lock.release();
    }
  });

  it("can reuse the same data directory when started twice in a row (sequentially) (lock release check)", async () => {
    const first = await createWarehouseFromEnv({ env: {}, dataDir });
    await first.close();

    const second = await createWarehouseFromEnv({ env: {}, dataDir });
    await expect(second.warehouse.queryStock({})).resolves.toEqual([]);
    await second.close();
  });

  it("always releases the lock even when db.close() fails (OPS-001, TASKS T34)", async () => {
    const handle = await createWarehouseFromEnv({ env: {}, dataDir });
    const closeSpy = vi
      .spyOn(PGlite.prototype, "close")
      .mockRejectedValueOnce(new Error("PGlite close failed (simulated)"));
    try {
      await expect(handle.close()).rejects.toThrow("PGlite close failed");
    } finally {
      closeSpy.mockRestore();
    }

    // Even though db.close() failed, the lock file must be released — previously release()
    // never ran at all, so the next startup kept being blocked with FileLockBusyError.
    const second = await createWarehouseFromEnv({ env: {}, dataDir });
    await second.close();
  });

  it("preserves both failures in an AggregateError when both db.close() and lock.release() fail (OPS-001, TASKS T34)", async () => {
    const handle = await createWarehouseFromEnv({ env: {}, dataDir });
    const closeSpy = vi
      .spyOn(PGlite.prototype, "close")
      .mockRejectedValueOnce(new Error("db close failed"));
    // Make lock.release() fail too — swapping the lock file's location for a directory makes
    // rm() fail with an error other than ENOENT (EISDIR) (release() ignores only ENOENT).
    const lockPath = `${dataDir}.lock`;
    await rm(lockPath, { force: true });
    await mkdir(lockPath, { recursive: true });
    try {
      await handle.close();
      expect.unreachable("close() must throw both failures");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const agg = err as AggregateError;
      expect(agg.errors).toHaveLength(2);
      expect(String(agg.errors[0])).toContain("db close failed");
    } finally {
      closeSpy.mockRestore();
      await rm(lockPath, { recursive: true, force: true });
    }
  });
});

describe("ensureNetworkMigrationsApplied (second adversarial review SR2-REL-001)", () => {
  // To verify the "pg" path logic (kind branch + pending migration detection + error message)
  // without a real network Postgres, build a fake WarehouseHandle that labels a PGlite-based
  // connectionProvider as "pg" — ensureNetworkMigrationsApplied only touches the DB through the
  // connectionProvider, so from its point of view it cannot tell whether the actual store is pg
  // or PGlite.
  function fakeNetworkHandle(db: PGlite): WarehouseHandle {
    const connectionProvider = createPgliteConnectionProvider(db);
    return {
      warehouse: createPgWarehouse(connectionProvider),
      kind: "pg",
      connectionProvider,
      close: () => Promise.resolve(),
    };
  }

  it("does nothing when kind is pglite, regardless of schema state (the embedded path is already auto-migrated)", async () => {
    const db = new PGlite(); // Completely empty state, deliberately without applying migrations.
    const connectionProvider = createPgliteConnectionProvider(db);
    const handle: WarehouseHandle = {
      warehouse: createPgWarehouse(connectionProvider),
      kind: "pglite",
      connectionProvider,
      close: () => Promise.resolve(),
    };

    await expect(ensureNetworkMigrationsApplied(handle)).resolves.toBeUndefined();
  });

  it("throws an error pointing to retail-mcp-migrate when kind is pg and the schema is completely empty (all migrations pending)", async () => {
    const handle = fakeNetworkHandle(new PGlite());

    await expect(ensureNetworkMigrationsApplied(handle)).rejects.toThrow(
      /retail-mcp-migrate.*--confirm/s,
    );
  });

  it("passes when kind is pg and all migrations are already applied", async () => {
    const db = new PGlite();
    const migrations = await loadMigrations();
    await runMigrations(createPgliteExecutor(db), migrations);
    const handle = fakeNetworkHandle(db);

    await expect(ensureNetworkMigrationsApplied(handle)).resolves.toBeUndefined();
  });

  it("lists the pending ids precisely when kind is pg and only some are applied", async () => {
    const db = new PGlite();
    const migrations = await loadMigrations();
    const firstOnly = migrations.slice(0, 1);
    await runMigrations(createPgliteExecutor(db), firstOnly);
    const handle = fakeNetworkHandle(db);

    const lastId = migrations[migrations.length - 1]?.id;
    await expect(ensureNetworkMigrationsApplied(handle)).rejects.toThrow(
      lastId !== undefined ? new RegExp(lastId) : /./,
    );
  });
});
