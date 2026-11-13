import { mathFunctions, mathWords } from "./mathTextDetector.js";

const OPENERS = { ")": "(", "]": "[", "}": "{" };
const namedSymbols = new Set([...mathFunctions, ...mathWords]);

function groupStart(source, closeIndex) {
  const stack = [];
  for (let i = closeIndex; i >= 0; i -= 1) {
    const character = source[i];
    if (OPENERS[character]) stack.push(OPENERS[character]);
    else if (character === stack[stack.length - 1]) stack.pop();
    if (!stack.length) return i;
  }
  return -1;
}

function lettersStart(source, end) {
  let start = end;
  while (start > 0 && /\p{L}/u.test(source[start - 1])) start -= 1;
  return start;
}

function simpleAtomStart(source, end) {
  const last = source[end - 1];
  if (OPENERS[last]) {
    const open = groupStart(source, end - 1);
    return open < 0 ? -1 : lettersStart(source, open);
  }
  if (/[\p{N}.]/u.test(last)) {
    let start = end;
    while (start > 0 && /[\p{N}.]/u.test(source[start - 1])) start -= 1;
    return start;
  }
  if (/\p{L}/u.test(last)) {
    const letters = lettersStart(source, end);
    return namedSymbols.has(source.slice(letters, end).toLowerCase()) ? letters : end - 1;
  }
  return -1;
}

function numeratorStart(source, end) {
  let start = simpleAtomStart(source, end);
  while (start > 1 && (source[start - 1] === "^" || source[start - 1] === "_")) {
    const baseStart = simpleAtomStart(source, start - 1);
    if (baseStart < 0) break;
    start = baseStart;
  }
  return start;
}

function needsParentheses(numerator) {
  if (/^[\p{N}.]+$/u.test(numerator)) return false;
  return !(OPENERS[numerator.at(-1)] && groupStart(numerator, numerator.length - 1) === 0 && numerator[0] === "(");
}

/**
 * MathLive's ASCIIMath parser only stacks a fraction when the numerator is a number or a
 * bracketed group. Bracket every other numerator so `x/6` matches asciimath2tex's `\frac{x}{6}`.
 */
export function parenthesizeFractionNumerators(source) {
  let result = String(source || "");
  for (let i = 0; i < result.length; i += 1) {
    if (result[i] !== "/") continue;
    let end = i;
    while (end > 0 && result[end - 1] === " ") end -= 1;
    const start = end > 0 ? numeratorStart(result, end) : -1;
    if (start < 0) continue;
    const numerator = result.slice(start, end);
    if (!needsParentheses(numerator)) continue;
    result = `${result.slice(0, start)}(${numerator})${result.slice(i)}`;
    i = end + 2;
  }
  return result;
}
