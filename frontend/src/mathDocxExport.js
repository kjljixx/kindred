import { mml2omml } from "mathml2omml";

/** @typedef {{ placeholder: string, omml: string }} MathDocxEntry */

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {Element} katexEl
 * @returns {string}
 */
export function extractMathmlFromKatex(katexEl) {
  const math =
    katexEl.querySelector(".katex-mathml math") ?? katexEl.querySelector("math");
  return math?.outerHTML ?? "";
}

/**
 * @param {number} index
 * @returns {string}
 */
export function mathPlaceholder(index) {
  return `⟦KMATH:${index}⟧`;
}

/**
 * Replace KaTeX blocks with unique placeholders and collect OMML for each.
 * @param {string} html
 * @returns {{ html: string, mathEntries: MathDocxEntry[] }}
 */
export function prepareHtmlForDocxMath(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return { html: html || "", mathEntries: [] };

  /** @type {MathDocxEntry[]} */
  const mathEntries = [];
  let index = 0;

  for (const katex of [...root.querySelectorAll(".katex")]) {
    if (katex.closest(".katex") !== katex) continue;

    const mathml = extractMathmlFromKatex(katex);
    if (!mathml) continue;

    let omml;
    try {
      omml = mml2omml(mathml);
    } catch {
      continue;
    }
    if (!omml?.includes("m:oMath")) continue;

    const placeholder = mathPlaceholder(index);
    mathEntries.push({ placeholder, omml });

    const span = doc.createElement("span");
    span.textContent = placeholder;
    const replaceTarget = katex.closest(".render-latex") ?? katex;
    replaceTarget.replaceWith(span);
    index += 1;
  }

  return { html: root.innerHTML, mathEntries };
}

/**
 * @param {string} xml
 * @param {string} placeholder
 * @param {string} omml
 * @returns {string}
 */
const RUN_OPEN =
  "<w:r>(?:\\s*<w:rPr>(?:[^<]|<(?!/w:rPr>))*</w:rPr>)?\\s*<w:t(?:\\s[^>]*)?>";

export function replacePlaceholderWithOmml(xml, placeholder, omml) {
  const escaped = escapeRegex(placeholder);

  const aloneRe = new RegExp(
    `${RUN_OPEN}\\s*${escaped}\\s*</w:t>\\s*</w:r>`,
    "g",
  );
  const aloneReplaced = xml.replace(aloneRe, omml);
  if (aloneReplaced !== xml) return aloneReplaced;

  const splitRe = new RegExp(
    `(${RUN_OPEN})([^<]*)${escaped}([^<]*)(</w:t>\\s*</w:r>)`,
  );
  return xml.replace(splitRe, (_match, open, before, after, close) => {
    const parts = [];
    if (before) parts.push(`${open}${before}${close}`);
    parts.push(omml);
    if (after) parts.push(`${open}${after}${close}`);
    return parts.join("");
  });
}

/**
 * @param {Blob} docxBlob
 * @param {MathDocxEntry[]} mathEntries
 * @returns {Promise<Blob>}
 */
export async function patchDocxMath(docxBlob, mathEntries) {
  if (!mathEntries.length) return docxBlob;

  const { unzipSync, zipSync, strToU8, strFromU8 } = await import("fflate");
  const files = unzipSync(new Uint8Array(await docxBlob.arrayBuffer()));
  const path = "word/document.xml";
  if (!files[path]) return docxBlob;

  let xml = strFromU8(files[path]);
  for (const { placeholder, omml } of mathEntries) {
    xml = replacePlaceholderWithOmml(xml, placeholder, omml);
  }

  files[path] = strToU8(xml);
  return new Blob([zipSync(files)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}
