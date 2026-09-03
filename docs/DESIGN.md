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

## 12. v0.2 배포·안정성 설계 확장 (2026-09-03, npm 출시 전 적대적 검수 대응 — TASKS T28)

`docs/004~008` 적대적 검수(40건)와 `docs/SPEC.md` §18의 정책 확정을 구현 계약으로 옮긴다. DESIGN이 "구현의 진실의 원천"이라는 문서 서두 원칙에 따라, 여기 적힌 계약과 실제 코드가 다르면 문서 기준으로 코드를 고친다. 각 절 끝에 담당 TASKS 번호를 표시한다 — 이 절 자체는 계약만 정의하고 구현하지 않는다.

### 12.1 빌드/bin 구조 (REL-002/003/004, TASKS T29)

- **공개 계약**: `retail-mcp`는 CLI/MCP 서버 제품이다. 라이브러리로서의 `exports`는 이번 범위에서 제공하지 않는다(필요해지면 별도 결정).
- **빌드**: `tsc`로 `src/**/*.ts` → `dist/**/*.js` + `.d.ts`. 소스 트리 직접 실행(`tsx`)은 개발용으로만 남기고, `devDependencies`에 유지한다 — 게시된 패키지는 `dist/`의 순수 JS만으로 동작해야 한다(`tsx`가 없는 `npm install --omit=dev` 환경 포함).
- **`bin`**: MCP 서버 진입점(`dist/server.js`)과 온보딩 CLI(`dist/cli/onboard.js`)에 각각 shebang(`#!/usr/bin/env node`)을 붙이고 `package.json.bin`에 등록한다. 폴더 스캔·재주문 에이전트는 `npm run agent:*` 스크립트로만 노출하고(cron이 호출하는 대상이라 별도 전역 bin이 필요 없다), 필요해지면 후속 태스크에서 재검토한다.
- **`files` allowlist**: `dist/`, `migrations/`, `README.md`, `LICENSE`, `.env.example`을 포함하고 `tests/`, `tests/fixtures/`, `docs/`(내부 검수 문서), ESLint/Vitest 설정, 원본 `.ts` 소스는 제외한다. `npm pack --dry-run` 결과 파일 목록을 release gate에 고정한다(TASKS T29 완료 기준).
- **검증**: tarball을 임시 디렉터리에 `npm install --omit=dev`로 설치한 뒤 `npx retail-mcp --help`(또는 MCP initialize)까지 확인하는 스모크 테스트를 release gate에 추가한다(QA-001, TASKS T29).

**구현 완료(T29)**: `tsconfig.build.json`(`rootDir: src`, `src/mocks/**` 제외), `scripts/verifyPack.ts`(`npm run verify:pack`)가 빌드→pack→fresh install→`retail-mcp`(MCP `tools/list`)·`retail-mcp-onboard`(`.env`+템플릿 생성) 실행까지 실제로 검증한다. 이 스모크 테스트 자체가 소스 트리 테스트로는 드러나지 않던 결함 두 가지를 잡아냈다 — `src/adapters/mainModule.ts`(`process.argv[1]`이 npm bin 심볼릭 링크일 때의 realpath 비교)와 `src/cli/onboard.ts`의 `createReadlineAsk()`(파이프 입력에서 `rl.question()` 반복 호출이 멈추는 Node 자체의 동작, 비동기 이터레이터 소비로 교체) — 둘 다 이 문서 §12.1이 처음 계약을 쓸 때는 예상하지 못했던 IO 경계 결함이다.

### 12.2 authoritative snapshot 교체 계약 — tombstone (DATA-002, TASKS T31)

SPEC §18이 확정한 정책의 구현 계약이다.

