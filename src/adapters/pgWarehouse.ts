/**
 * Warehouse의 pg/PGlite 겸용 구현. 커넥션은 밖에서 주입한다(운영 = pg.Pool, 테스트 = PGlite).
 * SQL은 전부 파라미터라이즈드 고정 쿼리다 — 문자열 보간으로 값을 SQL에 직접 넣지 않는다.
 * `transaction(fn)`은 실제 BEGIN/COMMIT/ROLLBACK으로 구현한다(DESIGN §11.1, T1 적대적 검수 002-02).
 */
import type {
  AgentSendEntry,
  InventoryRow,
  ProductRow,
  PurchaseAgg,
  PurchaseReceiptRow,
  SalesAgg,
  SalesAggQuery,
  SalesLineRow,
  SalesPeriodAggRow,
  StockQuery,
  StockRow,
  StoreRow,
  SyncStateRow,
  Warehouse,
} from "../core/types.js";

// ── 커넥션 추상화 ───────────────────────────────────────────────────────

/** 단일 세션에서 파라미터라이즈드 쿼리를 실행하는 최소 인터페이스. */
export interface DbSession {
  query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface DbConnection extends DbSession {
  /** 세션을 반환한다. pg.Pool 기반이면 실제 반환, PGlite처럼 단일 세션뿐이면 no-op. */
  release(): void;
}

/** pgWarehouse가 세션을 확보하는 방법 — pg.Pool.connect()이거나 PGlite 인스턴스를 감싼 것. */
export interface DbConnectionProvider {
  acquire(): Promise<DbConnection>;
}

/** node-postgres Pool이 만족하는 최소 시그니처(직접 의존 대신 구조적 타입으로 받는다). */
export interface PgPoolLike {
  connect(): Promise<{
    query<T extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
    release(): void;
  }>;
}

export function createPgConnectionProvider(pool: PgPoolLike): DbConnectionProvider {
  return {
    async acquire() {
      const client = await pool.connect();
      return {
        query: (text, params) => client.query(text, params),
        release: () => client.release(),
      };
    },
  };
}

/** PGlite 인스턴스가 만족하는 최소 시그니처(테스트 전용). */
export interface PgliteLike {
  query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export function createPgliteConnectionProvider(db: PgliteLike): DbConnectionProvider {
  return {
    acquire() {
      // PGlite는 항상 단일 세션이다 — release는 no-op이고, 여러 acquire()가 같은 세션을 공유한다
      // (테스트 환경의 알려진 제약: 진짜 다중 커넥션 동시성은 PGlite로 검증할 수 없다).
      return Promise.resolve({
        query: (text: string, params?: unknown[]) => db.query(text, params),
        release: () => {},
      });
    },
  };
}

/** exploreSqlExecutor.ts(explore_sql 전용)가 같은 acquire/release 패턴을 재사용하려고 export한다. */
export async function withSession<T>(
  provider: DbConnectionProvider,
  fn: (session: DbSession) => Promise<T>,
): Promise<T> {
  const conn = await provider.acquire();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

// ── SQL 헬퍼 ────────────────────────────────────────────────────────────

/** rowCount개 행 × colCount개 컬럼의 `($1,$2), ($3,$4), ...` VALUES 절을 만든다. */
/**
 * `literalSuffix`(선택)는 매 행에 그대로 덧붙는 SQL 리터럴이다 — 사용자 입력이 아니라
 * 호출자가 코드에 고정으로 박아 넣는 상수(예: `, true`)에만 쓴다. 파라미터 바인딩 원칙을
 * 깨는 게 아니라, 매 행마다 파라미터를 하나씩 더 만들 필요가 없는 상수를 위한 지름길이다.
 */
function buildValuesPlaceholders(rowCount: number, colCount: number, literalSuffix = ""): string {
  const rows: string[] = [];
  let idx = 1;
  for (let r = 0; r < rowCount; r++) {
    const cols: string[] = [];
    for (let c = 0; c < colCount; c++) cols.push(`$${idx++}`);
    rows.push(`(${cols.join(", ")}${literalSuffix})`);
  }
  return rows.join(", ");
}

// ── 리소스별 쓰기/조회 (고정된 session에 바인딩) ───────────────────────────

async function upsertStoresOn(session: DbSession, rows: StoreRow[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) params.push(r.id, r.name);
  await session.query(
    `insert into stores (id, name)
     values ${buildValuesPlaceholders(rows.length, 2)}
     on conflict (id) do update set name = excluded.name`,
    params,
  );
}

async function upsertProductsOn(session: DbSession, rows: ProductRow[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.variantId,
      r.itemId,
      r.name,
      r.sku,
      r.category,
      r.lowStockThreshold ?? null,
      r.packSize ?? null,
    );
  }
  await session.query(
    `insert into products (variant_id, item_id, name, sku, category, low_stock_threshold, pack_size)
     values ${buildValuesPlaceholders(rows.length, 7)}
     on conflict (variant_id) do update set
       item_id = excluded.item_id, name = excluded.name,
       sku = excluded.sku, category = excluded.category,
       -- 어느 채널이든 이 값을 안 채우는 upsert(항상 null)가 다른 채널이 이미 저장해둔 값을
       -- 조용히 지우지 않도록, 이번 upsert가 실제 값을 줄 때만 덮어쓴다(TASKS T16 low_stock_
       -- threshold와 같은 패턴 — T24는 pack_size에도 동일하게 적용).
       low_stock_threshold = coalesce(excluded.low_stock_threshold, products.low_stock_threshold),
       pack_size = coalesce(excluded.pack_size, products.pack_size)`,
    params,
  );
}

async function upsertSalesLinesOn(session: DbSession, rows: SalesLineRow[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.receiptId,
      r.lineNo,
      r.storeId,
      r.variantId,
      r.qty,
      r.gross,
      r.discount,
      r.soldAt.toISOString(),
    );
  }
  await session.query(
    `insert into sales_lines (receipt_id, line_no, store_id, variant_id, qty, gross, discount, sold_at)
     values ${buildValuesPlaceholders(rows.length, 8)}
     on conflict (receipt_id, line_no) do update set
       store_id = excluded.store_id, variant_id = excluded.variant_id,
       qty = excluded.qty, gross = excluded.gross, discount = excluded.discount,
       sold_at = excluded.sold_at`,
    params,
  );
}

async function upsertInventoryOn(session: DbSession, rows: InventoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) params.push(r.storeId, r.variantId, r.inStock, r.updatedAt.toISOString());
  // active(TASKS T31, DATA-002 tombstone) — upsert되는 행은 항상 active=true다. 이 upsert
  // 경로 자체가 "지금 이 소스가 이 행을 현재 상태로 보고한다"는 뜻이라, 이전에 tombstone(비활성)
  // 처리됐던 행이 다시 나타나면 여기서 자동 재활성화된다(별도 reactivate 메서드 불필요).
  await session.query(
    `insert into inventory_levels (store_id, variant_id, in_stock, updated_at, active)
     values ${buildValuesPlaceholders(rows.length, 4, ", true")}
     on conflict (store_id, variant_id) do update set
       in_stock = excluded.in_stock, updated_at = excluded.updated_at, active = true`,
    params,
  );
}

