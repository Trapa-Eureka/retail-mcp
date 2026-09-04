import { describe, expect, it } from "vitest";
import { escapeCsvFormulaPrefix, unescapeCsvFormulaPrefix } from "../src/core/csvSafety.js";

describe("escapeCsvFormulaPrefix / unescapeCsvFormulaPrefix (SEC-004, TASKS T32)", () => {
  it.each(["=SUM(A1)", "+1+1", "-2+3", "@SUM(1)"])(
    "prefixes a dangerous prefix (%s) with a single quote",
    (value) => {
      expect(escapeCsvFormulaPrefix(value)).toBe(`'${value}`);
    },
  );

  it("leaves ordinary values as they are", () => {
    expect(escapeCsvFormulaPrefix("Cola 500ml")).toBe("Cola 500ml");
    expect(escapeCsvFormulaPrefix("SKU-COLA")).toBe("SKU-COLA");
  });

  it.each(["=SUM(A1)", "+1+1", "-2+3", "@SUM(1)"])("escape → unescape round trip (%s)", (value) => {
    expect(unescapeCsvFormulaPrefix(escapeCsvFormulaPrefix(value))).toBe(value);
  });

  it("does not touch values we did not escape (originally starting with ' but not followed by a dangerous character)", () => {
    expect(unescapeCsvFormulaPrefix("'twas the night")).toBe("'twas the night");
  });

  it("leaves a value that is only a single quote as it is", () => {
    expect(unescapeCsvFormulaPrefix("'")).toBe("'");
  });
});
