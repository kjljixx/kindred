import { describe, expect, it } from "vitest";
import { convertAsciiMathToLatex } from "mathlive";
import { parenthesizeFractionNumerators } from "../src/asciiMathFractions.js";

const stacked = (source) => convertAsciiMathToLatex(parenthesizeFractionNumerators(source));

describe("parenthesizeFractionNumerators", () => {
  it.each([
    ["x/6", "(x)/6"],
    ["a/b", "(a)/b"],
    ["x^2/6", "(x^2)/6"],
    ["x_1/6", "(x_1)/6"],
    ["e^(2x)/6", "(e^(2x))/6"],
    ["f(x)/6", "(f(x))/6"],
    ["sin(x)/6", "(sin(x))/6"],
    ["pi/6", "(pi)/6"],
    ["xy/6", "x(y)/6"],
    ["2x/6", "2(x)/6"],
    ["-x/6", "-(x)/6"],
    ["x /6", "(x)/6"],
    ["x/y/2", "(x)/(y)/2"],
  ])("brackets the numerator in %s", (source, expected) => {
    expect(parenthesizeFractionNumerators(source)).toBe(expected);
  });

  it.each(["6/x", "1.5/x", "(x+1)/6", "x+1", "x", "", "/6"])(
    "leaves %j unchanged",
    (source) => {
      expect(parenthesizeFractionNumerators(source)).toBe(source);
    },
  );

  it.each([
    ["x/6", "\\frac{x}{6}"],
    ["a/b", "\\frac{a}{b}"],
    ["x^2/6", "\\frac{x^{2}}{6}"],
    ["pi/6", "\\frac{\\pi }{6}"],
    ["6/x", "\\frac{6}{x}"],
  ])("makes MathLive stack %s", (source, latex) => {
    expect(stacked(source)).toBe(latex);
  });
});