- **경계 정의**: "authoritative 경계"는 (a) 지점 모드의 감시 폴더 최신 파일 1개, (b) 본사 통합 모드의 지점별 스냅샷 파일 1개(지점마다 독립) — 이미 §12(구 버전, 실제 사용 절차)가 규정한 "지점 스냅샷 파일이 끝까지 성공 파싱된 뒤에만 그 지점의 watermark를 커밋"과 같은 단위다.
- **스키마**: `inventory_levels`와 `sales_period_agg`(및 CSV 채널이 관리하는 `products`)에 `active boolean not null default true`(또는 동등한 상태 컬럼)를 추가한다. 물리 삭제(`DELETE`)는 하지 않는다 — 재활성화·감사 추적을 위해서다.
- **트랜잭션 계약**: 한 authoritative 스캔의 upsert 트랜잭션 안에서, "이번 스캔의 (매장,SKU) 집합에 없지만 그 매장에 대해 이전에 `active=true`였던 행"을 같은 트랜잭션으로 `active=false`로 전이한다 — upsert와 tombstone이 원자적으로 함께 커밋되거나 함께 롤백된다(부분 상태 금지, CLAUDE.md 구현 해석 보충의 "전체 페이지 성공 후에만 watermark 커밋" 원칙과 동일 정신).
- **소비 측 계약**: 재주문 계산(`computeReorderMetrics`/`computeCsvReorderMetrics`), 저재고 알림, 기본 MCP 조회는 `active=true` 행만 본다. `inventory_status` 등 진단 목적 조회에는 비활성 포함 옵션을 열어둘 수 있다(구현 시 결정).
- **본사 통합 모드 격리**: tombstone 판정은 지점별 독립 트랜잭션 안에서만 그 지점의 이전 상태와 비교한다 — 다른 지점의 (매장,SKU)를 이번 지점 스캔의 누락으로 오판하지 않는다.

**구현 완료(T31)**: `migrations/006_tombstone_active_flag.sql`(`inventory_levels`/`sales_period_agg`에 `active boolean not null default true` + `(store_id, active)` 인덱스). `Warehouse.deactivateMissingCsvRows({storeIds, presentInventory, presentSales})`(신규) — `unnest($2::text[], $3::text[])`로 "이번 스캔에 있는 (매장,SKU) 키 집합"을 만들어 그 밖의 기존 active 행만 `active=false`로 갱신한다(물리 삭제 없음). `upsertInventoryOn`/`upsertSalesPeriodAggOn`은 항상 `active=true`로 upsert해 재등장 시 자동 재활성화를 보장하고, `queryStockOn`/`querySalesPeriodAggOn`은 `active=true`만 반환한다 — Loyverse 경로(`sales_lines`/`etl/sync.ts`)는 tombstone을 호출하지 않으므로 기존 동작과 완전히 동일하다. `agent/folderScan.ts`가 `runFolderScan`/`runConsolidatedScan` 양쪽의 authoritative 트랜잭션 안에서(업서트와 같은 트랜잭션) `deactivateMissingCsvRows`를 호출한다 — `presentInventory`는 이번 파일의 모든 재고 행, `presentSales`는 판매이력 있는 행만(둘이 다를 수 있다).

### 12.3 파일 idempotency + 일일 다이제스트 (DATA-003/004, TASKS T31)

SPEC §18이 확정한 정책의 구현 계약이다.

- **입력 identity**: 감시 폴더 경로(source identity) + 선택된 최신 파일의 content hash(sha256, mtime만으로는 OPS-003의 동률 문제와 겹쳐 신뢰할 수 없다)를 계산해 이전 실행과 비교한다.
- **watermark 저장**: `sync_state`(기존 테이블, `resource` 자유 문자열 재사용 — 새 스키마 불필요)에 `csv_branch_digest:<watchDir>` 같은 키로 `{contentHash, lastSentAt}`를 JSON으로 저장한다(cursor 컬럼이 text이므로 JSON 문자열로 직렬화).
- **판정 로직**: (1) content hash가 이전과 다르면 무조건 처리하고 발송 여부는 기존 이슈 유무로 판단, 발송 시 `lastSentAt` 갱신. (2) content hash가 같으면, 사업장 타임존 기준 `lastSentAt`으로부터 24시간(또는 로컬 자정 경계 — 구현 시 확정)이 지났는지 확인 — 안 지났으면 `unchanged`로 조용히 종료(발송 없음, 로그만), 지났으면 같은 내용이라도 다이제스트 1회 발송 후 `lastSentAt` 갱신.
- **SCM 대사 결과와의 관계**: DATA-007(SCM 실패 상태 노출)과 연동 — SCM 처리 실패도 "이슈"로 취급해 하루 다이제스트에 포함될 수 있게 한다(완전 무음 방지).
- **atomic snapshot write**: `folderScan.ts`의 snapshot export는 고정 파일명(`snapshot.csv`)에 직접 `writeFile`하지 않고, 같은 디렉터리의 임시 파일(`snapshot.csv.tmp-<runId>`)에 쓴 뒤 `fsync` 후 `rename`으로 교체한다(POSIX rename은 원자적). 본사 수집 프로세스는 확장자가 `.tmp-*`인 파일을 무시한다(ready marker 대신 임시 파일명 자체를 신호로 쓴다 — 새 파일 형식을 추가하지 않는다).

