import { describe, expect, it } from "vitest";
import { parseNamedArg } from "../src/core/cliArgs.js";

describe("parseNamedArg (SR2-MAIL-001, 2차 적대적 검수 대응)", () => {
  it("--name=value 형태에서 값을 뽑는다", () => {
    expect(parseNamedArg(["node", "script.js", "--run-id=abc-123"], "run-id")).toBe("abc-123");
  });

  it("다른 플래그들 사이에 있어도 찾는다", () => {
    expect(parseNamedArg(["--sync", "--run-id=xyz", "--confirm"], "run-id")).toBe("xyz");
  });

  it("플래그가 없으면 undefined를 반환한다", () => {
    expect(parseNamedArg(["--sync", "--confirm"], "run-id")).toBeUndefined();
  });

  it("빈 argv면 undefined를 반환한다", () => {
    expect(parseNamedArg([], "run-id")).toBeUndefined();
  });

  it("값이 빈 문자열이면 빈 문자열을 반환한다(undefined와 구분)", () => {
    expect(parseNamedArg(["--run-id="], "run-id")).toBe("");
  });

  it("--name value(공백 구분) 형식은 지원하지 않는다", () => {
    expect(parseNamedArg(["--run-id", "abc-123"], "run-id")).toBeUndefined();
  });

  it("값에 =가 더 있어도 첫 번째 =까지만 접두어로 보고 나머지는 값에 포함한다", () => {
    expect(parseNamedArg(["--run-id=abc=def"], "run-id")).toBe("abc=def");
  });

  it("같은 이름이 여러 번 있으면 첫 번째 값을 쓴다", () => {
    expect(parseNamedArg(["--run-id=first", "--run-id=second"], "run-id")).toBe("first");
  });

  it("이름이 비슷한 다른 플래그(--run-id-extra=x)와 혼동하지 않는다", () => {
    expect(parseNamedArg(["--run-id-extra=x"], "run-id")).toBeUndefined();
  });
});
