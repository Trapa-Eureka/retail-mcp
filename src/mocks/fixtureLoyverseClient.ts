/**
 * fixtures/loyverse/*.json을 재생하는 목 LoyverseClient (TESTING.md §2).
 * 실제 API 응답 스키마(zod)로 파싱한 뒤 내부 Lv* 타입으로 좁혀 반환한다.
 * 커서 기반 페이지네이션을 실제로 재현한다 — 네트워크 호출 없음.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoyverseClient, LvReceipt, Page } from "../core/types.js";
import {
  LvInventoryResponseSchema,
  LvItemsResponseSchema,
  LvReceiptsResponseSchema,
  LvStoresResponseSchema,
  toLvInventoryLevel,
  toLvItem,
  toLvReceipt,
  toLvStore,
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

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name}는 1 이상의 정수여야 합니다. 받은 값: ${value}. ` +
        `0/음수/소수/NaN을 페이지 크기로 주면 빈 페이지가 무한히 반복될 수 있습니다.`,
    );
  }
}

interface CursorPayload {
  offset: number;
  [key: string]: unknown;
}

/** cursor를 조회 조건(queryTag)과 함께 묶은 불투명(opaque) 토큰으로 인코딩한다. */
function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { offset?: unknown }).offset !== "number"
  ) {
    throw new Error(
      `유효하지 않은 cursor입니다: "${cursor}". FixtureLoyverseClient가 이전 응답으로 발급한 ` +
        `cursor 문자열만 그대로 전달하세요.`,
    );
  }
  return parsed as CursorPayload;
}

/**
 * offset 기반 커서로 배열을 한 페이지씩 잘라낸다. cursor는 발급 당시의 조회 조건(queryTag,
 * 예: listReceipts의 sinceISO)을 함께 인코딩한 불투명 토큰이다 — 재사용 시 queryTag가
 * 다르면(예: sinceISO를 바꿔서 넘기면) 명확한 에러로 거부한다.
 */
function paginate<T>(
  all: T[],
  pageSize: number,
  cursor: string | undefined,
  queryTag: Record<string, unknown> = {},
): Page<T> {
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    const { offset: decodedOffset, ...decodedTag } = decoded;
    if (JSON.stringify(decodedTag) !== JSON.stringify(queryTag)) {
      throw new Error(
        "cursor는 최초 호출과 동일한 조회 조건에서만 사용할 수 있습니다. " +
          "조건을 바꾸려면 cursor 없이 새로 호출하세요.",
      );
    }
    offset = decodedOffset;
  }
  const items = all.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  const cursorOut =
    nextOffset < all.length ? encodeCursor({ offset: nextOffset, ...queryTag }) : null;
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
  assertPositiveInt("itemsPageSize", itemsPageSize);
  assertPositiveInt("receiptsPageSize", receiptsPageSize);
  assertPositiveInt("inventoryPageSize", inventoryPageSize);

  const storesRaw = LvStoresResponseSchema.parse(await readJson(path.join(dir, "stores.json")));
  const itemsRaw = LvItemsResponseSchema.parse(await readJson(path.join(dir, "items.json")));
  const receiptsRaw = LvReceiptsResponseSchema.parse(
    await readJson(path.join(dir, "receipts.json")),
  );
  const inventoryRaw = LvInventoryResponseSchema.parse(
    await readJson(path.join(dir, "inventory.json")),
  );

  const stores = storesRaw.stores.map(toLvStore);
  const items = itemsRaw.items.map(toLvItem);

  const allReceipts: LvReceipt[] = receiptsRaw.receipts
    .map(toLvReceipt)
    // 실제 API처럼 watermark 기준(updated_at) 정렬을 보장한다 — receipt_date가 아니다.
    // 동률은 receipt_number로 안정적으로 재조회할 수 있게 한다(DESIGN §11.1).
    .sort(
      (a, b) =>
        a.updated_at.localeCompare(b.updated_at) ||
        a.receipt_number.localeCompare(b.receipt_number),
    );

  const inventory = inventoryRaw.inventory_levels.map(toLvInventoryLevel);

  return {
    listStores() {
      return Promise.resolve(stores);
    },

    listItems(cursor?: string) {
      // paginate()가 던지는 에러(잘못된 cursor)를 동기 throw가 아닌 Promise reject로 전달한다.
      return Promise.resolve().then(() => paginate(items, itemsPageSize, cursor));
    },

    listReceipts(sinceISO: string, cursor?: string) {
      // sinceISO는 실제 API의 updated_at_min에 대응한다 — receipt_date가 아니라
      // updated_at 기준으로 필터링해야 과거 영수증의 사후 환불·취소·수정도 놓치지 않는다.
      return Promise.resolve().then(() => {
        const filtered = allReceipts.filter((r) => r.updated_at >= sinceISO);
        return paginate(filtered, receiptsPageSize, cursor, { sinceISO });
      });
    },

    listInventory(cursor?: string) {
      return Promise.resolve().then(() => paginate(inventory, inventoryPageSize, cursor));
    },
  };
}
