/**
 * Fixed clock for tests (TESTING.md §2). Every date calculation obtains "now" only through this
 * Clock — deterministic, independent of the machine's local time.
 */
import type { Clock } from "../core/types.js";

export function createFixedClock(iso: string): Clock {
  const fixed = new Date(iso);
  if (Number.isNaN(fixed.getTime())) {
    throw new Error(`Invalid ISO timestamp: "${iso}". Pass a parseable date string to FixedClock.`);
  }
  return {
    now: () => new Date(fixed.getTime()),
  };
}
