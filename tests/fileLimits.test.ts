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

describe("assertRowCountWithinLimit / assertCellLengthWithinLimit (순수, SEC-003)", () => {
  it("상한 이하 행 수는 통과한다", () => {
    expect(() => assertRowCountWithinLimit(MAX_ROWS, "f.csv")).not.toThrow();
  });

  it("상한을 넘는 행 수는 원인이 담긴 에러를 던진다", () => {
    expect(() => assertRowCountWithinLimit(MAX_ROWS + 1, "f.csv")).toThrow(/행.*상한|상한.*행/);
  });

  it("상한 이하 셀 길이는 통과한다", () => {
    expect(() =>
      assertCellLengthWithinLimit("a".repeat(MAX_CELL_LENGTH), "f.csv 1행 상품명열"),
    ).not.toThrow();
  });

  it("상한을 넘는 셀 길이는 원인(파일·행·열)이 담긴 에러를 던진다", () => {
    expect(() =>
      assertCellLengthWithinLimit("a".repeat(MAX_CELL_LENGTH + 1), "f.csv 3행 상품명열"),
    ).toThrow(/f\.csv 3행 상품명열/);
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

  it("상한 이하 파일은 통과한다", async () => {
    const p = join(dir, "small.csv");
    await writeFile(p, "a,b\n1,2\n");
    await expect(assertFileSizeWithinLimit(p)).resolves.toBeUndefined();
  });

  it("상한을 넘는 파일은 내용을 읽기 전에(stat만으로) 거부한다", async () => {
    const p = join(dir, "huge.csv");
    await writeFile(p, Buffer.alloc(MAX_FILE_BYTES + 1, "a"));
    await expect(assertFileSizeWithinLimit(p)).rejects.toThrow(/너무 큽니다/);
  });
});
