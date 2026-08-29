import { describe, expect, it } from "vitest";
import { evaluateHangingEquals } from "../src/mathTextExtension.js";

describe("evaluateHangingEquals", () => {
  it("evaluates arithmetic ending with =", () => {
    expect(evaluateHangingEquals("2+2=")).toBe("4");
    expect(evaluateHangingEquals("(1+2)*3=")).toBe("9");
  });

  it("returns null without a trailing equals", () => {
    expect(evaluateHangingEquals("2+2")).toBeNull();
    expect(evaluateHangingEquals("x=5")).toBeNull();
  });

  it("returns null for non-numeric results", () => {
    expect(evaluateHangingEquals("f(x)=")).toBeNull();
  });
});
