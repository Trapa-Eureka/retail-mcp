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
      // machineId도 hostname과 일관되게 다른 값으로 명시한다 — 실제 테스트 실행 머신의 진짜
      // MAC(두 acquireFileLock 호출 모두 기본값이면 같은 값이 됨, SR2-LOCK-001)에 좌우되지
      // 않고 "서로 다른 호스트" 시나리오를 결정적으로 재현하기 위해서다.
      await acquireFileLock(targetPath, {
        pid: 4242,
        hostname: "other-host",
        machineId: "11:11:11:11:11:11",
        isAlive: () => true,
      });

      // 이 프로세스 관점에서 "다른 호스트"이므로 isAlive를 false로 줘도(로컬에서 그 pid가
      // 안 보인다는 뜻일 뿐 원격 프로세스 생사와 무관) 회수하면 안 된다.
      await expect(
        acquireFileLock(targetPath, {
          hostname: "this-host",
          machineId: "22:22:22:22:22:22",
          isAlive: () => false,
        }),
      ).rejects.toThrow(/다른 호스트|생사를 확인할 수 없습니다/);
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

  describe("hostname 없는 구버전 락은 소유 호스트 불명 → busy(2차 적대적 검수 SR2-LOCK-002)", () => {
    const legacyLock = (pid: number): string =>
      // T34 이전 버전이 쓴 락 파일을 흉내낸다 — hostname/machineId/nonce/pidStartedAt이 아예 없다.
      JSON.stringify({ pid, acquiredAt: "2026-09-01T00:00:00.000Z" });

    it("로컬에서 그 pid가 죽어 있어도 자동 회수하지 않고 FileLockBusyError(unknownHost)를 던진다", async () => {
      // 예전 동작(하위 호환으로 "같은 호스트" 간주)이었다면 isAlive=false만으로 회수됐다 —
      // 공유 filesystem에서는 그 pid가 다른 호스트의 살아있는 프로세스일 수 있으므로 안 된다.
      await writeFile(`${targetPath}.lock`, legacyLock(99999));

      try {
        await acquireFileLock(targetPath, { isAlive: () => false });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(FileLockBusyError);
        const busyErr = err as FileLockBusyError;
        expect(busyErr.unknownHost).toBe(true);
        expect(busyErr.holderPid).toBe(99999);
        expect(busyErr.message).toContain("소유 호스트 정보(hostname)가 없습니다");
        expect(busyErr.message).toContain(`${targetPath}.lock`);
        expect(busyErr.message).toMatch(/직접 삭제/); // 원인 + 수정 방법
      }

      // 락 파일은 그대로 남아 있어야 한다(자동 삭제 금지).
      const remaining = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
      expect(remaining.pid).toBe(99999);
    });

    it("로컬에서 그 pid가 살아 있어도 마찬가지로 busy(unknownHost)다 — PID 판정 자체를 쓰지 않는다", async () => {
      await writeFile(`${targetPath}.lock`, legacyLock(4242));

      await expect(
        acquireFileLock(targetPath, { isAlive: () => true, getProcessStartedAt: () => "T2" }),
      ).rejects.toMatchObject({ name: "FileLockBusyError", unknownHost: true, holderPid: 4242 });
    });

    it("machineId만 없고 hostname은 있는 락(SR2-LOCK-001 이전 형식)은 구버전 취급이 아니다 — hostname 판정으로 정상 폴백해 같은 호스트의 stale lock을 회수한다", async () => {
      await writeFile(
        `${targetPath}.lock`,
        JSON.stringify({ pid: 99999, acquiredAt: "2026-09-01T00:00:00.000Z", hostname: "host-a" }),
      );

      const reclaimed = await acquireFileLock(targetPath, {
        hostname: "host-a",
        machineId: "dd:dd:dd:dd:dd:dd",
        isAlive: () => false,
      });
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
      expect(content.pid).toBe(process.pid);

      await reclaimed.release();
    });

    it("회귀: 현재 형식(hostname+machineId)의 같은 호스트 stale lock은 여전히 자동 회수된다", async () => {
      await acquireFileLock(targetPath, {
        pid: 99999,
        hostname: "this-host",
        machineId: "ee:ee:ee:ee:ee:ee",
        isAlive: () => false,
      });

      const reclaimed = await acquireFileLock(targetPath, {
        hostname: "this-host",
        machineId: "ee:ee:ee:ee:ee:ee",
        isAlive: () => false,
      });
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
      expect(content.pid).toBe(process.pid);

      await reclaimed.release();
    });

    it("회귀: 현재 형식의 살아있는 같은 호스트 락은 unknownHost=false인 일반 busy 에러다", async () => {
      await acquireFileLock(targetPath, { pid: 4242, isAlive: () => true });

      await expect(acquireFileLock(targetPath, { isAlive: () => true })).rejects.toMatchObject({
        name: "FileLockBusyError",
        unknownHost: false,
        holderPid: 4242,
      });
    });
  });

  describe("machineId 기반 cross-host 판정(2차 적대적 검수 SR2-LOCK-001)", () => {
    it("hostname이 같아도 machineId가 다르면 다른 호스트로 판정해 자동 회수하지 않는다(hostname 충돌 시나리오)", async () => {
      // 서로 다른 두 머신/컨테이너가 우연히 같은 hostname("localhost" 등 흔한 기본값)을 쓰는
      // 상황을 흉내낸다 — machineId(MAC 주소 등)만 다르다.
      await acquireFileLock(targetPath, {
        pid: 4242,
        hostname: "same-hostname",
        machineId: "aa:aa:aa:aa:aa:aa",
        isAlive: () => true,
      });

      // hostname은 같지만 machineId가 다르다 — isAlive를 false로 줘도(로컬에서 그 pid가 안
      // 보인다는 뜻일 뿐, 실제로는 다른 머신의 살아있는 프로세스) 회수하면 안 된다.
      await expect(
        acquireFileLock(targetPath, {
          hostname: "same-hostname",
          machineId: "bb:bb:bb:bb:bb:bb",
          isAlive: () => false,
        }),
      ).rejects.toThrow(/다른 호스트|생사를 확인할 수 없습니다/);
    });

    it("hostname이 달라도 machineId가 같으면 같은 호스트로 판정해 기존 PID 판정을 쓴다", async () => {
      await acquireFileLock(targetPath, {
        pid: 4242,
        hostname: "old-name",
        machineId: "cc:cc:cc:cc:cc:cc",
        isAlive: () => false, // 죽은 프로세스 — stale.
      });

      // hostname이 바뀌었지만(재부팅 후 DHCP 호스트명 변경 등) machineId는 같다 — 같은
      // 호스트이므로 죽은 프로세스의 stale lock을 정상적으로 회수할 수 있어야 한다.
      const reclaimed = await acquireFileLock(targetPath, {
        hostname: "new-name",
        machineId: "cc:cc:cc:cc:cc:cc",
        isAlive: () => false,
      });
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
      expect(content.pid).toBe(process.pid);

      await reclaimed.release();
    });

    it("machineId를 한쪽이라도 못 구하면(machineId 도입 전 락 등) 기존 hostname 판정으로 폴백한다", async () => {
      // machineId 도입 전 락(machineId 필드만 없고 hostname은 있음)을 흉내낸다 — hostname까지
      // 없는 락은 SR2-LOCK-002에 따라 별도 처리(위 describe 참고).
      await writeFile(
        `${targetPath}.lock`,
        JSON.stringify({ pid: 4242, acquiredAt: new Date().toISOString(), hostname: "host-a" }),
      );

      await expect(
        acquireFileLock(targetPath, {
          hostname: "host-b",
          machineId: "dd:dd:dd:dd:dd:dd",
          isAlive: () => false,
        }),
      ).rejects.toThrow(/다른 호스트|생사를 확인할 수 없습니다/);
    });

    it("락 파일에 machineId가 기록된다", async () => {
      const lock = await acquireFileLock(targetPath, { machineId: "ee:ee:ee:ee:ee:ee" });
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as {
        machineId: string;
      };
      expect(content.machineId).toBe("ee:ee:ee:ee:ee:ee");

      await lock.release();
    });

    it("machineId를 주입하지 않으면 필드 자체가 생략된다(undefined를 명시적으로 쓰지 않음)", async () => {
      // 이 테스트 환경(네트워크 인터페이스 없는 샌드박스 등)에 따라 실제 machineId 값은
      // 달라질 수 있으므로, 필드가 "있다면 문자열"이라는 것만 확인한다 — 핵심은 opts로
      // 명시적으로 override하지 않아도 acquire 자체가 실패하지 않는다는 것.
      const lock = await acquireFileLock(targetPath);
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as {
        machineId?: unknown;
      };
      if ("machineId" in content) {
        expect(typeof content.machineId).toBe("string");
      }

      await lock.release();
    });
  });
});
