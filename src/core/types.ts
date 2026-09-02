/**
 * 도메인 타입 + 핵심 인터페이스 (DESIGN.md §4).
 * `core/`는 인터페이스와 순수 계산만 정의한다 — 이 파일에서 외부 IO를 수행하지 않는다.
 */

/**
 * Postgres `numeric` 컬럼의 경계값 표현. pg/PGlite 드라이버는 numeric을 문자열로 반환하며,
 * JS number로 암묵 변환하면 정밀도 손실이 생길 수 있다. 파싱은 core 계산 직전 경계에서
 * 명시적으로 수행한다(CLAUDE.md 구현 해석 보충).
 */
export type Numeric = string;

/** ISO 8601 문자열로 다루는 시각. Loyverse API 원시 응답 경계에서만 사용하고, 이후는 Date로 변환한다. */
export type IsoDateTimeString = string;

// ── 시계 ────────────────────────────────────────────────────────────────

export interface Clock {
  now(): Date;
}

// ── Loyverse API 원시 응답 형태 (LoyverseClient 경계) ─────────────────────

export interface LvStore {
  id: string;
  name: string;
}

export interface LvItemVariant {
  variant_id: string;
  sku: string | null;
}

export interface LvItem {
  id: string;
  item_name: string;
  category_id: string | null;
  variants: LvItemVariant[];
}

export interface LvReceiptLineItem {
  variant_id: string;
  item_id: string;
  quantity: number;
  gross_total_money: number;
  total_discount: number;
}

export interface LvReceipt {
  receipt_number: string;
  store_id: string;
  /** "SALE" | "REFUND". 환불 라인의 quantity는 양수(환불한 수량) — 부호 반전은 ETL에서 한다. */
  receipt_type: "SALE" | "REFUND";
  /** REFUND 영수증에서만 원 판매 영수증 번호. SALE에서는 null. */
  refund_for: string | null;
  created_at: IsoDateTimeString;
  /** 증분 동기화 watermark의 기준(DESIGN §11.1). receipt_date가 아니라 이 필드로 필터링한다. */
  updated_at: IsoDateTimeString;
  receipt_date: IsoDateTimeString;
  /** 취소되지 않았으면 null. 취소된 영수증은 집계에서 제외한다(ETL 정책, SPEC §9). */
  cancelled_at: IsoDateTimeString | null;
  line_items: LvReceiptLineItem[];
}

export interface LvInventoryLevel {
  variant_id: string;
  store_id: string;
  in_stock: number;
  updated_at: IsoDateTimeString;
}

export interface Page<T> {
  items: T[];
  /**
   * API 페이지네이션 토큰(pageCursor). 한 리소스의 모든 페이지를 처리하는 동안만
   * 메모리에서 사용하고 DB(sync_state)에는 저장하지 않는다 — watermark와 다른 개념이다.
   */
  cursor: string | null;
}

/**
 * Loyverse REST API 전용 경계 — 이름뿐 아니라 반환 타입(LvReceipt의 receipt_number/
 * cancelled_at/receipt_type 등)까지 Loyverse 고유 구조다. `etl/sync.ts`의 영수증 단위
 * 증분 동기화(watermark = 마지막 영수증 updated_at) 모델 전체가 이 계약을 전제한다.
 *
 * CSV/Excel 채널(TASKS T12 이후)은 이 인터페이스를 구현하지 않는다 — CSV 파일에는 영수증이
 * 없고 "기간 합계 판매수량" 하나만 있어 이 계약에 억지로 맞지 않는다. 대신 CSV 경로
 * (`folderScan.ts`, TASKS T18)는 `Warehouse`에 직접 쓴다(SalesPeriodAggRow 등 도메인
 * 행 타입으로). `LoyverseClient`를 소스 중립적 이름으로 일반화하지 않은 것은 의도적이다 —
 * Loyverse 고유 구조를 정직하게 반영하는 이름이 오히려 명확하다.
 */
export interface LoyverseClient {
  listStores(): Promise<LvStore[]>;
  listItems(cursor?: string): Promise<Page<LvItem>>;
  /**
   * sinceISO는 실제 API의 `updated_at_min` 질의 파라미터에 대응한다 — `receipt_date`가
   * 아니라 `updated_at` 기준으로 필터링한다. 과거 영수증이 나중에 환불·취소되어 갱신돼도
   * 다음 증분 동기화가 이를 놓치지 않는다(DESIGN §11.1).
   */
  listReceipts(sinceISO: string, cursor?: string): Promise<Page<LvReceipt>>;
  listInventory(cursor?: string): Promise<Page<LvInventoryLevel>>;
}

