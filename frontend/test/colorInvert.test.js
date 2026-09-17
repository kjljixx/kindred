import { describe, expect, it } from "vitest";
import { invertWordLuminanceWindow } from "../src/colorInvert.js";

describe("color inversion", () => {
  it("swaps black and white", () => {
    expect(invertWordLuminanceWindow(0, 0, 0)).toEqual({ r: 255, g: 255, b: 255 });
    expect(invertWordLuminanceWindow(255, 255, 255)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("approximately restores in-gamut colors when applied twice", () => {
    const original = { r: 67, g: 83, b: 96 };
    const once = invertWordLuminanceWindow(original.r, original.g, original.b);
    const twice = invertWordLuminanceWindow(once.r, once.g, once.b);

    expect(twice.r).toBeCloseTo(original.r, -0);
    expect(twice.g).toBeCloseTo(original.g, -0);
    expect(twice.b).toBeCloseTo(original.b, -0);
  });
});
