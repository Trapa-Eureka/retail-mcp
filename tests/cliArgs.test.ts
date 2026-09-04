import { describe, expect, it } from "vitest";
import { parseNamedArg } from "../src/core/cliArgs.js";

describe("parseNamedArg (SR2-MAIL-001, second adversarial review response)", () => {
  it("extracts the value from the --name=value form", () => {
    expect(parseNamedArg(["node", "script.js", "--run-id=abc-123"], "run-id")).toBe("abc-123");
  });

  it("finds it even between other flags", () => {
    expect(parseNamedArg(["--sync", "--run-id=xyz", "--confirm"], "run-id")).toBe("xyz");
  });

  it("returns undefined when the flag is absent", () => {
    expect(parseNamedArg(["--sync", "--confirm"], "run-id")).toBeUndefined();
  });

  it("returns undefined for an empty argv", () => {
    expect(parseNamedArg([], "run-id")).toBeUndefined();
  });

  it("returns an empty string when the value is empty (distinct from undefined)", () => {
    expect(parseNamedArg(["--run-id="], "run-id")).toBe("");
  });

  it("does not support the --name value (space-separated) form", () => {
    expect(parseNamedArg(["--run-id", "abc-123"], "run-id")).toBeUndefined();
  });

  it("treats only the first = as the prefix and keeps any further = in the value", () => {
    expect(parseNamedArg(["--run-id=abc=def"], "run-id")).toBe("abc=def");
  });

  it("uses the first value when the same name appears several times", () => {
    expect(parseNamedArg(["--run-id=first", "--run-id=second"], "run-id")).toBe("first");
  });

  it("does not confuse a similarly named flag (--run-id-extra=x)", () => {
    expect(parseNamedArg(["--run-id-extra=x"], "run-id")).toBeUndefined();
  });
});
