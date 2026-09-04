import { describe, expect, it, vi } from "vitest";
import {
  AdvisoryLockBusyError,
  withTryAdvisoryLock,
  type QueryClient,
} from "../src/adapters/advisoryLock.js";

function fakeClient(locked: boolean): { client: QueryClient; calls: string[] } {
  const calls: string[] = [];
  const client: QueryClient = {
    query: <T extends Record<string, unknown>>(text: string) => {
      calls.push(text);
      if (text.startsWith("select pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ locked }] as unknown as T[] });
      }
      return Promise.resolve({ rows: [] as T[] });
    },
  };
  return { client, calls };
}

describe("withTryAdvisoryLock", () => {
  it("runs fn once the lock is acquired and unlocks when done", async () => {
    const { client, calls } = fakeClient(true);
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withTryAdvisoryLock(client, 1, fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "select pg_try_advisory_lock($1) as locked",
      "select pg_advisory_unlock($1)",
    ]);
  });

  it("throws AdvisoryLockBusyError without waiting and does not run fn when already locked", async () => {
    const { client } = fakeClient(false);
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withTryAdvisoryLock(client, 1, fn)).rejects.toThrow(AdvisoryLockBusyError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("always calls unlock even when fn fails", async () => {
    const { client, calls } = fakeClient(true);
    await expect(
      withTryAdvisoryLock(client, 1, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(calls).toContain("select pg_advisory_unlock($1)");
  });

  it("concurrent call simulation — only the one already running succeeds and the rest immediately get a busy error", async () => {
    // A shared client with a single state (locked) that mimics the real pg_try_advisory_lock.
    let locked = false;
    const client: QueryClient = {
      query: <T extends Record<string, unknown>>(text: string) => {
        if (text.startsWith("select pg_try_advisory_lock")) {
          if (locked) return Promise.resolve({ rows: [{ locked: false }] as unknown as T[] });
          locked = true;
          return Promise.resolve({ rows: [{ locked: true }] as unknown as T[] });
        }
        if (text.startsWith("select pg_advisory_unlock")) {
          locked = false;
          return Promise.resolve({ rows: [] as T[] });
        }
        return Promise.resolve({ rows: [] as T[] });
      },
    };

    let resolveSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });

    const first = withTryAdvisoryLock(client, 1, async () => {
      await slow;
      return "first";
    });
    // The second call follows after first has already acquired the lock (the lock attempt
    // proceeds synchronously up to the microtask queue), so the second must fail immediately as busy.
    await Promise.resolve();
    await Promise.resolve();
    const second = withTryAdvisoryLock(client, 1, () => Promise.resolve("second"));

    await expect(second).rejects.toThrow(AdvisoryLockBusyError);
    resolveSlow?.();
    await expect(first).resolves.toBe("first");
  });
});
