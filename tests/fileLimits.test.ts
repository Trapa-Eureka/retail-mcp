import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CELL_LENGTH,
  MAX_FILE_BYTES,
  MAX_ROWS,
  assertCellLengthWithinLimit,
  assertFileSizeWithinLimit,
  assertRowCountWithinLimit,
} from "../src/adapters/fileLimits.js";

describe("assertRowCountWithinLimit / assertCellLengthWithinLimit (pure, SEC-003)", () => {
  it("passes a row count at or below the limit", () => {
    expect(() => assertRowCountWithinLimit(MAX_ROWS, "f.csv")).not.toThrow();
  });

  it("throws an error naming the cause for a row count over the limit", () => {
    expect(() => assertRowCountWithinLimit(MAX_ROWS + 1, "f.csv")).toThrow(
      /rows.*limit|limit.*rows/,
    );
  });

  it("passes a cell length at or below the limit", () => {
    expect(() =>
      assertCellLengthWithinLimit("a".repeat(MAX_CELL_LENGTH), "f.csv row 1 column product"),
    ).not.toThrow();
  });

  it("throws an error naming the cause (file, row, column) for a cell length over the limit", () => {
    expect(() =>
      assertCellLengthWithinLimit("a".repeat(MAX_CELL_LENGTH + 1), "f.csv row 3 column product"),
    ).toThrow(/f\.csv row 3 column product/);
  });
});

describe("assertFileSizeWithinLimit (IO, SEC-003)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-filelimits-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes a file at or below the limit", async () => {
    const p = join(dir, "small.csv");
    await writeFile(p, "a,b\n1,2\n");
    await expect(assertFileSizeWithinLimit(p)).resolves.toBeUndefined();
  });

  it("rejects a file over the limit before reading its content (stat only)", async () => {
    const p = join(dir, "huge.csv");
    await writeFile(p, Buffer.alloc(MAX_FILE_BYTES + 1, "a"));
    await expect(assertFileSizeWithinLimit(p)).rejects.toThrow(/too large/);
  });
});
