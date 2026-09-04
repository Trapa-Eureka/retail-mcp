/**
 * Manual smoke script (TESTING.md §5) — humans only, targets a real Loyverse token + a real DB.
 *
 * ① sync (syncAll from etl/sync.ts) → ② print the output of the 3 query tools
 * (sell_through/inventory_status/stockout_risk) → ③ reorder agent dry-run.
 *
 * Live sends are not included here — regardless of the SEND_MODE value in `.env`, this script
 * always forces sendMode="dry_run", confirm=false (TESTING §5, CLAUDE.md guardrail 1). The first
 * live send is done once by a human running `npm run agent:reorder -- --confirm` directly (see README).
 *
 * To avoid accidentally touching a production DATABASE_URL beyond reads, this script never calls
 * the warehouse's upsert/setCursor family directly (only used inside syncAll) and otherwise uses
 * only the query tools.
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
    throw new Error(`${name} is not set. ${hint}`);
  }
  return value;
}

function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv(
    "DATABASE_URL",
    "Add the Neon/Supabase Postgres connection string to .env.",
  );
  const businessTimezone = requireEnv(
    "BUSINESS_TIMEZONE",
    "e.g. Asia/Manila. Add it to BUSINESS_TIMEZONE in .env.",
  );
  // LOYVERSE_API_TOKEN/ANTHROPIC_API_KEY are validated by each adapter's createXFromEnv() itself.

  const pool = new Pool({ connectionString: databaseUrl });
  const warehouse = createPgWarehouse(createPgConnectionProvider(pool));
  const clock = createSystemClock();

  try {
    heading("① sync — Loyverse → Postgres incremental sync");
    const loyverseClient = createLoyverseClientFromEnv();
    const syncResult = await syncAll({ loyverseClient, warehouse, clock }, {});
    for (const r of syncResult.resources) {
      console.log(
        `  ${r.resource}: ${r.status} (${r.itemCount} rows)` + (r.error ? ` — ${r.error}` : ""),
      );
    }
    if (!syncResult.ok) {
      throw new Error("Sync partially failed/skipped — check the cause in the output above.");
    }

    heading("② 3 query tools — sell_through / inventory_status / stockout_risk");
    const queryDeps: QueryToolDeps = { warehouse, clock, businessTimezone };

    const sellThrough = await sellThroughTool(queryDeps, { periodDays: 30, order: "desc", top: 5 });
    console.log(`sell_through top ${sellThrough.rows.length} (approximation: ${sellThrough.note})`);
    console.log(JSON.stringify(sellThrough.rows, null, 2));

    const inventoryStatus = await inventoryStatusTool(queryDeps, {});
    console.log(`inventory_status: ${inventoryStatus.rows.length} items`);

    const stockoutRisk = await stockoutRiskTool(queryDeps, { leadTimeDays: 7, safetyDays: 3 });
    console.log(`stockout_risk: ${stockoutRisk.rows.length} at-risk items`);
    console.log(JSON.stringify(stockoutRisk.rows.slice(0, 5), null, 2));

    for (const meta of [sellThrough.meta, inventoryStatus.meta, stockoutRisk.meta]) {
      if (meta.warnings.length > 0) {
        console.log(`  warning: ${meta.warnings.join(" / ")}`);
      }
    }

    heading("③ reorder agent dry-run (no live send — the smoke script always forces dry_run)");
    const agentResult = await runReorderAgent(
      {
        warehouse,
        clock,
        notificationProvider: createMockNotificationProvider(),
        summarizer: createClaudeSummarizer(),
      },
      {
        businessTimezone,
        sendMode: "dry_run", // Forced regardless of .env SEND_MODE (TESTING §5) — live sends are out of smoke scope.
        confirm: false,
        ...(process.env["REPORT_RECIPIENT"] ? { recipient: process.env["REPORT_RECIPIENT"] } : {}),
      },
    );
    console.log(`status: ${agentResult.status}, ${agentResult.suggestionCount} suggestions`);
    if (agentResult.summary) {
      console.log(`summary: ${agentResult.summary}`);
    }

    heading("Smoke complete");
    console.log(
      "All steps finished without errors. For the checklist before a live send, see " +
        "'Human checklist before the first live send' in README.md.",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