async function appendInventorySnapshotOn(
  session: DbSession,
  runId: string,
  at: Date,
  rows: InventoryRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) params.push(runId, at.toISOString(), r.storeId, r.variantId, r.inStock);
  await session.query(
    `insert into inventory_snapshots (run_id, snapped_at, store_id, variant_id, in_stock)
     values ${buildValuesPlaceholders(rows.length, 5)}
     on conflict (run_id, store_id, variant_id) do update set in_stock = excluded.in_stock`,
    params,
  );
}

async function upsertSalesPeriodAggOn(
  session: DbSession,
  rows: SalesPeriodAggRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.storeId,
      r.variantId,
      r.periodStart.toISOString(),
      r.periodEnd.toISOString(),
      r.soldQty,
    );
  }
  // active(TASKS T31, DATA-002 tombstone) — upsertInventoryOn과 같은 이유로 항상 true.
  await session.query(
    `insert into sales_period_agg (store_id, variant_id, period_start, period_end, sold_qty, active)
     values ${buildValuesPlaceholders(rows.length, 5, ", true")}
     on conflict (store_id, variant_id) do update set
       period_start = excluded.period_start,
       period_end = excluded.period_end,
       sold_qty = excluded.sold_qty,
       active = true`,
    params,
  );
}

/**
 * tombstone(TASKS T31, DATA-002) — `storeIds` 범위 안에서 이번 스캔에 없는 (매장,SKU)
 * `inventory_levels`/`sales_period_agg` 행을 `active=false`로만 표시한다(물리 삭제 없음).
 * `unnest($2::text[], $3::text[])`로 "이번 스캔에 있는 (매장,SKU) 키 집합"을 만들어 그 안에
 * 없는 행만 골라낸다 — present 목록이 비어 있으면(예: 판매이력 있는 행이 이번 스캔에 하나도
 * 없음) `storeIds` 범위의 기존 active 행 전부가 대상이 된다(그 매장들에 대해 이 스캔이
 * "판매이력 없음"을 authoritative하게 보고했다는 뜻이라 올바른 동작이다).
 */