**구현 완료(T31)**:

- `src/adapters/atomicFile.ts`(신규) — `writeFileAtomic(targetPath, content, {mode?})`. 임시 파일명은 `<targetPath>.tmp-<pid>-<타임스탬프>-<난수>`(접미사 방식) — `folderScan.ts`의 `listInventoryFiles()`가 이미 `/\.(csv|xlsx)$/i`로 파일명이 그 확장자로 "끝나는" 파일만 골라내므로, 이 이름은 별도 필터 없이 자연히 제외된다. `folderScan.ts`의 snapshot 쓰기가 이 유틸리티를 쓴다 — `.env` 쓰기(SEC-005)는 T32에서 같은 유틸리티를 재사용할 예정이다.
- `migrations/007_agent_send_log_unchanged_status.sql` — `agent_send_log.status`에 `unchanged`를 추가(기존 check 제약 재생성). `AgentSendStatus`에 `"unchanged"` 추가.
- **판정 로직 확정(위 설계안에서 정제)**: content hash + `sync_state` 워터마크(`csv_branch_digest:<watchDir 절대경로>`)는 설계 그대로다. 다만 **적용 범위를 실제 발송 시도 경로로 좁혔다** — `no_suggestions`/`dry_run`은 이메일을 애초에 안 보내므로 억제 판정과 무관하게 항상 그대로 처리한다(워터마크도 갱신하지 않는다). `willSend=true`이고 `issueCount>0`인, "정말 이메일을 보내려는" 경로에서만 `shouldSkipAsUnchanged()`를 확인한다. 이렇게 좁힌 이유: 착수 중 기존 가드레일 1 회귀 테스트("SEND_MODE=live && confirm 둘 다일 때만 실제 발송한다")가 같은 파일·같은 시각으로 두 번 연속 `runFolderScan`을 호출하는데, 초기 구현(파싱 이전에 전부 건너뛰는 방식)은 dry-run 성격의 첫 호출까지 워터마크에 반영해버려 사람이 dry-run으로 반복 확인하는 정상적 사용까지 억제해버렸다 — DATA-003이 실제로 막으려는 건 "cron이 반복 실행하며 하는 실제 이메일 스팸"이지 사람의 반복 수동 확인이 아니다.
- 워터마크는 **성공적으로 이메일을 보낸(`sent`) 시점에만** 갱신한다 — `failed`(실제 발송 실패)에서는 갱신하지 않아, 다음 실행이 같은 날·같은 내용이어도 즉시 재시도할 수 있다(하루 상한이 실패까지 억제하면 안 된다).
- 억제된 실행도 `status="unchanged"`로 이번 스캔이 실제로 계산한 `alerts`/`reconciliation`을 결과에 그대로 담아 반환한다 — 무엇이 억제됐는지 호출자가 알 수 있다.
- 테스트: `tests/atomicFile.test.ts`(신규), `tests/folderScan.test.ts`(다이제스트 억제/24시간 경과 후 재발송/내용 변경 시 미억제/발송 실패 시 미억제/dry_run 무관 — 5 tests, tombstone 3 tests).

### 12.4 explore_sql 격리 확정 — role 강제 + PGlite 재검토 (SEC-001/002, TASKS T30)

SPEC §18의 정책 확정을 구현 계약으로 옮긴다. §6/§17의 2단계 방어(`sqlValidator` 1차 + `BEGIN READ ONLY` 2차)는 유지하되, "이 두 겹이면 안전하다"는 기존 전제를 낮추고 아래를 추가한다.

- **전용 role 필수**: 운영 배포에서 `EXPLORE_SQL_ENABLED=true`로 켤 때는 `pgWarehouse`가 열리는 DB role에 `pg_advisory_lock`류 volatile 함수, `set_config`, 확장 함수 실행 권한이 없어야 한다 — README "권한 분리" 절의 권장을 필수 체크리스트로 격상한다. 코드에서 role 권한을 강제로 조회·검증하지는 않는다(운영 DB role 구성은 배포자 책임 영역, 가드레일 4의 기존 원칙과 동일) — 대신 문서와 초기 경고 로그로 명시한다.
- **회귀 테스트**: `pg_try_advisory_lock`/`pg_advisory_unlock`, `set_config('statement_timeout', ...)` 재정의를 이용한 우회를 `tests/exploreSqlExecutor.test.ts`에 공격 시나리오로 고정한다(005 SEC-001/002가 재현한 그대로) — "막는다"가 아니라 "이 두 겹만으로는 못 막는 부분이 있고, 그래서 role 제한이 필수"라는 사실 자체를 문서화하는 회귀 테스트로 남긴다.
- **PGlite 노출 재검토**: PGlite는 `statement_timeout` 미집행(§17 기존 한계)에 더해 role 기반 함수 실행 제한을 지원하지 않는다 — `EXPLORE_SQL_ENABLED=true` + PGlite(임베디드) 조합은 SEC-002의 DoS 경로에 그대로 노출된다. 이 조합이 감지되면(웨어하우스 팩토리가 이미 pg/pglite 분기를 알고 있다) 서버 기동 로그에 명확한 경고를 남긴다 — 강제 차단 여부는 T30 구현 중 최종 확정.

