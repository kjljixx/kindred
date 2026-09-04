import { ComputeEngine } from "@cortex-js/compute-engine";
import { asciiMathToLatex } from "./mathRender.js";

const computeEngine = new ComputeEngine();
const MAX_CALC_DECIMAL_PLACES = 6;

export function isMathLiveEqualsInput(event) {
  return event?.inputType === "insertText" && event.data === "=";
}

/** Return a numeric result for a formula ending in "=", or null. */
export function calculateTrailingEquals(asciiMath) {
  const source = String(asciiMath || "").trim();
  if (!source.endsWith("=")) return null;

  const expressionSource = source.slice(0, -1).trim();
  if (!expressionSource) return null;

  try {
    const result = computeEngine
      .parse(asciiMathToLatex(expressionSource))
      .evaluate()
      .N();
    if (!result.isNumberLiteral || result.isNaN || result.isInfinity) return null;

    const numericValue = result.numericValue;
    if (numericValue == null) return null;
    const roundedValue = Number(Number(numericValue).toFixed(MAX_CALC_DECIMAL_PLACES));
    if (!Number.isFinite(roundedValue)) return null;
    return `${expressionSource}=${roundedValue}`;
  } catch {
    return null;
  }
}
