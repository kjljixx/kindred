import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  prepareHtmlForDocxTrackChanges,
  applyTrackedChangesToDocumentXml,
  enableTrackRevisions,
  patchDocxTrackChanges,
} from "../src/diffDocxExport.js";
import { DIFF_CLASS_STYLES } from "../src/diffExport.js";
import { htmlToDocxBlob } from "../src/docshiftConvert.js";
import { normalizeHtmlColorsToHex, normalizeBackgroundForDocx } from "../src/colorInvert.js";

const NONCE = "abc12345";
const OPTIONS = { author: "Tester", date: "2026-01-01T09:30:00" };
const INS = `⟦INS:${NONCE}⟧`;
const INS_END = `⟦/INS:${NONCE}⟧`;
const DEL = `⟦DEL:${NONCE}⟧`;
const DEL_END = `⟦/DEL:${NONCE}⟧`;

const run = (text, props = "") =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (inner) => `<w:p><w:pPr><w:jc w:val="left"/></w:pPr>${inner}</w:p>`;
const DIFF_PROPS = '<w:color w:val="863c3f"/><w:strike/><w:shd w:fill="fedede"/>';

describe("prepareHtmlForDocxTrackChanges", () => {
  it("wraps each text node inside diff spans, including nested formatting", () => {
    const html = '<p>keep <span class="diff-del">old <strong>bold</strong> text</span><span class="diff-ins">new</span></p>';
    const out = prepareHtmlForDocxTrackChanges(html, NONCE);
    expect(out).toContain(`${DEL}old ${DEL_END}<strong>${DEL}bold${DEL_END}</strong>${DEL} text${DEL_END}`);
    expect(out).toContain(`${INS}new${INS_END}`);
    expect(out).toContain("<p>keep ");
  });

  it("leaves text outside diff spans and whitespace-only nodes untouched", () => {
    const out = prepareHtmlForDocxTrackChanges('<p>plain <span class="diff-ins"> </span></p>', NONCE);
    expect(out).not.toContain("⟦");
  });

  it("does not double-wrap nested diff elements", () => {
    const out = prepareHtmlForDocxTrackChanges(
      '<p><span class="diff-ins"><span class="diff-del">x</span></span></p>',
      NONCE,
    );
    expect(out.match(/⟦/g)).toHaveLength(2);
  });
});

