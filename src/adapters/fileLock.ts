/**
 * File lock for directory-level exclusive access. PGlite does not raise an error when several
 * processes open the same data directory at once; it silently loses the writes of the process
 * that opened it later (SPEC.md §12 "PGlite multi-process concurrent access" spike result) —
 * instead of relying on PGlite's own concurrency guarantees, this module uses a PID+timestamp
 * lock file to "refuse to start if another live process is already using it" (TASKS.md T13).
 *
 * The lock file lives outside the protected directory (`{targetPath}.lock`) — so that no
 * foreign file is placed inside the PGlite data directory.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname as osHostname, networkInterfaces } from "node:os";
import path from "node:path";

export interface FileLock {
  /** Verifies the lock is held by this process, then deletes the lock file. Ignored if another process owns it. */
  release(): Promise<void>;
}

export interface FileLockOptions {
  /** For test injection. Default: process.pid. */
  pid?: number;
  /** For test injection. Default: liveness check via process.kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
  /** For test injection. Default: () => new Date(). */
  nowFn?: () => Date;
  /** Maximum number of retries after reclaiming a stale lock (to handle contention with other processes). Default 5. */
  maxRetries?: number;
  /** For test injection (OPS-002). Default: os.hostname(). */
  hostname?: string;
  /** For test injection (second adversarial review SR2-LOCK-001). Default: defaultGetMachineId()
   * (MAC address of the first non-internal network interface, undefined if unavailable). */
  machineId?: string;
  /**
   * For test injection (OPS-002) — returns the start time of the process running under the
   * given pid as a string if it can be determined, or null if not (unsupported platform, no
   * permission, no such process). Default is `ps -o lstart= -p <pid>` on POSIX (always null on
   * Windows — see defaultGetProcessStartedAt below).
   */
  getProcessStartedAt?: (pid: number) => string | null;
}

interface LockFileContent {
  pid: number;
  acquiredAt: string;
  /** OPS-002 — a lock written by another host cannot have its liveness checked from this
   * process, so it is never reclaimed automatically (manual verification required). A lock
   * without this field (pre-T34 format, or a file created by another tool) is treated as
   * **owner host unknown** and likewise never reclaimed automatically (second adversarial
   * review SR2-LOCK-002 — previously it was assumed to be "the same host" and reclaimed based
   * on the local PID check alone, which could steal a live lock of another host on a shared
   * filesystem). Current code always records it. */
  hostname?: string;
  /** Second adversarial review SR2-LOCK-001 — hostname is a user-editable string, so different
   * machines/containers using the same value (a common default hostname, containers from the
   * same image, etc.) could be misjudged. A MAC address is bound to a physical/virtual NIC, so
   * such collisions are far less likely — when this value is present it takes precedence over
   * the hostname string comparison (when both exist). For older locks (field missing) or
   * environments where it cannot be determined (no network interface etc.), fall back to the
   * existing hostname judgement. */
  machineId?: string;
  /** A random value that distinguishes the actual run instance that created this lock, even
   * with the same pid/hostname (release() checks this value as well as the pid — OPS-002 hardening). */
  nonce?: string;
  /** OPS-002 — auxiliary signal to mitigate PID reuse misjudgement (the OS reassigning a dead
   * process's PID to another process). The start time of the process running under this pid
   * when the lock was created (only on platforms where it can be determined) — if later the
   * same pid reports "alive" but the pid's *current* start time differs from this value, the
   * pid was reused in the meantime and the lock is treated as stale. If null/missing, the
   * existing PID-only judgement is used without this signal (it is not a required signal).
   */
  pidStartedAt?: string | null;
}

/** Only attempted on POSIX (`ps -o lstart=` is common to macOS/Linux) — Windows has no
 * equivalent command without extra installs (`wmic`/PowerShell are heavier and this project has
 * never validated them, see OPS-006), and on failure (no ps, no permission, already exited) it
 * silently falls back to null since this is only OPS-002's auxiliary signal — if this function
 * threw, lock acquisition itself would be blocked, which would be a "new failure" rather than
 * the "mitigation" this signal is meant to be. */