async function deactivateMissingCsvRowsOn(
  session: DbSession,
  params: {
    storeIds: string[];
    presentInventory: { storeId: string; variantId: string }[];
    presentSales: { storeId: string; variantId: string }[];
  },
): Promise<void> {
  if (params.storeIds.length === 0) return;

  await session.query(
    `update inventory_levels
     set active = false
     where store_id = any($1::text[])
       and active = true
       and not exists (
         select 1 from unnest($2::text[], $3::text[]) as present(store_id, variant_id)
         where present.store_id = inventory_levels.store_id
           and present.variant_id = inventory_levels.variant_id
       )`,
    [
      params.storeIds,
      params.presentInventory.map((k) => k.storeId),
      params.presentInventory.map((k) => k.variantId),
    ],
  );

  await session.query(
    `update sales_period_agg
     set active = false
     where store_id = any($1::text[])
       and active = true
       and not exists (
         select 1 from unnest($2::text[], $3::text[]) as present(store_id, variant_id)
         where present.store_id = sales_period_agg.store_id
           and present.variant_id = sales_period_agg.variant_id
       )`,
    [
      params.storeIds,
      params.presentSales.map((k) => k.storeId),
      params.presentSales.map((k) => k.variantId),
    ],
  );
}

async function upsertPurchaseReceiptsOn(
  session: DbSession,
  rows: PurchaseReceiptRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.storeId,
      r.variantId,
      // date 컬럼 — received_at은 시각이 아니라 "그 날짜"라 시간 성분을 버린다(UTC 기준 날짜).
      r.receivedAt.toISOString().slice(0, 10),
      r.receivedQty,
      r.unitCost ?? null,
      r.currency ?? null,
      r.vendor ?? null,
    );
  }
  await session.query(
    `insert into purchase_receipts
       (store_id, variant_id, received_at, received_qty, unit_cost, currency, vendor)
     values ${buildValuesPlaceholders(rows.length, 7)}
     on conflict (store_id, variant_id, received_at) do update set
       received_qty = excluded.received_qty,
       unit_cost = excluded.unit_cost,
       currency = excluded.currency,
       vendor = excluded.vendor`,
    params,
  );
}

/**
 * querySalesAggOn과 대칭 — SalesAggQuery를 그대로 받는다. received_at은 date 컬럼이라
 * `::date`로 캐스트해 기간 경계와 비교한다(SPEC §13 — 사업장 타임존 인지 경계 변환은 이번
 * 스코프 밖, 알려진 단순화로 문서화).
 */
async function queryPurchaseAggOn(session: DbSession, q: SalesAggQuery): Promise<PurchaseAgg[]> {
  const { rows } = await session.query<{
    store_id: string;
    variant_id: string;
    received_qty_raw: string;
  }>(
    `select
       pr.store_id as store_id,
       pr.variant_id as variant_id,
       sum(pr.received_qty)::text as received_qty_raw
     from purchase_receipts pr
     join products p on p.variant_id = pr.variant_id
     where pr.received_at >= $1::date and pr.received_at < $2::date
       and ($3::text is null or pr.store_id = $3)
       and ($4::text is null or p.category = $4)
     group by pr.store_id, pr.variant_id`,
    [q.periodStart.toISOString(), q.periodEnd.toISOString(), q.storeId ?? null, q.category ?? null],
  );
  return rows.map((r) => ({
    storeId: r.store_id,
    variantId: r.variant_id,
    receivedQtyRaw: r.received_qty_raw,
  }));
}

async function getCursorOn(session: DbSession, resource: string): Promise<string | null> {
  const { rows } = await session.query<{ cursor: string | null }>(
    "select cursor from sync_state where resource = $1",
    [resource],
  );
  return rows[0]?.cursor ?? null;
}

