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

  it("락 파일의 부모 디렉터리가 아직 없어도 자동으로 만들어 획득에 성공한다(TASKS T29, QA-001 tarball smoke test가 발견 — 새 설치 첫 실행의 `.retail-mcp/`)", async () => {
    const freshTargetPath = join(dir, "not-yet-created", "data");

    const lock = await acquireFileLock(freshTargetPath);
    const content = JSON.parse(await readFile(`${freshTargetPath}.lock`, "utf8")) as {
      pid: number;
    };
    expect(content.pid).toBe(process.pid);

    await lock.release();
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

  describe("PID 재사용 완화 및 cross-host 판정(OPS-002, TASKS T34)", () => {
    it("pid는 살아있지만 프로세스 시작 시각이 락 기록과 다르면 pid 재사용으로 보고 회수한다", async () => {
      // 원래 프로세스(pid=4242)가 만든 락 — 시작 시각 T1.
      await acquireFileLock(targetPath, {
        pid: 4242,
        isAlive: () => true,
        getProcessStartedAt: () => "T1",
      });

      // 같은 pid=4242가 지금은 살아있지만(OS가 재사용), 시작 시각이 T2로 다르다 — 죽은
      // 원래 프로세스가 아니라 새 프로세스라는 뜻이므로 stale로 취급해 회수해야 한다.
      const reclaimed = await acquireFileLock(targetPath, {
        isAlive: () => true,
        getProcessStartedAt: () => "T2",
      });
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
      expect(content.pid).toBe(process.pid);

      await reclaimed.release();
    });

    it("pid가 살아있고 프로세스 시작 시각도 같으면(재사용 아님) 정상적으로 busy 에러를 던진다", async () => {
      await acquireFileLock(targetPath, {
        pid: 4242,
        isAlive: () => true,
        getProcessStartedAt: () => "T1",
      });

      await expect(
        acquireFileLock(targetPath, { isAlive: () => true, getProcessStartedAt: () => "T1" }),
      ).rejects.toThrow(FileLockBusyError);
    });

    it("시작 시각을 구할 수 없으면(null) 이 신호 없이 기존 PID-only 판정으로 폴백한다", async () => {
      await acquireFileLock(targetPath, {
        pid: 4242,
        isAlive: () => true,
        getProcessStartedAt: () => null,
      });

      // 시작 시각을 못 구하는 상황(예: Windows, 권한 없음)이 재현돼도 "살아있다"만으로
      // 안전하게 busy 처리해야 한다 — pid 재사용 신호가 없다고 stale로 오판하면 안 된다.
      await expect(
        acquireFileLock(targetPath, { isAlive: () => true, getProcessStartedAt: () => null }),
      ).rejects.toThrow(FileLockBusyError);
    });

    it("다른 호스트가 쓴 락은 프로세스가 살아있는지와 무관하게 자동 회수하지 않는다", async () => {
      await acquireFileLock(targetPath, {
        pid: 4242,
        hostname: "other-host",
        isAlive: () => true,
      });

      // 이 프로세스 관점에서 "다른 호스트"이므로 isAlive를 false로 줘도(로컬에서 그 pid가
      // 안 보인다는 뜻일 뿐 원격 프로세스 생사와 무관) 회수하면 안 된다.
      await expect(
        acquireFileLock(targetPath, { hostname: "this-host", isAlive: () => false }),
      ).rejects.toThrow(/다른 호스트|생사를 확인할 수 없습니다/);
    });

    it("구버전 락 파일(hostname 필드 없음)은 같은 호스트로 간주해 기존 PID 판정을 그대로 쓴다(하위 호환)", async () => {
      // T34 이전 버전이 쓴 락 파일을 흉내낸다 — hostname/nonce/pidStartedAt이 아예 없다.
      await writeFile(
        `${targetPath}.lock`,
        JSON.stringify({ pid: 99999, acquiredAt: new Date().toISOString() }),
      );

      const reclaimed = await acquireFileLock(targetPath, { isAlive: () => false });
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
      expect(content.pid).toBe(process.pid);

      await reclaimed.release();
    });

    it("락 파일에 hostname·nonce·pidStartedAt이 기록된다", async () => {
      const lock = await acquireFileLock(targetPath, { hostname: "test-host" });
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as {
        hostname: string;
        nonce: string;
      };
      expect(content.hostname).toBe("test-host");
      expect(typeof content.nonce).toBe("string");
      expect(content.nonce.length).toBeGreaterThan(0);

      await lock.release();
    });
  });
});
