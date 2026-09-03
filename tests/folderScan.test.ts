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

// 본점/SKU-COLA: 28일 560개 판매(일평균 20) + 재고 10 → daysOfCover=0.5 → 품절 위험(history 모드).
// 본점/SKU-CHIPS: 판매이력 없음, 재고 1 → 기본 임계치(5) 미만(no_history 모드).
// 마카티점/SKU-WATER: 28일 28개 판매(일평균 1) + 재고 100 → daysOfCover=100 → 안전(알림 대상 아님).
const HAPPY_CSV = `매장명,상품명,SKU,재고수량,판매수량,판매기간시작일,판매기간종료일
본점,코카콜라 500ml,SKU-COLA,10,560,2026-08-01,2026-08-29
본점,Piattos,SKU-CHIPS,1,,,
마카티점,생수 500ml,SKU-WATER,100,28,2026-08-01,2026-08-29
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

  it("watchDir과 snapshotDir이 같으면 명확한 에러로 거부한다", async () => {
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
    ).rejects.toThrow(/같은 폴더/);
  });

  it("픽스처 CSV 1회 스캔 → 적재 → 알림 판정 → 스냅샷 갱신까지 e2e(dry_run)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    const notificationProvider = createMockNotificationProvider();

    const result = await runFolderScan(
      { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
      { watchDir, snapshotDir, sendMode: "dry_run" },
    );

    expect(result.itemCount).toBe(3);
    expect(result.alertCount).toBe(2); // SKU-COLA(품절위험) + SKU-CHIPS(임계치 미만), WATER는 안전
    expect(result.alerts.map((a) => a.variantId).sort()).toEqual(["SKU-CHIPS", "SKU-COLA"]);
    expect(result.status).toBe("dry_run");
    expect(result.sent).toBe(false);
    expect(notificationProvider.sent).toHaveLength(0); // dry_run이라 실제 발송 안 함

    // 적재 확인 — queryStock으로 3개 품목 전부 확인.
    const stock = await warehouse.queryStock({});
    expect(stock).toHaveLength(3);

    // 스냅샷 파일이 실제로 쓰였는지 확인.
    const snapshotContent = await readFile(result.snapshotPath, "utf8");
    expect(snapshotContent).toContain("본점");
    expect(snapshotContent).toContain("마카티점");
  });

  it("포장수량(SPEC §14/TASKS T25)이 있으면 알림에 최종 발주량·발주 팩수가 포함된다", async () => {
    const { warehouse } = await makeWarehouse();
    const csvWithPackSize = `매장명,상품명,SKU,재고수량,판매수량,판매기간시작일,판매기간종료일,포장수량