async function setCursorOn(
  session: DbSession,
  resource: string,
  watermark: string,
  at: Date,
): Promise<void> {
  await session.query(
    `insert into sync_state (resource, cursor, last_synced_at)
     values ($1, $2, $3)
     on conflict (resource) do update set
       cursor = excluded.cursor, last_synced_at = excluded.last_synced_at`,
    [resource, watermark, at.toISOString()],
  );
}

async function getSyncStateOn(session: DbSession): Promise<SyncStateRow[]> {
  const { rows } = await session.query<{
    resource: string;
    cursor: string | null;
    last_synced_at: string | Date | null;
  }>("select resource, cursor, last_synced_at from sync_state order by resource");
  return rows.map((r) => ({
    resource: r.resource,
    cursor: r.cursor,
    lastSyncedAt: r.last_synced_at === null ? null : new Date(r.last_synced_at),
  }));
}

async function querySalesAggOn(session: DbSession, q: SalesAggQuery): Promise<SalesAgg[]> {
  const { rows } = await session.query<{
    store_id: string;
    variant_id: string;
    name: string;
    category: string | null;
    sold_qty_raw: string;
  }>(
    `select
       sl.store_id as store_id,
       sl.variant_id as variant_id,
       p.name as name,
       p.category as category,
       sum(sl.qty)::text as sold_qty_raw
     from sales_lines sl
     join products p on p.variant_id = sl.variant_id
     where sl.sold_at >= $1 and sl.sold_at < $2
       and ($3::text is null or sl.store_id = $3)
       and ($4::text is null or p.category = $4)
     group by sl.store_id, sl.variant_id, p.name, p.category`,
    [q.periodStart.toISOString(), q.periodEnd.toISOString(), q.storeId ?? null, q.category ?? null],
  );
  return rows.map((r) => ({
    storeId: r.store_id,
    variantId: r.variant_id,
    name: r.name,
    category: r.category,
    soldQtyRaw: r.sold_qty_raw,
  }));
}

/**
 * sales_period_agg는 (store,variant)당 한 행 — 그 행의 period_start/period_end가 곧 "가장
 * 최근 스캔이 CSV에서 읽은 기간"이다(재집계가 아니라 저장된 합계를 그대로 반환). 질의 기간과
 * 저장된 기간이 겹치는 행만 반환한다 — 완전히 다른(겹치지 않는) 기간을 물어봤는데 오래된
 * 스캔 값을 마치 그 기간 데이터인 것처럼 조용히 돌려주지 않기 위해서다. windowDays 등 호출자
 * 쪽 기간 가정과 저장된 기간 길이가 다를 수 있다는 점은 이 함수가 책임지지 않는다(TASKS T17).
 */
async function querySalesPeriodAggOn(session: DbSession, q: SalesAggQuery): Promise<SalesAgg[]> {
  const { rows } = await session.query<{
    store_id: string;
    variant_id: string;
    name: string;
    category: string | null;
    sold_qty_raw: string;
  }>(
    `select
       spa.store_id as store_id,
       spa.variant_id as variant_id,
       p.name as name,
       p.category as category,
       spa.sold_qty::text as sold_qty_raw
     from sales_period_agg spa
     join products p on p.variant_id = spa.variant_id
     where spa.active = true
       and spa.period_start < $2 and spa.period_end > $1
       and ($3::text is null or spa.store_id = $3)
       and ($4::text is null or p.category = $4)`,
    [q.periodStart.toISOString(), q.periodEnd.toISOString(), q.storeId ?? null, q.category ?? null],
  );
  return rows.map((r) => ({
    storeId: r.store_id,
    variantId: r.variant_id,
    name: r.name,
    category: r.category,
    soldQtyRaw: r.sold_qty_raw,
  }));
}

async function queryStockOn(session: DbSession, q: StockQuery): Promise<StockRow[]> {
  const { rows } = await session.query<{
    store_id: string;
    variant_id: string;
    name: string;
    in_stock_raw: string;
    updated_at: string | Date;
  }>(
    `select
       il.store_id as store_id,
       il.variant_id as variant_id,
       p.name as name,
       il.in_stock::text as in_stock_raw,
       il.updated_at as updated_at
     from inventory_levels il
     join products p on p.variant_id = il.variant_id
     where il.active = true
       and ($1::text is null or il.store_id = $1)
       and ($2::text[] is null or il.variant_id = any($2::text[]))
       and ($3::text is null or p.category = $3)`,
    [q.storeId ?? null, q.variantIds ?? null, q.category ?? null],
  );
  return rows.map((r) => ({
    storeId: r.store_id,
    variantId: r.variant_id,
    name: r.name,
    inStockRaw: r.in_stock_raw,
    updatedAt: new Date(r.updated_at),
  }));
}

