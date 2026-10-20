import { describe, expect, it, vi } from "vitest";
import { suggestionDiffParts } from "../src/suggestionDiff.js";

const EQUAL = 0;
const INSERT = 1;
const DELETE = -1;

describe("suggestionDiffParts", () => {
  it("names the word diff parts for the chat renderer", () => {
    const wordDiff = vi.fn(() => [[DELETE, "During"], [INSERT, "In"], [EQUAL, " middle school, I built a tank algorithm"]]);

    expect(suggestionDiffParts("During middle school, I built a tank algorithm", "In middle school, I built a tank algorithm", wordDiff)).toEqual([
      { type: "delete", text: "During" },
      { type: "insert", text: "In" },
      { type: "equal", text: " middle school, I built a tank algorithm" },
    ]);
    expect(wordDiff).toHaveBeenCalledWith("During middle school, I built a tank algorithm", "In middle school, I built a tank algorithm");
  });

  it("skips one- or two-word suggestions without running the diff", () => {
    const wordDiff = vi.fn();

    expect(suggestionDiffParts("text", "clearer", wordDiff)).toBeNull();
    expect(suggestionDiffParts("a  big", "a huge", wordDiff)).toBeNull();
    expect(wordDiff).not.toHaveBeenCalled();
  });

  it("skips very long suggestions without running the diff", () => {
    const wordDiff = vi.fn();
    const long = "word ".repeat(1001);

    expect(suggestionDiffParts(long, "short rewrite of many words", wordDiff)).toBeNull();
    expect(wordDiff).not.toHaveBeenCalled();
  });

  it("skips rewrites that keep less than 10% of the text", () => {
    const original = "the quick brown fox jumps over";
    const replacement = "a completely different sentence appears";
    const wordDiff = () => [[DELETE, original], [INSERT, replacement]];

    expect(suggestionDiffParts(original, replacement, wordDiff)).toBeNull();
  });

  it("keeps a heavy rewrite that still shares common words", () => {
    const original = "During middle school, I built a tank algorithm for a programming competition";
    const replacement = "For a middle-school contest, I built an algorithm";
    const wordDiff = () => [
      [DELETE, "During middle school"], [INSERT, "For a middle-school contest"],
      [EQUAL, ", I built a"], [DELETE, " tank"], [INSERT, "n"], [EQUAL, " algorithm"],
      [DELETE, " for a programming competition"],
    ];

    expect(suggestionDiffParts(original, replacement, wordDiff)).toHaveLength(7);
  });

  it("keeps a diff that preserves enough of the text", () => {
    const original = "the quick brown fox jumps over";
    const replacement = "the quick brown fox leaps over";
    const wordDiff = () => [[EQUAL, "the quick brown fox "], [DELETE, "jumps"], [INSERT, "leaps"], [EQUAL, " over"]];

    expect(suggestionDiffParts(original, replacement, wordDiff)).toHaveLength(4);
  });
});
