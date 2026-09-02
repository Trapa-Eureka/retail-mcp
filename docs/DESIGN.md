# DESIGN — retail-mcp v0.1

이 문서가 구현의 진실의 원천이다. 코드와 다르면 문서 기준으로 코드를 고치고, 설계 변경은 문서 수정이 먼저다.

## 1. 아키텍처

```
                    Claude Code / Desktop            cron (월 07:00 등)
                          │ (MCP stdio)                    │
                          ▼                                ▼
                    src/server.ts                   src/agent/reorder.ts
                    (도구 6종 등록만)                (오케스트레이션만)
                          │                                │
                          └────────────┬───────────────────┘
                                       ▼
                             core/metrics.ts  ← 두 경로가 같은 함수를 사용
                             core/etl 변환 (순수)
                                       │
        ┌──────────────┬───────────────┼─────────────────┬──────────────┐
        ▼              ▼               ▼                 ▼              ▼
  LoyverseClient   Warehouse      NotificationProvider  Summarizer   Clock
  adapters/        adapters/      (sheet_mcp 이식:      (Claude API   │
  loyverseClient   pgWarehouse     resendProvider)       요약 전용)    │
  mocks/fixture    tests: PGlite   mocks/mock            mocks/fixed  mocks/fixed
```

원칙: `core/`는 인터페이스와 순수 계산만. MCP 서버와 에이전트는 조립 계층이라 로직이 없다. 두 진입점이 같은 core를 쓰므로 "도구로 본 숫자 = 리포트의 숫자"가 구조적으로 보장된다.

## 2. 웨어하우스 스키마 (migrations/001_init.sql)

```sql
create table stores (
  id text primary key, name text not null
);
create table products (           -- Loyverse variant 단위로 평탄화
  variant_id text primary key, item_id text not null,
  name text not null, sku text, category text
);
create table sales_lines (        -- 영수증 라인 단위
  receipt_id text not null, line_no int not null,
  store_id text not null references stores(id),
  variant_id text not null references products(variant_id),
  qty numeric not null,           -- 환불은 음수
  gross numeric not null, discount numeric not null default 0,
  sold_at timestamptz not null,
  primary key (receipt_id, line_no)
);
create index on sales_lines (store_id, variant_id, sold_at);
create table inventory_levels (   -- 현재고 (upsert로 최신 유지)
  store_id text not null references stores(id),
  variant_id text not null references products(variant_id),
  in_stock numeric not null, updated_at timestamptz not null,
  primary key (store_id, variant_id)
);
create table inventory_snapshots ( -- 동기화 시마다 적재: 시계열의 시작점
  snapped_at timestamptz not null,
  store_id text not null, variant_id text not null, in_stock numeric not null,
  primary key (snapped_at, store_id, variant_id)
);
create table sync_state (
  resource text primary key,       -- receipts | items | inventory | stores
  cursor text, last_synced_at timestamptz
);
create table agent_send_log (
  id bigserial primary key, sent_at timestamptz not null,
  recipient text not null, subject text not null,
  suggestion_count int not null, message_id text, dry_run boolean not null
);
```

## 3. 지표 수식 (core/metrics.ts — SPEC §2와 동일해야 함)

```
sellThrough(v, 기간)   = soldQty / (soldQty + endStock)        // soldQty+endStock=0 → null(신규/무재고 표기)
avgDailySales(v, 창N)  = 최근 N일 soldQty / N                   // 기본 N=28, 달력일
daysOfCover(v)         = inStock / avgDailySales                // avg=0 → Infinity 표기
stockoutRisk(v)        = daysOfCover < leadTime + safetyDays    // 기본 7 + 3
reorderQty(v)          = max(0, ceil(targetCover*avgDaily - inStock))  // 기본 targetCover=21
```

전부 순수 함수: `(rows: SalesAgg[], stock: StockRow[], opts) → MetricRow[]`. DB 접근 없음, Date는 `Clock` 주입.

## 4. 핵심 인터페이스 (core/types.ts)

