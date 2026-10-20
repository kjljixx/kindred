const MAX_CHARS = 5000;
const MAX_WORDS_FOR_PLAIN_CHIP = 2;
const MIN_UNCHANGED_SHARE = 0.1;
const PART_TYPES = new Map([[-1, "delete"], [0, "equal"], [1, "insert"]]);

console.debug("kindred: suggestion diff config", {
  maxChars: MAX_CHARS,
  maxWordsForPlainChip: MAX_WORDS_FOR_PLAIN_CHIP,
  minUnchangedShare: MIN_UNCHANGED_SHARE,
});

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

/** Word diff of a suggestion as [{ type: "equal" | "insert" | "delete", text }], or null to show both versions. */
export function suggestionDiffParts(original, replacement, wordDiffParts) {
  const skip = (reason) => {
    console.debug(`kindred: suggestion diff skipped (${reason})`);
    return null;
  };
  const longest = Math.max(original.length, replacement.length);
  if (longest > MAX_CHARS) return skip(`${longest} chars`);
  if (wordCount(original) <= MAX_WORDS_FOR_PLAIN_CHIP && wordCount(replacement) <= MAX_WORDS_FOR_PLAIN_CHIP) {
    return skip("short suggestion");
  }
  const parts = wordDiffParts(original, replacement);
  const unchanged = parts.reduce((total, [op, text]) => (op === 0 ? total + text.length : total), 0);
  const share = unchanged / longest;
  const percent = Math.round(share * 100);
  if (share < MIN_UNCHANGED_SHARE) return skip(`${percent}% unchanged`);
  console.debug(`kindred: suggestion diff built (${parts.length} parts, ${percent}% unchanged)`);
  return parts.map(([op, text]) => ({ type: PART_TYPES.get(op), text }));
}
