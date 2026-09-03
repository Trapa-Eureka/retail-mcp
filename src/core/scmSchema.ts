/**
 * SCM 시트(발주·입고) 연동의 원시 행 스키마 + 도메인 변환 (SPEC.md §13). csvSchema.ts와 같은
 * 원칙 — 여기는 "이미 헤더별로 파싱된 한 행 객체"의 유효성만 순수하게 검증하고 도메인 타입으로
 * 옮긴다(외부 IO 없음). 실제 구글시트를 읽어오는 어댑터(Google Sheets API 클라이언트)는
 * 이번 스코프에 없다 — 자격증명·의존성이 걸린 결정이라 별도 태스크로 미뤘고, 지금은 시트
 * 스냅샷을 테스트 픽스처로만 쓴다(`tests/fixtures/scm/`).
 *
 * 컬럼명은 실제 확인한 샘플 시트("입출고내역" 탭)의 헤더 그대로(한글)를 키로 쓴다 — 금액·비고·월
 * 컬럼은 수식으로 계산되거나 이 파이프라인이 쓰지 않는 값이라 스키마에 정의하지 않는다
 * (zod object는 정의 안 된 키를 조용히 무시한다, strict 아님).
 */
import { z } from "zod";
import type { PurchaseReceiptRow } from "./types.js";

function blankToUndefined(v: unknown): unknown {
  if (typeof v === "string" && v.trim() === "") return undefined;
  return v;
}

function requiredTrimmedString(label: string) {
  return z.preprocess(
    blankToUndefined,
    z
      .string({ error: `${label}은(는) 필수 컬럼입니다.` })
      .trim()
      .min(1, `${label}이(가) 비어 있습니다.`),
  );
}

function optionalTrimmedString(label: string) {
  return z.preprocess(
    blankToUndefined,
    z.string().trim().min(1, `${label}이(가) 비어 있습니다.`).optional(),
  );
}

function requiredDate(label: string) {
  return z.preprocess(
    blankToUndefined,
    z.coerce.date({ error: `${label}은(는) 날짜여야 합니다.` }),
  );
}

function requiredPositiveNumber(label: string) {
  return z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: `${label}은(는) 숫자여야 합니다.` })
      .refine((n) => Number.isFinite(n) && n > 0, {
        message: `${label}은(는) 0보다 큰 숫자여야 합니다.`,
      }),
  );
}

function optionalNonNegativeNumber(label: string) {
  return z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: `${label}은(는) 숫자여야 합니다.` })
      .refine((n) => Number.isFinite(n) && n >= 0, {
        message: `${label}은(는) 0 이상의 숫자여야 합니다.`,
      })
      .optional(),
  );
}

export const scmReceiptRowSchema = z.object({
  일자: requiredDate("일자"),
  구분: z.preprocess(
    blankToUndefined,
    z.enum(["입고", "출고"], { error: '구분은(는) "입고" 또는 "출고"여야 합니다.' }),
  ),
  상품코드: requiredTrimmedString("상품코드"),
  상품명: requiredTrimmedString("상품명"),
  수량: requiredPositiveNumber("수량"),
  // 확인한 샘플 시트는 통화 컬럼이 없다(원화 단일 사업자 전제) — 단가가 있으면 KRW로 간주한다.
  단가: optionalNonNegativeNumber("단가"),
  거래처: optionalTrimmedString("거래처"),
});

export type ScmReceiptRow = z.infer<typeof scmReceiptRowSchema>;

/** `raw`를 검증한다. 실패하면 원인을 전부 모아 하나의 에러로 던진다(CLAUDE.md 컨벤션). */
export function parseScmReceiptRow(raw: unknown): ScmReceiptRow {
  const result = scmReceiptRowSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(행 전체)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`SCM 입출고내역 행이 기대한 형식과 맞지 않습니다 — ${detail}`);
  }
  return result.data;
}

/**
 * 여러 원시 행을 도메인 `PurchaseReceiptRow[]`로 변환한다. **"구분=입고" 행만 반영하고
 * "구분=출고" 행은 의도적으로 건너뛴다** — retail-mcp의 판매 원천은 Loyverse/CSV 채널이고,
 * SCM 시트의 출고까지 별도 파이프라인으로 적재하면 같은 판매를 이중 계산하게 된다(SPEC §13
 * "스코프 결정"). `storeId`는 이 원장이 어느 매장 소속인지 시트 자체에 없어(단일 사업장
 * 전제 시트) 호출자가 명시적으로 넘긴다.
 */
export function mapScmRowsToPurchaseReceipts(
  rawRows: unknown[],
  storeId: string,
  defaultCurrency = "KRW",
): PurchaseReceiptRow[] {
  const receipts: PurchaseReceiptRow[] = [];
  rawRows.forEach((raw, idx) => {
    let row: ScmReceiptRow;
    try {
      row = parseScmReceiptRow(raw);
    } catch (err) {
      throw new Error(
        `SCM 입출고내역 ${idx + 1}번째 행 처리 실패: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (row.구분 !== "입고") return; // 출고는 건너뜀(위 문서 주석 — 스코프 결정).
    receipts.push({
      storeId,
      variantId: row.상품코드,
      receivedAt: row.일자,
      receivedQty: String(row.수량),
      unitCost: row.단가 !== undefined ? String(row.단가) : null,
      currency: row.단가 !== undefined ? defaultCurrency : null,
      vendor: row.거래처 ?? null,
    });
  });
  return receipts;
}
