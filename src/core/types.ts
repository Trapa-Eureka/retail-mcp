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
  /**
   * 품목별 저재고 임계치 override(SPEC §12, TASKS T16) — CSV/Excel 채널 전용, Loyverse
   * 경로는 항상 undefined다. 실제로 읽어 임계치 판정에 쓰는 것은 T17의 몫이다.
   *
   * **세 값의 의미가 서로 다르다(006 DATA-005, TASKS T33)** — upsert가 어떻게 반영할지가
   * 값마다 다르므로 셋을 섞어 쓰지 않는다:
   * - `undefined` = "이 upsert는 이 필드에 대해 아무 정보가 없다"(CSV/Excel이면 파일에 이
   *   컬럼 자체가 없음, 구버전 템플릿과의 하위 호환) → 기존 DB 값을 그대로 둔다.
   * - `null` = "명시적으로 지운다"(CSV/Excel이면 컬럼은 있지만 이 행의 셀이 비어 있음) →
   *   기존 값이 있어도 null로 덮어쓴다.
   * - 값 = 이 값으로 설정.
   *
   * `pgWarehouse.ts`의 `upsertProductsOn`이 이 구분을 실제로 반영한다 — 배치(한 파일) 전체에
   * 걸쳐 "어느 한 행이라도 undefined가 아니면" 그 필드는 이번 upsert가 소유권을 가진 것으로
   * 보고 컬럼 전체를 덮어쓴다(컬럼 존재 여부는 파일 헤더 단위 속성이라 한 파일 안에서
   * 행마다 갈리지 않는다 — 갈린다면 전부 undefined이거나 전부 아니거나 둘 중 하나).
   */
  lowStockThreshold?: Numeric | null;
  /**
   * 공급자가 출고하는 최소 팩/박스 단위(SPEC §14, "팩 단위 반올림"). 없으면 낱개 매입이
   * 가능하다는 뜻 — 재주문 제안량을 반올림하지 않는다. lowStockThreshold와 달리 CSV/Excel
   * 채널 전용이 아니다(소스 중립적) — 어느 채널이 채우든 상관없다. 실제로 이 값을 채워
   * 반올림에 쓰는 것은 core/metrics.ts의 roundToPackMultiple/applyPackRounding 몫이다.
   *
   * `undefined`/`null`/값 세 상태의 의미는 `lowStockThreshold`와 동일하다(006 DATA-005,
   * TASKS T33) — 위 문서 참고.
   */
  packSize?: Numeric | null;
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

/**
 * SCM 시트 연동(SPEC §13)의 입고 실적 한 건. "발주"(미입고) 상태는 다루지 않는다 — 이미
 * 입고된 것만 기록한다. 같은 (storeId, variantId, receivedAt)에 여러 건이 있으면 마지막
 * 값으로 덮어써진다(합산 아님 — v0.1 한계, 원본 시트에 이벤트 순번이 없다).
 */
export interface PurchaseReceiptRow {
  storeId: string;
  variantId: string;
  receivedAt: Date;
  /** 입고 수량. 음수 불가(반품입고는 v0.1 스코프 밖). */
  receivedQty: Numeric;
  unitCost?: Numeric | null;
  currency?: string | null;
  vendor?: string | null;
}

/**
 * 기간 내 입고수량 합계 — querySalesAgg/querySalesPeriodAgg가 반환하는 SalesAgg와 같은
 * 모양으로 맞춰, core/metrics.ts의 재고 정합성 계산이 판매·입고 두 집계를 대칭적으로
 * 다룰 수 있게 한다(SPEC §13).
 */