// ── 웨어하우스 도메인 행 (migrations/001_init.sql과 대응) ──────────────────

export interface StoreRow {
  id: string;
  name: string;
}

export interface ProductRow {
  variantId: string;
  itemId: string;
  name: string;
  sku: string | null;
  category: string | null;
}

export interface SalesLineRow {
  receiptId: string;
  lineNo: number;
  storeId: string;
  variantId: string;
  /** 환불은 음수. 원시 순판매량 — max(0, ·) 정규화는 core/metrics.ts에서 계산 직전에 적용한다. */
  qty: Numeric;
  gross: Numeric;
  discount: Numeric;
  soldAt: Date;
}

export interface InventoryRow {
  storeId: string;
  variantId: string;
  /** 원시 현재고. 음수는 데이터 품질 경고 대상 — 계산 시 0으로 clamp(SPEC §9), 저장은 원시값. */
  inStock: Numeric;
  updatedAt: Date;
}

/**
 * CSV/Excel 채널의 기간합계 판매 데이터(SPEC §12, TASKS T12). Loyverse의 SalesLineRow(영수증
 * 라인 단위)와 달리 "이 기간 동안 총 N개 팔렸다"는 집계값 하나뿐이다 — CSV 파일에는 영수증이
 * 없다. sales_lines에 가짜 영수증으로 끼워 넣지 않고 별도로 저장한다.
 */
export interface SalesPeriodAggRow {
  storeId: string;
  variantId: string;
  /** 이 판매수량이 어느 기간의 합인지 — 반개방 구간이 아니라 CSV가 준 값 그대로(포함 경계). */
  periodStart: Date;
  periodEnd: Date;
  /** 기간 내 판매수량 합계. CSV는 환불을 별도 표현하지 않으므로 음수 불가. */
  soldQty: Numeric;
}

export interface SalesAggQuery {
  storeId?: string;
  category?: string;
  /** 반개방 구간 [periodStart, periodEnd) — 사업장 타임존 기준으로 계산된 UTC 경계값. */
  periodStart: Date;
  periodEnd: Date;
}

export interface SalesAgg {
  storeId: string;
  variantId: string;
  name: string;
  category: string | null;
  /** 기간 내 원시 순판매량 합계(환불 포함, 음수 가능). */
  soldQtyRaw: Numeric;
}

export interface StockQuery {
  storeId?: string;
  variantIds?: string[];
  /**
   * 카테고리 필터(T9 추가). sell_through 도구가 category로 필터링할 때, 판매 없이 재고만
   * 있는 다른 카테고리 품목이 category=null로 결과에 새는 것을 막으려면 queryStock 자체가
   * 카테고리로 걸러야 한다 — computeSellThrough가 만드는 결합 결과의 category는 salesAgg
   * 쪽 값만 신뢰할 수 있고 재고 전용 행에는 카테고리가 없기 때문이다.
   */
  category?: string;
}

export interface StockRow {
  storeId: string;
  variantId: string;
  name: string;
  /** 원시 현재고. 음수 가능 — 데이터 품질 경고 대상(SPEC §9). */
  inStockRaw: Numeric;
  updatedAt: Date;
}

// ── 에이전트 발송 로그 (DESIGN §11.5) ──────────────────────────────────────

export type AgentSendStatus = "no_suggestions" | "dry_run" | "sending" | "sent" | "failed";

export interface AgentSendEntry {
  /**
   * 멱등 키이자 예약(reservation) 키. `sending`/`sent`는 run_id당 최대 1건만 허용된다
   * (agent_send_log_run_id_active_idx). T8은 provider.send() 호출 **전에** 반드시
   * status='sending'으로 이 행을 먼저 커밋해 발송권을 예약해야 한다 — insert가 unique
   * violation으로 실패하면 이미 발송 중/완료된 것이므로 재발송하지 않는다(DESIGN §11.5).
   */
  runId: string;
  sentAt: Date;
  status: AgentSendStatus;
  /** 미발송 상태(no_suggestions 등)에서는 null. */
  recipient: string | null;
  subject: string | null;
  suggestionCount: number;
  messageId: string | null;
  dryRun: boolean;
  errorCode: string | null;
}

// ── 동기화 상태 (T9 sync_status 도구용) ──────────────────────────────────

export interface SyncStateRow {
  resource: string;
  /** sync_state.cursor(=watermark). receipts는 마지막 영수증 updated_at — 실제 동기화 실행
   * 시각과 다를 수 있다(DESIGN §11.1). stores/items/inventory는 lastSyncedAt과 같은 값이다. */
  cursor: string | null;
  lastSyncedAt: Date | null;
}

