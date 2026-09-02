import { describe, expect, it } from "vitest";
import { createFixtureLoyverseClient } from "../src/mocks/fixtureLoyverseClient.js";
import type { LvItem, LvReceipt } from "../src/core/types.js";

// TESTING.md §2 시나리오 창: today=2026-09-01T00:00:00Z, 최근 35일 = [2026-07-28, 2026-09-01)
const WINDOW_START_ISO = "2026-07-28T00:00:00.000Z";
const LAST_5_DAYS = ["2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31"];

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
    expect(page1.cursor).not.toBeNull();

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
    expect(page1.cursor).not.toBeNull();

    const page2 = await client.listReceipts(WINDOW_START_ISO, page1.cursor ?? undefined);
    expect(page2.items).toHaveLength(40);
    expect(page2.cursor).not.toBeNull();

    const page3 = await client.listReceipts(WINDOW_START_ISO, page2.cursor ?? undefined);
    expect(page3.items.length).toBeGreaterThan(0);
    expect(page3.cursor).toBeNull();

    const all: LvReceipt[] = [...page1.items, ...page2.items, ...page3.items];
    expect(all.length).toBe(40 + 40 + page3.items.length);
    expect(all.length).toBe(84);
  });

  it("listReceipts cursor는 최초 호출과 다른 sinceISO로 재사용할 수 없다", async () => {
    const client = await createFixtureLoyverseClient();
    const page1 = await client.listReceipts(WINDOW_START_ISO);
    expect(page1.cursor).not.toBeNull();

    await expect(
      client.listReceipts("2026-08-01T00:00:00.000Z", page1.cursor ?? undefined),
    ).rejects.toThrow(/조회 조건/);
  });

  it("listReceipts — 환불 영수증은 receipt_type/refund_for를 보존하고 quantity는 양수다 (실제 API 계약)", async () => {
    const client = await createFixtureLoyverseClient();
    const page1 = await client.listReceipts(WINDOW_START_ISO);
    const page2 = await client.listReceipts(WINDOW_START_ISO, page1.cursor ?? undefined);
    const page3 = await client.listReceipts(WINDOW_START_ISO, page2.cursor ?? undefined);
    const all = [...page1.items, ...page2.items, ...page3.items];

    const refunds = all.filter((r) => r.receipt_type === "REFUND");
    expect(refunds.length).toBeGreaterThan(0);
    for (const r of refunds) {
      expect(r.refund_for).not.toBeNull();
      for (const li of r.line_items) {
        expect(li.quantity).toBeGreaterThan(0); // 실제 API: 환불도 quantity는 양수, 부호 반전은 ETL 몫
      }
    }
    const sales = all.filter((r) => r.receipt_type === "SALE");
    expect(sales.every((r) => r.refund_for === null)).toBe(true);
  });

  it("listReceipts — 취소된 영수증의 cancelled_at을 보존한다", async () => {
    const client = await createFixtureLoyverseClient();
    const page1 = await client.listReceipts(WINDOW_START_ISO);
    const page2 = await client.listReceipts(WINDOW_START_ISO, page1.cursor ?? undefined);
    const all = [...page1.items, ...page2.items];

    const cancelled = all.filter((r) => r.cancelled_at !== null);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.receipt_number).toBe("R-STORE_MAIN-00013");
  });

  it("listReceipts — updated_at(watermark) 기준 필터링은 receipt_date만으로는 못 잡는 사후 수정 영수증을 잡아낸다", async () => {
    const client = await createFixtureLoyverseClient();
    // 이 영수증은 receipt_date=2026-08-02 지만 updated_at=2026-08-05로 사후 갱신됐다.
    // sinceISO를 08-04로 주면 receipt_date 기준 필터는 놓치지만 updated_at 기준 필터는 잡아야 한다.
    const sinceISO = "2026-08-04T00:00:00.000Z";
    const result = await client.listReceipts(sinceISO);
    const found = result.items.find((r) => r.receipt_number === "R-STORE_MAKATI-00049");
    if (!found) throw new Error("fixture에 R-STORE_MAKATI-00049가 있어야 한다");
    expect(found.receipt_date < sinceISO).toBe(true); // receipt_date만 보면 창 밖
    expect(found.updated_at >= sinceISO).toBe(true); // updated_at 기준으로는 창 안
  });

  it("listReceipts — 신규 품목(bearbrand)은 정확히 마지막 5일, 매장당 1건씩만 등장한다", async () => {
    const client = await createFixtureLoyverseClient();
    const page1 = await client.listReceipts(WINDOW_START_ISO);
    const page2 = await client.listReceipts(WINDOW_START_ISO, page1.cursor ?? undefined);
    const page3 = await client.listReceipts(WINDOW_START_ISO, page2.cursor ?? undefined);
    const all = [...page1.items, ...page2.items, ...page3.items];

    const bearbrandReceipts = all.filter((r) =>
      r.line_items.some((li) => li.variant_id === "var_bearbrand300"),
    );
    expect(bearbrandReceipts).toHaveLength(10); // 5일 × 2매장

    const daysByStore: Record<string, Set<string>> = {
      store_main: new Set(),
      store_makati: new Set(),
    };
    for (const r of bearbrandReceipts) {
      daysByStore[r.store_id]?.add(r.receipt_date.slice(0, 10));
    }
    expect([...(daysByStore["store_main"] ?? [])].sort()).toEqual(LAST_5_DAYS);
    expect([...(daysByStore["store_makati"] ?? [])].sort()).toEqual(LAST_5_DAYS);

    // 창 밖(마지막 5일 이전)에는 0건이어야 한다
    const beforeLast5Days = all.filter(
      (r) =>
        r.line_items.some((li) => li.variant_id === "var_bearbrand300") &&
        r.receipt_date.slice(0, 10) < (LAST_5_DAYS[0] ?? ""),
    );
    expect(beforeLast5Days).toHaveLength(0);
  });

  it("listInventory — 커서 페이지 2개 이상 재현 (2매장×8품목=16행, 기본 페이지 10), updated_at 보존", async () => {
    const client = await createFixtureLoyverseClient();

    const page1 = await client.listInventory();
    expect(page1.items).toHaveLength(10);
    expect(page1.cursor).not.toBeNull();

    const page2 = await client.listInventory(page1.cursor ?? undefined);
    expect(page2.items).toHaveLength(6);
    expect(page2.cursor).toBeNull();

    const all = [...page1.items, ...page2.items];
    expect(all.every((i) => typeof i.updated_at === "string" && i.updated_at.length > 0)).toBe(
      true,
    );

    const zeroStock = all.filter((i) => i.variant_id === "var_luckymepancit");
    expect(zeroStock).toHaveLength(2);
    expect(zeroStock.every((i) => i.in_stock === 0)).toBe(true);
  });

  it("유효하지 않은 cursor는 원인이 담긴 에러를 던진다", async () => {
    const client = await createFixtureLoyverseClient();
    await expect(client.listItems("not-a-valid-cursor")).rejects.toThrow(/cursor/);
  });

  it("페이지 크기는 1 이상의 정수만 허용한다", async () => {
    await expect(createFixtureLoyverseClient({ itemsPageSize: 0 })).rejects.toThrow(
      /1 이상의 정수/,
    );
    await expect(createFixtureLoyverseClient({ itemsPageSize: -1 })).rejects.toThrow(
      /1 이상의 정수/,
    );
    await expect(createFixtureLoyverseClient({ itemsPageSize: 1.5 })).rejects.toThrow(
      /1 이상의 정수/,
    );
    await expect(createFixtureLoyverseClient({ itemsPageSize: Number.NaN })).rejects.toThrow(
      /1 이상의 정수/,
    );
  });
});
