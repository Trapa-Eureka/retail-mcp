import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConsolidatedScan, runFolderScan } from "../src/agent/folderScan.js";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import { createMockNotificationProvider } from "../src/mocks/mockNotificationProvider.js";
import type { PGlite } from "@electric-sql/pglite";
import type { Warehouse } from "../src/core/types.js";

const NOW_ISO = "2026-09-03T00:00:00Z";

// Main Store/SKU-COLA: 560 sold in 28 days (daily avg 20) + stock 10 → daysOfCover=0.5 → stockout risk (history mode).
// Main Store/SKU-CHIPS: no sales history, stock 1 → below default threshold (5) (no_history mode).
// North Branch/SKU-WATER: 28 sold in 28 days (daily avg 1) + stock 100 → daysOfCover=100 → safe (not an alert target).
const HAPPY_CSV = `store,product,sku,stock_qty,sales_qty,period_start,period_end
Main Store,Cola 500ml,SKU-COLA,10,560,2026-08-01,2026-08-29
Main Store,Piattos,SKU-CHIPS,1,,,
North Branch,Water 500ml,SKU-WATER,100,28,2026-08-01,2026-08-29
`;

async function makeWarehouse(): Promise<{ db: PGlite; warehouse: Warehouse }> {
  const db = await createTestWarehouse();
  return { db, warehouse: createPgWarehouse(createPgliteConnectionProvider(db)) };
}

