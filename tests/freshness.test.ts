import { describe, expect, it } from "vitest";
import { DEFAULT_STALE_THRESHOLD_HOURS, computeFreshness } from "../src/core/freshness.js";
import type { SyncStateRow } from "../src/core/types.js";

const NOW = new Date("2026-09-02T00:00:00Z");

describe("computeFreshness", () => {
  it("전 리소스가 임계값 이내면 경고 없이 가장 오래된 시각을 반환한다", () => {
    const syncState: SyncStateRow[] = [
      { resource: "receipts", cursor: "wm-1", lastSyncedAt: new Date("2026-09-01T23:00:00Z") },
      { resource: "inventory", cursor: "wm-2", lastSyncedAt: new Date("2026-09-01T20:00:00Z") },
    ];
    const result = computeFreshness(syncState, ["receipts", "inventory"], NOW);
    expect(result.warnings).toEqual([]);
    expect(result.dataLastSyncedAt).toEqual(new Date("2026-09-01T20:00:00Z"));
  });

  it(`기본 임계값(${DEFAULT_STALE_THRESHOLD_HOURS}시간) 초과 리소스는 stale 경고를 낸다`, () => {
    const syncState: SyncStateRow[] = [
      { resource: "inventory", cursor: "wm-1", lastSyncedAt: new Date("2026-08-30T00:00:00Z") },
    ];
    const result = computeFreshness(syncState, ["inventory"], NOW);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/inventory.*24시간 이상/);
    expect(result.dataLastSyncedAt).toEqual(new Date("2026-08-30T00:00:00Z"));
  });

  it("한 번도 동기화되지 않은 리소스가 있으면 dataLastSyncedAt은 null이고 경고를 낸다", () => {
    const syncState: SyncStateRow[] = [
      { resource: "inventory", cursor: "wm-1", lastSyncedAt: new Date("2026-09-01T23:00:00Z") },
    ];
    const result = computeFreshness(syncState, ["receipts", "inventory"], NOW);
    expect(result.dataLastSyncedAt).toBeNull();
    expect(result.warnings).toEqual(['"receipts" 리소스가 아직 한 번도 동기화되지 않았습니다.']);
  });

  it("staleThresholdHours를 좁게 주면 그 값 기준으로 경고한다", () => {
    const syncState: SyncStateRow[] = [
      { resource: "inventory", cursor: "wm-1", lastSyncedAt: new Date("2026-09-01T23:00:00Z") },
    ];
    const result = computeFreshness(syncState, ["inventory"], NOW, 0.5);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("0.5시간 이상");
  });
});
