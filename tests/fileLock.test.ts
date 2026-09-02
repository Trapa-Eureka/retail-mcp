import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireFileLock, FileLockBusyError, withFileLock } from "../src/adapters/fileLock.js";

describe("fileLock", () => {
  let dir: string;
  let targetPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-filelock-"));
    targetPath = join(dir, "data");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("동시 acquire 시도 중 하나만 성공한다(SPEC §12 스파이크 재현)", async () => {
    const results = await Promise.allSettled([
      acquireFileLock(targetPath),
      acquireFileLock(targetPath),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(FileLockBusyError);

    await (
      fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireFileLock>>>
    ).value.release();
  });

  it("살아있는 프로세스가 보유 중이면 에러 메시지에 보유 PID와 조치가 포함된다", async () => {
    const lock = await acquireFileLock(targetPath, { pid: 4242, isAlive: () => true });

    try {
      await acquireFileLock(targetPath, { isAlive: () => true });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FileLockBusyError);
      const busyErr = err as FileLockBusyError;
      expect(busyErr.holderPid).toBe(4242);
      expect(busyErr.message).toContain("4242");
      expect(busyErr.message).toMatch(/다시 시도|수동으로 삭제/); // 조치 안내 포함
    }

    await lock.release();
  });

  it("존재하지 않는 PID가 남긴 stale lock을 자동으로 회수하고 획득에 성공한다", async () => {
    // pid=99999(죽은 프로세스로 가정)로 락을 만든 뒤, isAlive를 항상 false로 주입해
    // "그 프로세스는 죽었다"는 상황을 재현한다.
    const staleLock = await acquireFileLock(targetPath, {
      pid: 99999,
      isAlive: () => false,
    });
    // release()는 호출하지 않는다 — 프로세스가 크래시해 락 파일만 남은 상황을 흉내낸다.
    void staleLock;

    const reclaimed = await acquireFileLock(targetPath, { isAlive: () => false });
    const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
    expect(content.pid).toBe(process.pid);

    await reclaimed.release();
  });

  it("release 후에는 다시 acquire할 수 있다", async () => {
    const lock = await acquireFileLock(targetPath);
    await lock.release();

    const second = await acquireFileLock(targetPath);
    await second.release();
  });

  it("release 시점에 락 파일이 다른 pid 소유로 바뀌어 있으면 지우지 않는다", async () => {
    const lock = await acquireFileLock(targetPath);
    // 우리 락이 stale로 회수되고 다른 프로세스(pid=555)가 새로 획득한 상황을 흉내낸다.
    await writeFile(
      `${targetPath}.lock`,
      JSON.stringify({ pid: 555, acquiredAt: new Date().toISOString() }),
    );

    await lock.release();

    const remaining = await readFile(`${targetPath}.lock`, "utf8");
    expect((JSON.parse(remaining) as { pid: number }).pid).toBe(555);
  });

  it("withFileLock: fn 실행 후 자동으로 release되어 다음 acquire가 성공한다", async () => {
    const result = await withFileLock(targetPath, async () => {
      await expect(acquireFileLock(targetPath)).rejects.toThrow(FileLockBusyError);
      return "done";
    });
    expect(result).toBe("done");

    const lock = await acquireFileLock(targetPath);
    await lock.release();
  });

  it("withFileLock: fn이 실패해도 release는 수행된다", async () => {
    await expect(
      withFileLock(targetPath, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const lock = await acquireFileLock(targetPath);
    await lock.release();
  });
});