```ts
export interface LoyverseClient {
  listStores(): Promise<LvStore[]>;
  listItems(cursor?: string): Promise<Page<LvItem>>;
  listReceipts(sinceISO: string, cursor?: string): Promise<Page<LvReceipt>>;
  listInventory(cursor?: string): Promise<Page<LvInventoryLevel>>;
}
export interface Warehouse {
  // 한 리소스의 data upsert + watermark 갱신을 한 트랜잭션으로 커밋한다 (§11.1).
  // fn 안에서 예외가 나면 fn이 사용한 tx의 모든 쓰기가 롤백된다. 구현체(T4)는 실제
  // BEGIN/COMMIT/ROLLBACK을 제공해야 한다.
  transaction<T>(fn: (tx: Warehouse) => Promise<T>): Promise<T>;
  upsertStores(rows: StoreRow[]): Promise<void>;
  upsertProducts(rows: ProductRow[]): Promise<void>;
  upsertSalesLines(rows: SalesLineRow[]): Promise<void>;      // PK 충돌 시 갱신 (멱등)
  upsertInventory(rows: InventoryRow[]): Promise<void>;
  appendInventorySnapshot(runId: string, at: Date, rows: InventoryRow[]): Promise<void>;
  getCursor(resource: string): Promise<string | null>;        // sync_state.cursor(=watermark) 조회
  setCursor(resource: string, watermark: string, at: Date): Promise<void>;
  getSyncState(): Promise<SyncStateRow[]>;                    // 전 리소스 cursor+last_synced_at(T9 추가)
  querySalesAgg(q: SalesAggQuery): Promise<SalesAgg[]>;       // 고정 파라미터라이즈드 SQL
  queryStock(q: StockQuery): Promise<StockRow[]>;
  queryStores(storeId?: string): Promise<StoreRow[]>;         // 매장명 조회(T8 추가) — 리포트/필터검증용
  logAgentSend(e: AgentSendEntry): Promise<void>;
}
export interface NotificationProvider {  // sheet_mcp와 동일 시그니처 (이식)
  readonly channel: "email"; send(msg: OutboundMessage): Promise<SendResult>;
}
export interface Summarizer {            // LLM 경계 — 문구만
  summarize(input: ReorderReport): Promise<string>;  // 2~3문장, 수치 생성 금지 프롬프트
}
export interface Clock { now(): Date }
```

## 5. ETL (src/etl/sync.ts)

1. `stores` → `items`(variants 평탄화) → `receipts`(증분: `sinceISO = cursor`, 라인 분해, 환불은 음수 qty) → `inventory`(전량 upsert + 스냅샷 append)
2. 커서: receipts는 마지막 `created_at`(또는 API가 주는 cursor)을 `sync_state`에 저장. **재실행 멱등**: 전 테이블 PK upsert.
3. 페이지네이션·레이트리밋: 페이지 단위 순차 처리, 429 시 지수 백오프. 부분 실패 시 해당 리소스 커서를 갱신하지 않아 다음 실행에서 재시도된다.
4. LLM 개입 없음 — 전 과정 결정론.

## 6. MCP 도구 (src/server.ts, zod 스키마)

| 도구 | 입력(기본값) | 반환 |
|---|---|---|
| `sell_through` | store_id?, category?, period_days=30, order=asc\|desc(기본값 T9 확정: desc), top=20 | 품목별 근사 셀스루 표 (근사식 각주 포함) |
| `inventory_status` | store_id?, below_days_cover? | 현재고 + 커버일수 |
| `stockout_risk` | store_id?, lead_time_days=7, safety_days=3 | 위험 품목 + 예상 소진일(오늘+커버일수, YYYY-MM-DD) |
| `reorder_suggestions` | store_id?, target_days_cover=21, lead_time_days=7 | 제안 수량 표 — **에이전트와 동일 함수**(`agent/reorder.ts`의 `buildReorderReport()`를 그대로 호출) |
| `sync_now` | resources?=[all] | 동기화 실행 결과 요약 — 동시 호출은 advisory lock으로 하나만 실행, 나머지는 즉시 오류 |
| `sync_status` | — | 리소스별 커서·마지막 동기화 시각 |

질의 도구는 읽기 전용이며 고정 쿼리만 사용한다. 자유 SQL은 v0.2(`explore_sql`, 읽기 전용 롤 전제).

**구현 정정(T9)**: `sell_through`의 `queryStock`에 `category` 필터를 추가했다 — 카테고리로 필터링할
때 판매 없이 재고만 있는 다른 카테고리 품목이 `computeSellThrough`의 결합 결과에서
`category: null`로 새어 들어와 필터를 무력화하는 결함을 막기 위함이다(`StockQuery.category`,
`core/types.ts`). `Warehouse.getSyncState()`(전 리소스 cursor+last_synced_at)를 추가해
`sync_status`와 신선도 판정(`core/freshness.ts`)에 쓴다.

## 7. 재주문 에이전트 (src/agent/reorder.ts)

```
로드 opts → sync_now(선택: --sync 플래그) → reorderSuggestions(core)
→ 제안 0건이면 로그만 남기고 종료 (발송 없음)
→ 리포트 조립: 지점별 표(품목·현재고·커버일수·제안량) = 결정론
→ Summarizer.summarize(표 데이터) = LLM 문구 2~3문장 (표 아래 삽입)
→ SEND_MODE=live && --confirm 일 때만 provider.send, 아니면 dry-run 출력
→ agent_send_log 기록
```

LLM 실패 시 요약 없이 표만으로 발송한다(요약은 부가물, 발송을 막지 않는다).

