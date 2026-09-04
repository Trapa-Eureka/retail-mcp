/**
 * Real clock adapter. `core/` and `agent/reorder.ts` never call `new Date()` directly without
 * going through this file — the clock, like every other external IO (POS, DB, send), sits
 * behind an interface (CLAUDE.md convention). Tests use `createFixedClock()` from
 * `src/mocks/fixedClock.ts`.
 */
import type { Clock } from "../core/types.js";

export function createSystemClock(): Clock {
  return {
    now: () => new Date(),
  };
}
