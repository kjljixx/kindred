// jsDelivr rejects pandoc.wasm (~59MB uncompressed; 50MB limit). Prefer local
// static copy, then unpkg (CORS + large files), then official pandoc.org host.
const WASM_CANDIDATES = [
  "/static/pandoc.wasm",
  "https://unpkg.com/pandoc-wasm@1.1.0/src/pandoc.wasm",
  "https://pandoc.org/app/pandoc.wasm",
];
const CORE_URL = "https://esm.sh/pandoc-wasm@1.1.0/src/core.js";

/** @type {Promise<{ convert: Function }> | null} */
let pandocPromise = null;

/**
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchWasmBinary() {
  const errors = [];
  for (const url of WASM_CANDIDATES) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        errors.push(`${url} → ${res.status}`);
        continue;
      }
      return await res.arrayBuffer();
    } catch (err) {
      errors.push(`${url} → ${err && err.message ? err.message : err}`);
    }
  }
  throw new Error(
    `Failed to load pandoc.wasm (${errors.join("; ")}). ` +
      "Place a copy at /static/pandoc.wasm or check network access to unpkg.",
  );
}

const EXT_TO_FORMAT = {
  md: "markdown",
  markdown: "markdown",
  mkd: "markdown",
  rst: "rst",
  tex: "latex",
  latex: "latex",
  html: "html",
  htm: "html",
  docx: "docx",
  odt: "odt",
  epub: "epub",
  org: "org",
  textile: "textile",
  wiki: "mediawiki",
  mediawiki: "mediawiki",
  twiki: "twiki",
  dokuwiki: "dokuwiki",
  tikiwiki: "tikiwiki",
  creole: "creole",
  muse: "muse",
  fb2: "fb2",
  ipynb: "ipynb",
  jats: "jats",
  json: "json",
  native: "native",
  opml: "opml",
  rtf: "rtf",
  txt: "markdown",
  text: "markdown",
  xml: "html",
  csv: "csv",
  tsv: "tsv",
  bib: "biblatex",
  ris: "ris",
  typ: "typst",
  dj: "djot",
};

/**
 * @param {string} filename
 * @returns {string | null} Pandoc --from format, or null if extension is unknown
 */
export function formatFromFilename(filename) {
  const base = String(filename || "").split(/[/\\]/).pop() || "";
  const dot = base.lastIndexOf(".");
  const ext = (dot >= 0 ? base.slice(dot + 1) : "").toLowerCase();
  if (!ext) return "markdown";
  return EXT_TO_FORMAT[ext] || null;
}

/**
 * Strip full-document wrappers so TipTap gets a fragment.
 * @param {string} html
 * @returns {string}
 */
