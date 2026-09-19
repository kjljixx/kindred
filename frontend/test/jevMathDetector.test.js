import { describe, expect, it, vi } from "vitest";
import { classifyMathWithJev } from "../src/jevMathDetector.js";

describe("classifyMathWithJev", () => {
  it("returns expressions selected by Jev", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ranges: [
          { start: 4, end: 10, text: "sin(x)" },
          { start: 15, end: 18, text: "x^2" },
        ],
      }),
    });

    const result = await classifyMathWithJev(
      "Use sin(x) and x^2",
      undefined,
      fetchImpl,
    );

    expect(result.expressions).toEqual(["sin(x)", "x^2"]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/math/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Use sin(x) and x^2",
        candidates: undefined,
      }),
    });
  });
});