// ── 웨어하우스 인터페이스 ───────────────────────────────────────────────

export interface Warehouse {
  /**
   * 한 리소스의 data upsert와 watermark(setCursor) 갱신을 하나의 트랜잭션으로 커밋한다
   * (DESIGN §11.1). `fn` 내부에서 사용하는 `tx`는 같은 트랜잭션에 묶인 Warehouse이며,
   * `fn`이 예외를 던지면 그 안에서 호출한 모든 쓰기가 롤백된다 — 데이터는 적재됐는데
   * watermark만 안 남거나 그 반대인 상태가 구조적으로 나오지 않는다. 구현체(T4)는
   * 실제 BEGIN/COMMIT/ROLLBACK을 제공해야 한다.
   */
  transaction<T>(fn: (tx: Warehouse) => Promise<T>): Promise<T>;

  upsertStores(rows: StoreRow[]): Promise<void>;
  upsertProducts(rows: ProductRow[]): Promise<void>;
  /** PK(receipt_id, line_no) 충돌 시 갱신 — 멱등. */
  upsertSalesLines(rows: SalesLineRow[]): Promise<void>;
  upsertInventory(rows: InventoryRow[]): Promise<void>;
  appendInventorySnapshot(runId: string, at: Date, rows: InventoryRow[]): Promise<void>;
  /**
   * CSV/Excel 채널의 기간합계 판매 upsert(SPEC §12, TASKS T12) — PK(store_id, variant_id),
   * 매 스캔마다 최신값으로 교체한다(inventory_levels와 같은 모델, 이력 누적 아님).
   * sales_lines(영수증 라인 단위)와는 별도 테이블이다.
   */
  upsertSalesPeriodAgg(rows: SalesPeriodAggRow[]): Promise<void>;
  /** sync_state.cursor(=watermark) 조회. API 페이지 토큰이 아니다. */
  getCursor(resource: string): Promise<string | null>;
  setCursor(resource: string, watermark: string, at: Date): Promise<void>;
  /** 전 리소스의 cursor+last_synced_at 목록(T9 `sync_status` 도구용). resource 오름차순. */
  getSyncState(): Promise<SyncStateRow[]>;
  /** 고정 파라미터라이즈드 SQL만 사용한다. */
  querySalesAgg(q: SalesAggQuery): Promise<SalesAgg[]>;
  /**
   * sales_period_agg를 querySalesAgg와 같은 SalesAgg 반환 형태로 조회한다(TASKS T12) —
   * core/metrics.ts의 computeSellThrough/computeReorderMetrics는 SalesAgg[]만 받으므로
   * 소스가 sales_lines 집계든 CSV 기간합계든 core 계층 변경 없이 그대로 재사용된다.
   */
  querySalesPeriodAgg(q: SalesAggQuery): Promise<SalesAgg[]>;
  queryStock(q: StockQuery): Promise<StockRow[]>;
  /**
   * 매장 목록/이름 조회(T8에서 추가) — 재주문 리포트의 지점별 표 제목(storeName)과
   * 존재하지 않는 store_id 필터 검증(T9 MCP 도구 공용)에 쓴다. storeId를 주면 그 매장만.
   */
  queryStores(storeId?: string): Promise<StoreRow[]>;
  logAgentSend(e: AgentSendEntry): Promise<void>;
}

// ── 알림 (sheet_mcp NotificationProvider 이식 대상과 동일 시그니처) ─────────

export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  messageId: string;
}

export interface NotificationProvider {
  readonly channel: "email";
  send(msg: OutboundMessage): Promise<SendResult>;
}

// ── 재주문 리포트 + 요약 (LLM 경계) ─────────────────────────────────────

export interface ReorderLineItem {
  variantId: string;
  name: string;
  /** 이미 max(0, ·)로 정규화된 표시용 값. */
  inStock: number;
  avgDailySales: number;
  /** null = 무한(∞) 커버 — 판매 없음. */
  daysOfCover: number | null;
  reorderQty: number;
}

export interface ReorderStoreSection {
  storeId: string;
  storeName: string;
  items: ReorderLineItem[];
}

export interface ReorderReport {
  generatedAt: Date;
  timezone: string;
  dataLastSyncedAt: Date | null;
  stores: ReorderStoreSection[];
  warnings: string[];
}

export interface Summarizer {
  /** 2~3문장 요약 문구만 반환한다. 수치를 새로 만들지 않고 입력 표의 사실만 서술하도록 프롬프트에 명시한다. */
  summarize(input: ReorderReport): Promise<string>;
}
