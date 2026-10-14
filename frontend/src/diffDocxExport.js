const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DEFAULT_AUTHOR = "Anonymous";
const SENTINEL_KINDS = { ins: "INS", del: "DEL" };

const RUN_RE = /<w:r>(?:(?!<\/w:r>)[\s\S])*<\/w:r>/g;
const RUN_DIFF_PROPS_RE = /<w:color [^>]*\/>|<w:shd [^>]*\/>|<w:strike\/>/g;
const TRACKED_OR_RUN_RE =
  /<w:(ins|del) [^>]*>(?:(?!<\/w:\1>)[\s\S])*<\/w:\1>|<w:r>(?:(?!<\/w:r>)[\s\S])*<\/w:r>/g;
const TABLE_SPLIT_RE = /(<w:tbl>[\s\S]*?<\/w:tbl>)/;
const PARAGRAPH_RE = /<w:p(?:\s[^>]*)?>(?:(?!<\/w:p>)[\s\S])*<\/w:p>/g;

const pad2 = (value) => String(value).padStart(2, "0");

/** Local wall-clock time without a zone suffix, which Word reads as local time. */
function localDateTime(now = new Date()) {
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return `${date}T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

function sentinelOpen(kind, nonce) {
  return `⟦${SENTINEL_KINDS[kind]}:${nonce}⟧`;
}

function sentinelClose(kind, nonce) {
  return `⟦/${SENTINEL_KINDS[kind]}:${nonce}⟧`;
}

function textNodesUnder(node) {
  return [...node.childNodes].flatMap((child) => {
    if (child.nodeType === 3) return [child];
    return child.nodeType === 1 ? textNodesUnder(child) : [];
  });
}

/**
 * Wrap every text node inside diff-ins / diff-del elements in nonce-stamped
 * text sentinels, so each resulting DOCX run carries its own change marker.
 * @param {string} html
 * @param {string} nonce
 * @returns {string}
 */
export function prepareHtmlForDocxTrackChanges(html, nonce) {
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return html || "";

  const wrapped = new Set();
  const counts = { ins: 0, del: 0 };
  for (const el of root.querySelectorAll(".diff-ins, .diff-del")) {
    const kind = el.classList.contains("diff-del") ? "del" : "ins";
    for (const node of textNodesUnder(el)) {
      if (wrapped.has(node) || !node.nodeValue.trim()) continue;
      node.nodeValue = `${sentinelOpen(kind, nonce)}${node.nodeValue}${sentinelClose(kind, nonce)}`;
      wrapped.add(node);
      counts[kind] += 1;
    }
  }
  console.info(
    `track changes export: tagged ${counts.ins} inserted and ${counts.del} deleted text nodes (nonce=${nonce})`,
  );
  return root.innerHTML;
}

function runText(run) {
  return [...run.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(([, text]) => text).join("");
}

function wrapSentinelRuns(xml, nonce, nextAttrs, stats) {
  const sentinelRe = new RegExp(`⟦(/?)(INS|DEL):${nonce}⟧`, "g");
  return xml.replace(RUN_RE, (run) => {
    const kinds = [...run.matchAll(sentinelRe)].map(([, , kind]) => kind.toLowerCase());
    if (!kinds.length) return run;
    const kind = kinds[0];
    stats[kind] += 1;
    let plain = run.replace(sentinelRe, "").replace(RUN_DIFF_PROPS_RE, "");
    if (kind === "del") {
      plain = plain.replace(/<w:t(?=[\s>])/g, "<w:delText").replace(/<\/w:t>/g, "</w:delText>");
    }
    return `<w:${kind} ${nextAttrs()}>${plain}</w:${kind}>`;
  });
}

/** "ins" or "del" when every text run in the paragraph is a tracked change of that kind. */
function paragraphKind(paragraph) {
  const kinds = new Set();
  for (const [part, kind] of paragraph.matchAll(TRACKED_OR_RUN_RE)) {
    if (kind) kinds.add(kind);
    else if (runText(part).trim() || part.includes("<w:drawing")) return null;
  }
  return kinds.size === 1 ? [...kinds][0] : null;
}

function markParagraphs(segment, nextAttrs, stats) {
  return segment.replace(PARAGRAPH_RE, (paragraph) => {
    const kind = paragraphKind(paragraph);
    if (!kind) return paragraph;
    stats.paragraphs += 1;
    const mark = `<w:${kind} ${nextAttrs()}/>`;
    if (paragraph.includes("<w:pPr>")) {
      const [pPr] = paragraph.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
      const marked = pPr.includes("<w:rPr>")
        ? pPr.replace("<w:rPr>", `<w:rPr>${mark}`)
        : pPr.replace("</w:pPr>", `<w:rPr>${mark}</w:rPr></w:pPr>`);
      return paragraph.replace(pPr, () => marked);
    }
    return paragraph.replace(/^(<w:p(?:\s[^>]*)?>)/, `$1<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`);
  });
}

/**
 * @param {string} xml word/document.xml
 * @param {string} nonce
 * @param {{ author?: string, date?: string }} [options]
 */
export function applyTrackedChangesToDocumentXml(xml, nonce, options = {}) {
  const author = options.author ?? DEFAULT_AUTHOR;
  const date = options.date ?? localDateTime();
  let nextId = 1;
  const nextAttrs = () => `w:id="${nextId++}" w:author="${author}" w:date="${date}"`;
  const stats = { ins: 0, del: 0, paragraphs: 0 };

  const wrapped = wrapSentinelRuns(xml, nonce, nextAttrs, stats);
  const marked = wrapped
    .split(TABLE_SPLIT_RE)
    .map((part, i) => (i % 2 ? part : markParagraphs(part, nextAttrs, stats)))
    .join("");
  return { xml: marked, stats };
}

export function enableTrackRevisions(settingsXml) {
  if (settingsXml.includes("<w:trackRevisions")) return settingsXml;
  if (settingsXml.includes("<w:displayBackgroundShape/>")) {
    return settingsXml.replace("<w:displayBackgroundShape/>", "<w:displayBackgroundShape/><w:trackRevisions/>");
  }
  return settingsXml.replace(/(<w:settings[^>]*>)/, "$1<w:trackRevisions/>");
}

/**
 * @param {Blob} docxBlob
 * @param {string} nonce
 * @param {{ author?: string, date?: string }} [options]
 * @returns {Promise<Blob>}
 */
export async function patchDocxTrackChanges(docxBlob, nonce, options = {}) {
  const { unzipSync, zipSync, strToU8, strFromU8 } = await import("fflate");
  const files = unzipSync(new Uint8Array(await docxBlob.arrayBuffer()));
  const path = "word/document.xml";
  if (!files[path]) {
    console.warn("track changes export skipped: word/document.xml missing");
    return docxBlob;
  }

  const { xml, stats } = applyTrackedChangesToDocumentXml(strFromU8(files[path]), nonce, options);
  console.info(
    `track changes export: ${stats.ins} insertions, ${stats.del} deletions, ${stats.paragraphs} paragraph marks (nonce=${nonce}, author=${options.author ?? DEFAULT_AUTHOR})`,
  );
  if (!stats.ins && !stats.del) return docxBlob;

  files[path] = strToU8(xml);
  if (files["word/settings.xml"]) {
    files["word/settings.xml"] = strToU8(enableTrackRevisions(strFromU8(files["word/settings.xml"])));
  }
  return new Blob([zipSync(files)], { type: DOCX_MIME });
}