export function htmlBodyFragment(html) {
  const raw = String(html || "").trim();
  if (!raw) return "<p></p>";
  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) {
    const inner = bodyMatch[1].trim();
    return inner || "<p></p>";
  }
  return raw
    .replace(/<!DOCTYPE[^>]*>/i, "")
    .replace(/<\/?html[^>]*>/gi, "")
    .replace(/<\/?head[^>]*>[\s\S]*?<\/head>/gi, "")
    .trim() || "<p></p>";
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function looksLikeText(bytes) {
  if (!bytes.length) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) return false;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) control++;
  }
  return control / sample.length < 0.05;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function textToHtmlParagraphs(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return "<p></p>";
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
async function importRawTextToHtml(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!looksLikeText(bytes)) {
    throw new Error(
      "Unsupported file type (not a known Pandoc format and not plain text)",
    );
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  return textToHtmlParagraphs(text);
}

export function ensurePandoc() {
  if (!pandocPromise) {
    pandocPromise = (async () => {
      const [{ createPandocInstance }, wasmBinary] = await Promise.all([
        import(/* @vite-ignore */ CORE_URL),
        fetchWasmBinary(),
      ]);
      return createPandocInstance(wasmBinary);
    })().catch((err) => {
      pandocPromise = null;
      throw err;
    });
  }
  return pandocPromise;
}

/**
 * @param {File|Blob} file
 * @param {string} [filename]
 * @returns {Promise<string>}
 */
export async function importFileToHtml(file, filename) {
  const name = filename || (file instanceof File ? file.name : "import.bin");
  const blob =
    file instanceof Blob ? file : new Blob([file], { type: "application/octet-stream" });
  const from = formatFromFilename(name);
  if (!from) {
    return importRawTextToHtml(blob);
  }
  const { convert } = await ensurePandoc();
  // WASI-safe key: original names with spaces/unicode can break path lookup.
  const safeName = `import.${(name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]+/g, "") || "bin"}`;
  const result = await convert(
    { from, to: "html", "input-files": [safeName] },
    null,
    { [safeName]: blob },
  );
  if (result.stderr) {
    console.warn("pandoc import stderr:", result.stderr);
  }
  const html = htmlBodyFragment(result.stdout || "");
  if (!html || html === "<p></p>") {
    const errHint = (result.stderr || "").trim();
    throw new Error(errHint || `Import produced no content (from=${from})`);
  }
  return html;
}

/**
 * TipTap stores alignment as `style="text-align: ..."` on blocks.
 * Pandoc's HTML reader drops those (Para has no Attr), so we collect
 * alignments here and re-apply them on the DOCX after convert.
 * @param {string} html
 * @returns {string[]} OOXML jc values: left|center|right|both
 */
function extractParagraphAlignments(html) {
  const doc = new DOMParser().parseFromString(
    `<div id="kindred-export-root">${html || ""}</div>`,
    "text/html",
  );
  const root = doc.getElementById("kindred-export-root");
  if (!root) return [];
  const out = [];
  for (const el of root.children) {
    const style = el.getAttribute("style") || "";
    const m = /(?:^|;)\s*text-align\s*:\s*([a-z]+)/i.exec(style);
    const raw = (m ? m[1] : "left").toLowerCase();
    if (raw === "justify") out.push("both");
    else if (raw === "center" || raw === "right" || raw === "left") out.push(raw);
    else out.push("left");
  }
  return out;
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/**
 * @param {Blob} docxBlob
 * @param {string[]} alignments
 * @returns {Promise<Blob>}
 */
async function patchDocxParagraphAlignments(docxBlob, alignments) {
  if (!alignments.length || alignments.every((a) => a === "left")) {
    return docxBlob;
  }
  const { unzipSync, zipSync, strToU8, strFromU8 } = await import(
    /* @vite-ignore */ "https://esm.sh/fflate@0.8.2"
  );
  const files = unzipSync(new Uint8Array(await docxBlob.arrayBuffer()));
  const path = "word/document.xml";
  if (!files[path]) return docxBlob;
  const xml = strFromU8(files[path]);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) return docxBlob;
  const paras = [...body.children].filter((el) => el.localName === "p");
  for (let i = 0; i < paras.length && i < alignments.length; i++) {
    const align = alignments[i];
    if (!align || align === "left") continue;
    const p = paras[i];
    let pPr = [...p.children].find((c) => c.localName === "pPr");
    if (!pPr) {
      pPr = doc.createElementNS(W_NS, "w:pPr");
      p.insertBefore(pPr, p.firstChild);
    }
    let jc = [...pPr.children].find((c) => c.localName === "jc");
    if (!jc) {
      jc = doc.createElementNS(W_NS, "w:jc");
      pPr.appendChild(jc);
    }
    jc.setAttribute("w:val", align);
  }
  files[path] = strToU8(new XMLSerializer().serializeToString(doc));
  return new Blob([zipSync(files)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

/** @typedef {{ id: string, label: string, ext: string, pandoc: string, mime: string }} ExportFormat */

/** @type {ExportFormat[]} */
export const EXPORT_FORMATS = [
  {
    id: "docx",
    label: "DOCX",
    ext: "docx",
    pandoc: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    id: "md",
    label: "Markdown",
    ext: "md",
    pandoc: "markdown",
    mime: "text/markdown;charset=utf-8",
  },
  {
    id: "html",
    label: "HTML",
    ext: "html",
    pandoc: "html",
    mime: "text/html;charset=utf-8",
  },
  {
    id: "txt",
    label: "Plain text",
    ext: "txt",
    pandoc: "plain",
    mime: "text/plain;charset=utf-8",
  },
  {
    id: "odt",
    label: "ODT",
    ext: "odt",
    pandoc: "odt",
    mime: "application/vnd.oasis.opendocument.text",
  },
  {
    id: "rtf",
    label: "RTF",
    ext: "rtf",
    pandoc: "rtf",
    mime: "application/rtf",
  },
];

/**
 * @param {string} [formatId]
 * @returns {ExportFormat}
 */
export function exportFormatById(formatId) {
  return (
    EXPORT_FORMATS.find((f) => f.id === formatId) ||
    EXPORT_FORMATS.find((f) => f.id === "docx") ||
    EXPORT_FORMATS[0]
  );
}

/**
 * @param {string} html
 * @param {string} [formatId]
 * @returns {Promise<{ blob: Blob, format: ExportFormat }>}
 */
export async function htmlToExportBlob(html, formatId = "docx") {
  const format = exportFormatById(formatId);
  // WASI-safe output key; caller picks the download filename separately.
  const outName = `export.${format.ext}`;
  const { convert } = await ensurePandoc();
  const src = html || "<p></p>";
  const alignments =
    format.pandoc === "docx" ? extractParagraphAlignments(src) : [];
  const result = await convert(
    { from: "html", to: format.pandoc, "output-file": outName },
    src,
    {},
  );
  if (result.stderr) {
    console.warn("pandoc export stderr:", result.stderr);
  }
  let out = result.files?.[outName];
  if (!(out instanceof Blob) || out.size === 0) {
    const text = String(result.stdout || "");
    if (text) {
      out = new Blob([text], { type: format.mime });
    }
  }
  if (!(out instanceof Blob) || out.size === 0) {
    const errHint = (result.stderr || "").trim();
    throw new Error(errHint || `Export produced empty ${format.label}`);
  }
  if (format.pandoc === "docx") {
    out = await patchDocxParagraphAlignments(out, alignments);
  } else if (out.type !== format.mime) {
    out = new Blob([out], { type: format.mime });
  }
  return { blob: out, format };
}

/**
 * @param {string} html
 * @param {string} [filename]
 * @returns {Promise<Blob>}
 */
export async function htmlToDocxBlob(html, filename = "export.docx") {
  void filename;
  const { blob } = await htmlToExportBlob(html, "docx");
  return blob;
}
