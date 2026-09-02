/**
 * ETL 동기화 오케스트레이션 (DESIGN §5, §11.1, §11.2).
 * 순서: stores → items → receipts → inventory (FK 의존 때문에 이 순서를 유지한다 — sales_lines/
 * inventory_levels/inventory_snapshots는 stores·products를 참조한다).
 * 리소스 하나의 모든 페이지 처리 + upsert + watermark 갱신은 Warehouse.transaction()으로
 * 하나의 트랜잭션에 묶는다 — 중간 페이지 실패 시 그 리소스의 데이터와 watermark가 함께
 * 롤백되고, 이전 watermark부터 안전하게 재시도된다. 조립 계층이라 LLM 개입 없음 — 전 과정 결정론.
 *
 * 이 파일은 **Loyverse 전용 경로**다(TASKS T12) — `LoyverseClient`의 영수증 단위 증분 동기화
 * 모델을 그대로 전제한다. CSV/Excel 채널은 `syncAll()`을 재사용하지 않고 별도 오케스트레이션
 * (`folderScan.ts`, TASKS T18)에서 `Warehouse`에 직접 쓴다 — 폴더 스캔은 "현재 파일 전체를
 * 매번 다시 읽는 스냅샷" 모델이라 여기의 watermark/커서 기반 증분 동기화와 맞지 않는다.
 */
import { randomUUID } from "node:crypto";
import type {
  Clock,
  InventoryRow,
  LoyverseClient,
  LvItem,
  ProductRow,
  SalesLineRow,
  StoreRow,
  Warehouse,
} from "../core/types.js";

export type SyncResource = "stores" | "items" | "receipts" | "inventory";

export interface ResourceSyncResult {
  resource: SyncResource;
  status: "success" | "failed" | "skipped";
  /** 이번 실행에서 적재를 시도한 행 수(성공 시). 실패/건너뜀이면 0. */
  itemCount: number;
  error?: string;
  /** 성공했을 때만 채워진다 — 실패/건너뜀은 null(이전 성공 시각은 sync_status가 DB에서 조회). */
  lastSyncedAt: Date | null;
}

export interface SyncResult {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  resources: ResourceSyncResult[];
  /** 리소스 중 하나라도 success가 아니면 false — 앞 리소스 성공을 뒤 리소스 실패 뒤에 숨기지 않는다. */
  ok: boolean;
}

export interface SyncOptions {
  /** 기본값: clock.now().toISOString() — 재고 스냅샷과 로그를 한 실행으로 묶는 식별자. */
  runId?: string;
  /** 기본값: 4종 전부. 부분 동기화(예: 스모크에서 stores만) 테스트용. */
  resources?: SyncResource[];
}

export interface SyncDeps {
  loyverseClient: LoyverseClient;
  warehouse: Warehouse;
  clock: Clock;
}

const RECEIPTS_EPOCH_ISO = "1970-01-01T00:00:00.000Z";
/** 한 upsert 호출당 최대 행 수 — Postgres 파라미터 상한(65535)을 넉넉히 피한다(T10 50k행 대비). */
const UPSERT_CHUNK_SIZE = 1000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function syncStores(deps: SyncDeps): Promise<ResourceSyncResult> {
  try {
    const stores = await deps.loyverseClient.listStores();
    const rows: StoreRow[] = stores.map((s) => ({ id: s.id, name: s.name }));
    const at = deps.clock.now();
    await deps.warehouse.transaction(async (tx) => {
      for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) await tx.upsertStores(batch);
      await tx.setCursor("stores", at.toISOString(), at);
    });
    return { resource: "stores", status: "success", itemCount: rows.length, lastSyncedAt: at };
  } catch (err) {
    return {
      resource: "stores",
      status: "failed",
      itemCount: 0,
      error: errorMessage(err),
      lastSyncedAt: null,
    };
  }
}

