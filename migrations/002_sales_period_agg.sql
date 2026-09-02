-- 002_sales_period_agg.sql — CSV/Excel 채널의 기간합계 판매 데이터
-- 진실의 원천: docs/SPEC.md §12 "컬럼 구성"·"판매이력 없을 때: 임계치 폴백".
--
-- CSV/Excel에는 영수증 단위 이력이 없다 — "이 기간 동안 이 매장의 이 SKU가 총 N개 팔렸다"는
-- 기간 합계 하나만 준다. sales_lines(영수증 라인 단위, receipt_id+line_no PK, gross/discount
-- 포함)에 억지로 끼워 넣으면 가짜 영수증을 만들어야 하므로, 별도 테이블로 분리해
-- Loyverse 경로의 거래 단위 정확성을 CSV의 대략치로 오염시키지 않는다
-- (docs/TASKS.md T12, LoyverseClient/etl/sync.ts는 여전히 Loyverse 전용 경로로 남는다).
--
-- inventory_levels와 같은 모델: 매 스캔(SPEC §12 "실행 모델")마다 최신 값으로 upsert한다 —
-- 기간별 이력을 누적하지 않고 "가장 최근 스캔이 본 기간 합계"만 보관한다.
create table sales_period_agg (
  store_id text not null references stores (id),
  variant_id text not null references products (variant_id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  -- 기간 내 판매수량 합계. CSV는 환불을 별도로 표현하지 않으므로 음수를 허용하지 않는다
  -- (Loyverse sales_lines의 qty와 달리 순판매량 근사가 아니라 원천 합계 그대로다).
  sold_qty numeric not null check (sold_qty >= 0),
  primary key (store_id, variant_id)
);
