/**
 * CSV/Excel 입력 파일에 대한 크기·행 수·셀 길이 상한(005 SEC-003, TASKS T32).
 *
 * 감시 폴더에 놓인 대형/압축폭탄 XLSX 또는 대량 CSV가 프로세스 메모리·CPU를 고갈시킬 수
 * 있다는 지적에 대한 대응이다. 세 가지 상한은 위협 모델이 서로 달라 하나로 대체되지 않는다:
 *
 * - **파일 크기(디스크 바이트 수)** — CSV는 평문이라 디스크 크기가 곧 대략적인 메모리 상한이다
 *   (인코딩 변환에 따라 최대 2배 정도). 압축이 없어 이 상한 하나로 충분히 방어된다.
 * - **행 수** — XLSX는 zip 압축이라 디스크 크기만으로는 "작은 파일이 거대한 worksheet로
 *   펼쳐지는" 압축폭탄을 막지 못한다. `csvExcelParser.ts`의 `parseExcelFile`이 스트리밍
 *   리더로 행을 하나씩 읽으면서 이 상한을 넘는 순간 나머지 압축 데이터를 더 읽지 않고
 *   중단한다 — 정상 크기의 파일이 병적으로 많은 행을 담고 있는 경우(가장 흔한 실수 케이스)
 *   와 zip 확장 공격 둘 다에 대한 조기 차단이다.
 * - **셀 길이** — zip 압축은 셀 하나(특히 반복되는 shared string)가 작은 압축 크기로 거대한
 *   문자열로 펼쳐지게 할 수 있다. 행 수 상한과 별개로 개별 값의 길이도 제한한다.
 *
 * **알려진 잔여 위험**: ExcelJS의 스트리밍 리더는 기본적으로 `sharedStrings: 'cache'`
 * 모드로 zip의 shared-strings 테이블 전체를 worksheet 행을 읽기 전에 먼저 메모리에 캐시한다
 * (내부 구현 경계 — 이 프로젝트에서 바꿀 수 없다). shared-strings 테이블 자체에 극단적으로
 * 큰 단일 문자열이 들어있다면, 우리 쪽 셀 길이 검사가 실행되기 전에 이미 그 문자열이
 * 메모리에 펼쳐진 뒤다. 파일 크기 상한이 zip 자체의 최대 크기는 여전히 제한하므로 무한정
 * 확장은 아니지만, "작은 파일 → 셀 하나가 거대한 문자열" 공격을 100% 막는다고는 주장하지
 * 않는다 — explore_sql의 READ ONLY 트랜잭션이 advisory lock류 부수효과를 못 막는 것과
 * 같은 종류의, 정직하게 기록해두는 잔여 위험이다(docs/005 SEC-001 참고).
 */
import { stat } from "node:fs/promises";

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_ROWS = 100_000;
export const MAX_CELL_LENGTH = 10_000;

function formatBytes(n: number): string {
  return `${n.toLocaleString("en-US")}바이트`;
}

/** 읽기 전에 디스크 파일 크기를 확인한다 — 내용을 메모리에 올리기 전에 거부할 수 있는
 * 유일한 검사라 항상 다른 두 상한보다 먼저 호출한다. */
export async function assertFileSizeWithinLimit(filePath: string): Promise<void> {
  const info = await stat(filePath);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(
      `파일이 너무 큽니다(${filePath}): ${formatBytes(info.size)} — 상한 ` +
        `${formatBytes(MAX_FILE_BYTES)}(20MB)를 초과했습니다. 파일을 기간·매장 단위로 ` +
        "나눠서 다시 내보내세요.",
    );
  }
}

/** 지금까지 읽은 데이터 행 수가 상한을 넘으면 던진다 — 스트리밍 파서는 이 호출을 행마다
 * 반복해 초과 즉시 나머지 입력을 더 읽지 않고 중단할 수 있다. */
export function assertRowCountWithinLimit(count: number, filePath: string): void {
  if (count > MAX_ROWS) {
    throw new Error(
      `파일에 데이터 행이 너무 많습니다(${filePath}): ${count.toLocaleString("en-US")}행 초과 — ` +
        `상한 ${MAX_ROWS.toLocaleString("en-US")}행을 넘었습니다. 파일을 나눠서 다시 시도하세요.`,
    );
  }
}

/** `context`는 사람이 어느 셀인지 바로 찾을 수 있게 파일명·행·열 정보를 담는다. */
export function assertCellLengthWithinLimit(value: string, context: string): void {
  if (value.length > MAX_CELL_LENGTH) {
    throw new Error(
      `셀 값이 너무 깁니다(${context}): ${value.length.toLocaleString("en-US")}자 — 상한 ` +
        `${MAX_CELL_LENGTH.toLocaleString("en-US")}자를 초과했습니다.`,
    );
  }
}