describe("runFolderScan", () => {
  let dir: string;
  let watchDir: string;
  let snapshotDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-folderscan-"));
    watchDir = join(dir, "watch");
    snapshotDir = join(dir, "snapshot");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(watchDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects with a clear error when watchDir and snapshotDir are the same", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");

    await expect(
      runFolderScan(
        {
          warehouse,
          clock: createFixedClock(NOW_ISO),
          notificationProvider: createMockNotificationProvider(),
        },
        { watchDir, snapshotDir: watchDir },
      ),
    ).rejects.toThrow(/same folder/);
  });

  it("one scan of the fixture CSV → load → alert decision → snapshot refresh, e2e (dry_run)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    const notificationProvider = createMockNotificationProvider();

    const result = await runFolderScan(
      { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
      { watchDir, snapshotDir, sendMode: "dry_run" },
    );

    expect(result.itemCount).toBe(3);
    expect(result.alertCount).toBe(2); // SKU-COLA (stockout risk) + SKU-CHIPS (below threshold), WATER is safe
    expect(result.alerts.map((a) => a.variantId).sort()).toEqual(["SKU-CHIPS", "SKU-COLA"]);
    expect(result.status).toBe("dry_run");
    expect(result.sent).toBe(false);
    expect(notificationProvider.sent).toHaveLength(0); // dry_run, so nothing actually sent

    // Load check — all 3 items via queryStock.
    const stock = await warehouse.queryStock({});
    expect(stock).toHaveLength(3);

    // Check the snapshot file was really written.
    const snapshotContent = await readFile(result.snapshotPath, "utf8");
    expect(snapshotContent).toContain("Main Store");
    expect(snapshotContent).toContain("North Branch");
  });

  it("with pack_size (SPEC §14/TASKS T25) the alert includes the final order qty and pack count", async () => {
    const { warehouse } = await makeWarehouse();
    const csvWithPackSize = `store,product,sku,stock_qty,sales_qty,period_start,period_end,pack_size
Main Store,Cola 500ml,SKU-COLA,10,560,2026-08-01,2026-08-29,24
`;
    await writeFile(join(watchDir, "inventory.csv"), csvWithPackSize, "utf8");

    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir, snapshotDir },
    );

    expect(result.alertCount).toBe(1);
    const [alert] = result.alerts;
    // avgDailySales=20 (560/28 days), inStock=10 → reorderQty=ceil(21*20-10)=410 → rounded up to
    // packs of 24: ceil(410/24)=18 packs=432 units.
    expect(alert?.reorderQty).toBe(410);
    expect(alert?.finalOrderQty).toBe(432);
    expect(alert?.packCount).toBe(18);
    expect(alert?.reason).toContain("final order qty 432 (18 packs)");
  });

  it("without pack_size (single-unit purchase) the alert shows only the suggested qty and finalOrderQty is undefined", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");

    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir, snapshotDir },
    );

    const cola = result.alerts.find((a) => a.variantId === "SKU-COLA");
    expect(cola?.packCount).toBeNull();
    expect(cola?.finalOrderQty).toBe(cola?.reorderQty);
    expect(cola?.reason).not.toContain("final order qty");

    // no_history mode (SKU-CHIPS) has no reorderQty concept in the first place.
    const chips = result.alerts.find((a) => a.variantId === "SKU-CHIPS");
    expect(chips?.reorderQty).toBeUndefined();
  });

  it("sends for real only when both SEND_MODE=live and confirm are set (guardrail 1)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    const notificationProvider = createMockNotificationProvider();

    // live but no confirm — not sent.
    const withoutConfirm = await runFolderScan(
      { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
      { watchDir, snapshotDir, sendMode: "live", confirm: false, recipient: "owner@example.com" },
    );
    expect(withoutConfirm.sent).toBe(false);
    expect(notificationProvider.sent).toHaveLength(0);

    // live && confirm both — sent.
    const withConfirm = await runFolderScan(
      { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
      {
        watchDir,
        snapshotDir,
        sendMode: "live",
        confirm: true,
        recipient: "owner@example.com",
        runId: "run-live-1",
      },
    );
    expect(withConfirm.sent).toBe(true);
    expect(notificationProvider.sent).toHaveLength(1);
    expect(notificationProvider.sent[0]?.to).toBe("owner@example.com");
  });

  it("with 0 alert targets it does not send and ends as no_suggestions", async () => {
    const { warehouse } = await makeWarehouse();
    const safeCsv = `store,product,sku,stock_qty,sales_qty,period_start,period_end
Main Store,Water 500ml,SKU-WATER,100,28,2026-08-01,2026-08-29
`;
    await writeFile(join(watchDir, "inventory.csv"), safeCsv, "utf8");
    const notificationProvider = createMockNotificationProvider();

    const result = await runFolderScan(
      { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
      { watchDir, snapshotDir, sendMode: "live", confirm: true, recipient: "owner@example.com" },
    );

    expect(result.status).toBe("no_suggestions");
    expect(result.alertCount).toBe(0);
    expect(notificationProvider.sent).toHaveLength(0);
  });

  it("on a parse failure it stops with a clear error and no partial load", async () => {
    const { warehouse } = await makeWarehouse();
    const brokenCsv = `store,product,sku,stock_qty\n,Cola,SKU-COLA,10\n`; // store is empty (required)
    await writeFile(join(watchDir, "inventory.csv"), brokenCsv, "utf8");

    await expect(
      runFolderScan(
        {
          warehouse,
          clock: createFixedClock(NOW_ISO),
          notificationProvider: createMockNotificationProvider(),
        },
        { watchDir, snapshotDir },
      ),
    ).rejects.toThrow();

    const stock = await warehouse.queryStock({});
    expect(stock).toHaveLength(0); // Nothing should have been loaded.
  });

  it("with several files in the watch folder only the most recent one is used", async () => {
    const { warehouse } = await makeWarehouse();
    const oldCsv = `store,product,sku,stock_qty\nMain Store,Old Product,SKU-OLD,99\n`;
    await writeFile(join(watchDir, "old.csv"), oldCsv, "utf8");
    await new Promise((r) => setTimeout(r, 20)); // Make sure the mtimes differ.
    await writeFile(join(watchDir, "new.csv"), HAPPY_CSV, "utf8");

    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir, snapshotDir },
    );

    expect(result.sourceFile).toContain("new.csv");
    const stock = await warehouse.queryStock({});
    expect(stock.some((s) => s.variantId === "SKU-OLD")).toBe(false);
  });

  it("with several files sharing the same mtime it picks deterministically by file name (OPS-003, 006 review, TASKS T34)", async () => {
    const { warehouse } = await makeWarehouse();
    const aCsv = `store,product,sku,stock_qty\nMain Store,Product A,SKU-A,1\n`;
    const zCsv = `store,product,sku,stock_qty\nMain Store,Product Z,SKU-Z,1\n`;
    await writeFile(join(watchDir, "a-inventory.csv"), aCsv, "utf8");
    await writeFile(join(watchDir, "z-inventory.csv"), zCsv, "utf8");
    // Make both files' mtimes exactly identical — actually reproduces the situation where relying
    // on the OS readdir order could pick a different file on each run.
    const { utimes } = await import("node:fs/promises");
    const tiedMtime = new Date("2026-08-01T00:00:00Z");
    await utimes(join(watchDir, "a-inventory.csv"), tiedMtime, tiedMtime);
    await utimes(join(watchDir, "z-inventory.csv"), tiedMtime, tiedMtime);

    // Sequential repetition, not concurrency — what this test reproduces is "picks the same file
    // every time without depending on the OS readdir order", not concurrency itself (concurrent
    // scans are a separate concern).
    for (let i = 0; i < 3; i++) {
      const result = await runFolderScan(
        {
          warehouse,
          clock: createFixedClock(NOW_ISO),
          notificationProvider: createMockNotificationProvider(),
        },
        { watchDir, snapshotDir },
      );
      // Path sorted descending — "z-inventory.csv" comes first because it sorts after "a-inventory.csv".
      expect(result.sourceFile).toContain("z-inventory.csv");
    }
  });

  it("can also scan an XLSX file (reusing the T16 fixture)", async () => {
    const { warehouse } = await makeWarehouse();
    await copyFile("tests/fixtures/csvExcel/inventory.xlsx", join(watchDir, "inventory.xlsx"));

    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir, snapshotDir },
    );

    expect(result.itemCount).toBe(3);
    // Only Main Store/SKU-CHIPS (stock 2 < default threshold 5) is an alert target — the rest are safe.
    expect(result.alertCount).toBe(1);
    expect(result.alerts[0]?.variantId).toBe("SKU-CHIPS");
  });

  it("scanning twice in a row keeps the upsert idempotent (no duplicate load)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");

    await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir, snapshotDir },
    );
    await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir, snapshotDir },
    );

    const stock = await warehouse.queryStock({});
    expect(stock).toHaveLength(3); // 3, not 6 — reloading does not add rows.
  });
});

