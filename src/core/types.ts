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
  receipt_date: IsoDateTimeString;
  line_items: LvReceiptLineItem[];
}

export interface LvInventoryLevel {
  variant_id: string;
  store_id: string;
  in_stock: number;
}

export interface Page<T> {
  items: T[];
  /**
   * API 페이지네이션 토큰(pageCursor). 한 리소스의 모든 페이지를 처리하는 동안만
   * 메모리에서 사용하고 DB(sync_state)에는 저장하지 않는다 — watermark와 다른 개념이다.
   */
  cursor: string | null;
}

export interface LoyverseClient {
  listStores(): Promise<LvStore[]>;
  listItems(cursor?: string): Promise<Page<LvItem>>;
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
  /** sync_state.cursor(=watermark) 조회. API 페이지 토큰이 아니다. */
  getCursor(resource: string): Promise<string | null>;
  setCursor(resource: string, watermark: string, at: Date): Promise<void>;
  /** 고정 파라미터라이즈드 SQL만 사용한다. */
  querySalesAgg(q: SalesAggQuery): Promise<SalesAgg[]>;
  queryStock(q: StockQuery): Promise<StockRow[]>;
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