export interface PurchaseAgg {
  storeId: string;
  variantId: string;
  /** 기간 내 입고수량 합계(원시값, 음수 없음). */
  receivedQtyRaw: Numeric;
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

/**
 * `unchanged`(TASKS T31, DATA-003) — CSV/Excel 지점 스캔에서 파일 content hash가 마지막
 * 발송 시점과 같고 하루 다이제스트 상한(24시간)에도 안 걸리면 이 상태로 종료한다(발송·
 * 요약·스냅샷 재작성 없이 조용히). Loyverse 경로(agent/reorder.ts)는 이 상태를 쓰지 않는다.
 */
/**
 * `unknown`(007 OPS-004, TASKS T34) — 발송 요청이 HTTP 응답을 받기 전에 실패해(타임아웃,
 * 연결 후 소켓 끊김 등) "이미 발송됐을 수도, 안 됐을 수도" 있는 경우 전용 — `failed`(확실히
 * 실패: HTTP 오류 응답, 또는 DNS 실패/연결 거부처럼 연결이 성립조차 안 된 경우)와 구분한다
 * (SR2-MAIL-002, 2차 적대적 검수 — 예전엔 타임아웃만 unknown이었다). `NotificationProvider`가
 * 이 애매함을 감지하면 `AmbiguousSendError`(`.name`)를 던지고, 에이전트가 그걸 보고
 * `status: "unknown"`으로 기록한다. 사람이 발송처 대시보드로 실제 발송 여부를 확인한 뒤
 * 재시도 여부를 판단해야 한다 — 자동 재시도 로직은 이 프로젝트에 없다(그 자체가 정책).
 */
export type AgentSendStatus =
  "no_suggestions" | "dry_run" | "sending" | "sent" | "failed" | "unchanged" | "unknown";

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
  /**
   * SCM 시트 연동의 입고 실적 upsert(SPEC §13). 같은 (storeId, variantId, receivedAt)는
   * 마지막 값으로 갱신된다.
   */
  upsertPurchaseReceipts(rows: PurchaseReceiptRow[]): Promise<void>;
  /**
   * querySalesAgg와 대칭인 입고 집계 조회 — SalesAggQuery를 그대로 재사용한다(같은 반개방
   * 기간·매장·카테고리 필터 개념).
   */
  queryPurchaseAgg(q: SalesAggQuery): Promise<PurchaseAgg[]>;
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
  /**
   * 상품 목록 조회(T25) — `sales_lines`/`inventory_levels` 조인만으로는 노출되지 않는
   * `ProductRow` 전체 필드(특히 `packSize`, SPEC §14)를 읽어와야 하는 곳(예: 재주문 리포트의
   * 팩 단위 반올림)에 쓴다. `variantIds`를 생략하면 전체, 빈 배열이면 빈 결과.
   */
  queryProducts(variantIds?: string[]): Promise<ProductRow[]>;
  /**
   * CSV/Excel authoritative 스캔에서 이번 파일에 없는 (매장,SKU) `inventory_levels`/
   * `sales_period_agg` 행을 비활성화한다(tombstone, DATA-002, TASKS T31) — 물리 삭제 없음,
   * `active=false`로만 표시하고 이력은 보존한다. `queryStock`/`querySalesPeriodAgg`는
   * `active=true` 행만 반환한다. 다시 파일에 나타나면 `upsertInventory`/
   * `upsertSalesPeriodAgg`(항상 `active=true`로 쓴다)가 자동으로 재활성화한다.
   * `storeIds`는 이번 스캔이 대표하는 매장 범위(tombstone 판정 경계) — 그 밖의 매장 데이터는
   * 절대 건드리지 않는다(본사 통합 모드의 지점별 독립 트랜잭션 원칙과 일치). `presentInventory`/
   * `presentSales`는 이번 스캔에서 실제로 파싱된 (매장,SKU) 키 — 재고는 모든 행이, 판매는
   * 판매이력 있는 행만 해당한다(두 세트가 다를 수 있다).
   */
  deactivateMissingCsvRows(params: {
    storeIds: string[];
    presentInventory: { storeId: string; variantId: string }[];
    presentSales: { storeId: string; variantId: string }[];
  }): Promise<void>;
  logAgentSend(e: AgentSendEntry): Promise<void>;

  /**
   * 보존 기간 정책(007 OPS-005, TASKS T34) — `snapped_at`/`sent_at`이 `before`보다 오래된
   * 행을 지운다(또는 `dryRun`이면 지울 대상 행 수만 센다). `inventory_snapshots`/
   * `agent_send_log`는 감사·로그 테이블이지 가드레일 4의 "비즈니스 데이터"(stores/products/
   * sales/inventory)가 아니다 — `scripts/cleanup.ts`(사람 전용 실행) 용도로만 노출한다.
   * 삭제(또는 셀 대상) 행 수를 반환한다.
   */
  deleteOldInventorySnapshots(before: Date, opts?: { dryRun?: boolean }): Promise<number>;
  deleteOldAgentSendLog(before: Date, opts?: { dryRun?: boolean }): Promise<number>;
}

// ── explore_sql (v0.2 대기열, 가드레일 4 예외 — DESIGN §6이 이름으로 미리 예고해둔 것) ──────
//
// 나머지 Warehouse 메서드는 전부 파라미터라이즈드 고정 쿼리다. explore_sql은 유일하게 사용자가
// 임의 SQL 텍스트를 주는 도구라 별도 인터페이스로 분리했다 — Warehouse 계약("고정 쿼리만")을
// 이 하나 때문에 흐리지 않기 위해서다. 구현은 adapters/exploreSqlExecutor.ts, 진짜 방어선(BEGIN
// READ ONLY 트랜잭션)은 그 파일의 문서 주석 참고.

export interface ExploreSqlOptions {
  /** 결과 최대 행 수. 기본 200, 최대 1000(초과 요청은 자동으로 잘린다, 에러 아님). */
  limit?: number;
  /** 쿼리 최대 실행 시간(ms). 기본 5000, 최대 30000. */
  timeoutMs?: number;
}

export interface ExploreSqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** limit에 걸려 일부만 반환했으면 true. */
  truncated: boolean;
  timeoutMs: number;
}

export interface ExploreSqlExecutor {
  execute(sql: string, opts?: ExploreSqlOptions): Promise<ExploreSqlResult>;
}

// ── 알림 (sheet_mcp NotificationProvider 이식 대상과 동일 시그니처) ─────────

export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * 007 OPS-004(TASKS T34) — 이 발송 시도를 식별하는 안정적 키(에이전트가 `runId`를 그대로
   * 준다). Resend는 `Idempotency-Key` 헤더로 24시간 내 같은 키의 재요청을 중복 발송 없이
   * dedupe한다(resend.com API 문서 확인, 2026-09-03) — 타임아웃 후 사람이 같은 runId로
   * 수동 재시도해도 실제로는 한 통만 나간다. Provider가 지원하지 않으면(예: MockNotification
   * Provider) 그냥 무시해도 된다.
   */
  idempotencyKey?: string;
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
  /**
   * 팩 단위 반올림(SPEC §14, TASKS T24/T25) — `ProductRow.packSize`가 없으면(낱개 매입
   * 가능) `finalOrderQty === reorderQty`이고 `packSize`/`packCount`는 null.
   */
  packSize: number | null;
  /** 실제 발주 가능한 수량(포장수량 배수로 올림). packSize가 없으면 reorderQty와 같다. */
  finalOrderQty: number;
  /** 발주할 팩(박스) 개수. packSize가 없으면 null. */
  packCount: number | null;
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