describe("runFolderScan — SCM receipts absorption + stock consistency verification (SPEC §16, TASKS T26)", () => {
  let dir: string;
  let watchDir: string;
  let snapshotDir: string;
  let scmReceiptsDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-scm-"));
    watchDir = join(dir, "watch");
    snapshotDir = join(dir, "snapshot");
    scmReceiptsDir = join(dir, "scm");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(watchDir, { recursive: true });
    await mkdir(scmReceiptsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("without scmReceiptsDir (previous behaviour) reconciliation is always an empty array", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,9\n",
      "utf8",
    );
    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir, snapshotDir },
    );
    expect(result.reconciliation).toEqual([]);
    expect(result.scmStatus).toEqual({ kind: "not_configured" });
  });

  it("absorbs the SCM receipts CSV into purchase_receipts — the reconciliation is insufficientData because opening stock is unverified (006 DATA-006, TASKS T33)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,9\n",
      "utf8",
    );
    // Mimics a Google Sheet exported with "File > Download > CSV" (SPEC §16). There is no
    // onboarding stock-count input flow yet (SPEC §16), so opening stock is unknown — on the surface
    // 30 received vs 9 in stock looks like a discrepancy, but the assumption itself (opening
    // stock=0) cannot be trusted, so it is not treated as a "confirmed discrepancy".
    await writeFile(
      join(scmReceiptsDir, "receipts.csv"),
      "date,type,sku,product,qty,unit_price,vendor\n" +
        "2026-07-01,inbound,SKU-COLA,Cola 500ml,30,12000,Smart Distribution\n",
      "utf8",
    );

    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir, snapshotDir, scmReceiptsDir },
    );

    // The confirmed-discrepancy list (reconciliation) is empty — insufficientData rows do not go in here.
    expect(result.reconciliation).toEqual([]);
    // Instead scmStatus records, as a structured result, that "SCM was loaded but the reconciliation
    // is reference only" (006 DATA-007 — the SCM processing outcome does not vanish from the result).
    expect(result.scmStatus).toMatchObject({
      kind: "ok",
      receiptCount: 1,
      insufficientData: true,
    });

    // The stock itself is at or above the default threshold (5) so 0 low-stock alerts, and 0
    // confirmed discrepancies, so there is no issue to report — not "hiding an SCM problem behind a
    // normal-looking result", there simply is no confirmed issue.
    expect(result.alertCount).toBe(0);
    expect(result.status).toBe("no_suggestions");

    const purchases = await warehouse.queryPurchaseAgg({
      storeId: "Main Store",
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2027-01-01T00:00:00Z"),
    });
    expect(purchases).toEqual([
      { storeId: "Main Store", variantId: "SKU-COLA", receivedQtyRaw: "30" },
    ]);
  });

  it("with an inventory file containing several stores it throws a clear error without scmReceiptsStoreId", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,9\nNorth Branch,Water 500ml,SKU-WATER,20\n",
      "utf8",
    );
    await writeFile(
      join(scmReceiptsDir, "receipts.csv"),
      "date,type,sku,product,qty\n2026-07-01,inbound,SKU-COLA,Cola 500ml,30\n",
      "utf8",
    );

    await expect(
      runFolderScan(
        {
          warehouse,
          clock: createFixedClock(NOW_ISO),
          notificationProvider: createMockNotificationProvider(),
        },
        { watchDir, snapshotDir, scmReceiptsDir },
      ),
    ).rejects.toThrow(/scmReceiptsStoreId/);
  });

  it("even if SCM file parsing fails, the low-stock alert decision continues (isolation)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    await writeFile(join(scmReceiptsDir, "broken.csv"), "this,is,not,scm\n1,2,3,4\n", "utf8");

    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      // HAPPY_CSV has 2 stores so the store cannot be auto-inferred — the focus of this test is not
      // the store decision but "an SCM parse failure does not block the alert decision", so it is
      // given explicitly to verify only that path.
      { watchDir, snapshotDir, scmReceiptsDir, scmReceiptsStoreId: "Main Store" },
    );

    // SCM parsing failed (only a warning) but HAPPY_CSV's 2 low-stock alerts are processed as usual.
    expect(result.alertCount).toBe(2);
    expect(result.reconciliation).toEqual([]);
    // 006 DATA-007 — "failed" and "no data" are distinguished. Not swallowed silently; it stays in the result.
    expect(result.scmStatus.kind).toBe("failed");
    if (result.scmStatus.kind === "failed") {
      expect(result.scmStatus.error.length).toBeGreaterThan(0);
    }
  });

  it("when there is a confirmed low-stock alert, the SCM insufficientData summary is included in the sent email body (006 DATA-006/007, TASKS T33)", async () => {
    const { warehouse } = await makeWarehouse();
    const notificationProvider = createMockNotificationProvider();
    // SKU-CHIPS is below the default threshold (5) so a confirmed low-stock alert fires — there must
    // be an issue for a report to actually be sent, so we can verify the SCM status line inside it.
    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Piattos,SKU-CHIPS,2\n",
      "utf8",
    );
    await writeFile(
      join(scmReceiptsDir, "receipts.csv"),
      "date,type,sku,product,qty,unit_price,vendor\n" +
        "2026-07-01,inbound,SKU-CHIPS,Piattos,10,1000,Snack Distribution\n",
      "utf8",
    );

    const result = await runFolderScan(
      { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
      {
        watchDir,
        snapshotDir,
        scmReceiptsDir,
        sendMode: "live",
        confirm: true,
        recipient: "owner@example.com",
      },
    );

    expect(result.status).toBe("sent");
    expect(result.scmStatus).toMatchObject({ kind: "ok", insufficientData: true });
    expect(notificationProvider.sent).toHaveLength(1);
    expect(notificationProvider.sent[0]?.text).toContain("[SCM stock consistency note]");
    expect(notificationProvider.sent[0]?.text).toContain("not a confirmed reconciliation");
    // The wording asserting a confirmed discrepancy ("check for theft, damage or count error") must not appear.
    expect(notificationProvider.sent[0]?.text).not.toContain("check for theft");
  });

  it("if scmReceiptsDir has no file yet it is skipped quietly (not an error) — scmStatus is no_file", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,9\n",
      "utf8",
    );

    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir, snapshotDir, scmReceiptsDir }, // The folder exists but is empty
    );
    expect(result.reconciliation).toEqual([]);
    expect(result.scmStatus).toEqual({ kind: "no_file" });
  });
});

