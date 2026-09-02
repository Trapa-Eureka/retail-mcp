/**
 * 데이터 신선도 판정 — 순수 함수 (SPEC §9 "모든 조회와 리포트는 마지막 성공 동기화 시각을
 * 포함한다. 허용 신선도 기준을 넘으면 stale 경고를 붙인다"). `agent/reorder.ts`의
 * `buildReorderReport()`(리포트)와 `mcp/tools.ts`의 조회 도구가 이 하나의 함수를 공유한다 —
 * "같은 core 함수 사용" 원칙(SPEC §3-4)을 신선도 판정에도 적용한다. 외부 IO 없음: 호출자가
 * `Warehouse.getSyncState()`로 미리 조회한 값을 넘긴다.
 */
import type { SyncStateRow } from "./types.js";

export const DEFAULT_STALE_THRESHOLD_HOURS = 24;

export interface FreshnessResult {
  /**
   * 관련 리소스 중 가장 오래된(=가장 신선도가 낮은) 마지막 동기화 시각. 관련 리소스 중
   * 하나라도 동기화 이력이 없으면(null) 전체를 null로 처리한다 — 일부만 있는 값을 신선한
   * 것처럼 보여주지 않는다.
   */
  dataLastSyncedAt: Date | null;
  warnings: string[];
}

/**
 * `resources`에 해당하는 리소스들의 동기화 상태를 보고 dataLastSyncedAt과 stale 경고를 만든다.
 * @param staleThresholdHours 기본 DEFAULT_STALE_THRESHOLD_HOURS(24). 호출자가 env(STALE_THRESHOLD_HOURS)로 조정.
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
      warnings.push(`"${resource}" 리소스가 아직 한 번도 동기화되지 않았습니다.`);
      continue;
    }
    if (dataLastSyncedAt === null || state.lastSyncedAt < dataLastSyncedAt) {
      dataLastSyncedAt = state.lastSyncedAt;
    }
    if (now.getTime() - state.lastSyncedAt.getTime() > staleThresholdMs) {
      warnings.push(
        `"${resource}" 데이터가 ${staleThresholdHours}시간 이상 갱신되지 않았습니다` +
          `(마지막 동기화: ${state.lastSyncedAt.toISOString()}) — stale 상태일 수 있습니다.`,
      );
    }
  }

  return { dataLastSyncedAt: anyMissing ? null : dataLastSyncedAt, warnings };
}
