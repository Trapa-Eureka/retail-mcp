-- 001_init.sql — 초기 스키마
-- 진실의 원천: DESIGN.md §2(기본 DDL) + §11(스키마 명확화). 아직 배포 전이므로
-- §11 보정을 후속 마이그레이션으로 쪼개지 않고 이 파일에 함께 반영한다.

create table stores (
  id text primary key,
  name text not null
);

-- Loyverse variant 단위로 평탄화된 상품.
create table products (
  variant_id text primary key,
  item_id text not null,
  name text not null,
  sku text,
  category text
);

-- 영수증 라인 단위 판매 기록.
-- qty: 환불은 음수. 원시 순판매량을 그대로 보존한다 — 계산 시 max(0, qty) 정책은
-- core 계층 경계에서 적용하고 저장 시점에 지우지 않는다 (SPEC §9).
create table sales_lines (
  receipt_id text not null,
  line_no int not null,
  store_id text not null references stores (id),
  variant_id text not null references products (variant_id),
  qty numeric not null,
  gross numeric not null,
  discount numeric not null default 0,
  sold_at timestamptz not null,
  primary key (receipt_id, line_no)
);
create index sales_lines_store_variant_sold_at_idx on sales_lines (store_id, variant_id, sold_at);

-- 현재고. 동기화마다 upsert로 최신 상태만 유지한다.
-- 음수 in_stock은 데이터 품질 경고 대상 — 저장은 원시값, 계산 시 0으로 clamp (SPEC §9).
create table inventory_levels (
  store_id text not null references stores (id),
  variant_id text not null references products (variant_id),
  in_stock numeric not null,
  updated_at timestamptz not null,
  primary key (store_id, variant_id)
);

-- 동기화마다 적재하는 재고 스냅샷 — 시계열의 시작점.
-- run_id: 한 동기화 실행에서 고정한 실행 식별자(DESIGN §11.2). 동일 시각(snapped_at)에
-- 재실행하더라도 run_id가 PK에 포함되어 있어 스냅샷 PK 충돌이 나지 않고 실행별로 구분된다.
create table inventory_snapshots (
  run_id text not null,
  snapped_at timestamptz not null,
  store_id text not null references stores (id),
  variant_id text not null references products (variant_id),
  in_stock numeric not null,
  primary key (run_id, store_id, variant_id)
);
create index inventory_snapshots_snapped_at_idx on inventory_snapshots (snapped_at);

-- 리소스별 동기화 진행 상태.
-- watermark(=cursor 컬럼)는 "완료된 리소스의 증분 시작점"만 저장한다.
-- API 페이지네이션 토큰(pageCursor)은 여기 저장하지 않는다 — 인메모리에서만 쓰고
-- 리소스 전체 페이지가 성공한 뒤에만 watermark를 커밋한다 (DESIGN §11.1, CLAUDE.md 구현 해석 보충).
create table sync_state (
  resource text primary key, -- receipts | items | inventory | stores
  cursor text, -- watermark 값. 예: 마지막 처리 완료 시각 또는 (updated_at, id) 직렬화 문자열
  last_synced_at timestamptz
);

-- 에이전트 실행/발송 로그.
-- status로 no_suggestions/dry_run/sending/sent/failed를 구분한다 (DESIGN §11.5).
--
-- 이중 발송 방지는 예약(reservation) 패턴으로 강제한다: T8은 provider.send()를 호출하기
-- 전에 반드시 status='sending' 행을 먼저 커밋한다. run_id당 sending/sent는 최대 1건만
-- 허용하는 부분 unique 인덱스가 있어, 이 INSERT 자체가 원자적 잠금 역할을 한다 — insert가
-- unique violation으로 실패하면 이미 발송 중이거나 발송 완료된 것이므로 재발송하지 않는다.
-- 성공하면 같은 행을 'sent'로, 실패하면 'failed'로 UPDATE한다('failed'는 unique 인덱스
-- 대상이 아니므로 재시도로 새 'sending' 행을 다시 예약할 수 있다).
-- 'sending' 상태로 멈춘 채 오래된 행(예: 프로세스 크래시)에 대한 처리 정책은 T8에서 정한다.
create table agent_send_log (
  id bigserial primary key,
  run_id text not null,
  sent_at timestamptz not null,
  status text not null check (status in ('no_suggestions', 'dry_run', 'sending', 'sent', 'failed')),
  recipient text, -- 미발송 상태(no_suggestions 등)에서는 null 허용
  subject text,
  suggestion_count int not null,
  message_id text,
  dry_run boolean not null,
  error_code text
);
create unique index agent_send_log_run_id_active_idx
  on agent_send_log (run_id)
  where status in ('sending', 'sent');
