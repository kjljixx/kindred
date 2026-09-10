import { describe, expect, it } from "vitest";
import { classifyMath, classifyMathHtml } from "../src/mathTextDetector.js";

describe("classifyMath", () => {
  it("detects sin(x) + x^2 as a math run", () => {
    const result = classifyMath("The answer is sin(x) + x^2.");
    expect(result.runs.length).toBeGreaterThan(0);
    const runText = result.runs.map((run) => run.map((t) => t.text).join(" ")).join(" ");
    expect(runText).toContain("sin(");
    expect(runText).toContain("x^");
  });

  it("does not treat lone numbers as math runs", () => {
    const result = classifyMath("I have 3 apples.");
    expect(result.runs).toHaveLength(0);
  });

  it("wraps math ranges in render-latex spans", () => {
    const result = classifyMath("sin(x)");
    expect(result.html).toContain('class="render-latex"');
    expect(result.html).toContain("sin(x)");
  });

  it("detects differentials like dx as math", () => {
    const result = classifyMath("integrate dx over dt.");
    expect(result.runs.length).toBeGreaterThan(0);
    const runText = result.runs.map((run) => run.map((t) => t.text).join(" ")).join(" ");
    expect(runText).toContain("dx");
    expect(runText).toContain("dt");
  });

  it("does not treat URLs containing math-like text as math", () => {
    for (const url of ["https://example.com/x^2", "example.com/x^2"]) {
      const result = classifyMath(`See ${url} for details.`);
      expect(result.ranges).toHaveLength(0);
      expect(result.html).not.toContain('class="render-latex"');
    }
  });

  it("does not treat emails containing math-like text as math", () => {
    const result = classifyMath("winston.r.cai@gmail.com");

    expect(result.ranges).toHaveLength(0);
    expect(result.html).not.toContain('class="render-latex"');
  });

  it("does not treat punctuation-wrapped URLs as math", () => {
    const result = classifyMath(
      "(https://community.wolfram.com/groups/-/m/t/3503047).",
    );

    expect(result.ranges).toHaveLength(0);
    expect(result.html).not.toContain('class="render-latex"');
  });

  it("does not treat punctuation-wrapped emails as math", () => {
    const result = classifyMath("(winston.r.cai@gmail.com).");

    expect(result.ranges).toHaveLength(0);
    expect(result.html).not.toContain('class="render-latex"');
  });

  it("does not treat phone numbers as math", () => {
    for (const phoneNumber of [
      "+1 123 456 7890",
      "(123) 456-7890",
      "123-456-7890",
      "123.456.7890",
    ]) {
      const result = classifyMath(`Call ${phoneNumber}.`);

      expect(result.ranges).toHaveLength(0);
      expect(result.html).not.toContain('class="render-latex"');
    }
  });

  it("does not expand a math range across text punctuation", () => {
    const result = classifyMath("x.");

    expect(result.ranges).toEqual([{ start: 0, end: 1 }]);
    expect(result.html).toBe('<span class="render-latex">x</span>.');
  });

  it("does not classify visible link text as math", () => {
    const html = '<p><a href="https://example.com">x^2</a></p>';

    expect(classifyMathHtml(html)).toBe(html);
  });
});
