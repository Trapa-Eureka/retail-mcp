import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeFileBytes,
  mapRowsToDomain,
  parseInventoryFile,
} from "../src/adapters/csvExcelParser.js";
import { MAX_CELL_LENGTH, MAX_ROWS } from "../src/adapters/fileLimits.js";

const FIXTURES_DIR = "tests/fixtures/csvExcel";
const NOW = new Date("2026-09-03T00:00:00Z");

describe("decodeFileBytes", () => {
  it("UTF-8 파일을 UTF-8로 인식한다", async () => {
    const bytes = await readFile(`${FIXTURES_DIR}/inventory-utf8.csv`);
    const { text, encoding } = decodeFileBytes(bytes);
    expect(encoding).toBe("utf-8");
    expect(text).toContain("코카콜라");
  });

  it("EUC-KR/CP949 파일을 euc-kr로 인식하고 올바르게 디코딩한다", async () => {
    const bytes = await readFile(`${FIXTURES_DIR}/inventory-euckr.csv`);
    const { text, encoding } = decodeFileBytes(bytes);
    expect(encoding).toBe("euc-kr");
    expect(text).toContain("코카콜라");
  });

  it("둘 다 아니면(깨진 바이트) 명시적 에러를 던진다(무음 mojibake 금지)", () => {
    // UTF-8로도 EUC-KR로도 유효하지 않은 바이트 시퀀스.
    const garbage = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81]);
    expect(() => decodeFileBytes(garbage)).toThrow(/인코딩/);
  });
});

describe("parseInventoryFile", () => {
  it("UTF-8 CSV 픽스처를 정상 파싱한다", async () => {
    const result = await parseInventoryFile(`${FIXTURES_DIR}/inventory-utf8.csv`, NOW);
    expect(result.stores.map((s) => s.id).sort()).toEqual(["마카티점", "본점"]);
    expect(result.products.find((p) => p.variantId === "SKU-COLA")?.name).toBe("코카콜라 500ml");
    expect(result.inventory).toHaveLength(3);
    // 본점/SKU-COLA는 판매이력 있음 → salesPeriodAgg에 존재.
    expect(result.salesPeriodAgg).toEqual([
      {
        storeId: "본점",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-08-01"),
        periodEnd: new Date("2026-08-29"),
        soldQty: "56",
      },
    ]);
  });

  it("EUC-KR/CP949 CSV 픽스처를 정상 파싱한다(UTF-8과 동일한 결과)", async () => {
    const utf8Result = await parseInventoryFile(`${FIXTURES_DIR}/inventory-utf8.csv`, NOW);
    const eucKrResult = await parseInventoryFile(`${FIXTURES_DIR}/inventory-euckr.csv`, NOW);
    expect(eucKrResult).toEqual(utf8Result);
  });

  it("XLSX 픽스처(네이티브 숫자/날짜 셀)를 정상 파싱한다", async () => {
    const result = await parseInventoryFile(`${FIXTURES_DIR}/inventory.xlsx`, NOW);
    expect(result.stores.map((s) => s.id).sort()).toEqual(["마카티점", "본점"]);
    const cola = result.inventory.find((r) => r.storeId === "본점" && r.variantId === "SKU-COLA");
    expect(cola?.inStock).toBe("40");
    expect(result.salesPeriodAgg).toEqual([
      {
        storeId: "본점",
        variantId: "SKU-COLA",
        periodStart: new Date("2026-08-01"),
        periodEnd: new Date("2026-08-29"),
        soldQty: "56",
      },
    ]);
  });

  it("지원하지 않는 확장자는 명시적으로 거부한다", async () => {
    await expect(parseInventoryFile("inventory.txt", NOW)).rejects.toThrow(/지원하지 않는/);
  });
});

