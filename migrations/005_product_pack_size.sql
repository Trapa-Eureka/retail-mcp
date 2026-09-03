-- 005_product_pack_size.sql — 팩 단위 반올림 (docs/SPEC.md §14)
--
-- 공급자가 출고하는 최소 팩/박스 단위. 없으면(낱개로 매입 가능한 품목) null — 재주문
-- 제안량을 그대로 쓴다(반올림하지 않는다). 소스 중립적 필드다(CSV/Excel 전용이 아니다) —
-- 어느 채널이 이 값을 채우든 상관없이 core/metrics.ts의 반올림 후처리 함수가 소비한다.
alter table products
  add column pack_size numeric check (pack_size is null or pack_size > 0);