describe("runFolderScan — tombstone (DATA-002, TASKS T31)", () => {
  let dir: string;
  let watchDir: string;
  let snapshotDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-folderscan-tombstone-"));
    watchDir = join(dir, "watch");
    snapshotDir = join(dir, "snapshot");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(watchDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a SKU missing from the second scan file is deactivated in the DB and disappears from queries", async () => {
    const { warehouse } = await makeWarehouse();
    const deps = {
      warehouse,
      clock: createFixedClock(NOW_ISO),
      notificationProvider: createMockNotificationProvider(),
    };

    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,10\nMain Store,Piattos,SKU-CHIPS,3\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });
    expect(
      (await warehouse.queryStock({ storeId: "Main Store" })).map((s) => s.variantId).sort(),
    ).toEqual(["SKU-CHIPS", "SKU-COLA"]);

    // Second scan — SKU-CHIPS disappeared from the file (mimics discontinuation/disposal).
    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,8\n",
      "utf8",
    );
    const second = await runFolderScan(deps, { watchDir, snapshotDir });

    const stock = await warehouse.queryStock({ storeId: "Main Store" });
    expect(stock.map((s) => s.variantId)).toEqual(["SKU-COLA"]);
    // The alert decision no longer sees the deactivated SKU-CHIPS either (itemCount counts only
    // this file's rows — the rows this scan actually processed, not the whole DB state).
    expect(second.itemCount).toBe(1);
  });

  it("a SKU that had disappeared is automatically reactivated on the next scan when it reappears", async () => {
    const { warehouse } = await makeWarehouse();
    const deps = {
      warehouse,
      clock: createFixedClock(NOW_ISO),
      notificationProvider: createMockNotificationProvider(),
    };

    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,10\nMain Store,Piattos,SKU-CHIPS,3\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });

    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,8\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });
    expect((await warehouse.queryStock({ storeId: "Main Store" })).map((s) => s.variantId)).toEqual(
      ["SKU-COLA"],
    );

    // Third scan — SKU-CHIPS reappeared (mimics restocking).
    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,7\nMain Store,Piattos,SKU-CHIPS,5\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });

    const stock = await warehouse.queryStock({ storeId: "Main Store" });
    expect(stock.map((s) => s.variantId).sort()).toEqual(["SKU-CHIPS", "SKU-COLA"]);
  });

  it("deactivated rows are not physically deleted and remain in the DB (for audit)", async () => {
    const { warehouse, db } = await makeWarehouse();
    const deps = {
      warehouse,
      clock: createFixedClock(NOW_ISO),
      notificationProvider: createMockNotificationProvider(),
    };

    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,10\nMain Store,Piattos,SKU-CHIPS,3\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });

    await writeFile(
      join(watchDir, "inventory.csv"),
      "store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,8\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from inventory_levels where variant_id = 'SKU-CHIPS'",
    );
    expect(rows[0]?.count).toBe("1");
  });
});

