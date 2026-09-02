/**
 * fixtures/loyverse/*.json을 재생하는 목 LoyverseClient (TESTING.md §2).
 * 실제 API 응답 스키마(zod)로 파싱한 뒤 내부 Lv* 타입으로 좁혀 반환한다.
 * 커서 기반 페이지네이션을 실제로 재현한다 — 네트워크 호출 없음.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LoyverseClient,
  LvInventoryLevel,
  LvItem,
  LvReceipt,
  LvStore,
  Page,
} from "../core/types.js";
import {
  LvInventoryResponseSchema,
  LvItemsResponseSchema,
  LvReceiptsResponseSchema,
  LvStoresResponseSchema,
} from "../adapters/loyverseSchemas.js";

const DEFAULT_FIXTURES_DIR = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../fixtures/loyverse",
);

export interface FixtureLoyverseClientOptions {
  fixturesDir?: string;
  itemsPageSize?: number;
  receiptsPageSize?: number;
  inventoryPageSize?: number;
}

/** offset 기반 커서로 배열을 한 페이지씩 잘라낸다. */
function paginate<T>(all: T[], pageSize: number, cursor: string | undefined): Page<T> {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(
      `유효하지 않은 cursor입니다: "${cursor}". FixtureLoyverseClient가 발급한 cursor 문자열만 전달하세요.`,
    );
  }
  const items = all.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  const cursorOut = nextOffset < all.length ? String(nextOffset) : null;
  return { items, cursor: cursorOut };
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as unknown;
}

export async function createFixtureLoyverseClient(
  opts: FixtureLoyverseClientOptions = {},
): Promise<LoyverseClient> {
  const dir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const itemsPageSize = opts.itemsPageSize ?? 5;
  const receiptsPageSize = opts.receiptsPageSize ?? 40;
  const inventoryPageSize = opts.inventoryPageSize ?? 10;

  const storesRaw = LvStoresResponseSchema.parse(await readJson(path.join(dir, "stores.json")));
  const itemsRaw = LvItemsResponseSchema.parse(await readJson(path.join(dir, "items.json")));
  const receiptsRaw = LvReceiptsResponseSchema.parse(
    await readJson(path.join(dir, "receipts.json")),
  );
  const inventoryRaw = LvInventoryResponseSchema.parse(
    await readJson(path.join(dir, "inventory.json")),
  );

  const stores: LvStore[] = storesRaw.stores.map((s) => ({ id: s.id, name: s.name }));

  const items: LvItem[] = itemsRaw.items.map((i) => ({
    id: i.id,
    item_name: i.item_name,
    category_id: i.category_id,
    variants: i.variants.map((v) => ({ variant_id: v.variant_id, sku: v.sku })),
  }));

  const allReceipts: LvReceipt[] = receiptsRaw.receipts
    .map((r) => ({
      receipt_number: r.receipt_number,
      store_id: r.store_id,
      receipt_date: r.receipt_date,
      line_items: r.line_items.map((li) => ({
        variant_id: li.variant_id,
        item_id: li.item_id,
        quantity: li.quantity,
        gross_total_money: li.gross_total_money,
        total_discount: li.total_discount,
      })),
    }))
    // 실제 API처럼 시간순 정렬을 보장한다 — 이후 sinceISO 필터·커서 페이지네이션의 전제
    .sort((a, b) => a.receipt_date.localeCompare(b.receipt_date));

  const inventory: LvInventoryLevel[] = inventoryRaw.inventory_levels.map((l) => ({
    variant_id: l.variant_id,
    store_id: l.store_id,
    in_stock: l.in_stock,
  }));

  return {
    listStores() {
      return Promise.resolve(stores);
    },

    listItems(cursor?: string) {
      // paginate()가 던지는 에러(잘못된 cursor)를 동기 throw가 아닌 Promise reject로 전달한다.
      return Promise.resolve().then(() => paginate(items, itemsPageSize, cursor));
    },

    listReceipts(sinceISO: string, cursor?: string) {
      // sinceISO는 페이지네이션 전 구간의 최초 호출에서만 적용한다(실제 API와 동일하게
      // cursor가 있으면 원 질의 범위를 그대로 이어받는다 — 우리 인터페이스는 매 호출마다
      // sinceISO를 다시 받으므로 항상 동일한 값을 넘긴다는 전제로 필터링한다).
      return Promise.resolve().then(() => {
        const filtered = allReceipts.filter((r) => r.receipt_date >= sinceISO);
        return paginate(filtered, receiptsPageSize, cursor);
      });
    },

    listInventory(cursor?: string) {
      return Promise.resolve().then(() => paginate(inventory, inventoryPageSize, cursor));
    },
  };
}
