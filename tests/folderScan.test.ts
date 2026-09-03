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

describe("runFolderScan — SCM 입고 실적 흡수 + 재고 정합성 검증 (SPEC §16, TASKS T26)", () => {
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

  it("scmReceiptsDir을 안 주면(기존 동작) reconciliation은 항상 빈 배열이다", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,9\n",
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
  });

  it("SCM 입고 CSV를 흡수해 purchase_receipts에 적재하고 재고 정합성 불일치를 찾아낸다", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,9\n",
      "utf8",
    );
    // 구글시트를 "파일 > 다운로드 > CSV"로 내보낸 것을 흉내낸다(SPEC §16) — 입고 30인데
    // 판매이력이 없어(재고 파일이 판매수량 컬럼 없음) 예상재고 30, 실제재고 9로 불일치.
    await writeFile(
      join(scmReceiptsDir, "receipts.csv"),
      "일자,구분,상품코드,상품명,수량,단가,거래처\n" +
        "2026-07-01,입고,SKU-COLA,코카콜라 500ml,30,12000,스마트유통\n",
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

    expect(result.reconciliation).toHaveLength(1);
    const [row] = result.reconciliation;
    expect(row?.variantId).toBe("SKU-COLA");
    expect(row?.expectedStock).toBe(30); // 0(기초, 기본값) + 30(입고) − 0(판매이력 없음)
    expect(row?.actualStock).toBe(9);
    expect(row?.discrepancy).toBe(-21);

    // 재고 자체는 기본 임계치(5) 이상이라 저재고 알림은 0건이지만, 재고 정합성 경고만으로도
    // "보고할 게 있다" 판정이 나 dry-run 출력까지 이어진다(issueCount 로직).
    expect(result.alertCount).toBe(0);
    expect(result.status).toBe("dry_run");

    const purchases = await warehouse.queryPurchaseAgg({
      storeId: "본점",
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2027-01-01T00:00:00Z"),
    });
    expect(purchases).toEqual([{ storeId: "본점", variantId: "SKU-COLA", receivedQtyRaw: "30" }]);
  });

  it("매장이 여러 개인 재고 파일에서 scmReceiptsStoreId 없이는 명확한 에러를 던진다", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,9\n마카티점,생수 500ml,SKU-WATER,20\n",
      "utf8",
    );
    await writeFile(
      join(scmReceiptsDir, "receipts.csv"),
      "일자,구분,상품코드,상품명,수량\n2026-07-01,입고,SKU-COLA,코카콜라 500ml,30\n",
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

  it("SCM 파일 파싱이 실패해도 저재고 알림 판정은 계속 진행한다(격리)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(join(watchDir, "inventory.csv"), HAPPY_CSV, "utf8");
    await writeFile(join(scmReceiptsDir, "broken.csv"), "이건,SCM,형식이,아님\n1,2,3,4\n", "utf8");

    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      // HAPPY_CSV엔 매장이 2개라 store 자동추론이 안 된다 — 이 테스트의 초점은 store 결정이
      // 아니라 "SCM 파싱 실패가 알림 판정을 막지 않는다"이므로 명시해서 그 경로만 검증한다.
      { watchDir, snapshotDir, scmReceiptsDir, scmReceiptsStoreId: "본점" },
    );

    // SCM 파싱은 실패했지만(경고만 남김) 기존 HAPPY_CSV의 저재고 알림 2건은 그대로 처리된다.
    expect(result.alertCount).toBe(2);
    expect(result.reconciliation).toEqual([]);
  });

  it("scmReceiptsDir에 파일이 아직 없으면 조용히 건너뛴다(에러 아님)", async () => {
    const { warehouse } = await makeWarehouse();
    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,9\n",
      "utf8",
    );

    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock(NOW_ISO),
        notificationProvider: createMockNotificationProvider(),
      },
      { watchDir, snapshotDir, scmReceiptsDir }, // 폴더는 있지만 안이 비어 있음
    );
    expect(result.reconciliation).toEqual([]);
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

  it("두 번째 스캔 파일에서 사라진 SKU는 DB에서 비활성화되고 조회에서 빠진다", async () => {
    const { warehouse } = await makeWarehouse();
    const deps = {
      warehouse,
      clock: createFixedClock(NOW_ISO),
      notificationProvider: createMockNotificationProvider(),
    };

    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,10\n본점,Piattos,SKU-CHIPS,3\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });
    expect(
      (await warehouse.queryStock({ storeId: "본점" })).map((s) => s.variantId).sort(),
    ).toEqual(["SKU-CHIPS", "SKU-COLA"]);

    // 두 번째 스캔 — SKU-CHIPS가 파일에서 사라졌다(판매 중단/폐기 흉내).
    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,8\n",
      "utf8",
    );
    const second = await runFolderScan(deps, { watchDir, snapshotDir });

    const stock = await warehouse.queryStock({ storeId: "본점" });
    expect(stock.map((s) => s.variantId)).toEqual(["SKU-COLA"]);
    // 알림 판정도 비활성화된 SKU-CHIPS를 더 이상 보지 않는다(itemCount는 이번 파일의 행
    // 수만 센다 — DB 전체 상태가 아니라 이번 스캔이 실제로 처리한 행 수).
    expect(second.itemCount).toBe(1);
  });

  it("사라졌던 SKU가 다시 나타나면 다음 스캔에서 자동으로 재활성화된다", async () => {
    const { warehouse } = await makeWarehouse();
    const deps = {
      warehouse,
      clock: createFixedClock(NOW_ISO),
      notificationProvider: createMockNotificationProvider(),
    };

    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,10\n본점,Piattos,SKU-CHIPS,3\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });

    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,8\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });
    expect((await warehouse.queryStock({ storeId: "본점" })).map((s) => s.variantId)).toEqual([
      "SKU-COLA",
    ]);

    // 세 번째 스캔 — SKU-CHIPS가 다시 나타났다(재입고 흉내).
    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,7\n본점,Piattos,SKU-CHIPS,5\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });

    const stock = await warehouse.queryStock({ storeId: "본점" });
    expect(stock.map((s) => s.variantId).sort()).toEqual(["SKU-CHIPS", "SKU-COLA"]);
  });

  it("비활성화된 행도 물리 삭제되지 않고 DB에 남아 있다(감사 목적)", async () => {
    const { warehouse, db } = await makeWarehouse();
    const deps = {
      warehouse,
      clock: createFixedClock(NOW_ISO),
      notificationProvider: createMockNotificationProvider(),
    };

    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,10\n본점,Piattos,SKU-CHIPS,3\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });

    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,SKU,재고수량\n본점,코카콜라 500ml,SKU-COLA,8\n",
      "utf8",
    );
    await runFolderScan(deps, { watchDir, snapshotDir });

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from inventory_levels where variant_id = 'SKU-CHIPS'",
    );
    expect(rows[0]?.count).toBe("1");
  });
});

