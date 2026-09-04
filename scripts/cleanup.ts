/**
 * Operational data retention cleanup CLI (007 OPS-005, TASKS T34) — run by humans only.
 *
 * `agent_send_log` (one row per agent run) and `inventory_snapshots` (one full inventory
 * snapshot set per Loyverse sync) grow without bound in long-term operation (flagged by the
 * 007 review) — this script deletes rows older than the retention period
 * (`CLEANUP_RETENTION_DAYS`, default 90 days).
 *
 * It is a destructive operation of the same nature as `npm run migrate` (guardrail 5,
 * production DATABASE_URL migrations are run by humans only), so it uses the same double-gate
 * pattern: the default is dry-run (only counts the target rows, deletes nothing), and actually
 * deleting requires an explicit `--confirm` (the same "explicit risk acknowledgement"
 * convention as `SEND_MODE=live && --confirm`).
 *
 * pg when `DATABASE_URL` is set, embedded PGlite otherwise — `createWarehouseFromEnv()` already
 * knows that branch, so this script behaves the same either way (unlike `npm run migrate` it is
 * not pg-only — PGlite auto-migrates its schema on startup, but cleanup is separate).
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
      `CLEANUP_RETENTION_DAYS is invalid: "${raw}". It must be an integer number of days greater than 0.`,
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
        `[dry-run] rows to delete under the ${retentionDays}-day retention period (before ${before.toISOString()}) — ` +
          `inventory_snapshots ${snapshotCount} rows, agent_send_log ${sendLogCount} rows. ` +
          "To actually delete them, run again with --confirm.",
      );
      return;
    }

    console.log(
      `Cleanup complete — under the ${retentionDays}-day retention period (before ${before.toISOString()}) ` +
        `deleted inventory_snapshots ${snapshotCount} rows, agent_send_log ${sendLogCount} rows.`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
