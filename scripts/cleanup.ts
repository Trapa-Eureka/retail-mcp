/**
 * 운영 데이터 보존 정책 정리 CLI(007 OPS-005, TASKS T34) — 사람 전용 실행.
 *
 * `agent_send_log`(에이전트 실행 1회당 1행)와 `inventory_snapshots`(Loyverse 동기화마다
 * 전체 재고 스냅샷 1세트)는 장기 운영 시 무제한으로 늘어난다(007 검수 지적) — 이 스크립트가
 * 보존 기간(`CLEANUP_RETENTION_DAYS`, 기본 90일)보다 오래된 행을 지운다.
 *
 * `npm run migrate`(가드레일 5, 프로덕션 DATABASE_URL 마이그레이션은 사람만)와 같은 성격의
 * 파괴적 작업이라 같은 이중 게이트 패턴을 쓴다: 기본은 dry-run(대상 행 수만 세고 지우지
 * 않음), 실제로 지우려면 `--confirm`을 명시해야 한다(`SEND_MODE=live && --confirm`과 동일한
 * "명시적 위험 인지" 관례).
 *
 * `DATABASE_URL`이 있으면 pg, 없으면 임베디드 PGlite — `createWarehouseFromEnv()`가 이미
 * 그 분기를 알고 있어 이 스크립트는 어느 쪽이든 동일하게 동작한다(`npm run migrate`와 달리
 * pg 전용이 아니다 — PGlite는 스키마를 기동 시 자동 마이그레이션하지만 정리는 별도다).
 */
import { createWarehouseFromEnv } from "../src/adapters/warehouseFactory.js";

const DEFAULT_RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseRetentionDays(): number {
  const raw = process.env["CLEANUP_RETENTION_DAYS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `CLEANUP_RETENTION_DAYS이 올바르지 않습니다: "${raw}". 0보다 큰 정수(일)여야 합니다.`,
    );
  }
  return n;
}

async function main(): Promise<void> {
  const retentionDays = parseRetentionDays();
  const confirm = process.argv.includes("--confirm");
  const before = new Date(Date.now() - retentionDays * MS_PER_DAY);

  const handle = await createWarehouseFromEnv();
  try {
    const snapshotCount = await handle.warehouse.deleteOldInventorySnapshots(before, {
      dryRun: !confirm,
    });
    const sendLogCount = await handle.warehouse.deleteOldAgentSendLog(before, {
      dryRun: !confirm,
    });

    if (!confirm) {
      console.log(
        `[dry-run] 보존 기간 ${retentionDays}일(${before.toISOString()} 이전) 삭제 대상 — ` +
          `inventory_snapshots ${snapshotCount}행, agent_send_log ${sendLogCount}행. ` +
          "실제로 지우려면 --confirm을 추가해 다시 실행하세요.",
      );
      return;
    }

    console.log(
      `정리 완료 — 보존 기간 ${retentionDays}일(${before.toISOString()} 이전) 기준으로 ` +
        `inventory_snapshots ${snapshotCount}행, agent_send_log ${sendLogCount}행 삭제.`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
