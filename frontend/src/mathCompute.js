import { ComputeEngine } from "@cortex-js/compute-engine";
import { asciiMathToLatex } from "./mathRender.js";

const computeEngine = new ComputeEngine();
const MAX_CALC_DECIMAL_PLACES = 6;
const MIN_FIXED_ABSOLUTE_VALUE = 10 ** -MAX_CALC_DECIMAL_PLACES;
const MAX_FIXED_ABSOLUTE_VALUE = 1e21;

function formatCalculationResult(numericValue) {
  const value = Number(numericValue);
  if (!Number.isFinite(value)) return null;

  const absoluteValue = Math.abs(value);
  if (absoluteValue > 0 && (
    absoluteValue < MIN_FIXED_ABSOLUTE_VALUE
    || absoluteValue >= MAX_FIXED_ABSOLUTE_VALUE
  )) {
    const [coefficient, exponent] = value.toExponential(MAX_CALC_DECIMAL_PLACES).split("e");
    const trimmedCoefficient = coefficient.replace(/\.?0+$/, "");
    return `${trimmedCoefficient}*10^${Number(exponent)}`;
  }

  return String(Number(value.toFixed(MAX_CALC_DECIMAL_PLACES)));
}

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
    const formattedValue = formatCalculationResult(numericValue);
    if (formattedValue == null) return null;
    return `${expressionSource}=${formattedValue}`;
  } catch {
    return null;
  }
}
