/**
 * Fixed template schema for the CSV/Excel channel (SPEC.md §12 "column layout"). Reading the
 * actual file and handling its encoding is the adapter's job (TASKS T16, `csvExcelParser.ts`)
 * — this module only validates "a single row object already parsed per header", purely
 * (no external IO, CLAUDE.md core principle).
 *
 * The column names are used as keys exactly as defined in the SPEC §12 table — if the template
 * header the user actually fills in differs from the name in code, mapping mistakes on the
 * adapter side become easy to make.
 *
 * Validations that "cannot be decided from a single row" (they need a pass over the whole
 * file), such as (store, sku) uniqueness, are not this schema's responsibility — T16 checks
 * them while iterating over the rows and converting them into domain row types.
 */
import { z } from "zod";
import { unescapeCsvFormulaPrefix } from "./csvSafety.js";

/** Treat an empty string (blank cell) as "no value" — for a required column this becomes a
 * required error, for an optional column it becomes undefined. Without this, z.coerce.number()
 * turns "" into 0 and we could not distinguish "left the cell blank" from "filled in 0"
 * (fatal for the sales-history mode decision). */
function blankToUndefined(v: unknown): unknown {
  if (typeof v === "string" && v.trim() === "") return undefined;
  return v;
}

/** After blankToUndefined and after trim, reverse the formula-injection escape (SEC-004,
 * TASKS T32 — `core/csvSafety.ts`). Trimming first means the prefix check stays stable even
 * if a person opens the snapshot CSV and accidentally leaves leading whitespace (`  '=foo`).
 * Applied only to free-text columns a human fills in, such as store, product and sku — other
 * string columns such as the currency code have a fixed format, so a dangerous prefix cannot
 * occur there in the first place. */
function requiredTrimmedString(label: string) {
  return z.preprocess(
    (v) => {
      const afterBlank = blankToUndefined(v);
      return typeof afterBlank === "string"
        ? unescapeCsvFormulaPrefix(afterBlank.trim())
        : afterBlank;
    },
    z.string({ error: `${label} is a required column.` }).min(1, `${label} is empty.`),
  );
}

function nonNegativeNumber(label: string) {
  return z.coerce
    .number({ error: `${label} must be a number.` })
    .refine((n) => Number.isFinite(n) && n >= 0, {
      message: `${label} must be a number of 0 or more.`,
    });
}

/** Required numeric column — a blank cell ("") is turned back into undefined before
 * z.coerce.number() would make it 0, so the error correctly says "required but empty"
 * (stock_qty etc.). */
function requiredNonNegativeNumber(label: string) {
  return z.preprocess(blankToUndefined, nonNegativeNumber(label));
}

function optionalNonNegativeNumber(label: string) {
  return z.preprocess(blankToUndefined, nonNegativeNumber(label).optional());
}

/** pack_size (pack size, SPEC §14) — 0 is meaningless because it cannot be told apart from
 * "no pack unit", so the value must be greater than 0. */
function optionalPositiveNumber(label: string) {
  return z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: `${label} must be a number.` })
      .refine((n) => Number.isFinite(n) && n > 0, {
        message: `${label} must be a number greater than 0.`,
      })
      .optional(),
  );
}

function optionalDate(label: string) {
  return z.preprocess(
    blankToUndefined,
    z.coerce.date({ error: `${label} must be a date.` }).optional(),
  );
}

function optionalCurrencyCode() {
  return z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter code (e.g. PHP, KRW, USD).")
      .transform((v) => v.toUpperCase())
      .optional(),
  );
}

export const csvRowSchema = z
  .object({
    store: requiredTrimmedString("store"),
    product: requiredTrimmedString("product"),
    sku: requiredTrimmedString("sku"),
    stock_qty: requiredNonNegativeNumber("stock_qty"),
    sales_qty: optionalNonNegativeNumber("sales_qty"),
    period_start: optionalDate("period_start"),
    period_end: optionalDate("period_end"),
    unit_price: optionalNonNegativeNumber("unit_price"),
    currency: optionalCurrencyCode(),
    low_stock_threshold: optionalNonNegativeNumber("low_stock_threshold"),
    // SPEC §14 "pack-unit rounding" — optional column. When absent the item is treated as one
    // that can be bought individually (older templates without this column still parse —
    // backward compatible).
    pack_size: optionalPositiveNumber("pack_size"),
  })
  .superRefine((row, ctx) => {
    const hasSales = row.sales_qty !== undefined;
    const hasStart = row.period_start !== undefined;
    const hasEnd = row.period_end !== undefined;

    if (hasSales && !(hasStart && hasEnd)) {
      ctx.addIssue({
        code: "custom",
        message:
          "If sales_qty is present, both period_start and period_end are required to compute average daily sales.",
        path: ["period_start"],
      });
    }
    if (!hasSales && (hasStart || hasEnd)) {
      ctx.addIssue({
        code: "custom",
        message:
          "A sales period is given but sales_qty is missing — fill in sales_qty or clear the period.",
        path: ["sales_qty"],
      });
    }
    if (hasStart && hasEnd && row.period_start! >= row.period_end!) {
      ctx.addIssue({
        code: "custom",
        message: "period_start must be before period_end.",
        path: ["period_end"],
      });
    }
    if (row.unit_price !== undefined && row.currency === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "If unit_price is present, a currency code is also required (SPEC §9 — amounts are never handled without a currency).",
        path: ["currency"],
      });
    }
  });

export type CsvRow = z.infer<typeof csvRowSchema>;

/**
 * Validate `raw` (a single row parsed per header). On failure, collect every cause and throw
 * a single error (CLAUDE.md "error messages give the cause and how to fix it").
 */
export function parseCsvRow(raw: unknown): CsvRow {
  const result = csvRowSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(whole row)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`CSV/Excel row does not match the SPEC §12 fixed template — ${detail}`);
  }
  return result.data;
}

/** Decide whether a row has sales history (sell-through can be computed) or not (threshold
 * fallback). SPEC §12. */
export type SalesHistoryMode = "history" | "no_history";

export function salesHistoryModeOf(row: CsvRow): SalesHistoryMode {
  return row.sales_qty !== undefined ? "history" : "no_history";
}
