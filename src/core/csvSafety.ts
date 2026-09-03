/**
 * CSV의 spreadsheet formula injection 방어(005 SEC-004, TASKS T32).
 *
 * `snapshotExport.ts`가 만드는 스냅샷 CSV는 두 가지 용도를 동시에 가진다 — ①본사가
 * `csvExcelParser.ts`(T16)로 다시 읽어들이는 기계 판독용 왕복 입력(SPEC §12 "다지점
 * 헤드오피스 통합 조회")이면서, ②지점 담당자가 확인차 Excel/Google Sheets로 직접 여는
 * 사람이 보는 파일이기도 하다(구현 계약: "사람도 열 수 있는 CSV"로 취급 — 006 리뷰가 요구한
 * "기계 전용/사람 열람 계약 정의"). 매장명·상품명·SKU는 원본 CSV/XLSX 입력에서 그대로
 * 흘러온 자유 텍스트라 `=`, `+`, `-`, `@`로 시작하면 Excel/Sheets가 이를 수식으로 실행할 수
 * 있다(CSV quoting은 구분자 escape일 뿐 수식 실행을 막지 못한다).
 *
 * 대응: 내보낼 때 위험 접두사가 있으면 앞에 작은따옴표(`'`)를 붙인다(Excel/Sheets 표준
 * "텍스트로 강제" 관례 — 셀이 수식이 아니라 그 문자 그대로 표시된다). 다시 읽어들일 때는
 * `csvSchema.ts`의 `requiredTrimmedString`이 이 접두사를 정확히 역으로 벗겨내 원래 값을
 * 복원한다 — 우리가 붙인 경우에만 대칭적으로 벗겨지므로(원본 값이 애초에 위험 접두사로
 * 시작할 때만 붙었을 것이므로) 왕복(export → import) 후 원래 도메인 데이터와 완전히
 * 일치한다(`tests/snapshotExport.test.ts`의 왕복 테스트로 고정).
 */

const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@"]);

/** 값이 `=`/`+`/`-`/`@`로 시작하면 앞에 `'`를 붙인다. 그 외엔 그대로 반환한다. */
export function escapeCsvFormulaPrefix(value: string): string {
  return FORMULA_TRIGGER_CHARS.has(value.charAt(0)) ? `'${value}` : value;
}

/** `escapeCsvFormulaPrefix`가 붙인 접두사만 정확히 역으로 벗겨낸다 — 원래부터 `'`로
 * 시작했지만 그 다음이 위험 문자가 아닌 값(우리가 escape하지 않았을 값)은 건드리지 않는다. */
export function unescapeCsvFormulaPrefix(value: string): string {
  return value.charAt(0) === "'" && FORMULA_TRIGGER_CHARS.has(value.charAt(1))
    ? value.slice(1)
    : value;
}
