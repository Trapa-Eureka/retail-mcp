/**
 * Data freshness judgement — pure function (SPEC §9 "every query and report includes the last
 * successful sync time. A stale warning is attached when the allowed freshness threshold is
 * exceeded"). `buildReorderReport()` in `agent/reorder.ts` (the report) and the query tools in
 * `mcp/tools.ts` share this single function — the "same core function" principle (SPEC §3-4)
 * applied to freshness as well. No external IO: the caller passes the value it already fetched with
 * `Warehouse.getSyncState()`.
 */
import type { SyncStateRow } from "./types.js";

export const DEFAULT_STALE_THRESHOLD_HOURS = 24;

export interface FreshnessResult {
  /**
   * The oldest (= least fresh) last-sync time among the relevant resources. If any relevant
   * resource has never been synced (null), the whole value is null — partial values are never
   * presented as fresh.
   */
  dataLastSyncedAt: Date | null;
  warnings: string[];
}

/**
 * Builds dataLastSyncedAt and stale warnings from the sync state of the resources in `resources`.
 * @param staleThresholdHours Default DEFAULT_STALE_THRESHOLD_HOURS (24). The caller adjusts it via env (STALE_THRESHOLD_HOURS).
 */
export function computeFreshness(
  syncState: SyncStateRow[],
  resources: string[],
  now: Date,
  staleThresholdHours: number = DEFAULT_STALE_THRESHOLD_HOURS,
): FreshnessResult {
  const warnings: string[] = [];
  const staleThresholdMs = staleThresholdHours * 60 * 60 * 1000;
  let dataLastSyncedAt: Date | null = null;
  let anyMissing = false;

  for (const resource of resources) {
    const state = syncState.find((s) => s.resource === resource);
    if (!state || state.lastSyncedAt === null) {
      anyMissing = true;
      warnings.push(`Resource "${resource}" has never been synced.`);
      continue;
    }
    if (dataLastSyncedAt === null || state.lastSyncedAt < dataLastSyncedAt) {
      dataLastSyncedAt = state.lastSyncedAt;
    }
    if (now.getTime() - state.lastSyncedAt.getTime() > staleThresholdMs) {
      warnings.push(
        `"${resource}" data has not been refreshed for more than ${staleThresholdHours} hour(s)` +
          ` (last synced: ${state.lastSyncedAt.toISOString()}) — it may be stale.`,
      );
    }
  }

  return { dataLastSyncedAt: anyMissing ? null : dataLastSyncedAt, warnings };
}