**구현 완료(T30)**:

- `core/sqlValidator.ts`에 `FORBIDDEN_FUNCTION_CALLS` 신설(`FORBIDDEN_KEYWORDS`와 별개 목록) — advisory lock류(`pg_advisory_lock`/`pg_try_advisory_lock`/...), `set_config`, 백엔드 제어류(`pg_terminate_backend`/`pg_cancel_backend`/`pg_reload_conf`/`pg_rotate_logfile`), 파일·원격 접근류(`lo_import`/`lo_export`/`dblink*`/`pg_read_file`/`pg_read_binary_file`/`pg_ls_dir`)를 함수명 단위(`\b이름\s*\(`)로 막는다 — `FORBIDDEN_KEYWORDS`의 `\b단어\b` 매칭이 `pg_advisory_lock`의 "_lock" 앞에 단어 경계가 없어(밑줄도 `\w`) 놓쳤던 정확한 우회(005 실증)를 닫는다. 여전히 완전하지 않다(모든 volatile 함수를 나열할 수 없다)는 걸 문서화 — `nextval()` 같은 목록 밖 함수는 여전히 `BEGIN READ ONLY`가 최종 방어선이다.
- **차단 여부 확정: PGlite(임베디드, `DATABASE_URL` 미설정)에서 `EXPLORE_SQL_ENABLED=true`는 기본적으로 서버 기동을 거부한다.** `resolveServerConfig()`가 `DATABASE_URL` 없이(=PGlite 경로, `createWarehouseFromEnv`와 같은 판정 기준) `EXPLORE_SQL_ENABLED=true`면 원인+조치가 담긴 에러를 던진다 — 새 env `EXPLORE_SQL_ALLOW_PGLITE=true`를 함께 설정해야만 우회할 수 있다(`SEND_MODE=live && --confirm`과 같은 "명시적 위험 인지" 이중 게이트 패턴). PGlite는 role 기반 권한 분리도, `statement_timeout` 집행도 못하는 두 안전장치가 전부 빠지는 조합이라 완전 차단보다는 "그래도 켜야 한다면 명시적으로"를 선택했다 — 실 Postgres/Neon 경로는 이 확인 없이 그대로 동작한다.
- `createRetailMcpServer()`가 `EXPLORE_SQL_ENABLED=true`일 때 서버 기동 시 `console.warn`(stderr — MCP 프로토콜은 stdout 전용이라 절대 오염시키지 않는다)으로 전용 role 권장 경고를 한 번 남긴다(웨어하우스 kind만 언급, 시크릿·연결 정보는 로그에 없음).
- 테스트: `tests/sqlValidator.test.ts`(함수 블록리스트 각 항목 + 언더스코어 우회 재현 + 스키마 한정자/대소문자/공백 우회 시도 + 오탐 방지), `tests/exploreSqlExecutor.test.ts`(신규 함수가 실행 전에 거부됨 + "검증기를 우회했다면 READ ONLY 혼자로는 advisory lock을 못 막았을 것"을 세션에 직접 재현하는 문서화 목적 테스트), `tests/server.test.ts`(`EXPLORE_SQL_ALLOW_PGLITE` 게이팅 3가지 케이스).

### 12.5 원자적 파일 쓰기 — 공통 유틸리티 (DATA-004, TASKS T31)

12.3의 atomic snapshot write와 SEC-005(`.env` 0600 원자 쓰기)가 같은 패턴(임시 파일 → flush → rename)을 필요로 한다 — `src/adapters/atomicFile.ts`(신규, 순수 IO 유틸리티)로 공용화한다: `writeFileAtomic(path, content, { mode? })`. `onboard.ts`의 `.env` 쓰기와 `folderScan.ts`의 snapshot 쓰기가 이 유틸리티를 공유한다.
