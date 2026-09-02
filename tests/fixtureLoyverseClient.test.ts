import { describe, expect, it } from "vitest";
import { createFixtureLoyverseClient } from "../src/mocks/fixtureLoyverseClient.js";
import type { LvItem, LvReceipt } from "../src/core/types.js";

// TESTING.md §2 시나리오 창: today=2026-09-01T00:00:00Z, 최근 35일 = [2026-07-28, 2026-09-01)
const WINDOW_START_ISO = "2026-07-28T00:00:00.000Z";
const LAST_5_DAYS_START_ISO = "2026-08-27T00:00:00.000Z"; // 신규 품목 이력 시작일

describe("FixtureLoyverseClient", () => {
  it("listStores — 매장 2곳, 페이지네이션 없음", async () => {
    const client = await createFixtureLoyverseClient();
    const stores = await client.listStores();
    expect(stores).toHaveLength(2);
    expect(stores.map((s) => s.name)).toEqual(["본점", "마카티점"]);
  });

  it("listItems — 커서 페이지 2개 이상 재현 (기본 페이지 크기 5, 품목 8종)", async () => {
    const client = await createFixtureLoyverseClient();

    const page1 = await client.listItems();
    expect(page1.items).toHaveLength(5);
    expect(page1.cursor).toBe("5");

    const page2 = await client.listItems(page1.cursor ?? undefined);
    expect(page2.items).toHaveLength(3);
    expect(page2.cursor).toBeNull();

    const allNames = [...page1.items, ...page2.items].map((i: LvItem) => i.item_name);
    expect(allNames).toContain("코카콜라 500ml"); // 한글 유니코드
    expect(allNames).toContain("미린다 오렌지"); // 한글 유니코드
    expect(allNames).toContain("Datu Puti Suka 1L"); // 타갈로그 브랜드명
  });

  it("listReceipts — 커서 페이지 2개 이상 재현 (전체 창 조회 시 84건, 기본 페이지 40)", async () => {
    const client = await createFixtureLoyverseClient();

    const page1 = await client.listReceipts(WINDOW_START_ISO);
    expect(page1.items).toHaveLength(40);
    expect(page1.cursor).toBe("40");

    const page2 = await client.listReceipts(WINDOW_START_ISO, page1.cursor ?? undefined);
    expect(page2.items).toHaveLength(40);
    expect(page2.cursor).toBe("80");

    const page3 = await client.listReceipts(WINDOW_START_ISO, page2.cursor ?? undefined);
    expect(page3.items.length).toBeGreaterThan(0);
    expect(page3.cursor).toBeNull();

    const all: LvReceipt[] = [...page1.items, ...page2.items, ...page3.items];
    expect(all.length).toBe(40 + 40 + page3.items.length);

    // 환불 포함 — 음수 quantity 라인이 존재한다
    const hasRefundLine = all.some((r) => r.line_items.some((li) => li.quantity < 0));
    expect(hasRefundLine).toBe(true);

    // 신규 품목(이력 5일) — bearbrand는 창의 마지막 5일에만 등장한다
    const bearbrandReceipts = all.filter((r) =>
      r.line_items.some((li) => li.variant_id === "var_bearbrand300"),
    );
    expect(bearbrandReceipts.length).toBeGreaterThan(0);
    for (const r of bearbrandReceipts) {
      expect(r.receipt_date >= LAST_5_DAYS_START_ISO).toBe(true);
    }
  });

  it("listReceipts — sinceISO로 필터링된다", async () => {
    const client = await createFixtureLoyverseClient();
    const full = await client.listReceipts(WINDOW_START_ISO);
    const narrowed = await client.listReceipts(LAST_5_DAYS_START_ISO);

    expect(narrowed.items.length).toBeLessThan(full.items.length + 1);
    for (const r of narrowed.items) {
      expect(r.receipt_date >= LAST_5_DAYS_START_ISO).toBe(true);
    }
  });

  it("listInventory — 커서 페이지 2개 이상 재현 (2매장×8품목=16행, 기본 페이지 10)", async () => {
    const client = await createFixtureLoyverseClient();

    const page1 = await client.listInventory();
    expect(page1.items).toHaveLength(10);
    expect(page1.cursor).toBe("10");

    const page2 = await client.listInventory(page1.cursor ?? undefined);
    expect(page2.items).toHaveLength(6);
    expect(page2.cursor).toBeNull();

    // 재고 0 품목(luckymepancit) 포함 — 두 매장 모두
    const all = [...page1.items, ...page2.items];
    const zeroStock = all.filter((i) => i.variant_id === "var_luckymepancit");
    expect(zeroStock).toHaveLength(2);
    expect(zeroStock.every((i) => i.in_stock === 0)).toBe(true);
  });

  it("유효하지 않은 cursor는 원인이 담긴 에러를 던진다", async () => {
    const client = await createFixtureLoyverseClient();
    await expect(client.listItems("not-a-number")).rejects.toThrow(/cursor/);
  });
});