본점,코카콜라 500ml,SKU-COLA,10,560,2026-08-01,2026-08-29,24
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
    // avgDailySales=20(560/28일), inStock=10 → reorderQty=ceil(21*20-10)=410 → 24개입 팩으로
    // 올리면 ceil(410/24)=18팩=432개.
    expect(alert?.reorderQty).toBe(410);
    expect(alert?.finalOrderQty).toBe(432);
    expect(alert?.packCount).toBe(18);
    expect(alert?.reason).toContain("최종 발주량 432(18팩)");
  });

  it("포장수량이 없으면(낱개 매입) 알림에 제안수량만 표시되고 finalOrderQty는 undefined다", async () => {
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
    expect(cola?.reason).not.toContain("최종 발주량");

    // no_history 모드(SKU-CHIPS)는 애초에 reorderQty 개념이 없다.
    const chips = result.alerts.find((a) => a.variantId === "SKU-CHIPS");
    expect(chips?.reorderQty).toBeUndefined();
  });

  it("SEND_MODE=live && confirm 둘 다일 때만 실제 발송한다(가드레일 1)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    const notificationProvider = createMockNotificationProvider();

    // live인데 confirm 없음 — 발송 안 됨.
    const withoutConfirm = await runFolderScan(
      { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
      { watchDir, snapshotDir, sendMode: "live", confirm: false, recipient: "owner@example.com" },
    );
    expect(withoutConfirm.sent).toBe(false);
    expect(notificationProvider.sent).toHaveLength(0);

    // live && confirm 둘 다 — 발송됨.
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

  it("알림 대상이 0건이면 발송하지 않고 no_suggestions로 끝난다", async () => {
    const { warehouse } = await makeWarehouse();
    const safeCsv = `매장명,상품명,SKU,재고수량,판매수량,판매기간시작일,판매기간종료일
본점,생수 500ml,SKU-WATER,100,28,2026-08-01,2026-08-29
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

  it("파싱 실패 시 부분 적재 없이 명확한 에러로 중단한다", async () => {
    const { warehouse } = await makeWarehouse();
    const brokenCsv = `매장명,상품명,SKU,재고수량\n,콜라,SKU-COLA,10\n`; // 매장명 비어 있음(필수)
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
    expect(stock).toHaveLength(0); // 아무것도 적재되지 않았어야 한다.
  });

  it("감시 폴더에 파일이 여러 개면 가장 최근 파일만 사용한다", async () => {
    const { warehouse } = await makeWarehouse();
    const oldCsv = `매장명,상품명,SKU,재고수량\n본점,오래된상품,SKU-OLD,99\n`;
    await writeFile(join(watchDir, "old.csv"), oldCsv, "utf8");
    await new Promise((r) => setTimeout(r, 20)); // mtime 차이를 확실히 만든다.
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

  it("XLSX 파일도 스캔할 수 있다(T16 픽스처 재사용)", async () => {
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
    // 본점/SKU-CHIPS(재고 2 < 기본임계치 5)만 알림 대상 — 나머지는 안전권.
    expect(result.alertCount).toBe(1);
    expect(result.alerts[0]?.variantId).toBe("SKU-CHIPS");
  });

  it("두 번 연속 스캔해도 upsert가 멱등하다(중복 적재 없음)", async () => {
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
    expect(stock).toHaveLength(3); // 6이 아니라 3 — 재적재돼도 행이 늘지 않는다.
  });
});

describe("runConsolidatedScan (본사 통합 모드, TASKS T20)", () => {
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

  it("지점 2개 스냅샷을 매장명으로 필터링해 통합 조회할 수 있다(SPEC §5 '본점만' 예시와 동일 동작)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(
      join(collectDir, "본점.csv"),
      `매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,10\n`,
      "utf8",
    );
    await writeFile(
      join(collectDir, "마카티점.csv"),
      `매장명,상품명,SKU,재고수량\n마카티점,생수 500ml,SKU-WATER,20\n`,
      "utf8",
    );

    const result = await runConsolidatedScan(
      { warehouse, clock: createFixedClock(NOW_ISO) },
      { collectDir },
    );

    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files.every((f) => f.status === "success")).toBe(true);

    // 기존 MCP 도구가 쓰는 것과 같은 queryStock({storeId}) 필터링이 스키마 변경 없이 그대로 된다.
    const mainStoreOnly = await warehouse.queryStock({ storeId: "본점" });
    expect(mainStoreOnly).toHaveLength(1);
    expect(mainStoreOnly[0]?.variantId).toBe("SKU-COLA");

    const all = await warehouse.queryStock({});
    expect(all).toHaveLength(2);
  });

  it("한 지점 스냅샷이 파싱 실패해도 다른 지점 데이터·watermark에는 영향이 없다", async () => {
    const { warehouse } = await makeWarehouse();
    // 본점: 매장명이 비어 있어 T15 검증에서 실패한다.
    await writeFile(
      join(collectDir, "본점.csv"),
      `매장명,상품명,SKU,재고수량\n,코카콜라 500ml,SKU-COLA,10\n`,
      "utf8",
    );
    await writeFile(
      join(collectDir, "마카티점.csv"),
      `매장명,상품명,SKU,재고수량\n마카티점,생수 500ml,SKU-WATER,20\n`,
      "utf8",
    );

    const result = await runConsolidatedScan(
      { warehouse, clock: createFixedClock(NOW_ISO) },
      { collectDir },
    );

    expect(result.ok).toBe(false);
    const failed = result.files.find((f) => f.file === "본점.csv");
    const succeeded = result.files.find((f) => f.file === "마카티점.csv");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBeTruthy();
    expect(succeeded?.status).toBe("success");

    // 실패한 지점의 데이터는 전혀 적재되지 않았다 — 성공한 지점만 있다.
    const stock = await warehouse.queryStock({});
    expect(stock).toHaveLength(1);
    expect(stock[0]?.storeId).toBe("마카티점");

    // watermark(sync_state)도 성공한 지점만 기록된다.
    const syncState = await warehouse.getSyncState();
    const resources = syncState.map((s) => s.resource);
    expect(resources).toContain("csv_branch:마카티점.csv");
    expect(resources).not.toContain("csv_branch:본점.csv");
  });

  it("수집 폴더가 비어 있으면 명확한 에러를 던진다", async () => {
    const { warehouse } = await makeWarehouse();
    await expect(
      runConsolidatedScan({ warehouse, clock: createFixedClock(NOW_ISO) }, { collectDir }),
    ).rejects.toThrow(/지점 스냅샷 파일/);
  });
});
