import { describe, expect, it } from "vitest";
import { DEFAULT_STALE_THRESHOLD_HOURS, computeFreshness } from "../src/core/freshness.js";
import type { SyncStateRow } from "../src/core/types.js";

const NOW = new Date("2026-09-02T00:00:00Z");

describe("computeFreshness", () => {
  it("returns the oldest time without warnings when every resource is within the threshold", () => {
    const syncState: SyncStateRow[] = [
      { resource: "receipts", cursor: "wm-1", lastSyncedAt: new Date("2026-09-01T23:00:00Z") },
      { resource: "inventory", cursor: "wm-2", lastSyncedAt: new Date("2026-09-01T20:00:00Z") },
    ];
    const result = computeFreshness(syncState, ["receipts", "inventory"], NOW);
    expect(result.warnings).toEqual([]);
    expect(result.dataLastSyncedAt).toEqual(new Date("2026-09-01T20:00:00Z"));
  });

  it(`emits a stale warning for a resource older than the default threshold (${DEFAULT_STALE_THRESHOLD_HOURS} hours)`, () => {
    const syncState: SyncStateRow[] = [
      { resource: "inventory", cursor: "wm-1", lastSyncedAt: new Date("2026-08-30T00:00:00Z") },
    ];
    const result = computeFreshness(syncState, ["inventory"], NOW);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/inventory.*more than 24 hour/);
    expect(result.dataLastSyncedAt).toEqual(new Date("2026-08-30T00:00:00Z"));
  });

  it("when a resource has never been synced, dataLastSyncedAt is null and a warning is emitted", () => {
    const syncState: SyncStateRow[] = [
      { resource: "inventory", cursor: "wm-1", lastSyncedAt: new Date("2026-09-01T23:00:00Z") },
    ];
    const result = computeFreshness(syncState, ["receipts", "inventory"], NOW);
    expect(result.dataLastSyncedAt).toBeNull();
    expect(result.warnings).toEqual(['Resource "receipts" has never been synced.']);
  });

  it("warns against a narrower staleThresholdHours when one is given", () => {
    const syncState: SyncStateRow[] = [
      { resource: "inventory", cursor: "wm-1", lastSyncedAt: new Date("2026-09-01T23:00:00Z") },
    ];
    const result = computeFreshness(syncState, ["inventory"], NOW, 0.5);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("more than 0.5 hour");
  });
});
