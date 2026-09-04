/**
 * Size, row-count and cell-length limits for CSV/Excel input files (005 SEC-003, TASKS T32).
 *
 * This responds to the finding that a large or zip-bomb XLSX, or a huge CSV, dropped into the
 * watched folder could exhaust process memory and CPU. The three limits address different
 * threat models and do not replace one another:
 *
 * - **File size (bytes on disk)** — CSV is plain text, so the on-disk size is roughly the
 *   memory ceiling (up to about 2x depending on encoding conversion). There is no compression,
 *   so this single limit is enough of a defence.
 * - **Row count** — XLSX is zip-compressed, so disk size alone cannot stop a zip bomb where "a
 *   small file expands into a gigantic worksheet". `parseExcelFile` in `csvExcelParser.ts`
 *   reads rows one by one with a streaming reader and stops the moment this limit is exceeded,
 *   without reading the rest of the compressed data — an early block against both a
 *   normal-sized file holding a pathological number of rows (the most common mistake) and a zip
 *   expansion attack.
 * - **Cell length** — zip compression lets a single cell (especially a repeated shared string)
 *   expand from a tiny compressed size into a huge string. Independently of the row-count
 *   limit, the length of individual values is limited too.
 *
 * **Known residual risk**: ExcelJS's streaming reader by default runs in `sharedStrings: 'cache'`
 * mode and caches the zip's entire shared-strings table in memory before reading worksheet rows
 * (an internal implementation boundary — this project cannot change it). If the shared-strings
 * table itself contains an extremely large single string, that string has already been expanded
 * in memory before our cell-length check runs. The file-size limit still bounds the maximum
 * size of the zip itself, so expansion is not unlimited, but we do not claim to block the
 * "small file → one gigantic cell string" attack 100% — it is a residual risk recorded honestly,
 * of the same kind as explore_sql's READ ONLY transaction not blocking advisory-lock side
 * effects (see docs/005 SEC-001).
 */
import { stat } from "node:fs/promises";

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_ROWS = 100_000;
export const MAX_CELL_LENGTH = 10_000;

function formatBytes(n: number): string {
  return `${n.toLocaleString("en-US")} bytes`;
}

/** Check the on-disk file size before reading — it is the only check that can reject the file
 * before its content is loaded into memory, so it is always called before the other two
 * limits. */
export async function assertFileSizeWithinLimit(filePath: string): Promise<void> {
  const info = await stat(filePath);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large (${filePath}): ${formatBytes(info.size)} — exceeds the limit of ` +
        `${formatBytes(MAX_FILE_BYTES)} (20MB). Split the file by period or store and ` +
        "export it again.",
    );
  }
}

/** Throw when the number of data rows read so far exceeds the limit — a streaming parser can
 * repeat this call per row and stop reading the rest of the input as soon as it is exceeded. */
export function assertRowCountWithinLimit(count: number, filePath: string): void {
  if (count > MAX_ROWS) {
    throw new Error(
      `File has too many data rows (${filePath}): more than ${count.toLocaleString("en-US")} rows — ` +
        `exceeds the limit of ${MAX_ROWS.toLocaleString("en-US")} rows. Split the file and try again.`,
    );
  }
}

/** `context` carries the file name, row and column so a person can locate the cell right away. */
export function assertCellLengthWithinLimit(value: string, context: string): void {
  if (value.length > MAX_CELL_LENGTH) {
    throw new Error(
      `Cell value is too long (${context}): ${value.length.toLocaleString("en-US")} characters — exceeds the limit of ` +
        `${MAX_CELL_LENGTH.toLocaleString("en-US")} characters.`,
    );
  }
}