function defaultGetProcessStartedAt(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** Second adversarial review SR2-LOCK-001 — auxiliary signal against the problem where a
 * hostname string collision (different machines/containers using the same default hostname)
 * causes another host's active lock to be misjudged as stale and deleted. Writes nothing to disk
 * (persisting a UUID to a file at install time fails its purpose when the lock target directory
 * itself is a shared/network filesystem, because that file would be shared too) and reuses the
 * network interface MAC address the OS already holds — bound to a physical/virtual NIC, so
 * collisions are far less likely than with hostname, and the call is synchronous so tests have
 * no real file IO side effects. Loopback (internal) and interfaces without a value are skipped
 * and the first one found is used — even with several interfaces this value is only an
 * auxiliary "same machine?" signal, so any choice is fine as long as it is consistently
 * reproducible. If unavailable (a sandbox without network interfaces etc.) returns undefined —
 * in that case it safely falls back to the existing hostname judgement (never throws, because
 * a throw here would block lock acquisition itself). */
function defaultGetMachineId(): string | undefined {
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (!entry.internal && entry.mac && entry.mac !== "00:00:00:00:00:00") {
          return entry.mac;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export class FileLockBusyError extends Error {
  /** Second adversarial review SR2-LOCK-002 — true when the lock file has no hostname (legacy
   * format), so it is unknown which host's process created it. The local PID check is
   * meaningless then (the pid may belong to another host), so it is not reclaimed automatically
   * and a person must verify and delete it manually. */
  public readonly unknownHost: boolean;

  constructor(
    lockPath: string,
    public readonly holderPid: number,
    acquiredAt: string,
    holderHostname?: string,
    opts: { unknownHost?: boolean } = {},
  ) {
    const unknownHost = opts.unknownHost ?? false;
    const hostNote = unknownHost
      ? " The lock file has no owner host information (hostname) (legacy format) — it is unknown which host's process created it, so this machine's PID check cannot decide whether it is stale and it will not be reclaimed automatically."
      : holderHostname !== undefined
        ? ` The lock was created by a process on host "${holderHostname}" — if that is a process on another host, its liveness cannot be checked from this machine and it will not be reclaimed automatically.`
        : "";
    const remedy = unknownHost
      ? `Verify that no process, including on other hosts, is using this directory, then delete ${lockPath} manually and try again.`
      : `Try again after that process has finished. If this error keeps appearing even though the process is already dead, delete ${lockPath} manually.`;
    super(
      `${lockPath} is already in use by process ${holderPid} (since ${acquiredAt}).${hostNote} ` +
        "If two processes open the same data directory at the same time, PGlite may silently " +
        `lose data (SPEC §12) — ${remedy}`,
    );
    this.name = "FileLockBusyError";
    this.unknownHost = unknownHost;
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function defaultIsAlive(pid: number): boolean {
  try {
    // signal 0: does not actually send a signal; only checks process existence and permission.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no process with that PID (it died) — stale lock. Other errors such as EPERM mean
    // it exists but we lack signal permission, so conservatively treat it as "alive".
    return isNodeErrnoException(err) ? err.code !== "ESRCH" : true;
  }
}

function lockPathFor(targetPath: string): string {
  return `${targetPath}.lock`;
}

async function tryCreateLockFile(lockPath: string, content: LockFileContent): Promise<boolean> {
  try {
    // The lock file's parent directory may not exist yet — for example the embedded PGlite
    // default path `.retail-mcp/data` (DESIGN §12.1, first run of a fresh install) starts from
    // a completely new directory where even the parent `.retail-mcp/` does not exist yet. Found
    // during work (QA-001 tarball smoke test, `scripts/verifyPack.ts`) — writing with `wx`
    // directly without mkdir failed with ENOENT. `recursive: true` is safe if it already
    // exists, and two processes calling mkdir at the same time both succeed without error
    // (same semantics as POSIX mkdir -p) — the 'wx' exclusive create below does the actual
    // contention arbitration.
    await mkdir(path.dirname(lockPath), { recursive: true });
    // 'wx': exclusive create that fails if the file already exists — a single syscall, so even
    // if two processes try at once only one succeeds (no TOCTOU race; the fix for the problem
    // the SPEC §12 spike reproduced).
    await writeFile(lockPath, JSON.stringify(content), { flag: "wx" });
    return true;
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "EEXIST") return false;
    throw err;
  }
}

async function readLockFile(lockPath: string): Promise<LockFileContent | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === "number" &&
      typeof (parsed as { acquiredAt?: unknown }).acquiredAt === "string"
    ) {
      return parsed as LockFileContent;
    }
    throw new Error("Unexpected format.");
  } catch (err) {
    throw new Error(
      `Cannot parse the contents of ${lockPath} (it may be corrupted). ` +
        "Verify that no other process is using this directory, then delete the file manually.",
      { cause: err },
    );
  }
}

/**
 * Acquires an exclusive lock on `targetPath` (a directory etc.). Throws `FileLockBusyError` if a
 * live process already holds it. A stale lock left by a dead process is reclaimed automatically
 * and the acquisition is retried.
 */
export async function acquireFileLock(
  targetPath: string,
  opts: FileLockOptions = {},
): Promise<FileLock> {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const nowFn = opts.nowFn ?? (() => new Date());
  const maxRetries = opts.maxRetries ?? 5;
  const hostname = opts.hostname ?? osHostname();
  const machineId = opts.machineId ?? defaultGetMachineId();
  const getProcessStartedAt = opts.getProcessStartedAt ?? defaultGetProcessStartedAt;
  const lockPath = lockPathFor(targetPath);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const nonce = randomUUID();
    const content: LockFileContent = {
      pid,
      acquiredAt: nowFn().toISOString(),
      hostname,
      nonce,
      pidStartedAt: getProcessStartedAt(pid),
      // exactOptionalPropertyTypes: when machineId could not be determined (undefined), omit the
      // field entirely — this differs from explicitly writing `machineId: undefined` (the intent
      // is for it to be treated as "this signal is absent", the same as an older lock).
      ...(machineId !== undefined ? { machineId } : {}),
    };
    if (await tryCreateLockFile(lockPath, content)) {
      return {
        async release(): Promise<void> {
          const current = await readLockFile(lockPath);
          // If it is not ours (different pid, or same pid but another instance's nonce), leave
          // it alone — nonce may be absent in older lock files, in which case compare pid only.
          if (current === null || current.pid !== pid) return;
          if (typeof current.nonce === "string" && current.nonce !== nonce) return;
          try {
            await rm(lockPath);
          } catch (err) {
            if (!(isNodeErrnoException(err) && err.code === "ENOENT")) throw err;
          }
        },
      };
    }

    const holder = await readLockFile(lockPath);
    if (holder === null) continue; // Another process released it in the meantime — retry immediately.

    // Second adversarial review SR2-LOCK-002 — a lock without a hostname field (pre-T34 format)
    // gives no way to tell which host's process created it. Previously, for backward
    // compatibility, it was assumed to be "the same host" and passed to the PID judgement below,
    // but on a shared/network filesystem a live pid on another host could be misjudged as stale
    // and deleted merely because it does not exist on this machine. So **owner host unknown =
    // busy** is handled conservatively and a person must verify and delete it manually. No
    // migration option is provided — this package is not yet published to npm so no legacy
    // locks exist on the user side, and current code always records hostname, so this branch
    // effectively only triggers on "lock files of unknown origin".
    if (typeof holder.hostname !== "string") {
      throw new FileLockBusyError(lockPath, holder.pid, holder.acquiredAt, undefined, {
        unknownHost: true,
      });
    }

    // OPS-002 — a lock written by another host cannot have its liveness checked from this process.
    //
    // Second adversarial review SR2-LOCK-001 — hostname is a user-editable string, so if
    // different machines/containers happen to use the same value (a common default hostname,
    // containers from the same base image, etc.) they could be misjudged as "the same host" and
    // a lock actually in use by another host could be deleted as stale. When both sides can
    // determine a machineId (network interface MAC, see defaultGetMachineId), that value takes
    // precedence over the hostname string comparison — even with equal hostnames, a different
    // machineId means another host (and conversely, different hostnames with the same machineId
    // mean the same host — covering the rare case where the hostname changes while running).
    // If either side lacks a machineId (a lock from before machineId was introduced, a sandbox
    // without network interfaces, etc.), fall back to the hostname judgement without this
    // signal — hostname presence was guaranteed above, so it is always comparable here.
    const holderMachineId = typeof holder.machineId === "string" ? holder.machineId : undefined;
    const crossHost =
      holderMachineId !== undefined && machineId !== undefined
        ? holderMachineId !== machineId
        : holder.hostname !== hostname;
    if (crossHost) {
      throw new FileLockBusyError(lockPath, holder.pid, holder.acquiredAt, holder.hostname);
    }

    if (isAlive(holder.pid)) {
      // The PID is alive, but if the process start time recorded when the lock was created
      // differs from the start time of the process now running under that pid, the OS reused
      // the pid in the meantime (OPS-002) — ignore the "alive" signal and treat it as stale. If
      // either value is unavailable (older lock, Windows, no permission, etc.), this signal is
      // not used and it is treated as "alive" as before.
      const recordedStartedAt = holder.pidStartedAt;
      const currentStartedAt = getProcessStartedAt(holder.pid);
      const pidReused =
        typeof recordedStartedAt === "string" &&
        typeof currentStartedAt === "string" &&
        recordedStartedAt !== currentStartedAt;
      if (!pidReused) {
        throw new FileLockBusyError(lockPath, holder.pid, holder.acquiredAt, holder.hostname);
      }
    }

    // Stale lock — left by a dead process (isAlive false) or the pid was reused, so reclaim it
    // and retry.
    try {
      await rm(lockPath);
    } catch (err) {
      if (!(isNodeErrnoException(err) && err.code === "ENOENT")) throw err;
    }
  }

  throw new Error(
    `Acquiring ${lockPath} was retried ${maxRetries} times but kept contending with another process. ` +
      "Try again shortly.",
  );
}

/** Convenience function that handles acquire → run fn → release (always attempted, whether fn succeeded or failed) in one go. */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const lock = await acquireFileLock(targetPath, opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
