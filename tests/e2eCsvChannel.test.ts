/**
 * CSV/Excel channel e2e (TASKS T22) — verifies the two real usage procedures described in SPEC §12
 * end to end, on a real filesystem with independent PGlite warehouses. The individual unit
 * behaviours are already covered densely by `tests/folderScan.test.ts` (T18/T20), so this file
 * focuses on whether those pieces mesh exactly as in the real operating procedure.
 *
 * Scenario 1 (branch standalone): inventory file → parse → load → low-stock alert send (really
 * passing the SEND_MODE=live+--confirm double gate), run with the same folder structure onboarding
 * creates.
 *
 * Scenario 2 (HQ consolidated): two **mutually independent PGlite warehouses** (branches A/B) each
 * scan and produce real snapshot files, which are moved by "the transfer means already in use"
 * (SPEC §12, simulated here with a file copy) into the collect folder of a third independent PGlite
 * warehouse (HQ), and HQ queries the consolidated view — the existing `runConsolidatedScan` tests
 * fed hand-written snapshot fixtures directly, whereas here we confirm that a file actually
 * produced by the T19 export passes the T20 import as-is.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConsolidatedScan, runFolderScan } from "../src/agent/folderScan.js";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import { createMockNotificationProvider } from "../src/mocks/mockNotificationProvider.js";
import type { Warehouse } from "../src/core/types.js";

const NOW_ISO = "2026-09-03T00:00:00Z";

async function makeWarehouse(): Promise<Warehouse> {
  const db = await createTestWarehouse();
  return createPgWarehouse(createPgliteConnectionProvider(db));
}

describe("e2e — branch standalone scenario (file→parse→load→alert)", () => {
  let dir: string;
  let watchDir: string;
  let snapshotDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-e2e-branch-"));
    watchDir = join(dir, "watch");
    snapshotDir = join(dir, "snapshot");
    await mkdir(watchDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("with the exact structure onboarding creates — drop in an inventory file, scan, and it ends with the load + a real low-stock alert send", async () => {
    const warehouse = await makeWarehouse();
    const notificationProvider = createMockNotificationProvider();

    // Main Store: an item with sales history (stockout risk) + an item without (below threshold, override 3).
    // North Branch: an item with sales history and safe stock — not an alert target.
    const inventoryCsv = `store,product,sku,stock_qty,sales_qty,period_start,period_end,low_stock_threshold
Main Store,Cola 500ml,SKU-COLA,10,560,2026-08-01,2026-08-29,
Main Store,Piattos,SKU-CHIPS,2,,,,3
North Branch,Water 500ml,SKU-WATER,100,28,2026-08-01,2026-08-29,
`;
    await writeFile(join(watchDir, "inventory.csv"), inventoryCsv, "utf8");

    const result = await runFolderScan(
      { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
      {
        watchDir,
        snapshotDir,
        sendMode: "live",
        confirm: true, // Really passing the double gate (guardrail 1) — the real send path, not dry_run.
        recipient: "owner@example.com",
      },
    );

    // Load: all 3 items landed in the warehouse.
    const stock = await warehouse.queryStock({});
    expect(stock).toHaveLength(3);
    expect(stock.map((s) => s.variantId).sort()).toEqual(["SKU-CHIPS", "SKU-COLA", "SKU-WATER"]);

    // Alert decision: COLA (stockout risk, history mode) + CHIPS (below threshold 3, no_history
    // mode) = 2, WATER is safe and excluded.
    expect(result.alertCount).toBe(2);
    expect(result.alerts.map((a) => a.variantId).sort()).toEqual(["SKU-CHIPS", "SKU-COLA"]);
    expect(result.alerts.find((a) => a.variantId === "SKU-CHIPS")?.mode).toBe("no_history");
    expect(result.alerts.find((a) => a.variantId === "SKU-COLA")?.mode).toBe("history");

    // Send: live && confirm both set, so it really went out (check the mock provider actually received it).
    expect(result.sent).toBe(true);
    expect(result.status).toBe("sent");
    expect(notificationProvider.sent).toHaveLength(1);
    const sentMessage = notificationProvider.sent[0]!;
    expect(sentMessage.to).toBe("owner@example.com");
    expect(sentMessage.text).toContain("Cola 500ml");
    expect(sentMessage.text).toContain("Piattos");
    expect(sentMessage.text).not.toContain("Water 500ml"); // Safe stock must not appear in the report.

    // Snapshot: the artefact the next step (HQ consolidation) reads as-is was really written.
    const snapshotContent = await readFile(result.snapshotPath, "utf8");
    expect(snapshotContent).toContain("Main Store");
    expect(snapshotContent).toContain("North Branch");
  });

  it("if parsing fails it ends with a clear error, no alert and no snapshot (re-confirming no load)", async () => {
    const warehouse = await makeWarehouse();
    const notificationProvider = createMockNotificationProvider();
    // Invalid header without the sku column at all — the T15 zod parsing rejects it for a missing required column.
    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,stock_qty\nMain Store,Cola,10\n",
      "utf8",
    );

    await expect(
      runFolderScan(
        { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
        { watchDir, snapshotDir, sendMode: "live", confirm: true, recipient: "owner@example.com" },
      ),
    ).rejects.toThrow();

    expect(await warehouse.queryStock({})).toHaveLength(0);
    expect(notificationProvider.sent).toHaveLength(0);
  });
});

describe("e2e — HQ consolidated scenario (2 branch snapshots→consolidated view)", () => {
  let dir: string;
  let branchADir: string;
  let branchBDir: string;
  let hqCollectDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-e2e-hq-"));
    branchADir = join(dir, "branch-a");
    branchBDir = join(dir, "branch-b");
    hqCollectDir = join(dir, "hq-collect");
    await Promise.all([
      mkdir(join(branchADir, "watch"), { recursive: true }),
      mkdir(join(branchBDir, "watch"), { recursive: true }),
      mkdir(hqCollectDir, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("two mutually independent branches each scan and produce real snapshots, HQ collects them and queries filtered by store name", async () => {
    // ── Branch A (Main Store): performs one real scan with its own independent warehouse and folders ──
    const branchAWarehouse = await makeWarehouse();
    await writeFile(
      join(branchADir, "watch", "inventory.csv"),
      `store,product,sku,stock_qty,sales_qty,period_start,period_end\n` +
        `Main Store,Cola 500ml,SKU-COLA,10,560,2026-08-01,2026-08-29\n`,
      "utf8",
    );
    const branchAResult = await runFolderScan(
      {
        warehouse: branchAWarehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir: join(branchADir, "watch"), snapshotDir: join(branchADir, "snapshot") },
    );

    // ── Branch B (North Branch): a completely different warehouse instance — knows nothing of the other's data ──
    const branchBWarehouse = await makeWarehouse();
    await writeFile(
      join(branchBDir, "watch", "inventory.csv"),
      `store,product,sku,stock_qty,low_stock_threshold\n` +
        `North Branch,Water 500ml,SKU-WATER,2,5\n`,
      "utf8",
    );
    const branchBResult = await runFolderScan(
      {
        warehouse: branchBWarehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir: join(branchBDir, "watch"), snapshotDir: join(branchBDir, "snapshot") },
    );

    // ── HQ: gathers the two branches' real snapshot artefacts into the collect folder (the existing
    //    transfer means simulated with a file copy) and runs a consolidated scan on its own third
    //    independent warehouse ──
    await copyFile(branchAResult.snapshotPath, join(hqCollectDir, "main-store.csv"));
    await copyFile(branchBResult.snapshotPath, join(hqCollectDir, "north-branch.csv"));

    const hqWarehouse = await makeWarehouse();
    const hqResult = await runConsolidatedScan(
      { warehouse: hqWarehouse, clock: createFixedClock(NOW_ISO) },
      { collectDir: hqCollectDir },
    );

    expect(hqResult.ok).toBe(true);
    expect(hqResult.files).toHaveLength(2);

    // Consolidated view: store filtering works as-is with the existing queryStock({storeId}), no
    // schema change (exactly as SPEC §12 "multi-store head-office consolidated view" foresaw).
    const all = await hqWarehouse.queryStock({});
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.storeId).sort()).toEqual(["Main Store", "North Branch"]);

    const mainStoreOnly = await hqWarehouse.queryStock({ storeId: "Main Store" });
    expect(mainStoreOnly).toHaveLength(1);
    expect(mainStoreOnly[0]?.variantId).toBe("SKU-COLA");
    expect(Number(mainStoreOnly[0]?.inStockRaw)).toBe(10);

    const makatiOnly = await hqWarehouse.queryStock({ storeId: "North Branch" });
    expect(makatiOnly).toHaveLength(1);
    expect(makatiOnly[0]?.variantId).toBe("SKU-WATER");

    // The watermark is also recorded independently per branch.
    const resources = (await hqWarehouse.getSyncState()).map((s) => s.resource);
    expect(resources).toContain("csv_branch:main-store.csv");
    expect(resources).toContain("csv_branch:north-branch.csv");

    // The HQ consolidated scan does not re-send alerts (SPEC §12 / TASKS T20 decision — the alert
    // already went out at the branch stage) — the runConsolidatedScan signature having no
    // notificationProvider already guarantees this structurally, but it is stated explicitly for
    // documentation purposes.
    expect(hqResult).not.toHaveProperty("sent");
  });
});