## 8. 환경변수 (.env.example로 커밋)

```
DATABASE_URL=            # Neon/Supabase Postgres
LOYVERSE_API_TOKEN=
SEND_MODE=dry_run        # dry_run | live
RESEND_API_KEY=
MAIL_FROM=
REPORT_RECIPIENT=
ANTHROPIC_API_KEY=       # 요약 전용
```

## 9. Claude Code 연결

```bash
claude mcp add retail-mcp --scope project -- npx tsx src/server.ts
```

`.mcp.json`은 레포에 커밋, 시크릿은 .env/셸 환경으로. 연결 확인은 Claude Code 내 `/mcp`.

## 10. 디렉터리 구조 (목표)

```
retail-mcp/
  CLAUDE.md  README.md  .mcp.json  .env.example
  docs/  migrations/  fixtures/loyverse/  scripts/smoke.ts
  src/{core,etl,adapters,mocks,agent,mcp}/  src/server.ts   # mcp/ = MCP 도구 6종 로직(T9), server.ts는 등록만
  tests/
```

## 11. 설계 명확화 (구현 시 필수)

### 11.1 증분 동기화와 원자성

- 외부 API의 페이지 토큰(`pageCursor`)과 다음 실행의 증분 시작점(`watermark`)을 분리한다. `sync_state.cursor`에는 **완료된 리소스의 watermark만** 저장하며 페이지 토큰은 저장하지 않는다.
- 한 리소스의 모든 페이지를 staging/트랜잭션 안에서 처리하고, 데이터 upsert와 watermark 갱신을 같은 트랜잭션에서 커밋한다. 중간 페이지 실패 시 해당 리소스의 데이터와 watermark를 롤백한 뒤 이전 watermark부터 재시도한다. 이 원자성은 `Warehouse.transaction(fn)`으로 표현한다 — ETL(T7)은 upsert류와 `setCursor`를 반드시 같은 `fn` 안에서, 전달받은 `tx`로만 호출한다.
- `receipts` watermark는 `(updated_at, receipt_id)`처럼 동률을 안정적으로 재조회할 수 있는 경계를 사용한다. API가 단일 시각만 지원하면 경계 시각을 포함해 재조회하고 PK upsert로 중복을 제거한다.
- 리소스 순서는 의존성 때문에 유지하되, 앞 리소스 성공과 뒤 리소스 실패를 전체 성공으로 보고하지 않는다. 결과에 리소스별 성공/실패와 마지막 성공 시각을 담는다.

### 11.2 스냅샷과 실행 식별자

- 한 동기화 실행에서 고정한 `runId`와 `snappedAt`을 모든 재고 행에 공통 사용한다. 동일 시각 재실행 충돌을 피하도록 실제 마이그레이션에는 `run_id`를 추가하거나 PK를 `(run_id, store_id, variant_id)`로 정의한다.
- `appendInventorySnapshot`과 현재고 upsert는 같은 트랜잭션에서 처리한다(`Warehouse.transaction`). 빈 재고 응답은 기존 현재고를 0으로 덮지 않고 동기화 오류로 취급한다.
- `inventory_snapshots.store_id`/`variant_id`는 각각 `stores`/`products`를 참조하는 외래키다 — 존재하지 않는 매장·상품의 스냅샷은 적재 자체가 거부된다.

### 11.3 수치·시간 정규화

- `soldQty`는 원시 순판매량과 계산용 수량을 구분한다. 계산용 판매량과 현재고는 각각 `max(0, value)`이며 음수 원시 값에는 `data_quality_warnings`를 붙인다.
- `cancelled_at`이 있는 영수증은 ETL이 `sales_lines`에 적재하지 않는다(SPEC §9) — SALE/REFUND 어느 쪽이든 완결되지 않은 거래로 취급해 판매·환불 집계 모두에서 제외한다.
- Postgres `numeric`은 경계에서 명시적으로 decimal/문자열로 다룬 뒤 수량 정책에 따라 변환한다. 표시 반올림과 재주문 `ceil`을 제외하고 중간 계산을 임의 반올림하지 않는다.
- 판매 창은 `[사업장 현지 오늘-N일 시작, 현지 오늘 시작)`으로 정의한다. 예상 소진일은 유한한 커버일수에만 계산하고, 반환값에는 기준 타임존을 포함한다.

### 11.4 권한과 도구 분리

