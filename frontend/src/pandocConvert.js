// Prefer vendored wasm under /static; CDN hosts are fallbacks only.
const WASM_CANDIDATES = [
  "/static/pandoc.wasm",
  "https://unpkg.com/pandoc-wasm@1.1.0/src/pandoc.wasm",
  "https://pandoc.org/app/pandoc.wasm",
];

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

const IMAGE_MIME_EXTENSIONS = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/tiff": "tif",
  "image/vnd.microsoft.icon": "ico",
  "image/webp": "webp",
  "image/x-icon": "ico",
};

function imageMimeType(filename, fallback = "") {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  const byExtension = {
    avif: "image/avif", bmp: "image/bmp", gif: "image/gif", ico: "image/x-icon",
    jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml",
    tif: "image/tiff", tiff: "image/tiff", webp: "image/webp",
  };
  return /^image\//i.test(fallback) ? fallback : byExtension[ext] || "";
}

function imageDataUri(blob, filename) {
  const mime = imageMimeType(filename, blob.type);
  if (!mime) throw new Error(`Unsupported imported image type: ${filename}`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read imported image: ${filename}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(new Blob([blob], { type: mime }));
  });
}

function importedMediaByPath(files) {
  const media = new Map();
  const mediaByName = new Map();
  for (const [path, blob] of Object.entries(files || {})) {
    if (!(blob instanceof Blob) || !imageMimeType(path, blob.type)) continue;
    const normalized = path.replace(/^\.\//, "");
    const item = { blob, path };
    media.set(normalized, item);
    media.set(decodeURIComponent(normalized), item);
    const name = normalized.split("/").pop();
    if (name) mediaByName.set(name, (mediaByName.get(name) || []).concat(item));
  }
  return { media, mediaByName };
}

async function embedImportedImages(html, files) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return html;
  const { media, mediaByName } = importedMediaByPath(files);
  for (const image of root.querySelectorAll("img[src]")) {
    const src = image.getAttribute("src") || "";
    if (/^(https?:|data:image\/)/i.test(src)) continue;
    const key = src.replace(/^\.\//, "").split(/[?#]/, 1)[0];
    const nameMatches = mediaByName.get(key.split("/").pop()) || [];
    const match = media.get(key) || media.get(decodeURIComponent(key)) ||
      (nameMatches.length === 1 ? nameMatches[0] : null);
    if (!match) {
      throw new Error(`Cannot import local image reference: ${src}`);
    }
    image.setAttribute("src", await imageDataUri(match.blob, match.path));
  }
  return root.innerHTML;
}

function decodeImageDataUri(value) {
  const match = /^data:(image\/[a-z0-9.+-]+)((?:;[^,]*)?),([\s\S]*)$/i.exec(String(value || ""));
  if (!match) throw new Error("Invalid embedded image data URI");
  const mime = match[1].toLowerCase();
  const extension = IMAGE_MIME_EXTENSIONS[mime];
  if (!extension) throw new Error(`Unsupported embedded image type: ${mime}`);
  try {
    const encoded = match[2].toLowerCase().includes(";base64");
    const payload = encoded ? atob(match[3].replace(/\s/g, "")) : decodeURIComponent(match[3]);
    const bytes = encoded
      ? Uint8Array.from(payload, (char) => char.charCodeAt(0))
      : new TextEncoder().encode(payload);
    return { blob: new Blob([bytes], { type: mime }), extension };
  } catch {
    throw new Error("Invalid embedded image data URI");
  }
}

function replaceImagePaths(text, media) {
  let output = String(text || "");
  for (const { path, dataUri } of media) {
    output = output.split(`./${path}`).join(dataUri);
    output = output.split(path).join(dataUri);
  }
  return output;
}

function materializeEmbeddedImages(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  const files = {};
  const media = [];
  const pathsByDataUri = new Map();
  if (!root) return { html, files, media };
  for (const image of root.querySelectorAll("img[src]")) {
    const dataUri = image.getAttribute("src") || "";
    if (!/^data:/i.test(dataUri)) continue;
    let path = pathsByDataUri.get(dataUri);
    if (!path) {
      const { blob, extension } = decodeImageDataUri(dataUri);
      // pandoc-wasm accepts files at the virtual filesystem root only.
      path = `kindred-image-${media.length + 1}.${extension}`;
      files[path] = blob;
      media.push({ path, dataUri });
      pathsByDataUri.set(dataUri, path);
    }
    image.setAttribute("src", path);
  }
  return { html: root.innerHTML, files, media };
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
        import("pandoc-wasm/src/core.js"),
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
    { from, to: "html", "input-files": [safeName], "extract-media": "media" },
    null,
    { [safeName]: blob },
  );
  if (result.stderr) {
    console.warn("pandoc import stderr:", result.stderr);
  }
  const html = await embedImportedImages(
    htmlBodyFragment(result.stdout || ""),
    result.files,
  );
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
  const { unzipSync, zipSync, strToU8, strFromU8 } = await import("fflate");
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
    id: "pdf",
    label: "PDF",
    ext: "pdf",
    pandoc: "pdf",
    mime: "application/pdf;charset=utf-8",
  }
];

import html2pdf from "html2pdf.js";

export async function htmlToPdfBlob(html) {
  const container = document.createElement("div");
  container.innerHTML = html;
  container.style.color = "#000000";
  const style = document.createElement("style");
  style.textContent = `
    mark { color: inherit; }
  `;
  container.prepend(style);
  const options = {
    margin: [15, 15, 15, 15], // [top, right, bottom, left] in millimeters
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
  };
  return html2pdf().set(options).from(container).outputPdf("blob");
}

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
  const { html: src, files, media } = materializeEmbeddedImages(html || "<p></p>");
  if (format.id === "pdf") {
    const blob = await htmlToPdfBlob(html);
    return { blob, format };
  }
  const alignments =
    format.pandoc === "docx" ? extractParagraphAlignments(src) : [];
  const result = await convert(
    { from: "html", to: format.pandoc, "output-file": outName },
    src,
    files,
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
  if (media.length && (format.pandoc === "html" || format.pandoc === "markdown")) {
    const restored = replaceImagePaths(await out.text(), media);
    out = new Blob([restored], { type: format.mime });
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