async function syncItems(deps: SyncDeps): Promise<ResourceSyncResult> {
  try {
    const allItems: LvItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await deps.loyverseClient.listItems(cursor);
      allItems.push(...page.items);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);

    const rows: ProductRow[] = allItems.flatMap((item) =>
      item.variants.map((v) => ({
        variantId: v.variant_id,
        itemId: item.id,
        name: item.item_name,
        sku: v.sku,
        // 카테고리 "이름" 해석(Categories API)은 DESIGN §4 LoyverseClient 계약 밖이다 —
        // v0.1은 category_id를 그대로 저장한다(이름 해석은 v0.2 대기열).
        category: item.category_id,
      })),
    );

    const at = deps.clock.now();
    await deps.warehouse.transaction(async (tx) => {
      for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) await tx.upsertProducts(batch);
      await tx.setCursor("items", at.toISOString(), at);
    });
    return { resource: "items", status: "success", itemCount: rows.length, lastSyncedAt: at };
  } catch (err) {
    return {
      resource: "items",
      status: "failed",
      itemCount: 0,
      error: errorMessage(err),
      lastSyncedAt: null,
    };
  }
}

async function syncReceipts(deps: SyncDeps): Promise<ResourceSyncResult> {
  try {
    const previousWatermark = await deps.warehouse.getCursor("receipts");
    const sinceISO = previousWatermark ?? RECEIPTS_EPOCH_ISO;
    // watermark보다 크거나 "같은" updated_at도 다시 조회한다(동률 안정 재조회, DESIGN §11.1) —
    // 이미 적재된 영수증이 다시 와도 PK(receipt_id, line_no) upsert라 안전하다.
    let maxUpdatedAt: string | null = previousWatermark;
    let itemCount = 0;

    await deps.warehouse.transaction(async (tx) => {
      const allLines: SalesLineRow[] = [];
      let cursor: string | undefined;
      do {
        const page = await deps.loyverseClient.listReceipts(sinceISO, cursor);
        for (const receipt of page.items) {
          itemCount += 1;
          if (maxUpdatedAt === null || receipt.updated_at > maxUpdatedAt) {
            maxUpdatedAt = receipt.updated_at;
          }
          // 취소된 영수증은 완결되지 않은 거래로 보고 집계에서 제외한다(SPEC §9, DESIGN §11.3).
          // 주의(알려진 한계, v0.1): 과거에 이미 적재된 영수증이 나중에 취소되면 그 라인은
          // 여기서 새로 적재/갱신되지 않는다 — 기존에 적재된 sales_lines를 지우는 로직은
          // v0.1 범위 밖이다(취소가 흔히 생성 직후 일어난다는 전제). v0.2에서 보완한다.
          if (receipt.cancelled_at !== null) continue;

          const sign = receipt.receipt_type === "REFUND" ? -1 : 1;
          receipt.line_items.forEach((li, lineNo) => {
            allLines.push({
              receiptId: receipt.receipt_number,
              lineNo,
              storeId: receipt.store_id,
              variantId: li.variant_id,
              qty: String(sign * li.quantity),
              gross: String(sign * li.gross_total_money),
              discount: String(li.total_discount),
              soldAt: new Date(receipt.receipt_date),
            });
          });
        }
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined);

      for (const batch of chunk(allLines, UPSERT_CHUNK_SIZE)) {
        await tx.upsertSalesLines(batch);
      }
      if (maxUpdatedAt !== null && maxUpdatedAt !== previousWatermark) {
        await tx.setCursor("receipts", maxUpdatedAt, deps.clock.now());
      }
    });

    return { resource: "receipts", status: "success", itemCount, lastSyncedAt: deps.clock.now() };
  } catch (err) {
    return {
      resource: "receipts",
      status: "failed",
      itemCount: 0,
      error: errorMessage(err),
      lastSyncedAt: null,
    };
  }
}

