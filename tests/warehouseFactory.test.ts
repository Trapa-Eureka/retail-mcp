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

  it("DATABASE_URL 미설정 시 임베디드 PGlite로 기동하고 첫 실행에 자동 마이그레이션한다", async () => {
    const handle = await createWarehouseFromEnv({ env: {}, dataDir });
    try {
      expect(handle.kind).toBe("pglite");
      expect(handle.pgPool).toBeUndefined();

      // 마이그레이션이 실제로 적용됐는지 웨어하우스를 통해 확인(빈 조회가 에러 없이 성공).
      await expect(handle.warehouse.queryStock({ storeId: "no_such_store" })).resolves.toEqual([]);

      // 데이터 디렉터리가 실제로 파일로 만들어졌는지도 확인.
      const files = await readdir(dataDir);
      expect(files.length).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  });

  it("dataDir의 부모 디렉터리조차 없는 완전히 새 경로에서도 기동한다(TASKS T29, QA-001 tarball smoke test가 발견 — 새 설치 첫 실행 재현)", async () => {
    const freshDataDir = join(dir, "not-yet-created", "data");
    const handle = await createWarehouseFromEnv({ env: {}, dataDir: freshDataDir });
    try {
      expect(handle.kind).toBe("pglite");
      await expect(handle.warehouse.queryStock({ storeId: "no_such_store" })).resolves.toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it("DATABASE_URL 설정 시 pg 경로로 기동한다(실제 연결은 시도하지 않음 — 회귀 확인용)", async () => {
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

  it("임베디드 경로가 이미 다른 프로세스에 열려 있으면 FileLockBusyError로 거부한다", async () => {
    const lock = await acquireFileLock(dataDir, { isAlive: () => true });
    try {
      await expect(createWarehouseFromEnv({ env: {}, dataDir })).rejects.toBeInstanceOf(
        FileLockBusyError,
      );
    } finally {
      await lock.release();
    }
  });

  it("두 번 연속 기동해도(순차) 같은 데이터 디렉터리를 재사용할 수 있다(락 해제 확인)", async () => {
    const first = await createWarehouseFromEnv({ env: {}, dataDir });
    await first.close();

    const second = await createWarehouseFromEnv({ env: {}, dataDir });
    await expect(second.warehouse.queryStock({})).resolves.toEqual([]);
    await second.close();
  });

  it("db.close()가 실패해도 lock은 반드시 해제된다(OPS-001, TASKS T34)", async () => {
    const handle = await createWarehouseFromEnv({ env: {}, dataDir });
    const closeSpy = vi
      .spyOn(PGlite.prototype, "close")
      .mockRejectedValueOnce(new Error("PGlite close 실패(시뮬레이션)"));
    try {
      await expect(handle.close()).rejects.toThrow("PGlite close 실패");
    } finally {
      closeSpy.mockRestore();
    }

    // db.close()가 실패했어도 lock 파일은 해제돼 있어야 한다 — 예전엔 release()가 아예
    // 실행되지 않아 다음 기동이 FileLockBusyError로 계속 막혔다.
    const second = await createWarehouseFromEnv({ env: {}, dataDir });
    await second.close();
  });

  it("db.close()와 lock.release() 둘 다 실패하면 AggregateError로 둘 다 보존한다(OPS-001, TASKS T34)", async () => {
    const handle = await createWarehouseFromEnv({ env: {}, dataDir });
    const closeSpy = vi
      .spyOn(PGlite.prototype, "close")
      .mockRejectedValueOnce(new Error("db close 실패"));
    // lock.release()도 실패하게 만든다 — 락 파일 자리를 디렉터리로 바꿔치기하면 rm()이
    // ENOENT가 아닌 다른 에러(EISDIR)로 실패한다(release()는 ENOENT만 무시한다).
    const lockPath = `${dataDir}.lock`;
    await rm(lockPath, { force: true });
    await mkdir(lockPath, { recursive: true });
    try {
      await handle.close();
      expect.unreachable("close()가 두 실패를 모두 던져야 한다");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const agg = err as AggregateError;
      expect(agg.errors).toHaveLength(2);
      expect(String(agg.errors[0])).toContain("db close 실패");
    } finally {
      closeSpy.mockRestore();
      await rm(lockPath, { recursive: true, force: true });
    }
  });
});

describe("ensureNetworkMigrationsApplied(2차 적대적 검수 SR2-REL-001)", () => {
  // 실 네트워크 Postgres 없이도 "pg" 경로의 로직(kind 분기 + 대기 마이그레이션 판정 +
  // 에러 메시지)을 검증하기 위해, PGlite 기반 connectionProvider를 "pg"로 표시한 가짜
  // WarehouseHandle을 만든다 — ensureNetworkMigrationsApplied는 connectionProvider를 통해서만
  // DB에 접근하므로 실제 저장소가 pg든 PGlite든 이 함수 입장에서는 구분되지 않는다.
  function fakeNetworkHandle(db: PGlite): WarehouseHandle {
    const connectionProvider = createPgliteConnectionProvider(db);
    return {
      warehouse: createPgWarehouse(connectionProvider),
      kind: "pg",
      connectionProvider,
      close: () => Promise.resolve(),
    };
  }

  it("kind가 pglite면 스키마 상태와 무관하게 아무 것도 하지 않는다(embedded 경로는 이미 자동 마이그레이션됨)", async () => {
    const db = new PGlite(); // 마이그레이션을 일부러 적용하지 않은 완전히 빈 상태.
    const connectionProvider = createPgliteConnectionProvider(db);
    const handle: WarehouseHandle = {
      warehouse: createPgWarehouse(connectionProvider),
      kind: "pglite",
      connectionProvider,
      close: () => Promise.resolve(),
    };

    await expect(ensureNetworkMigrationsApplied(handle)).resolves.toBeUndefined();
  });

  it("kind가 pg이고 스키마가 완전히 비어 있으면(대기 중인 마이그레이션 전부) retail-mcp-migrate로 안내하는 에러를 던진다", async () => {
    const handle = fakeNetworkHandle(new PGlite());

    await expect(ensureNetworkMigrationsApplied(handle)).rejects.toThrow(
      /retail-mcp-migrate.*--confirm/s,
    );
  });

  it("kind가 pg이고 모든 마이그레이션이 이미 적용돼 있으면 통과한다", async () => {
    const db = new PGlite();
    const migrations = await loadMigrations();
    await runMigrations(createPgliteExecutor(db), migrations);
    const handle = fakeNetworkHandle(db);

    await expect(ensureNetworkMigrationsApplied(handle)).resolves.toBeUndefined();
  });

  it("kind가 pg이고 일부만 적용돼 있으면 대기 중인 id를 정확히 나열한다", async () => {
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
