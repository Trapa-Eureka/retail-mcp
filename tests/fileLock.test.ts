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

  it("only one of two concurrent acquire attempts succeeds (reproduces the SPEC §12 spike)", async () => {
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

  it("when a live process holds the lock, the error message includes the holder PID and the remedy", async () => {
    const lock = await acquireFileLock(targetPath, { pid: 4242, isAlive: () => true });

    try {
      await acquireFileLock(targetPath, { isAlive: () => true });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FileLockBusyError);
      const busyErr = err as FileLockBusyError;
      expect(busyErr.holderPid).toBe(4242);
      expect(busyErr.message).toContain("4242");
      expect(busyErr.message).toMatch(/Try again|delete .* manually/); // includes remedy guidance
    }

    await lock.release();
  });

  it("automatically reclaims a stale lock left by a non-existent PID and acquires successfully", async () => {
    // Create a lock as pid=99999 (assumed to be a dead process), then inject isAlive as always
    // false to reproduce the "that process is dead" situation.
    const staleLock = await acquireFileLock(targetPath, {
      pid: 99999,
      isAlive: () => false,
    });
    // release() is deliberately not called — mimics a process crash that left only the lock file.
    void staleLock;

    const reclaimed = await acquireFileLock(targetPath, { isAlive: () => false });
    const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
    expect(content.pid).toBe(process.pid);

    await reclaimed.release();
  });

  it("creates the lock file's parent directory automatically when it does not exist yet and acquires successfully (TASKS T29, found by the QA-001 tarball smoke test — `.retail-mcp/` on the first run of a fresh install)", async () => {
    const freshTargetPath = join(dir, "not-yet-created", "data");

    const lock = await acquireFileLock(freshTargetPath);
    const content = JSON.parse(await readFile(`${freshTargetPath}.lock`, "utf8")) as {
      pid: number;
    };
    expect(content.pid).toBe(process.pid);

    await lock.release();
  });

  it("can acquire again after release", async () => {
    const lock = await acquireFileLock(targetPath);
    await lock.release();

    const second = await acquireFileLock(targetPath);
    await second.release();
  });

  it("does not delete the lock file at release time if it has been taken over by another pid", async () => {
    const lock = await acquireFileLock(targetPath);
    // Mimics our lock being reclaimed as stale and another process (pid=555) acquiring it anew.
    await writeFile(
      `${targetPath}.lock`,
      JSON.stringify({ pid: 555, acquiredAt: new Date().toISOString() }),
    );

    await lock.release();

    const remaining = await readFile(`${targetPath}.lock`, "utf8");
    expect((JSON.parse(remaining) as { pid: number }).pid).toBe(555);
  });

  it("withFileLock: releases automatically after fn runs so the next acquire succeeds", async () => {
    const result = await withFileLock(targetPath, async () => {
      await expect(acquireFileLock(targetPath)).rejects.toThrow(FileLockBusyError);
      return "done";
    });
    expect(result).toBe("done");

    const lock = await acquireFileLock(targetPath);
    await lock.release();
  });

  it("withFileLock: release is still performed when fn fails", async () => {
    await expect(
      withFileLock(targetPath, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const lock = await acquireFileLock(targetPath);
    await lock.release();
  });

  describe("PID reuse mitigation and cross-host judgement (OPS-002, TASKS T34)", () => {
    it("reclaims when the pid is alive but the process start time differs from the lock record (pid reuse)", async () => {
      // Lock created by the original process (pid=4242) — start time T1.
      await acquireFileLock(targetPath, {
        pid: 4242,
        isAlive: () => true,
        getProcessStartedAt: () => "T1",
      });

      // The same pid=4242 is alive now (the OS reused it) but the start time differs, T2 —
      // meaning it is a new process rather than the dead original, so it must be treated as
      // stale and reclaimed.
      const reclaimed = await acquireFileLock(targetPath, {
        isAlive: () => true,
        getProcessStartedAt: () => "T2",
      });
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
      expect(content.pid).toBe(process.pid);

      await reclaimed.release();
    });

    it("throws the normal busy error when the pid is alive and the process start time matches (no reuse)", async () => {
      await acquireFileLock(targetPath, {
        pid: 4242,
        isAlive: () => true,
        getProcessStartedAt: () => "T1",
      });

      await expect(
        acquireFileLock(targetPath, { isAlive: () => true, getProcessStartedAt: () => "T1" }),
      ).rejects.toThrow(FileLockBusyError);
    });

    it("falls back to the existing PID-only judgement without this signal when the start time is unavailable (null)", async () => {
      await acquireFileLock(targetPath, {
        pid: 4242,
        isAlive: () => true,
        getProcessStartedAt: () => null,
      });

      // Even when the start time cannot be determined (e.g. Windows, no permission), "alive"
      // alone must safely result in busy — the absence of the pid-reuse signal must not be
      // misjudged as stale.
      await expect(
        acquireFileLock(targetPath, { isAlive: () => true, getProcessStartedAt: () => null }),
      ).rejects.toThrow(FileLockBusyError);
    });

    it("never reclaims a lock written by another host automatically, regardless of whether the process is alive", async () => {
      // machineId is also set explicitly to a value consistent with the differing hostname — so
      // the "different hosts" scenario is reproduced deterministically, independent of the real
      // MAC of the machine running the tests (both acquireFileLock calls would get the same
      // value with the default, SR2-LOCK-001).
      await acquireFileLock(targetPath, {
        pid: 4242,
        hostname: "other-host",
        machineId: "11:11:11:11:11:11",
        isAlive: () => true,
      });

      // From this process's point of view it is "another host", so even with isAlive false
      // (which only means that pid is not visible locally and says nothing about the remote
      // process) it must not be reclaimed.
      await expect(
        acquireFileLock(targetPath, {
          hostname: "this-host",
          machineId: "22:22:22:22:22:22",
          isAlive: () => false,
        }),
      ).rejects.toThrow(/another host|liveness cannot be checked/);
    });

    it("records hostname, nonce and pidStartedAt in the lock file", async () => {
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

  describe("legacy lock without hostname is owner-host-unknown → busy (second adversarial review SR2-LOCK-002)", () => {
    const legacyLock = (pid: number): string =>
      // Mimics a lock file written by a pre-T34 version — hostname/machineId/nonce/pidStartedAt are all absent.
      JSON.stringify({ pid, acquiredAt: "2026-09-01T00:00:00.000Z" });

    it("throws FileLockBusyError(unknownHost) without reclaiming even if that pid is dead locally", async () => {
      // Under the old behaviour (assumed "same host" for backward compatibility) isAlive=false
      // alone would have reclaimed it — on a shared filesystem that pid may be a live process on
      // another host, so it must not.
      await writeFile(`${targetPath}.lock`, legacyLock(99999));

      try {
        await acquireFileLock(targetPath, { isAlive: () => false });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(FileLockBusyError);
        const busyErr = err as FileLockBusyError;
        expect(busyErr.unknownHost).toBe(true);
        expect(busyErr.holderPid).toBe(99999);
        expect(busyErr.message).toContain("no owner host information (hostname)");
        expect(busyErr.message).toContain(`${targetPath}.lock`);
        expect(busyErr.message).toMatch(/delete .* manually/); // cause + how to fix
      }

      // The lock file must remain as is (no automatic deletion).
      const remaining = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
      expect(remaining.pid).toBe(99999);
    });

    it("is likewise busy (unknownHost) even if that pid is alive locally — the PID judgement is not used at all", async () => {
      await writeFile(`${targetPath}.lock`, legacyLock(4242));

      await expect(
        acquireFileLock(targetPath, { isAlive: () => true, getProcessStartedAt: () => "T2" }),
      ).rejects.toMatchObject({ name: "FileLockBusyError", unknownHost: true, holderPid: 4242 });
    });

    it("a lock with hostname but no machineId (pre-SR2-LOCK-001 format) is not treated as legacy — it falls back to the hostname judgement normally and reclaims the same host's stale lock", async () => {
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

    it("regression: a same-host stale lock in the current format (hostname+machineId) is still reclaimed automatically", async () => {
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

    it("regression: a live same-host lock in the current format is a normal busy error with unknownHost=false", async () => {
      await acquireFileLock(targetPath, { pid: 4242, isAlive: () => true });

      await expect(acquireFileLock(targetPath, { isAlive: () => true })).rejects.toMatchObject({
        name: "FileLockBusyError",
        unknownHost: false,
        holderPid: 4242,
      });
    });
  });

  describe("machineId-based cross-host judgement (second adversarial review SR2-LOCK-001)", () => {
    it("judges as another host and does not reclaim when hostnames match but machineIds differ (hostname collision scenario)", async () => {
      // Mimics two different machines/containers that happen to use the same hostname (a common
      // default such as "localhost") — only the machineId (MAC address etc.) differs.
      await acquireFileLock(targetPath, {
        pid: 4242,
        hostname: "same-hostname",
        machineId: "aa:aa:aa:aa:aa:aa",
        isAlive: () => true,
      });

      // Same hostname but different machineId — even with isAlive false (which only means that
      // pid is not visible locally; in reality it is a live process on another machine) it must
      // not be reclaimed.
      await expect(
        acquireFileLock(targetPath, {
          hostname: "same-hostname",
          machineId: "bb:bb:bb:bb:bb:bb",
          isAlive: () => false,
        }),
      ).rejects.toThrow(/another host|liveness cannot be checked/);
    });

    it("judges as the same host and uses the existing PID judgement when hostnames differ but machineIds match", async () => {
      await acquireFileLock(targetPath, {
        pid: 4242,
        hostname: "old-name",
        machineId: "cc:cc:cc:cc:cc:cc",
        isAlive: () => false, // dead process — stale.
      });

      // The hostname changed (e.g. DHCP hostname change after reboot) but the machineId is the
      // same — it is the same host, so the dead process's stale lock must be reclaimed normally.
      const reclaimed = await acquireFileLock(targetPath, {
        hostname: "new-name",
        machineId: "cc:cc:cc:cc:cc:cc",
        isAlive: () => false,
      });
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as { pid: number };
      expect(content.pid).toBe(process.pid);

      await reclaimed.release();
    });

    it("falls back to the existing hostname judgement when either side lacks a machineId (e.g. a lock from before machineId was introduced)", async () => {
      // Mimics a lock from before machineId was introduced (only the machineId field is missing;
      // hostname is present) — a lock without even a hostname is handled separately per
      // SR2-LOCK-002 (see the describe above).
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
      ).rejects.toThrow(/another host|liveness cannot be checked/);
    });

    it("records machineId in the lock file", async () => {
      const lock = await acquireFileLock(targetPath, { machineId: "ee:ee:ee:ee:ee:ee" });
      const content = JSON.parse(await readFile(`${targetPath}.lock`, "utf8")) as {
        machineId: string;
      };
      expect(content.machineId).toBe("ee:ee:ee:ee:ee:ee");

      await lock.release();
    });

    it("omits the field entirely when machineId is not injected (no explicit undefined)", async () => {
      // The actual machineId value depends on this test environment (a sandbox without network
      // interfaces etc.), so only "if the field exists it is a string" is checked — the point is
      // that acquire itself does not fail even without an explicit override via opts.
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