describe("runFolderScan — daily digest (DATA-003, TASKS T31)", () => {
  let dir: string;
  let watchDir: string;
  let snapshotDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-folderscan-digest-"));
    watchDir = join(dir, "watch");
    snapshotDir = join(dir, "snapshot");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(watchDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("if the file is unchanged on the same day, the second live run does not resend (status=unchanged)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    const notificationProvider = createMockNotificationProvider();
    const deps = { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider };
    const opts = {
      watchDir,
      snapshotDir,
      sendMode: "live" as const,
      confirm: true,
      recipient: "owner@example.com",
    };

    const first = await runFolderScan(deps, { ...opts, runId: "run-1" });
    expect(first.status).toBe("sent");
    expect(notificationProvider.sent).toHaveLength(1);

    const second = await runFolderScan(deps, { ...opts, runId: "run-2" });
    expect(second.status).toBe("unchanged");
    expect(second.sent).toBe(false);
    // The alerts this scan actually computed are still in the result — you can see what was suppressed.
    expect(second.alerts.map((a) => a.variantId).sort()).toEqual(["SKU-CHIPS", "SKU-COLA"]);
    expect(notificationProvider.sent).toHaveLength(1); // The second one did not actually go out
  });

  it("even if the file is unchanged, once a day (24 hours) has passed the digest is sent again with the same content", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    const notificationProvider = createMockNotificationProvider();
    const opts = {
      watchDir,
      snapshotDir,
      sendMode: "live" as const,
      confirm: true,
      recipient: "owner@example.com",
    };

    const first = await runFolderScan(
      { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
      { ...opts, runId: "run-1" },
    );
    expect(first.status).toBe("sent");

    const nextDayIso = new Date(
      new Date(NOW_ISO).getTime() + 24 * 60 * 60 * 1000 + 1,
    ).toISOString();
    const second = await runFolderScan(
      { warehouse, clock: createFixedClock(nextDayIso), notificationProvider },
      { ...opts, runId: "run-2" },
    );
    expect(second.status).toBe("sent");
    expect(notificationProvider.sent).toHaveLength(2);
  });

  it("if the file content changes it is sent again without suppression, even within the same day", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    const notificationProvider = createMockNotificationProvider();
    const deps = { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider };
    const opts = {
      watchDir,
      snapshotDir,
      sendMode: "live" as const,
      confirm: true,
      recipient: "owner@example.com",
    };

    await runFolderScan(deps, { ...opts, runId: "run-1" });

    // New content with a changed stock_qty — the content hash differs.
    await writeFile(
      join(watchDir, "inventory.csv"),
      HAPPY_CSV.replace("SKU-COLA,10,560", "SKU-COLA,3,560"),
      "utf8",
    );
    const second = await runFolderScan(deps, { ...opts, runId: "run-2" });
    expect(second.status).toBe("sent");
    expect(notificationProvider.sent).toHaveLength(2);
  });

  it("a send failure (failed) does not refresh the watermark, so it can be retried right away on the same day", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    const failingProvider = createMockNotificationProvider({ failFor: ["owner@example.com"] });
    const deps = {
      warehouse,
      clock: createFixedClock(NOW_ISO),
      notificationProvider: failingProvider,
    };
    const opts = {
      watchDir,
      snapshotDir,
      sendMode: "live" as const,
      confirm: true,
      recipient: "owner@example.com",
    };

    await expect(runFolderScan(deps, { ...opts, runId: "run-1" })).rejects.toThrow();

    // Same file, same date, retry right after the failure — must not be suppressed and must try
    // again (and still fail, since failFor is kept).
    await expect(runFolderScan(deps, { ...opts, runId: "run-2" })).rejects.toThrow();
  });

  it("an ambiguous send result (AmbiguousSendError) is recorded as unknown, not failed (OPS-004, TASKS T34)", async () => {
    const { db, warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    // Mimics an error with the same shape (.name) as the one the real resendProvider.ts throws on timeout.
    const ambiguousProvider = {
      channel: "email" as const,
      send: () => {
        const err = new Error("Resend request timed out (simulated).");
        err.name = "AmbiguousSendError";
        return Promise.reject(err);
      },
    };
    const deps = {
      warehouse,
      clock: createFixedClock(NOW_ISO),
      notificationProvider: ambiguousProvider,
    };
    const opts = {
      watchDir,
      snapshotDir,
      sendMode: "live" as const,
      confirm: true,
      recipient: "owner@example.com",
      runId: "run-ambiguous",
    };

    await expect(runFolderScan(deps, opts)).rejects.toThrow(/timed out/);

    const { rows } = await db.query<{ status: string }>(
      "select status from agent_send_log where run_id = $1",
      ["run-ambiguous"],
    );
    // The 'sending' reservation row is updated to 'unknown' (no extra row — pgWarehouse.ts's
    // logAgentSendOn must treat "unknown" as an update target just like "sent"/"failed").
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("unknown");
  });

  describe("same run_id retry — provider dedupe TTL (second adversarial review SR2-MAIL-003, same gate as reorder.ts)", () => {
    const ambiguousProvider = {
      channel: "email" as const,
      dedupeTtlMs: 24 * 60 * 60 * 1000,
      send: () => {
        const err = new Error("Resend request timed out (simulated).");
        err.name = "AmbiguousSendError";
        return Promise.reject(err);
      },
    };
    const liveOpts = () => ({
      watchDir,
      snapshotDir,
      sendMode: "live" as const,
      confirm: true,
      recipient: "owner@example.com",
    });
    // Retry times are computed relative to this file's NOW_ISO (with fixed strings the inside/outside
    // TTL decision silently flips when NOW_ISO changes — it actually failed that way once during work).
    const HOUR = 60 * 60 * 1000;
    const RETRY_1H_LATER = new Date(new Date(NOW_ISO).getTime() + 1 * HOUR).toISOString();
    const RETRY_25H_LATER = new Date(new Date(NOW_ISO).getTime() + 25 * HOUR).toISOString();

    it("a retry within the TTL (1 hour later) after unknown is sent and the log becomes two rows: unknown → sent", async () => {
      const { db, warehouse } = await makeWarehouse();
      await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
      const opts = { ...liveOpts(), runId: "run-retry-ok" };

      await expect(
        runFolderScan(
          { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider: ambiguousProvider },
          opts,
        ),
      ).rejects.toThrow(/timed out/);

      const provider = createMockNotificationProvider();
      const retried = await runFolderScan(
        { warehouse, clock: createFixedClock(RETRY_1H_LATER), notificationProvider: provider },
        opts,
      );
      expect(retried.status).toBe("sent");
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]?.idempotencyKey).toBe("run-retry-ok");

      const { rows } = await db.query<{ status: string }>(
        "select status from agent_send_log where run_id = $1 order by id asc",
        ["run-retry-ok"],
      );
      expect(rows.map((r) => r.status)).toEqual(["unknown", "sent"]);
    });

    it("a retry after the TTL has passed (25 hours later) after unknown is refused and the provider is not called", async () => {
      const { db, warehouse } = await makeWarehouse();
      await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
      const opts = { ...liveOpts(), runId: "run-retry-late" };

      await expect(
        runFolderScan(
          { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider: ambiguousProvider },
          opts,
        ),
      ).rejects.toThrow(/timed out/);

      const provider = createMockNotificationProvider();
      await expect(
        runFolderScan(
          { warehouse, clock: createFixedClock(RETRY_25H_LATER), notificationProvider: provider },
          opts,
        ),
      ).rejects.toMatchObject({ name: "SendRetryRefusedError" });
      expect(provider.sent).toHaveLength(0);

      const { rows } = await db.query<{ status: string }>(
        "select status from agent_send_log where run_id = $1",
        ["run-retry-late"],
      );
      expect(rows.map((r) => r.status)).toEqual(["unknown"]);
    });
  });

  it("repeated dry_run runs are unrelated to the digest decision — the same report is shown again every time", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    const deps = {
      warehouse,
      clock: createFixedClock(NOW_ISO),
      notificationProvider: createMockNotificationProvider(),
    };
    const opts = { watchDir, snapshotDir, sendMode: "dry_run" as const };

    const first = await runFolderScan(deps, { ...opts, runId: "run-1" });
    const second = await runFolderScan(deps, { ...opts, runId: "run-2" });
    expect(first.status).toBe("dry_run");
    expect(second.status).toBe("dry_run"); // Not "unchanged" — dry_run is not subject to suppression.
    expect(second.alerts).toEqual(first.alerts);
  });
});

