/**
 * CSV/Excel 채널의 고정 템플릿 스키마 (SPEC.md §12 "컬럼 구성"). 실제 파일을 읽고 인코딩을
 * 처리하는 것은 어댑터(TASKS T16, `csvExcelParser.ts`)의 몫이다 — 여기는 "이미 헤더별로
 * 파싱된 한 행 객체"의 유효성만 순수하게 검증한다(외부 IO 없음, CLAUDE.md core 원칙).
 *
 * 컬럼명은 SPEC §12 표에 정의된 그대로(한글)를 키로 쓴다 — 사용자가 실제로 채우는 템플릿
 * 헤더와 코드상의 이름이 다르면 어댑터 쪽에서 매핑 실수가 나기 쉽다.
 *
 * (매장명, SKU) 유일성 같은 "행 하나로는 판단할 수 없는" 검증(파일 전체를 훑어야 함)은
 * 이 스키마의 책임이 아니다 — T16이 여러 행을 순회하며 도메인 행 타입으로 변환할 때 함께
 * 확인한다.
 */
import { z } from "zod";

/** 빈 문자열(셀이 비어 있음)을 "값 없음"으로 취급한다 — 필수 컬럼이면 required 에러로,
 * 선택 컬럼이면 undefined로 이어진다. 이게 없으면 z.coerce.number()가 ""를 0으로 바꿔
 * "칸을 비웠다"와 "0을 채웠다"를 구분하지 못하게 된다(판매이력 모드 판정에 치명적). */
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

function nonNegativeNumber(label: string) {
  return z.coerce
    .number({ error: `${label}은(는) 숫자여야 합니다.` })
    .refine((n) => Number.isFinite(n) && n >= 0, {
      message: `${label}은(는) 0 이상의 숫자여야 합니다.`,
    });
}

/** 필수 숫자 컬럼 — 빈 셀("")도 z.coerce.number()가 0으로 바꾸기 전에 undefined로 돌려
 * "필수인데 비어 있다"는 에러가 정확히 나오게 한다(재고수량 등). */
function requiredNonNegativeNumber(label: string) {
  return z.preprocess(blankToUndefined, nonNegativeNumber(label));
}

function optionalNonNegativeNumber(label: string) {
  return z.preprocess(blankToUndefined, nonNegativeNumber(label).optional());
}

function optionalDate(label: string) {
  return z.preprocess(
    blankToUndefined,
    z.coerce.date({ error: `${label}은(는) 날짜여야 합니다.` }).optional(),
  );
}

function optionalCurrencyCode() {
  return z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "통화는 3글자 코드(예: PHP, KRW, USD)여야 합니다.")
      .transform((v) => v.toUpperCase())
      .optional(),
  );
}

export const csvRowSchema = z
  .object({
    매장명: requiredTrimmedString("매장명"),
    상품명: requiredTrimmedString("상품명"),
    SKU: requiredTrimmedString("SKU"),
    재고수량: requiredNonNegativeNumber("재고수량"),
    판매수량: optionalNonNegativeNumber("판매수량"),
    판매기간시작일: optionalDate("판매기간시작일"),
    판매기간종료일: optionalDate("판매기간종료일"),
    단가: optionalNonNegativeNumber("단가"),
    통화: optionalCurrencyCode(),
    저재고임계치: optionalNonNegativeNumber("저재고임계치"),
  })
  .superRefine((row, ctx) => {
    const hasSales = row.판매수량 !== undefined;
    const hasStart = row.판매기간시작일 !== undefined;
    const hasEnd = row.판매기간종료일 !== undefined;

    if (hasSales && !(hasStart && hasEnd)) {
      ctx.addIssue({
        code: "custom",
        message:
          "판매수량이 있으면 판매기간시작일·판매기간종료일이 모두 있어야 일평균판매를 계산할 수 있습니다.",
        path: ["판매기간시작일"],
      });
    }
    if (!hasSales && (hasStart || hasEnd)) {
      ctx.addIssue({
        code: "custom",
        message: "판매기간만 있고 판매수량이 없습니다 — 판매수량을 채우거나 기간을 지우세요.",
        path: ["판매수량"],
      });
    }
    if (hasStart && hasEnd && row.판매기간시작일! >= row.판매기간종료일!) {
      ctx.addIssue({
        code: "custom",
        message: "판매기간시작일은 판매기간종료일보다 앞서야 합니다.",
        path: ["판매기간종료일"],
      });
    }
    if (row.단가 !== undefined && row.통화 === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "단가가 있으면 통화 코드도 필요합니다(SPEC §9 — 통화 없이 금액을 다루지 않는다).",
        path: ["통화"],
      });
    }
  });

export type CsvRow = z.infer<typeof csvRowSchema>;

/**
 * `raw`(헤더별로 파싱된 한 행)를 검증한다. 실패하면 원인을 전부 모아 하나의 에러로 던진다
 * (CLAUDE.md "에러 메시지는 원인 + 수정 방법까지").
 */
export function parseCsvRow(raw: unknown): CsvRow {
  const result = csvRowSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(행 전체)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`CSV/Excel 행이 SPEC §12 고정 템플릿과 맞지 않습니다 — ${detail}`);
  }
  return result.data;
}

/** 판매이력이 있는 행인지(셀스루 계산 가능) 없는 행인지(임계치 폴백) 판정한다. SPEC §12. */
export type SalesHistoryMode = "history" | "no_history";

export function salesHistoryModeOf(row: CsvRow): SalesHistoryMode {
  return row.판매수량 !== undefined ? "history" : "no_history";
}
