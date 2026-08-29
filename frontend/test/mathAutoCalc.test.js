import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import {
  evaluateHangingEquals,
  userInsertedEquals,
} from "../src/mathTextExtension.js";

const schema = new Schema({
  nodes: {
    doc: { content: "text*" },
    text: { inline: true },
  },
});

function transactionInserting(text, insert) {
  const doc = schema.node("doc", null, [schema.text(text)]);
  const state = EditorState.create({ doc });
  return state.tr.insertText(insert, state.doc.content.size);
}

function transactionDeleting(text, fromOffset, toOffset) {
  const doc = schema.node("doc", null, [schema.text(text)]);
  const state = EditorState.create({ doc });
  return state.tr.delete(fromOffset, toOffset);
}

describe("evaluateHangingEquals", () => {
  it("evaluates arithmetic ending with =", () => {
    expect(evaluateHangingEquals("2+2=")).toBe("4");
    expect(evaluateHangingEquals("(1+2)*3=")).toBe("9");
  });

  it("returns null without a trailing equals", () => {
    expect(evaluateHangingEquals("2+2")).toBeNull();
    expect(evaluateHangingEquals("x=5")).toBeNull();
  });

  it("returns null for non-numeric results", () => {
    expect(evaluateHangingEquals("f(x)=")).toBeNull();
  });
});

describe("userInsertedEquals", () => {
  it("returns true when the user inserts =", () => {
    const tr = transactionInserting("2+2", "=");
    expect(userInsertedEquals([tr])).toBe(true);
  });

  it("returns false when the user deletes text", () => {
    const tr = transactionDeleting("2+2=4", 4, 5);
    expect(userInsertedEquals([tr])).toBe(false);
  });

  it("returns false for auto-calc transactions", () => {
    const tr = transactionInserting("2+2=", "4").setMeta("mathAutoCalc", true);
    expect(userInsertedEquals([tr])).toBe(false);
  });
});
