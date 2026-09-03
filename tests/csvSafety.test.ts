import { describe, expect, it } from "vitest";
import { escapeCsvFormulaPrefix, unescapeCsvFormulaPrefix } from "../src/core/csvSafety.js";

describe("escapeCsvFormulaPrefix / unescapeCsvFormulaPrefix (SEC-004, TASKS T32)", () => {
  it.each(["=SUM(A1)", "+1+1", "-2+3", "@SUM(1)"])(
    "위험 접두사(%s)는 앞에 작은따옴표가 붙는다",
    (value) => {
      expect(escapeCsvFormulaPrefix(value)).toBe(`'${value}`);
    },
  );

  it("평범한 값은 그대로 둔다", () => {
    expect(escapeCsvFormulaPrefix("코카콜라 500ml")).toBe("코카콜라 500ml");
    expect(escapeCsvFormulaPrefix("SKU-COLA")).toBe("SKU-COLA");
  });

  it.each(["=SUM(A1)", "+1+1", "-2+3", "@SUM(1)"])("escape → unescape 왕복(%s)", (value) => {
    expect(unescapeCsvFormulaPrefix(escapeCsvFormulaPrefix(value))).toBe(value);
  });

  it("우리가 escape하지 않은 값(원래부터 '로 시작하지만 위험 문자가 아닌 경우)은 건드리지 않는다", () => {
    expect(unescapeCsvFormulaPrefix("'twas the night")).toBe("'twas the night");
  });

  it("작은따옴표 하나뿐인 값은 그대로 둔다", () => {
    expect(unescapeCsvFormulaPrefix("'")).toBe("'");
  });
});
