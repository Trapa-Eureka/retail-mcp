import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireFileLock, FileLockBusyError } from "../src/adapters/fileLock.js";
import { createWarehouseFromEnv } from "../src/adapters/warehouseFactory.js";

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
});