describe("runFolderScan — 일일 다이제스트 (DATA-003, TASKS T31)", () => {
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

  it("파일이 안 바뀌었고 같은 날이면 두 번째 live 실행은 재발송하지 않는다(status=unchanged)", async () => {
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
    // 이번 스캔이 실제로 계산한 alerts는 그대로 결과에 담겨 있다 — 무엇이 억제됐는지 알 수 있다.
    expect(second.alerts.map((a) => a.variantId).sort()).toEqual(["SKU-CHIPS", "SKU-COLA"]);
    expect(notificationProvider.sent).toHaveLength(1); // 두 번째는 실제로 안 나감
  });

  it("파일이 안 바뀌었어도 하루(24시간)가 지나면 같은 내용으로 다이제스트를 다시 보낸다", async () => {
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

  it("파일 내용이 바뀌면 같은 날 안에도 억제하지 않고 다시 보낸다", async () => {
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

    // 재고수량이 바뀐 새 내용 — content hash가 달라진다.
    await writeFile(
      join(watchDir, "inventory.csv"),
      HAPPY_CSV.replace("SKU-COLA,10,560", "SKU-COLA,3,560"),
      "utf8",
    );
    const second = await runFolderScan(deps, { ...opts, runId: "run-2" });
    expect(second.status).toBe("sent");
    expect(notificationProvider.sent).toHaveLength(2);
  });

  it("발송 실패(failed)는 워터마크를 갱신하지 않아 같은 날 바로 재시도할 수 있다", async () => {
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

    // 같은 파일, 같은 날짜, 실패 직후 재시도 — 억제되지 않고 다시 시도해야 한다(그리고
    // 여전히 실패한다, failFor가 유지되므로).
    await expect(runFolderScan(deps, { ...opts, runId: "run-2" })).rejects.toThrow();
  });

  it("dry_run 반복 실행은 다이제스트 판정과 무관하다 — 매번 같은 리포트를 그대로 다시 보여준다", async () => {
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
    expect(second.status).toBe("dry_run"); // "unchanged"가 아니다 — dry_run은 억제 대상이 아님.
    expect(second.alerts).toEqual(first.alerts);
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
