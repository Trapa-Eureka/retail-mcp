/**
 * 처리된 재고 데이터를 T15와 동일한 SPEC §12 고정 템플릿 CSV로 직렬화한다(TASKS T19).
 * 지점 인스턴스의 산출물이자 본사 인스턴스의 입력이 되는 왕복 가능한 포맷이다(SPEC §12
 * "다지점 헤드오피스 통합 조회") — `매장명`이 이미 필수 컬럼이라 스키마 변경 없이 그대로
 * 재사용된다. 사람이 보는 요약이 아니라 T16(csvExcelParser.ts)이 다시 읽어들일 수 있는
 * 기계 판독용 산출물이다.
 *
 * 순수 함수 — 외부 IO 없음(CLAUDE.md core 원칙). 파일 쓰기는 호출자(T18 folderScan.ts)의
 * 몫이다.
 *
 * 단가/통화는 내보내지 않는다 — T16이 애초에 저장하지 않는 필드라 왕복 대상이 아니다
 * (csvExcelParser.ts의 "알려진 스코프 경계" 참고).
 */
import { stringify } from "csv-stringify/sync";
import type { InventoryRow, ProductRow, SalesPeriodAggRow } from "./types.js";

/** T19가 소비하는 최소 입력 — T16의 `ParsedCsvExcelFile`과 같은 모양이지만(stores는 export에
 * 필요 없어 뺐다) 직접 의존을 피해 재사용성을 넓힌다. */
export interface SnapshotSource {
  inventory: InventoryRow[];
  products: ProductRow[];
  salesPeriodAgg: SalesPeriodAggRow[];
}

/** SPEC §12 고정 템플릿의 열 순서 그대로 — T15 `csvRowSchema`가 검증할 헤더와 정확히 일치해야 한다.
 * `포장수량`은 T24가 §14용으로 추가한 선택 컬럼 — 착수 중 발견(006 DATA-001, TASKS T31):
 * 여기 export에서 빠져 있어 지점 snapshot → 본사 통합 왕복에서 packSize가 조용히 null로
 * 바뀌었다. 지점 알림은 팩 단위로 올림하는데 본사 통합 조회는 그 정보를 잃는 결함이었다. */
const COLUMNS = [
  "매장명",
  "상품명",
  "SKU",
  "재고수량",
  "판매수량",
  "판매기간시작일",
  "판매기간종료일",
  "저재고임계치",
  "포장수량",
] as const;

function csvKey(storeId: string, variantId: string): string {
  return `${storeId}:${variantId}`;
}

/** UTC 기준 YYYY-MM-DD — T15의 `z.coerce.date()`가 다시 읽으면 같은 UTC 자정 Date가 된다. */
function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * `source`(T16이 이미 검증·변환해 만든 도메인 행)를 SPEC §12 고정 템플릿 CSV 문자열로
 * 직렬화한다. 재고가 있는 (매장,SKU)마다 한 행 — 판매이력이 없으면 판매 관련 컬럼은 빈칸.
 */
export function exportSnapshotCsv(source: SnapshotSource): string {
  const productByVariant = new Map(source.products.map((p) => [p.variantId, p]));
  const salesByKey = new Map(source.salesPeriodAgg.map((s) => [csvKey(s.storeId, s.variantId), s]));

  const rows = source.inventory.map((inv) => {
    const product = productByVariant.get(inv.variantId);
    const sales = salesByKey.get(csvKey(inv.storeId, inv.variantId));
    return {
      매장명: inv.storeId,
      상품명: product?.name ?? inv.variantId,
      SKU: inv.variantId,
      재고수량: inv.inStock,
      판매수량: sales?.soldQty ?? "",
      판매기간시작일: sales ? formatDateUtc(sales.periodStart) : "",
      판매기간종료일: sales ? formatDateUtc(sales.periodEnd) : "",
      저재고임계치:
        product?.lowStockThreshold !== undefined && product.lowStockThreshold !== null
          ? product.lowStockThreshold
          : "",
      포장수량:
        product?.packSize !== undefined && product.packSize !== null ? product.packSize : "",
    };
  });

  return stringify(rows, { header: true, columns: [...COLUMNS] });
}