async function syncInventory(deps: SyncDeps, runId: string): Promise<ResourceSyncResult> {
  try {
    const rawLevels: {
      store_id: string;
      variant_id: string;
      in_stock: number;
      updated_at: string;
    }[] = [];
    let cursor: string | undefined;
    do {
      const page = await deps.loyverseClient.listInventory(cursor);
      rawLevels.push(...page.items);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);

    // 빈 재고 응답은 기존 현재고를 조용히 방치하지 않고 동기화 오류로 취급한다(DESIGN §11.2) —
    // 업서트는 삭제를 하지 않으므로 데이터를 파괴하진 않지만, 응답이 진짜로 비어 있다는 것
    // 자체가 토큰 권한·API 이상의 신호일 가능성이 높다.
    if (rawLevels.length === 0) {
      throw new Error(
        "Loyverse inventory 응답이 비어 있습니다. 기존 재고는 변경하지 않고 동기화 오류로 " +
          "처리합니다. Loyverse 토큰에 INVENTORY_READ 권한이 있는지, 계정에 실제 재고 데이터가 " +
          "있는지 확인하세요.",
      );
    }

    const at = deps.clock.now();
    const rows: InventoryRow[] = rawLevels.map((l) => ({
      storeId: l.store_id,
      variantId: l.variant_id,
      inStock: String(l.in_stock),
      updatedAt: new Date(l.updated_at),
    }));

    await deps.warehouse.transaction(async (tx) => {
      for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) await tx.upsertInventory(batch);
      for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
        await tx.appendInventorySnapshot(runId, at, batch);
      }
      await tx.setCursor("inventory", at.toISOString(), at);
    });

    return { resource: "inventory", status: "success", itemCount: rows.length, lastSyncedAt: at };
  } catch (err) {
    return {
      resource: "inventory",
      status: "failed",
      itemCount: 0,
      error: errorMessage(err),
      lastSyncedAt: null,
    };
  }
}

function skipped(resource: SyncResource, reason: string): ResourceSyncResult {
  return { resource, status: "skipped", itemCount: 0, error: reason, lastSyncedAt: null };
}

/**
 * 4종 리소스를 순서대로 동기화한다. stores/items 동기화를 이번 실행에서 시도했는데 실패하면
 * receipts/inventory는 FK 의존 때문에 시도조차 하지 않고 "skipped"로 보고한다(둘 다 stores·
 * products를 참조하므로 시도해도 FK 위반으로 실패할 뿐이다) — 실행하지 않은 리소스와 실패한
 * 리소스를 구분해서 보고한다.
 */
export async function syncAll(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncResult> {
  const startedAt = deps.clock.now();
  // FixedClock으로 여러 번 실행해도 실행마다 구분돼야 하므로 clock이 아니라 randomUUID로 만든다
  // (TESTING §7: 동일 시각 FixedClock 2회 동기화에도 스냅샷 PK 충돌 없이 실행별 구분 가능해야 함).
  const runId = opts.runId ?? randomUUID();
  const wanted = new Set<SyncResource>(
    opts.resources ?? ["stores", "items", "receipts", "inventory"],
  );
  const results: ResourceSyncResult[] = [];

  let storesOk = true;
  if (wanted.has("stores")) {
    const r = await syncStores(deps);
    results.push(r);
    storesOk = r.status === "success";
  }

  let itemsOk = true;
  if (wanted.has("items")) {
    const r = await syncItems(deps);
    results.push(r);
    itemsOk = r.status === "success";
  }

  const dependenciesOk = storesOk && itemsOk;
  const skipReason = "stores/items 동기화 실패로 FK 의존 리소스를 건너뜀";

  if (wanted.has("receipts")) {
    results.push(dependenciesOk ? await syncReceipts(deps) : skipped("receipts", skipReason));
  }
  if (wanted.has("inventory")) {
    results.push(
      dependenciesOk ? await syncInventory(deps, runId) : skipped("inventory", skipReason),
    );
  }

  const finishedAt = deps.clock.now();
  return {
    runId,
    startedAt,
    finishedAt,
    resources: results,
    ok: results.every((r) => r.status === "success"),
  };
}
