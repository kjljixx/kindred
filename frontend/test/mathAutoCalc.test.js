import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { convertAsciiMathToLatex, convertLatexToAsciiMath } from "mathlive";
import AsciiMathParser from "asciimath2tex";
import {
  calculateTrailingEquals,
  isMathLiveEqualsInput,
} from "../src/mathCompute.js";
import {
  mathNodeTransaction,
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

describe("userInsertedEquals", () => {
  it("returns true when the user inserts =", () => {
    const tr = transactionInserting("2+2", "=");
    expect(userInsertedEquals([tr])).toBe(true);
  });

  it("returns false when the user deletes text", () => {
    const tr = transactionDeleting("2+2=4", 4, 5);
    expect(userInsertedEquals([tr])).toBe(false);
  });

});

describe("calculateTrailingEquals", () => {
  it("uses Compute Engine to append a numeric result", () => {
    expect(calculateTrailingEquals("2+2=")).toBe("2+2=4");
    expect(calculateTrailingEquals("1/3=")).toBe("1/3=0.333333");
    expect(calculateTrailingEquals("|-4|=")).toBe("|-4|=4");
  });

  it("leaves symbolic expressions and equations alone", () => {
    expect(calculateTrailingEquals("x+x=")).toBeNull();
    expect(calculateTrailingEquals("x^2=4=")).toBeNull();
  });
});

describe("isMathLiveEqualsInput", () => {
  it("only calculates after an equals sign is inserted", () => {
    expect(isMathLiveEqualsInput({ inputType: "insertText", data: "=" })).toBe(true);
    expect(isMathLiveEqualsInput({ inputType: "deleteContentBackward", data: "" })).toBe(false);
  });
});

describe("MathLive abs-value latex roundtrip", () => {
  it("keeps |…| as pipes so ascii-math does not leak \\lvert", () => {
    const ascii = "|-4|=4";
    const fromAsciimath2tex = new AsciiMathParser().parse(ascii);
    const fromMathLive = convertAsciiMathToLatex(ascii);

    expect(convertLatexToAsciiMath(fromAsciimath2tex)).toContain("lvert");
    expect(convertLatexToAsciiMath(fromMathLive)).toBe(ascii);
  });
});

describe("mathNodeTransaction", () => {
  const mathSchema = new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: { content: "inline*", group: "block" },
      text: { group: "inline" },
      mathLive: {
        group: "inline",
        inline: true,
        atom: true,
        attrs: { asciiMath: { default: "" } },
      },
    },
  });

  it("rebuilds a formula when plain text continues an adjacent math node", () => {
    const formula = mathSchema.nodes.mathLive.create({ asciiMath: "a^2" });
    const paragraph = mathSchema.nodes.paragraph.create(null, [
      formula,
      mathSchema.text("+b^2=c^2 "),
    ]);
    const state = EditorState.create({
      doc: mathSchema.nodes.doc.create(null, [paragraph]),
    });

    const transaction = mathNodeTransaction(state);

    expect(transaction).not.toBeNull();
    expect(transaction.doc.firstChild.firstChild).toMatchObject({
      type: { name: "mathLive" },
      attrs: { asciiMath: "a^2+b^2=c^2" },
    });
  });

  it("does not replace the MathLive node currently being edited", () => {
    const formula = mathSchema.nodes.mathLive.create({ asciiMath: "a^2" });
    const paragraph = mathSchema.nodes.paragraph.create(null, [formula]);
    const state = EditorState.create({
      doc: mathSchema.nodes.doc.create(null, [paragraph]),
    });

    expect(mathNodeTransaction(state, 1)).toBeNull();
  });

  it("calculates when an equals sign converts text into a math node", () => {
    const paragraph = mathSchema.nodes.paragraph.create(null, [
      mathSchema.text("2+2="),
    ]);
    const state = EditorState.create({
      doc: mathSchema.nodes.doc.create(null, [paragraph]),
    });

    const transaction = mathNodeTransaction(state, null, true);

    expect(transaction.doc.firstChild.firstChild).toMatchObject({
      type: { name: "mathLive" },
      attrs: { asciiMath: "2+2=4" },
    });
  });
});