describe("runConsolidatedScan (HQ consolidated mode, TASKS T20)", () => {
  let dir: string;
  let collectDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-consolidated-"));
    collectDir = join(dir, "collect");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(collectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("2 branch snapshots can be queried consolidated, filtered by store name (same behaviour as the SPEC §5 'Main Store only' example)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(
      join(collectDir, "main-store.csv"),
      `store,product,sku,stock_qty\nMain Store,Cola 500ml,SKU-COLA,10\n`,
      "utf8",
    );
    await writeFile(
      join(collectDir, "north-branch.csv"),
      `store,product,sku,stock_qty\nNorth Branch,Water 500ml,SKU-WATER,20\n`,
      "utf8",
    );

    const result = await runConsolidatedScan(
      { warehouse, clock: createFixedClock(NOW_ISO) },
      { collectDir },
    );

    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files.every((f) => f.status === "success")).toBe(true);

    // The same queryStock({storeId}) filtering the existing MCP tools use works as-is, no schema change.
    const mainStoreOnly = await warehouse.queryStock({ storeId: "Main Store" });
    expect(mainStoreOnly).toHaveLength(1);
    expect(mainStoreOnly[0]?.variantId).toBe("SKU-COLA");

    const all = await warehouse.queryStock({});
    expect(all).toHaveLength(2);
  });

  it("one branch snapshot failing to parse does not affect the other branch's data or watermark", async () => {
    const { warehouse } = await makeWarehouse();
    // Main Store: the store name is empty, so it fails T15 validation.
    await writeFile(
      join(collectDir, "main-store.csv"),
      `store,product,sku,stock_qty\n,Cola 500ml,SKU-COLA,10\n`,
      "utf8",
    );
    await writeFile(
      join(collectDir, "north-branch.csv"),
      `store,product,sku,stock_qty\nNorth Branch,Water 500ml,SKU-WATER,20\n`,
      "utf8",
    );

    const result = await runConsolidatedScan(
      { warehouse, clock: createFixedClock(NOW_ISO) },
      { collectDir },
    );

    expect(result.ok).toBe(false);
    const failed = result.files.find((f) => f.file === "main-store.csv");
    const succeeded = result.files.find((f) => f.file === "north-branch.csv");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBeTruthy();
    expect(succeeded?.status).toBe("success");

    // The failed branch's data was not loaded at all — only the successful branch is present.
    const stock = await warehouse.queryStock({});
    expect(stock).toHaveLength(1);
    expect(stock[0]?.storeId).toBe("North Branch");

    // The watermark (sync_state) is recorded only for the successful branch too.
    const syncState = await warehouse.getSyncState();
    const resources = syncState.map((s) => s.resource);
    expect(resources).toContain("csv_branch:north-branch.csv");
    expect(resources).not.toContain("csv_branch:main-store.csv");
  });

  it("throws a clear error when the collect folder is empty", async () => {
    const { warehouse } = await makeWarehouse();
    await expect(
      runConsolidatedScan({ warehouse, clock: createFixedClock(NOW_ISO) }, { collectDir }),
    ).rejects.toThrow(/branch snapshot file/);
  });
});
