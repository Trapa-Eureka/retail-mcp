-- 003_product_low_stock_threshold.sql — 품목별 저재고 임계치(CSV/Excel 채널)
-- 진실의 원천: docs/SPEC.md §12 "컬럼 구성"의 `저재고임계치`(선택, 품목별 override) ·
-- "판매이력 없을 때: 임계치 폴백". T16(CSV/Excel 파서)이 이 컬럼을 파싱하지만 저장할 곳이
-- 없어서 발견한 스키마 공백을 메운다(TASKS.md T16).
--
-- 상품(products) 테이블에 붙인다 — SPEC §12가 "상품별 override"라고 명시했으므로 매장별이
-- 아니라 품목 단위다. Loyverse 경로는 이 컬럼을 쓰지 않으므로 항상 null이다. 이 값을 실제로
-- 읽어 임계치 판정에 쓰는 것은 T17의 몫이다 — 이 마이그레이션은 쓰기 경로만 연다.
alter table products add column low_stock_threshold numeric;
