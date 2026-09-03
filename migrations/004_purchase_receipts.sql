-- 004_purchase_receipts.sql — SCM 시트 연동의 입고 실적 (docs/SPEC.md §13)
--
-- 원본은 구글시트 "입출고내역" 탭(발주·입고 데이터 샘플, 2026-09-03 확인)의 "구분=입고" 행이다.
-- 같은 시트의 "구분=출고" 행은 의도적으로 적재하지 않는다 — retail-mcp의 판매 원천은
-- Loyverse/CSV 채널이고, SCM 시트의 출고까지 별도 파이프라인으로 적재하면 같은 판매를
-- 이중 계산하게 된다(SPEC §13 "스코프 결정").
--
-- "발주"(주문했지만 아직 안 들어온 것) 상태는 다루지 않는다 — 확인한 샘플 시트에 발주 상태
-- 컬럼 자체가 없다(입고 실적만 있음). 이 테이블은 어디까지나 "이미 들어온 입고 실적" 원장이다.
create table purchase_receipts (
  store_id text not null references stores (id),
  variant_id text not null references products (variant_id),
  received_at date not null,
  -- 입고 수량. 반품입고(음수) 등은 v0.1 스코프 밖.
  received_qty numeric not null check (received_qty > 0),
  -- 매입 원가(선택, 감사 추적용) — 재고 정합성/정통 셀스루 계산 자체에는 쓰이지 않는다.
  unit_cost numeric,
  currency text,
  vendor text,
  check ((unit_cost is null) = (currency is null)),
  -- 같은 매장·SKU·같은 날짜에 입고가 여러 건이면 마지막 값으로 덮어써진다(합산이 아님) —
  -- 원본 시트에 이벤트 단위 순번이 없어 생기는 v0.1 한계. 필요해지면 시퀀스 컬럼을 추가한다.
  primary key (store_id, variant_id, received_at)
);
