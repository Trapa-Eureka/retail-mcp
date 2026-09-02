/**
 * 수동 스모크 스크립트 (TESTING.md §5) — 사람 전용, 실 Loyverse 토큰 + 실 DB 대상.
 *
 * ① sync(etl/sync.ts의 syncAll) → ② 조회 도구 3종(sell_through/inventory_status/
 * stockout_risk) 호출 출력 → ③ 재주문 에이전트 dry-run.
 *
 * live 발송은 여기 포함하지 않는다 — `.env`의 SEND_MODE 값과 무관하게 이 스크립트는 항상
 * sendMode="dry_run", confirm=false로 강제한다(TESTING §5, CLAUDE.md 가드레일 1). 최초
 * 실발송은 사람이 `npm run agent:reorder -- --confirm`을 직접 1회 실행한다(README 참고).
 *
 * 프로덕션 DATABASE_URL을 실수로 조회 이상으로 건드리지 않도록, 여기서는 warehouse의
 * upsert/setCursor류를 직접 호출하지 않고(syncAll 내부에서만 씀) 나머지는 조회 도구만 쓴다.
 */
import { Pool } from "pg";
import { createClaudeSummarizer } from "../src/adapters/claudeSummarizer.js";
import { createLoyverseClientFromEnv } from "../src/adapters/loyverseClient.js";
import { createPgConnectionProvider, createPgWarehouse } from "../src/adapters/pgWarehouse.js";
import { createSystemClock } from "../src/adapters/systemClock.js";
import { runReorderAgent } from "../src/agent/reorder.js";
import { syncAll } from "../src/etl/sync.js";
import { createMockNotificationProvider } from "../src/mocks/mockNotificationProvider.js";
import {
  inventoryStatusTool,
  sellThroughTool,
  stockoutRiskTool,
  type QueryToolDeps,
} from "../src/mcp/tools.js";

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name}이 없습니다. ${hint}`);
  }
  return value;
}

function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv(
    "DATABASE_URL",
    "Neon/Supabase Postgres 연결 문자열을 .env에 추가하세요.",
  );
  const businessTimezone = requireEnv(
    "BUSINESS_TIMEZONE",
    "예: Asia/Manila. .env의 BUSINESS_TIMEZONE에 추가하세요.",
  );
  // LOYVERSE_API_TOKEN/ANTHROPIC_API_KEY는 각 어댑터의 createXFromEnv()가 자체 검증한다.

  const pool = new Pool({ connectionString: databaseUrl });
  const warehouse = createPgWarehouse(createPgConnectionProvider(pool));
  const clock = createSystemClock();

  try {
    heading("① sync — Loyverse → Postgres 증분 동기화");
    const loyverseClient = createLoyverseClientFromEnv();
    const syncResult = await syncAll({ loyverseClient, warehouse, clock }, {});
    for (const r of syncResult.resources) {
      console.log(
        `  ${r.resource}: ${r.status} (${r.itemCount}건)` + (r.error ? ` — ${r.error}` : ""),
      );
    }
    if (!syncResult.ok) {
      throw new Error("동기화가 일부 실패/건너뜀 처리됐습니다 — 위 출력에서 원인을 확인하세요.");
    }

    heading("② 조회 도구 3종 — sell_through / inventory_status / stockout_risk");
    const queryDeps: QueryToolDeps = { warehouse, clock, businessTimezone };

    const sellThrough = await sellThroughTool(queryDeps, { periodDays: 30, order: "desc", top: 5 });
    console.log(`sell_through 상위 ${sellThrough.rows.length}건 (근사식: ${sellThrough.note})`);
    console.log(JSON.stringify(sellThrough.rows, null, 2));

    const inventoryStatus = await inventoryStatusTool(queryDeps, {});
    console.log(`inventory_status: ${inventoryStatus.rows.length}개 품목`);

    const stockoutRisk = await stockoutRiskTool(queryDeps, { leadTimeDays: 7, safetyDays: 3 });
    console.log(`stockout_risk: 위험 품목 ${stockoutRisk.rows.length}건`);
    console.log(JSON.stringify(stockoutRisk.rows.slice(0, 5), null, 2));

    for (const meta of [sellThrough.meta, inventoryStatus.meta, stockoutRisk.meta]) {
      if (meta.warnings.length > 0) {
        console.log(`  경고: ${meta.warnings.join(" / ")}`);
      }
    }

    heading("③ 재주문 에이전트 dry-run (live 발송 없음 — 스모크는 항상 dry_run 강제)");
    const agentResult = await runReorderAgent(
      {
        warehouse,
        clock,
        notificationProvider: createMockNotificationProvider(),
        summarizer: createClaudeSummarizer(),
      },
      {
        businessTimezone,
        sendMode: "dry_run", // .env SEND_MODE와 무관하게 강제(TESTING §5) — live 발송은 스모크 범위 밖.
        confirm: false,
        ...(process.env["REPORT_RECIPIENT"] ? { recipient: process.env["REPORT_RECIPIENT"] } : {}),
      },
    );
    console.log(`상태: ${agentResult.status}, 제안 ${agentResult.suggestionCount}건`);
    if (agentResult.summary) {
      console.log(`요약: ${agentResult.summary}`);
    }

    heading("스모크 완료");
    console.log(
      "모든 단계가 오류 없이 끝났습니다. live 발송 전 체크리스트는 README.md의 " +
        "'최초 live 발송 전 사람 체크리스트'를 확인하세요.",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