describe("parseInventoryFile — 크기/행 수/셀 길이 상한(SEC-003, TASKS T32)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-csvexcel-limits-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("CSV — 행 수가 상한을 넘으면 도메인 검증 전에 거부한다", async () => {
    const header = "매장명,상품명,SKU,재고수량\n";
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `본점,상품${i},SKU-${i},1`).join(
      "\n",
    );
    const p = join(dir, "too-many-rows.csv");
    await writeFile(p, header + rows + "\n", "utf8");
    await expect(parseInventoryFile(p, NOW)).rejects.toThrow(/행.*상한|상한.*행/);
  });

  it("CSV — 셀 값이 상한보다 길면 거부한다", async () => {
    const p = join(dir, "long-cell.csv");
    const longValue = "x".repeat(MAX_CELL_LENGTH + 1);
    await writeFile(p, `매장명,상품명,SKU,재고수량\n본점,${longValue},SKU-1,1\n`, "utf8");
    await expect(parseInventoryFile(p, NOW)).rejects.toThrow(/셀 값이 너무 깁니다/);
  });

  it("XLSX — 상한을 넘는 대량 행을 거부한다(buffered 판정 — csvExcelParser.ts 문서의 잔여 위험 참고)", async () => {
    const p = join(dir, "too-many-rows.xlsx");
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: p });
    const sheet = writer.addWorksheet("Sheet1");
    sheet.addRow(["매장명", "상품명", "SKU", "재고수량"]).commit();
    for (let i = 0; i < MAX_ROWS + 1; i++) {
      sheet.addRow(["본점", `상품${i}`, `SKU-${i}`, 1]).commit();
    }
    sheet.commit();
    await writer.commit();

    await expect(parseInventoryFile(p, NOW)).rejects.toThrow(/행.*상한|상한.*행/);
  });

  it("XLSX — 셀 값이 상한보다 길면 거부한다", async () => {
    const p = join(dir, "long-cell.xlsx");
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: p });
    const sheet = writer.addWorksheet("Sheet1");
    sheet.addRow(["매장명", "상품명", "SKU", "재고수량"]).commit();
    sheet.addRow(["본점", "x".repeat(MAX_CELL_LENGTH + 1), "SKU-1", 1]).commit();
    sheet.commit();
    await writer.commit();

    await expect(parseInventoryFile(p, NOW)).rejects.toThrow(/셀 값이 너무 깁니다/);
  });
});

describe("mapRowsToDomain", () => {
  const BASE_ROW = {
    매장명: "본점",
    상품명: "코카콜라 500ml",
    SKU: "SKU-COLA",
    재고수량: "40",
  };

  it("빈 파일(행 없음)은 명시적으로 거부한다", () => {
    expect(() => mapRowsToDomain([], NOW)).toThrow(/데이터 행이 없습니다/);
  });

  it("행 검증 실패를 모아서 하나의 에러로 던진다(부분 처리 없음)", () => {
    const rows = [{ ...BASE_ROW, 재고수량: "40" }, { 상품명: "누락 매장" }];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(/1개 행 오류/);
  });

  it("같은 파일 안에서 (매장명,SKU) 중복은 거부한다", () => {
    const rows = [BASE_ROW, BASE_ROW];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(/중복/);
  });

  it("같은 SKU가 다른 상품명으로 나오면 거부한다", () => {
    const rows = [BASE_ROW, { ...BASE_ROW, 매장명: "마카티점", 상품명: "코카콜라 1.5L" }];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(/상품명이 이전 행/);
  });

  it("같은 SKU가 다른 저재고임계치로 나오면 거부한다", () => {
    const rows = [
      { ...BASE_ROW, 저재고임계치: "10" },
      { ...BASE_ROW, 매장명: "마카티점", 저재고임계치: "5" },
    ];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(/저재고임계치가 이전 행/);
  });

  it("저재고임계치가 일관되면 products에 반영된다", () => {
    const rows = [
      { ...BASE_ROW, 저재고임계치: "10" },
      { ...BASE_ROW, 매장명: "마카티점", 저재고임계치: "10" },
    ];
    const result = mapRowsToDomain(rows, NOW);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.lowStockThreshold).toBe("10");
  });

  it("같은 SKU가 다른 포장수량(SPEC §14)으로 나오면 거부한다", () => {
    const rows = [
      { ...BASE_ROW, 포장수량: "24" },
      { ...BASE_ROW, 매장명: "마카티점", 포장수량: "12" },
    ];
    expect(() => mapRowsToDomain(rows, NOW)).toThrow(/포장수량이 이전 행/);
  });

  it("포장수량이 일관되면(또는 둘 다 생략되면) products에 반영된다", () => {
    const withPackSize = mapRowsToDomain(
      [
        { ...BASE_ROW, 포장수량: "24" },
        { ...BASE_ROW, 매장명: "마카티점", 포장수량: "24" },
      ],
      NOW,
    );
    expect(withPackSize.products[0]?.packSize).toBe("24");

    const withoutPackSize = mapRowsToDomain([BASE_ROW], NOW);
    expect(withoutPackSize.products[0]?.packSize).toBeNull();
  });

  it("판매이력 없는 행은 salesPeriodAgg에 들어가지 않는다(임계치 폴백 대상)", () => {
    const result = mapRowsToDomain([BASE_ROW], NOW);
    expect(result.salesPeriodAgg).toEqual([]);
    expect(result.inventory).toEqual([
      { storeId: "본점", variantId: "SKU-COLA", inStock: "40", updatedAt: NOW },
    ]);
  });

  it("inventory의 updatedAt은 호출자가 준 now를 그대로 쓴다(Clock 주입)", () => {
    const customNow = new Date("2020-01-01T00:00:00Z");
    const result = mapRowsToDomain([BASE_ROW], customNow);
    expect(result.inventory[0]?.updatedAt).toBe(customNow);
  });
});
