import { describe, expect, it } from "vitest";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { nameUnnamedPictures, normalizeDocxPackage } from "../src/docxPackage.js";

const DRAWING = (id) =>
  `<w:drawing><wp:inline><wp:docPr id="${id}" name="" descr="" title=""/><pic:nvPicPr><pic:cNvPr id="0" name="" descr=""/></pic:nvPicPr></wp:inline></w:drawing>`;

async function normalize(files) {
  const blob = new Blob([zipSync(files)]);
  const out = await normalizeDocxPackage(blob);
  return unzipSync(new Uint8Array(await out.arrayBuffer()));
}

describe("nameUnnamedPictures", () => {
  it("numbers each empty drawing name and keeps existing names", () => {
    const { xml, count } = nameUnnamedPictures(
      `${DRAWING(1)}${DRAWING(2)}<wp:docPr id="3" name="Chart"/>`,
    );
    expect(count).toBe(2);
    expect(xml).toContain('<wp:docPr id="1" name="Picture 1"');
    expect(xml).toContain('<wp:docPr id="2" name="Picture 2"');
    expect(xml).toContain('name="Chart"');
    expect(xml).not.toContain('name=""');
  });
});

describe("normalizeDocxPackage", () => {
  const source = {
    "word/": new Uint8Array(0),
    "word/media/": new Uint8Array(0),
    "word/document.xml": strToU8(`<w:document>${DRAWING(1)}</w:document>`),
    "word/media/a.png": new Uint8Array([137, 80, 78, 71]),
    "[Content_Types].xml": strToU8("<Types/>"),
  };

  it("puts [Content_Types].xml first and drops directory entries", async () => {
    const files = await normalize(source);
    expect(Object.keys(files)).toEqual([
      "[Content_Types].xml",
      "word/document.xml",
      "word/media/a.png",
    ]);
  });

  it("names pictures and leaves media bytes untouched", async () => {
    const files = await normalize(source);
    expect(strFromU8(files["word/document.xml"])).toContain('name="Picture 1"');
    expect(Array.from(files["word/media/a.png"])).toEqual([137, 80, 78, 71]);
  });
});