describe("applyTrackedChangesToDocumentXml", () => {
  it("wraps inserted runs in w:ins and strips diff styling and sentinels", () => {
    const xml = paragraph(run("keep ") + run(`${INS}new${INS_END}`, DIFF_PROPS));
    const { xml: out, stats } = applyTrackedChangesToDocumentXml(xml, NONCE, OPTIONS);
    expect(out).toContain('<w:ins w:id="1" w:author="Tester" w:date="2026-01-01T09:30:00">');
    expect(out).toContain(">new</w:t>");
    expect(out).not.toMatch(/w:color|w:shd|w:strike|⟦/);
    expect(stats).toMatchObject({ ins: 1, del: 0 });
  });

  it("wraps deleted runs in w:del and uses w:delText", () => {
    const xml = paragraph(run("keep ") + run(`${DEL}old${DEL_END}`, DIFF_PROPS));
    const { xml: out } = applyTrackedChangesToDocumentXml(xml, NONCE, OPTIONS);
    expect(out).toContain("<w:del ");
    expect(out).toContain(">old</w:delText>");
    expect(out).not.toContain("<w:t xml:space=\"preserve\">old");
  });

  it("defaults to the Anonymous author and a zoneless local timestamp", () => {
    const { xml: out } = applyTrackedChangesToDocumentXml(paragraph(run(`${INS}x${INS_END}`)), NONCE);
    expect(out).toMatch(/w:author="Anonymous" w:date="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"/);
  });

  it("keeps non-diff run properties such as bold", () => {
    const xml = paragraph(run(`${DEL}bold${DEL_END}`, `<w:b/>${DIFF_PROPS}`));
    const { xml: out } = applyTrackedChangesToDocumentXml(xml, NONCE, OPTIONS);
    expect(out).toContain("<w:b/>");
  });

  it("assigns unique revision ids across runs and paragraph marks", () => {
    const xml =
      paragraph(run(`${DEL}one${DEL_END}`)) +
      paragraph(run(`${INS}two${INS_END}`)) +
      paragraph(run("keep ") + run(`${INS}three${INS_END}`));
    const { xml: out } = applyTrackedChangesToDocumentXml(xml, NONCE, OPTIONS);
    const ids = [...out.matchAll(/w:id="(\d+)"/g)].map(([, id]) => id);
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks the paragraph when every text run is the same change kind", () => {
    const xml = paragraph(run(`${DEL}a${DEL_END}`) + run(" ") + run(`${DEL}b${DEL_END}`));
    const { xml: out, stats } = applyTrackedChangesToDocumentXml(xml, NONCE, OPTIONS);
    expect(out).toMatch(/<w:pPr><w:jc w:val="left"\/><w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr>/);
    expect(stats.paragraphs).toBe(1);
  });

  it("does not mark paragraphs that mix kept and changed text, or mixed kinds", () => {
    const mixedKept = paragraph(run("keep ") + run(`${DEL}old${DEL_END}`));
    const mixedKinds = paragraph(run(`${DEL}old${DEL_END}`) + run(`${INS}new${INS_END}`));
    const { stats } = applyTrackedChangesToDocumentXml(mixedKept + mixedKinds, NONCE, OPTIONS);
    expect(stats.paragraphs).toBe(0);
  });

  it("does not mark paragraphs inside tables", () => {
    const xml = `<w:tbl><w:tr><w:tc>${paragraph(run(`${DEL}cell${DEL_END}`))}</w:tc></w:tr></w:tbl>`;
    const { xml: out, stats } = applyTrackedChangesToDocumentXml(xml, NONCE, OPTIONS);
    expect(stats).toMatchObject({ del: 1, paragraphs: 0 });
    expect(out).not.toContain("<w:rPr><w:del");
  });

  it("ignores sentinels that carry a different nonce", () => {
    const xml = paragraph(run("⟦DEL⟧typed by user⟦/DEL⟧") + run("⟦DEL:other000⟧x⟦/DEL:other000⟧"));
    const { xml: out, stats } = applyTrackedChangesToDocumentXml(xml, NONCE, OPTIONS);
    expect(out).toBe(xml);
    expect(stats).toMatchObject({ ins: 0, del: 0, paragraphs: 0 });
  });
});

describe("enableTrackRevisions", () => {
  it("inserts trackRevisions after displayBackgroundShape", () => {
    const out = enableTrackRevisions('<w:settings><w:displayBackgroundShape/><w:evenAndOddHeaders/></w:settings>');
    expect(out).toContain("<w:displayBackgroundShape/><w:trackRevisions/><w:evenAndOddHeaders/>");
  });

  it("is idempotent", () => {
    const once = enableTrackRevisions("<w:settings><w:compat/></w:settings>");
    expect(enableTrackRevisions(once)).toBe(once);
  });
});

describe("diff export through docshift", () => {
  it("turns a styled diff into tracked changes in a real docx", async () => {
    const html =
      `<p>Hello <span class="diff-del" style="${DIFF_CLASS_STYLES["diff-del"]}">old <strong>bold</strong></span>` +
      `<span class="diff-ins" style="${DIFF_CLASS_STYLES["diff-ins"]}">new</span> end</p>` +
      `<p><span class="diff-del" style="${DIFF_CLASS_STYLES["diff-del"]}">whole paragraph gone</span></p>`;
    const prepared = normalizeBackgroundForDocx(
      normalizeHtmlColorsToHex(prepareHtmlForDocxTrackChanges(html, NONCE)),
    );
    const blob = await patchDocxTrackChanges(await htmlToDocxBlob(prepared), NONCE, OPTIONS);

    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const xml = strFromU8(files["word/document.xml"]);
    expect(xml).not.toContain("⟦");
    expect(xml.match(/<w:del /g).length).toBe(4);
    expect(xml.match(/<w:ins /g).length).toBe(1);
    expect(xml).toContain(">whole paragraph gone</w:delText>");
    expect(xml).toMatch(/<w:rPr><w:del [^>]*\/><\/w:rPr>/);
    expect(xml).not.toMatch(/w:strike|w:shd/);
    expect(strFromU8(files["word/settings.xml"])).toContain("<w:trackRevisions/>");
  });

  it("leaves a docx without diff sentinels unchanged", async () => {
    const original = await htmlToDocxBlob("<p>plain</p>");
    const patched = await patchDocxTrackChanges(original, NONCE, OPTIONS);
    expect(patched).toBe(original);
  });
});
