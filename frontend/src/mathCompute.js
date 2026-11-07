import { ComputeEngine } from "@cortex-js/compute-engine";
import { asciiMathToLatex } from "./mathRender.js";

const MAX_CALC_TIME_MS = 250;
const computeEngine = new ComputeEngine();
computeEngine.timeLimit = MAX_CALC_TIME_MS;
console.info(`Math auto-calc time limit: ${MAX_CALC_TIME_MS}ms`);
const MAX_DOUBLE_EXPONENT = 308;
const MAX_CALC_DECIMAL_PLACES = 6;
const MIN_FIXED_ABSOLUTE_VALUE = 10 ** -MAX_CALC_DECIMAL_PLACES;
const MAX_FIXED_ABSOLUTE_VALUE = 1e21;

function exceedsDoubleRange(numericValue) {
  const exponent = Number(/e([+-]\d+)$/u.exec(String(numericValue))?.[1]);
  return Math.abs(exponent) > MAX_DOUBLE_EXPONENT;
}

function formatCalculationResult(numericValue) {
  if (exceedsDoubleRange(numericValue)) {
    console.warn(`Math auto-calc result out of range: ${String(numericValue).slice(0, 40)}`);
    return null;
  }
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

/** Return the numeric result for a formula ending in "=", or null. */
export function calculateTrailingEquals(asciiMath) {
  const source = String(asciiMath || "").trim();
  if (!source.endsWith("=")) return null;

  const expressionSource = source.slice(0, -1).trim();
  if (!expressionSource) return null;

  const startTime = performance.now();
  try {
    const parsed = computeEngine.parse(asciiMathToLatex(expressionSource));
    if (parsed.operator === "Equal") {
      console.info(`Math auto-calc skipped equation "${expressionSource.slice(0, 60)}"`);
      return null;
    }
    const result = parsed.evaluate().N();
    if (!result.isNumberLiteral || result.isNaN || result.isInfinity) return null;

    const numericValue = result.numericValue;
    if (numericValue == null) return null;
    const formattedValue = formatCalculationResult(numericValue);
    if (formattedValue == null) return null;
    return formattedValue;
  } catch (error) {
    console.warn(
      `Math auto-calc abandoned "${expressionSource}" after ${Math.round(performance.now() - startTime)}ms:`,
      error?.message ?? error,
    );
    return null;
  }
}
