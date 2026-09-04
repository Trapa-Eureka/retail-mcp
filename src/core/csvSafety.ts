/**
 * Defence against CSV spreadsheet formula injection (005 SEC-004, TASKS T32).
 *
 * The snapshot CSV produced by `snapshotExport.ts` serves two purposes at once — (1) it is the
 * machine-readable round-trip input that HQ reads back in with `csvExcelParser.ts` (T16)
 * (SPEC §12 "multi-store head-office consolidated view"), and (2) it is also a human-facing
 * file that a branch person opens directly in Excel/Google Sheets to check it (implementation
 * contract: treated as "a CSV a human may also open" — the "machine-only / human-readable
 * contract definition" the 006 review asked for). Store, product and sku are free text flowing
 * straight from the original CSV/XLSX input, so if they start with `=`, `+`, `-` or `@`,
 * Excel/Sheets may execute them as formulas (CSV quoting only escapes delimiters; it does not
 * prevent formula execution).
 *
 * Response: on export, prefix a single quote (`'`) to values with a dangerous prefix (the
 * standard Excel/Sheets "force as text" convention — the cell is displayed literally instead of
 * being evaluated as a formula). On re-import, `requiredTrimmedString` in `csvSchema.ts` strips
 * exactly this prefix in reverse, restoring the original value — it is stripped symmetrically
 * only in the cases where we added it (it would only have been added when the original value
 * started with a dangerous prefix), so after the round trip (export → import) the data matches
 * the original domain data exactly (pinned by the round-trip test in
 * `tests/snapshotExport.test.ts`).
 */

const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@"]);

/** If the value starts with `=`/`+`/`-`/`@`, prefix it with `'`. Otherwise return it as is. */
export function escapeCsvFormulaPrefix(value: string): string {
  return FORMULA_TRIGGER_CHARS.has(value.charAt(0)) ? `'${value}` : value;
}

/** Strip exactly the prefix that `escapeCsvFormulaPrefix` added — a value that originally
 * started with `'` but whose next character is not a dangerous one (a value we would not have
 * escaped) is left untouched. */
export function unescapeCsvFormulaPrefix(value: string): string {
  return value.charAt(0) === "'" && FORMULA_TRIGGER_CHARS.has(value.charAt(1))
    ? value.slice(1)
    : value;
}