async function queryStoresOn(session: DbSession, storeId?: string): Promise<StoreRow[]> {
  const { rows } = await session.query<{ id: string; name: string }>(
    "select id, name from stores where ($1::text is null or id = $1) order by id",
    [storeId ?? null],
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * `variantIds`를 생략하면(undefined) 전체, 빈 배열을 주면 빈 결과(`= any('{}')`가 자연스럽게
 * 그렇게 동작한다 — 별도 분기 불필요).
 */
async function queryProductsOn(session: DbSession, variantIds?: string[]): Promise<ProductRow[]> {
  const { rows } = await session.query<{
    variant_id: string;
    item_id: string;
    name: string;
    sku: string | null;
    category: string | null;
    low_stock_threshold: string | null;
    pack_size: string | null;
  }>(
    `select variant_id, item_id, name, sku, category, low_stock_threshold, pack_size
     from products
     where ($1::text[] is null or variant_id = any($1::text[]))
     order by variant_id`,
    [variantIds ?? null],
  );
  return rows.map((r) => ({
    variantId: r.variant_id,
    itemId: r.item_id,
    name: r.name,
    sku: r.sku,
    category: r.category,
    lowStockThreshold: r.low_stock_threshold,
    packSize: r.pack_size,
  }));
}

/**
 * 이중 발송 방지 예약 패턴(DESIGN §11.5): status='sending'은 **항상 새 INSERT로만** 시도한다.
 * `agent_send_log_run_id_active_idx`(run_id당 sending/sent 최대 1건)가 이 INSERT를 원자적
 * 잠금으로 만든다 — 같은 run_id로 이미 sending/sent 행이 있으면 unique violation으로 실패하고,
 * 그걸 원인이 담긴 에러로 다시 던져 재발송을 막는다. status='sent'/'failed'는 이번 실행이 방금
 * 예약한 그 sending 행을 run_id+status='sending'으로 찾아 "같은 행"을 갱신한다 — 그래서
 * status만 보고 아무 기존 행이나 덮어쓰지 않는다(이미 sent인 행을 sending으로 되돌리는 결함을
 * 피한다). status='no_suggestions'/'dry_run'은 발송이 없으므로 예약 대상이 아니며, 실행마다
 * 감사 로그로 새 행을 남긴다.
 */
async function logAgentSendOn(session: DbSession, e: AgentSendEntry): Promise<void> {
  const insertParams = [
    e.runId,
    e.sentAt.toISOString(),
    e.status,
    e.recipient,
    e.subject,
    e.suggestionCount,
    e.messageId,
    e.dryRun,
    e.errorCode,
  ];

  if (e.status === "sent" || e.status === "failed") {
    const { rows } = await session.query<{ id: string }>(
      "select id from agent_send_log where run_id = $1 and status = 'sending' order by id desc limit 1",
      [e.runId],
    );
    const sendingId = rows[0]?.id;
    if (sendingId === undefined) {
      throw new Error(
        `run_id="${e.runId}"에 대한 sending 예약 행이 없어 status='${e.status}'로 갱신할 수 ` +
          "없습니다. logAgentSend()를 status='sending'으로 먼저 호출했는지 확인하세요.",
      );
    }
    await session.query(
      `update agent_send_log set
         sent_at = $2, status = $3, recipient = $4, subject = $5,
         suggestion_count = $6, message_id = $7, dry_run = $8, error_code = $9
       where id = $1`,
      [sendingId, ...insertParams.slice(1)],
    );
    return;
  }

  try {
    await session.query(
      `insert into agent_send_log
         (run_id, sent_at, status, recipient, subject, suggestion_count, message_id, dry_run, error_code)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      insertParams,
    );
  } catch (err) {
    if (e.status === "sending") {
      throw new Error(
        `run_id="${e.runId}"는 이미 발송 중이거나 발송 완료된 실행입니다 — 중복 발송을 막기 위해 ` +
          "새 예약을 거부합니다. 같은 run_id로 재시도하지 마세요.",
        { cause: err },
      );
    }
    throw err;
  }
}

// ── 고정 session에 바인딩된 Warehouse (transaction() 안에서 재사용) ─────────

function buildWarehouseOnSession(session: DbSession): Warehouse {
  return {
    // 이미 트랜잭션 안이므로 새 BEGIN 없이 같은 session으로 fn을 그대로 실행한다.
    transaction: (fn) => fn(buildWarehouseOnSession(session)),
    upsertStores: (rows) => upsertStoresOn(session, rows),
    upsertProducts: (rows) => upsertProductsOn(session, rows),
    upsertSalesLines: (rows) => upsertSalesLinesOn(session, rows),
    upsertInventory: (rows) => upsertInventoryOn(session, rows),
    appendInventorySnapshot: (runId, at, rows) =>
      appendInventorySnapshotOn(session, runId, at, rows),
    upsertSalesPeriodAgg: (rows) => upsertSalesPeriodAggOn(session, rows),
    upsertPurchaseReceipts: (rows) => upsertPurchaseReceiptsOn(session, rows),
    getCursor: (resource) => getCursorOn(session, resource),
    setCursor: (resource, watermark, at) => setCursorOn(session, resource, watermark, at),
    getSyncState: () => getSyncStateOn(session),
    querySalesAgg: (q) => querySalesAggOn(session, q),
    querySalesPeriodAgg: (q) => querySalesPeriodAggOn(session, q),
    queryPurchaseAgg: (q) => queryPurchaseAggOn(session, q),
    queryStock: (q) => queryStockOn(session, q),
    queryStores: (storeId) => queryStoresOn(session, storeId),
    queryProducts: (variantIds) => queryProductsOn(session, variantIds),
    deactivateMissingCsvRows: (params) => deactivateMissingCsvRowsOn(session, params),
    logAgentSend: (e) => logAgentSendOn(session, e),
  };
}

// ── 공개 팩토리 ─────────────────────────────────────────────────────────

export function createPgWarehouse(provider: DbConnectionProvider): Warehouse {
  return {
    async transaction<T>(fn: (tx: Warehouse) => Promise<T>): Promise<T> {
      return withSession(provider, async (session) => {
        await session.query("begin");
        try {
          const tx = buildWarehouseOnSession(session);
          const result = await fn(tx);
          await session.query("commit");
          return result;
        } catch (err) {
          try {
            await session.query("rollback");
          } catch {
            // rollback 자체 실패는 무시 — 아래에서 원본 에러를 던져 원인을 보존한다.
          }
          throw err;
        }
      });
    },
    upsertStores: (rows) => withSession(provider, (session) => upsertStoresOn(session, rows)),
    upsertProducts: (rows) => withSession(provider, (session) => upsertProductsOn(session, rows)),
    upsertSalesLines: (rows) =>
      withSession(provider, (session) => upsertSalesLinesOn(session, rows)),
    upsertInventory: (rows) => withSession(provider, (session) => upsertInventoryOn(session, rows)),
    appendInventorySnapshot: (runId, at, rows) =>
      withSession(provider, (session) => appendInventorySnapshotOn(session, runId, at, rows)),
    upsertSalesPeriodAgg: (rows) =>
      withSession(provider, (session) => upsertSalesPeriodAggOn(session, rows)),
    upsertPurchaseReceipts: (rows) =>
      withSession(provider, (session) => upsertPurchaseReceiptsOn(session, rows)),
    getCursor: (resource) => withSession(provider, (session) => getCursorOn(session, resource)),
    setCursor: (resource, watermark, at) =>
      withSession(provider, (session) => setCursorOn(session, resource, watermark, at)),
    getSyncState: () => withSession(provider, (session) => getSyncStateOn(session)),
    querySalesAgg: (q) => withSession(provider, (session) => querySalesAggOn(session, q)),
    querySalesPeriodAgg: (q) =>
      withSession(provider, (session) => querySalesPeriodAggOn(session, q)),
    queryPurchaseAgg: (q) => withSession(provider, (session) => queryPurchaseAggOn(session, q)),
    queryStock: (q) => withSession(provider, (session) => queryStockOn(session, q)),
    queryStores: (storeId) => withSession(provider, (session) => queryStoresOn(session, storeId)),
    queryProducts: (variantIds) =>
      withSession(provider, (session) => queryProductsOn(session, variantIds)),
    deactivateMissingCsvRows: (params) =>
      withSession(provider, (session) => deactivateMissingCsvRowsOn(session, params)),
    logAgentSend: (e) => withSession(provider, (session) => logAgentSendOn(session, e)),
  };
}
