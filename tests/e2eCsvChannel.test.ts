/**
 * CSV/Excel 채널 e2e (TASKS T22) — SPEC §12가 기술한 실제 사용 절차 두 가지를, 실제
 * 파일시스템·독립된 PGlite 웨어하우스로 끝까지 이어 붙여 검증한다. 개별 유닛 동작은 이미
 * `tests/folderScan.test.ts`(T18/T20)가 촘촘히 덮고 있으므로, 여기서는 그 조각들이 실제
 * 운영 절차 그대로 맞물리는지에 집중한다.
 *
 * 시나리오 1(지점 단독): 재고 파일 → 파싱 → 적재 → 저재고 알림 발송(SEND_MODE=live+--confirm
 * 이중 게이트 실통과)까지, 온보딩이 만드는 것과 동일한 폴더 구조로 실행한다.
 *
 * 시나리오 2(본사 통합): **서로 독립된 PGlite 웨어하우스** 두 개(지점 A/B)가 각자 스캔해 만든
 * 실제 스냅샷 파일을, "이미 쓰는 전송 수단"(SPEC §12, 여기서는 파일 복사로 흉내)으로 세 번째
 * 독립된 PGlite 웨어하우스(본사)의 수집 폴더에 옮기고, 본사가 통합 조회한다 — 기존
 * `runConsolidatedScan` 테스트는 손으로 쓴 스냅샷 픽스처를 바로 넣었지만, 여기서는 T19
 * export가 실제로 만든 파일이 T20 import를 그대로 통과하는지까지 확인한다.
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

describe("e2e — 지점 단독 시나리오(파일→파싱→적재→알림)", () => {
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

  it("온보딩이 만드는 구조 그대로 — 재고 파일을 넣고 스캔하면 적재 + 실제 저재고 알림 발송까지 끝난다", async () => {
    const warehouse = await makeWarehouse();
    const notificationProvider = createMockNotificationProvider();

    // 본점: 판매이력 있는 품목(품절 위험) + 판매이력 없는 품목(임계치 미만, override 3).
    // 마카티점: 판매이력 있는 안전 재고 품목 — 알림 대상 아님.
    const inventoryCsv = `매장명,상품명,SKU,재고수량,판매수량,판매기간시작일,판매기간종료일,저재고임계치
본점,코카콜라 500ml,SKU-COLA,10,560,2026-08-01,2026-08-29,
본점,Piattos,SKU-CHIPS,2,,,,3
마카티점,생수 500ml,SKU-WATER,100,28,2026-08-01,2026-08-29,
`;
    await writeFile(join(watchDir, "inventory.csv"), inventoryCsv, "utf8");

    const result = await runFolderScan(
      { warehouse, clock: createFixedClock(NOW_ISO), notificationProvider },
      {
        watchDir,
        snapshotDir,
        sendMode: "live",
        confirm: true, // 이중 게이트(가드레일 1) 실제 통과 — dry_run이 아니라 진짜 발송 경로.
        recipient: "owner@example.com",
      },
    );

    // 적재: 3개 품목 전부 웨어하우스에 반영됐다.
    const stock = await warehouse.queryStock({});
    expect(stock).toHaveLength(3);
    expect(stock.map((s) => s.variantId).sort()).toEqual(["SKU-CHIPS", "SKU-COLA", "SKU-WATER"]);

    // 알림 판정: COLA(품절위험, history 모드) + CHIPS(임계치 3 미만, no_history 모드) 2건,
    // WATER는 안전권이라 제외.
    expect(result.alertCount).toBe(2);
    expect(result.alerts.map((a) => a.variantId).sort()).toEqual(["SKU-CHIPS", "SKU-COLA"]);
    expect(result.alerts.find((a) => a.variantId === "SKU-CHIPS")?.mode).toBe("no_history");
    expect(result.alerts.find((a) => a.variantId === "SKU-COLA")?.mode).toBe("history");

    // 발송: live && confirm 둘 다라 실제로 나갔다(Mock provider가 실제로 받았는지 확인).
    expect(result.sent).toBe(true);
    expect(result.status).toBe("sent");
    expect(notificationProvider.sent).toHaveLength(1);
    const sentMessage = notificationProvider.sent[0]!;
    expect(sentMessage.to).toBe("owner@example.com");
    expect(sentMessage.text).toContain("코카콜라 500ml");
    expect(sentMessage.text).toContain("Piattos");
    expect(sentMessage.text).not.toContain("생수 500ml"); // 안전 재고는 리포트에 없어야 한다.

    // 스냅샷: 다음 단계(본사 통합)가 그대로 읽을 수 있는 산출물이 실제로 쓰였다.
    const snapshotContent = await readFile(result.snapshotPath, "utf8");
    expect(snapshotContent).toContain("본점");
    expect(snapshotContent).toContain("마카티점");
  });

  it("파싱이 실패하면 알림도 스냅샷도 없이 명확한 에러로 끝난다(적재 없음 재확인)", async () => {
    const warehouse = await makeWarehouse();
    const notificationProvider = createMockNotificationProvider();
    // SKU 컬럼 자체가 없는 잘못된 헤더 — T15 zod 파싱이 필수 컬럼 누락으로 거부한다.
    await writeFile(
      join(watchDir, "inventory.csv"),
      "매장명,상품명,재고수량\n본점,콜라,10\n",
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

describe("e2e — 본사 통합 시나리오(지점 2곳 스냅샷→통합 조회)", () => {
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

  it("서로 독립된 지점 두 곳이 각자 스캔해 낸 실제 스냅샷을, 본사가 취합해 매장명으로 필터링 조회한다", async () => {
    // ── 지점 A(본점): 자기만의 독립된 웨어하우스·폴더로 실제 스캔을 1회 수행한다 ──
    const branchAWarehouse = await makeWarehouse();
    await writeFile(
      join(branchADir, "watch", "inventory.csv"),
      `매장명,상품명,SKU,재고수량,판매수량,판매기간시작일,판매기간종료일\n` +
        `본점,코카콜라 500ml,SKU-COLA,10,560,2026-08-01,2026-08-29\n`,
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

    // ── 지점 B(마카티점): 완전히 다른 웨어하우스 인스턴스 — 서로의 데이터를 전혀 모른다 ──
    const branchBWarehouse = await makeWarehouse();
    await writeFile(
      join(branchBDir, "watch", "inventory.csv"),
      `매장명,상품명,SKU,재고수량,저재고임계치\n` + `마카티점,생수 500ml,SKU-WATER,2,5\n`,
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

    // ── 본사: 두 지점의 실제 스냅샷 산출물을(기존 전송 수단을 파일 복사로 흉내) 수집 폴더로
    //    모으고, 자신만의 세 번째 독립 웨어하우스로 통합 스캔한다 ──
    await copyFile(branchAResult.snapshotPath, join(hqCollectDir, "본점.csv"));
    await copyFile(branchBResult.snapshotPath, join(hqCollectDir, "마카티점.csv"));

    const hqWarehouse = await makeWarehouse();
    const hqResult = await runConsolidatedScan(
      { warehouse: hqWarehouse, clock: createFixedClock(NOW_ISO) },
      { collectDir: hqCollectDir },
    );

    expect(hqResult.ok).toBe(true);
    expect(hqResult.files).toHaveLength(2);

    // 통합 조회: 스키마 변경 없이 기존 queryStock({storeId})로 매장 필터링이 그대로 된다
    // (SPEC §12 "다지점 헤드오피스 통합 조회"가 예견한 그대로).
    const all = await hqWarehouse.queryStock({});
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.storeId).sort()).toEqual(["마카티점", "본점"]);

    const mainStoreOnly = await hqWarehouse.queryStock({ storeId: "본점" });
    expect(mainStoreOnly).toHaveLength(1);
    expect(mainStoreOnly[0]?.variantId).toBe("SKU-COLA");
    expect(Number(mainStoreOnly[0]?.inStockRaw)).toBe(10);

    const makatiOnly = await hqWarehouse.queryStock({ storeId: "마카티점" });
    expect(makatiOnly).toHaveLength(1);
    expect(makatiOnly[0]?.variantId).toBe("SKU-WATER");

    // watermark도 지점별로 독립 기록된다.
    const resources = (await hqWarehouse.getSyncState()).map((s) => s.resource);
    expect(resources).toContain("csv_branch:본점.csv");
    expect(resources).toContain("csv_branch:마카티점.csv");

    // 본사 통합 스캔은 재알림을 보내지 않는다(SPEC §12·TASKS T20 결정 — 이미 지점 단계에서
    // 알림이 나갔다) — runConsolidatedScan 시그니처 자체에 notificationProvider가 없다는
    // 사실이 이미 이를 구조적으로 보장하지만, 문서화 목적으로 명시한다.
    expect(hqResult).not.toHaveProperty("sent");
  });
});