- `sell_through`, `inventory_status`, `stockout_risk`, `reorder_suggestions`, `sync_status`는 읽기 전용 DB 자격 증명으로 실행한다.
- `sync_now`는 쓰기 작업이다. 운영에서는 별도 동기화 프로세스/쓰기 자격 증명으로 라우팅하고, MCP에 노출할 경우 `SYNC_TOOL_ENABLED=true`일 때만 등록한다. 기본값은 비활성이다.
- `sync_now` 동시 호출은 DB advisory lock으로 단일 실행만 허용한다. 로그와 MCP 오류에는 시크릿 및 외부 API 응답 원문을 포함하지 않는다.
  - **구현 정정(T9)**: TESTING §7 "다른 호출은 실행 중 오류/상태를 반환"에 맞춰 **논블로킹**
    `pg_try_advisory_lock`(`withTryAdvisoryLock`, `src/adapters/advisoryLock.ts`)을 쓴다 — 이미
    잠긴 상태면 기다리지 않고 즉시 `AdvisoryLockBusyError`를 던진다. 마이그레이션 러너(`scripts/
    migrate.ts`)의 `withAdvisoryLock`은 블로킹(대기 후 순차 실행)이라 의미가 다르므로 별도
    함수로 유지한다 — 두 헬퍼 모두 `src/adapters/advisoryLock.ts`에 있다(원래 migrate.ts 전용
    이었던 것을 src가 scripts에 의존하지 않도록 T9에서 옮겼다).

### 11.5 에이전트 실행 로그

- `agent_send_log`는 발송 성공만이 아니라 `no_suggestions`, `dry_run`, `sending`, `sent`, `failed` 결과를 구분할 수 있어야 한다. 실제 마이그레이션에 `status`, `error_code`, `run_id`를 추가하고, 미발송 상태에서는 `recipient`/`subject`를 nullable로 두거나 별도 `agent_run_log`를 사용한다.
- 이중 발송 방지는 **예약 패턴**으로 한다: T8은 `provider.send()`를 호출하기 전에 반드시 `status='sending'` 행을 먼저 커밋한다. `run_id`당 `sending`/`sent`는 최대 1건만 허용하는 부분 unique 인덱스가 이 INSERT를 원자적 잠금으로 만든다 — insert가 unique violation으로 실패하면 이미 발송 중이거나 완료된 것이므로 재발송하지 않는다. 성공하면 같은 행을 `sent`로, 실패하면 `failed`로 갱신한다(`failed`는 인덱스 대상이 아니므로 재시도가 새 `sending` 행을 다시 예약할 수 있다). 프로세스 크래시로 `sending`에 멈춘 오래된 행을 어떻게 회수할지는 T8에서 정책을 정한다(예: 일정 시간 경과 후 `failed`로 전이).
  - **구현 정정(T8)**: `pgWarehouse.logAgentSend`는 `status='sending'`을 **항상 새 INSERT로만** 시도하고(유니크 위반 시 원인이 담긴 에러로 재던짐), `status='sent'/'failed'`는 같은 `run_id`의 `status='sending'` 행을 찾아 그 행만 갱신한다. 애초 구현은 `run_id`로 기존 행 유무만 보고 있으면 무조건 UPDATE했는데, 그러면 이미 `sent`인 `run_id`로 다시 `logAgentSend('sending')`을 불러도 그 행을 조용히 `sending`으로 되돌려 재발송을 허용하는 결함이 있었다 — 부분 unique 인덱스의 보호를 실제로는 발동시키지 못했다. 실행 주기 안에서는 매 실행이 새 `run_id`(기본 `randomUUID()`)를 쓰므로 이 결함은 정상 운영에서 잘 드러나지 않지만, 재시도 스크립트가 `run_id`를 명시적으로 재사용하면 이중 발송이 가능했다. 정책 결정: **회수는 자동화하지 않는다** — 프로세스 크래시로 `sending`에 멈춘 행은 운영자가 DB에서 직접 확인 후 `failed`로 전이시킨다(Warehouse 인터페이스에 `agent_send_log` 조회 메서드가 없어 에이전트 자체는 오래된 `sending` 행을 조회할 수 없다). `sending` 없이 `sent`/`failed`를 기록하려는 호출은 그 자체로 오류로 취급해 던진다.

### 11.6 응답 공통 메타데이터

모든 조회 도구는 최소한 `generated_at`, `data_last_synced_at`, `timezone`, `filters`, `warnings`를 결과에 포함한다. 셀스루 응답에는 근사식, stale 데이터에는 경고를 포함하며 숫자 필드는 기계 판독 가능한 원값과 표시 문자열을 구분한다.

**구현(T9)**: stale 판정은 `core/freshness.ts`의 `computeFreshness()`(순수 함수, 기본 임계값
`DEFAULT_STALE_THRESHOLD_HOURS=24`, env `STALE_THRESHOLD_HOURS`로 조정)를 MCP 조회 도구
(`src/mcp/tools.ts`)와 에이전트 리포트(`agent/reorder.ts`의 `buildReorderReport()`) 둘 다 공유한다
— SPEC §9 "모든 조회와 리포트"에 stale 경고가 적용되게 하는 단일 지점이다.
