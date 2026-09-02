import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LvInventoryResponseSchema,
  LvItemsResponseSchema,
  LvReceiptsResponseSchema,
  LvStoresResponseSchema,
} from "../src/adapters/loyverseSchemas.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures/loyverse");

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(FIXTURES_DIR, file), "utf8")) as unknown;
}

describe("픽스처가 실제 Loyverse 응답 스키마(zod)로 파싱된다", () => {
  it("stores.json", async () => {
    const parsed = LvStoresResponseSchema.parse(await readJson("stores.json"));
    expect(parsed.stores.length).toBe(2);
  });

  it("items.json", async () => {
    const parsed = LvItemsResponseSchema.parse(await readJson("items.json"));
    expect(parsed.items.length).toBe(8);
  });

  it("receipts.json", async () => {
    const parsed = LvReceiptsResponseSchema.parse(await readJson("receipts.json"));
    expect(parsed.receipts.length).toBeGreaterThan(40);
  });

  it("inventory.json", async () => {
    const parsed = LvInventoryResponseSchema.parse(await readJson("inventory.json"));
    expect(parsed.inventory_levels.length).toBe(16);
  });

  it("스키마에 맞지 않는 응답은 에러를 던진다", () => {
    expect(() => LvStoresResponseSchema.parse({ stores: [{ id: "s1" }] })).toThrow();
  });
});
