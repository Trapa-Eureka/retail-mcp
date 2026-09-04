import { describe, expect, it } from "vitest";
import { createFixtureLoyverseClient } from "../src/mocks/fixtureLoyverseClient.js";
import type { LvItem, LvReceipt } from "../src/core/types.js";

// TESTING.md §2 scenario window: today=2026-09-01T00:00:00Z, last 35 days = [2026-07-28, 2026-09-01)
const WINDOW_START_ISO = "2026-07-28T00:00:00.000Z";
const LAST_5_DAYS = ["2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31"];

describe("FixtureLoyverseClient", () => {
  it("listStores — 2 stores, no pagination", async () => {
    const client = await createFixtureLoyverseClient();
    const stores = await client.listStores();
    expect(stores).toHaveLength(2);
    expect(stores.map((s) => s.name)).toEqual(["Main Store", "Makati Branch"]);
  });

  it("listItems — reproduces 2 or more cursor pages (default page size 5, 8 items)", async () => {
    const client = await createFixtureLoyverseClient();

    const page1 = await client.listItems();
    expect(page1.items).toHaveLength(5);
    expect(page1.cursor).not.toBeNull();

    const page2 = await client.listItems(page1.cursor ?? undefined);
    expect(page2.items).toHaveLength(3);
    expect(page2.cursor).toBeNull();

    const allNames = [...page1.items, ...page2.items].map((i: LvItem) => i.item_name);
    expect(allNames).toContain("Coca-Cola 500ml");
    expect(allNames).toContain("Mirinda Orange");
    expect(allNames).toContain("Datu Puti Suka 1L"); // Tagalog brand name
  });

  it("listReceipts — reproduces 2 or more cursor pages (84 receipts over the full window, default page 40)", async () => {
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

  it("a listReceipts cursor cannot be reused with a sinceISO different from the initial call", async () => {
    const client = await createFixtureLoyverseClient();
    const page1 = await client.listReceipts(WINDOW_START_ISO);
    expect(page1.cursor).not.toBeNull();

    await expect(
      client.listReceipts("2026-08-01T00:00:00.000Z", page1.cursor ?? undefined),
    ).rejects.toThrow(/query condition/);
  });

  it("listReceipts — refund receipts preserve receipt_type/refund_for and quantity is positive (real API contract)", async () => {
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
        expect(li.quantity).toBeGreaterThan(0); // real API: quantity is positive even for refunds; the ETL flips the sign
      }
    }
    const sales = all.filter((r) => r.receipt_type === "SALE");
    expect(sales.every((r) => r.refund_for === null)).toBe(true);
  });

  it("listReceipts — preserves cancelled_at of cancelled receipts", async () => {
    const client = await createFixtureLoyverseClient();
    const page1 = await client.listReceipts(WINDOW_START_ISO);
    const page2 = await client.listReceipts(WINDOW_START_ISO, page1.cursor ?? undefined);
    const all = [...page1.items, ...page2.items];

    const cancelled = all.filter((r) => r.cancelled_at !== null);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.receipt_number).toBe("R-STORE_MAIN-00013");
  });

  it("listReceipts — filtering by updated_at (watermark) catches later-edited receipts that receipt_date alone would miss", async () => {
    const client = await createFixtureLoyverseClient();
    // This receipt has receipt_date=2026-08-02 but was updated afterwards with updated_at=2026-08-05.
    // With sinceISO set to 08-04, a receipt_date filter misses it but an updated_at filter must catch it.
    const sinceISO = "2026-08-04T00:00:00.000Z";
    const result = await client.listReceipts(sinceISO);
    const found = result.items.find((r) => r.receipt_number === "R-STORE_MAKATI-00049");
    if (!found) throw new Error("the fixture must contain R-STORE_MAKATI-00049");
    expect(found.receipt_date < sinceISO).toBe(true); // outside the window by receipt_date alone
    expect(found.updated_at >= sinceISO).toBe(true); // inside the window by updated_at
  });

  it("listReceipts — the new item (bearbrand) appears exactly in the last 5 days, once per store per day", async () => {
    const client = await createFixtureLoyverseClient();
    const page1 = await client.listReceipts(WINDOW_START_ISO);
    const page2 = await client.listReceipts(WINDOW_START_ISO, page1.cursor ?? undefined);
    const page3 = await client.listReceipts(WINDOW_START_ISO, page2.cursor ?? undefined);
    const all = [...page1.items, ...page2.items, ...page3.items];

    const bearbrandReceipts = all.filter((r) =>
      r.line_items.some((li) => li.variant_id === "var_bearbrand300"),
    );
    expect(bearbrandReceipts).toHaveLength(10); // 5 days × 2 stores

    const daysByStore: Record<string, Set<string>> = {
      store_main: new Set(),
      store_makati: new Set(),
    };
    for (const r of bearbrandReceipts) {
      daysByStore[r.store_id]?.add(r.receipt_date.slice(0, 10));
    }
    expect([...(daysByStore["store_main"] ?? [])].sort()).toEqual(LAST_5_DAYS);
    expect([...(daysByStore["store_makati"] ?? [])].sort()).toEqual(LAST_5_DAYS);

    // Outside the window (before the last 5 days) there must be 0
    const beforeLast5Days = all.filter(
      (r) =>
        r.line_items.some((li) => li.variant_id === "var_bearbrand300") &&
        r.receipt_date.slice(0, 10) < (LAST_5_DAYS[0] ?? ""),
    );
    expect(beforeLast5Days).toHaveLength(0);
  });

  it("listInventory — reproduces 2 or more cursor pages (2 stores × 8 items = 16 rows, default page 10), preserves updated_at", async () => {
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

  it("an invalid cursor throws an error with the cause", async () => {
    const client = await createFixtureLoyverseClient();
    await expect(client.listItems("not-a-valid-cursor")).rejects.toThrow(/cursor/);
  });

  it("page sizes only accept integers of 1 or more", async () => {
    await expect(createFixtureLoyverseClient({ itemsPageSize: 0 })).rejects.toThrow(
      /integer of 1 or more/,
    );
    await expect(createFixtureLoyverseClient({ itemsPageSize: -1 })).rejects.toThrow(
      /integer of 1 or more/,
    );
    await expect(createFixtureLoyverseClient({ itemsPageSize: 1.5 })).rejects.toThrow(
      /integer of 1 or more/,
    );
    await expect(createFixtureLoyverseClient({ itemsPageSize: Number.NaN })).rejects.toThrow(
      /integer of 1 or more/,
    );
  });
});
