import { Editor, Extension, Node as TiptapNode } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import {
  DEFAULT_FONT_FAMILY,
  fontNameFromCssValue,
  loadGoogleFont,
  mountFontFamilyPicker,
} from "./fontCatalog.js";
import Placeholder from "@tiptap/extension-placeholder";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const keptSelectionKey = new PluginKey("keptSelection");

function createKeptCaretWidget() {
  const el = document.createElement("span");
  el.className = "toolbar-kept-caret";
  el.contentEditable = "false";
  el.setAttribute("aria-hidden", "true");
  return el;
}

/** Fake selection/caret while toolbar or chat holds focus. */
const KeptSelection = Extension.create({
  name: "keptSelection",
  addCommands() {
    return {
      setKeptSelection:
        (range) =>
          ({ tr, dispatch }) => {
            if (dispatch) {
              tr.setMeta(keptSelectionKey, range);
              tr.setMeta("addToHistory", false);
              dispatch(tr);
            }
            return true;
          },
      clearKeptSelection:
        () =>
          ({ tr, dispatch }) => {
            if (dispatch) {
              tr.setMeta(keptSelectionKey, null);
              tr.setMeta("addToHistory", false);
              dispatch(tr);
            }
            return true;
          },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: keptSelectionKey,
        state: {
          init: () => null,
          apply(tr, prev) {
            const meta = tr.getMeta(keptSelectionKey);
            if (meta !== undefined) return meta;
            if (!prev) return null;
            const max = tr.doc.content.size;
            const from = Math.max(0, Math.min(tr.mapping.map(prev.from), max));
            const to = Math.max(0, Math.min(tr.mapping.map(prev.to), max));
            return { from, to };
          },
        },
        props: {
          decorations(state) {
            const range = keptSelectionKey.getState(state);
            if (!range) return DecorationSet.empty;
            if (range.from < range.to) {
              return DecorationSet.create(state.doc, [
                Decoration.inline(range.from, range.to, { class: "toolbar-kept-selection" }),
              ]);
            }
            return DecorationSet.create(state.doc, [
              Decoration.widget(range.from, createKeptCaretWidget, {
                key: "toolbar-kept-caret",
                side: 0,
              }),
            ]);
          },
        },
      }),
    ];
  },
});

/** TipTap v2 has no official FontSize package; mirror Color on textStyle. */
const FontSize = Extension.create({
  name: "fontSize",
  addOptions() {
    return { types: ["textStyle"] };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) => {
              if (!attributes.fontSize) return {};
              return { style: `font-size: ${attributes.fontSize}` };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (fontSize) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain()
            .setMark("textStyle", { fontSize: null })
            .removeEmptyTextStyle()
            .run(),
    };
  },
});

const ConflictParagraph = TiptapNode.create({
  name: "conflictParagraph",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,
  addAttributes() {
    return {
      conflictIndex: {
        default: 0,
        parseHTML: (el) => Number(el.getAttribute("data-kindred-conflict") || 0),
        renderHTML: (attrs) => ({ "data-kindred-conflict": String(attrs.conflictIndex) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-kindred-conflict]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { class: "kindred-conflict-anchor", ...HTMLAttributes }];
  },
});

function attrOrNull(el, name) {
  const v = el.getAttribute(name);
  return v == null || v === "" ? null : v;
}

const KindredParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      alignOurs: {
        default: null,
        parseHTML: (el) => attrOrNull(el, "data-kindred-align-ours"),
        renderHTML: (attrs) =>
          attrs.alignOurs ? { "data-kindred-align-ours": attrs.alignOurs } : {},
      },
      alignTheirs: {
        default: null,
        parseHTML: (el) => attrOrNull(el, "data-kindred-align-theirs"),
        renderHTML: (attrs) =>
          attrs.alignTheirs ? { "data-kindred-align-theirs": attrs.alignTheirs } : {},
      },
      alignLabelOurs: {
        default: null,
        parseHTML: (el) => attrOrNull(el, "data-kindred-align-label-ours"),
        renderHTML: (attrs) =>
          attrs.alignLabelOurs
            ? { "data-kindred-align-label-ours": attrs.alignLabelOurs }
            : {},
      },
      alignLabelTheirs: {
        default: null,
        parseHTML: (el) => attrOrNull(el, "data-kindred-align-label-theirs"),
        renderHTML: (attrs) =>
          attrs.alignLabelTheirs
            ? { "data-kindred-align-label-theirs": attrs.alignLabelTheirs }
            : {},
      },
    };
  },
});

const ALIGN_PILL = {
  left: { label: "Left", icon: "≡" },
  center: { label: "Center", icon: "≡≡" },
  right: { label: "Right", icon: "≡" },
  justify: { label: "Justify", icon: "≡≡≡" },
};

function alignPillContent(align) {
  const key = String(align || "left").toLowerCase();
  const spec = ALIGN_PILL[key] || ALIGN_PILL.left;
  return `${spec.label}`;
}
const BLOCK_SEP = "\n\n";
const overlayKey = new PluginKey("kindredOverlay");

const DIFF_EQUAL = 0;
const DIFF_INSERT = 1;
const DIFF_DELETE = -1;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap plain text as TipTap-friendly HTML paragraphs. */
export function plainToHtml(text) {
  const raw = text || "";
  if (!raw) return "<p></p>";
  return raw
    .split(/\n\n+/)
    .map((para) => {
      const body = escapeHtml(para).replace(/\n/g, "<br>");
      return `<p>${body || "<br>"}</p>`;
    })
    .join("\n");
}

/** Strip tags for titles / fallbacks (not the review plain projection). */
export function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  return (doc.body.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

/** Same wording, different markup — Both is unsafe without ancestor marks. */
export function isFormatOnlyConflict(ours, theirs) {
  const a = stripHtml(ours);
  const b = stripHtml(theirs);
  return a.length > 0 && a === b;
}

const CONFLICT_PREVIEW_TAGS = new Set([
  "STRONG",
  "B",
  "EM",
  "I",
  "U",
  "S",
  "STRIKE",
  "BR",
]);

/** Inline-safe HTML for conflict button labels (TipTap marks only). */
export function conflictPreviewHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html || "");
  const out = document.createElement("div");

  function walk(from, into) {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        into.appendChild(document.createTextNode(child.nodeValue || ""));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName;
      if (tag === "SPAN") {
        const style = child.getAttribute("style") || "";
        const keepColor = /(?:^|;)\s*color\s*:/i.test(style);
        const keepSize = /(?:^|;)\s*font-size\s*:/i.test(style);
        const keepFamily = /(?:^|;)\s*font-family\s*:/i.test(style);
        if (keepColor || keepSize || keepFamily) {
          const el = document.createElement("span");
          if (keepColor && child.style.color) el.style.color = child.style.color;
          if (keepSize && child.style.fontSize) {
            el.style.fontSize = child.style.fontSize;
          }
          if (keepFamily && child.style.fontFamily) {
            el.style.fontFamily = child.style.fontFamily;
          }
          walk(child, el);
          into.appendChild(el);
          continue;
        }
      }
      if (CONFLICT_PREVIEW_TAGS.has(tag)) {
        const el = document.createElement(
          tag === "B" ? "strong" : tag === "I" ? "em" : tag.toLowerCase()
        );
        walk(child, el);
        into.appendChild(el);
      } else {
        walk(child, into);
      }
    }
  }

  walk(tmp, out);
  return out.innerHTML;
}

function fillConflictBtn(btn, html) {
  const preview = conflictPreviewHtml(html);
  const plainIn = stripHtml(html);
  const plainOut = stripHtml(preview);
  if (preview && plainOut) {
    btn.innerHTML = preview;
    return;
  }
  if (plainIn) {
    btn.textContent = plainIn;
    return;
  }
  btn.textContent = "\u00a0";
}

/**
 * Pretty-print with newlines only between sibling blocks.
 * Never injects \\n before closing tags (that would sit inside paragraph text).
 */
export function prettyPrintHtml(html) {
  const compact = String(html || "")
    .replace(/>\s+</g, "><")
    .trim();
  if (!compact) return "";
  return compact
    .replace(
      /><(p|h[1-6]|ul|ol|li|blockquote|pre|hr|div)(\s[^>]*)?>/gi,
      ">\n<$1$2>"
    )
    .trim();
}

/** Drop trailing empty hard breaks / whitespace at the end of a block (keep mid-paragraph br). */
function trimTrailingInsignificant(el) {
  while (el.lastChild) {
    const last = el.lastChild;
    if (last.nodeType === Node.TEXT_NODE) {
      const trimmed = (last.nodeValue || "").replace(/[\s\u00a0]+$/g, "");
      if (!trimmed) {
        el.removeChild(last);
        continue;
      }
      if (trimmed !== last.nodeValue) last.nodeValue = trimmed;
      break;
    }
    if (last.nodeType === Node.ELEMENT_NODE && last.tagName === "BR") {
      el.removeChild(last);
      continue;
    }
    if (last.nodeType === Node.ELEMENT_NODE) {
      trimTrailingInsignificant(last);
      break;
    }
    break;
  }
}

/** Stable style attrs for dirty compare (trailing ; / prop order / spacing). */
function canonicalizeStyleAttr(style) {
  return String(style || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((decl) => {
      const i = decl.indexOf(":");
      if (i < 0) return decl.replace(/\s+/g, " ");
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim().replace(/\s+/g, " ");
      return `${prop}: ${val}`;
    })
    .sort()
    .join("; ");
}

/**
 * Mark-preserving HTML normalize for save + dirty compare.
 * Strips TipTap serialization chrome; keeps real marks and mid-paragraph br.
 */
export function canonicalizeTextHtml(html) {
  const raw = String(html || "").trim();
  if (!raw) return "";
  const doc = new DOMParser().parseFromString(raw, "text/html");
  const root = doc.body;
  for (const el of root.querySelectorAll(
    "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, div"
  )) {
    trimTrailingInsignificant(el);
  }
  for (const el of root.querySelectorAll("[style]")) {
    const next = canonicalizeStyleAttr(el.getAttribute("style"));
    if (next) el.setAttribute("style", next);
    else el.removeAttribute("style");
  }
  return prettyPrintHtml(root.innerHTML);
}

/** Clipboard → plain text so tags stay literal (not TipTap structure). */
function pasteTextFromClipboard(dataTransfer) {
  if (!dataTransfer) return null;
  const plain = dataTransfer.getData("text/plain");
  if (plain) return plain;
  const html = dataTransfer.getData("text/html");
  if (!html) return null;
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return (body ? body[1] : html).trim();
}

/**
 * Text body for TipTap is always getHTML() output.
 * Do not sniff clipboard/source HTML into the document schema.
 */
export function ensureHtml(content) {
  if (!content) return "<p></p>";
  return content;
}

/** Structured text-conflict node (not git textual markers). */
function formatConflictMarkers(labelOurs, oursStr, labelTheirs, theirsStr) {
  return (
    `<span data-kindred-text-conflict` +
    ` data-kindred-label-ours="${escapeHtml(labelOurs)}"` +
    ` data-kindred-label-theirs="${escapeHtml(labelTheirs)}"` +
    ` data-kindred-ours="${escapeHtml(oursStr)}"` +
    ` data-kindred-theirs="${escapeHtml(theirsStr)}"` +
    `></span>`
  );
}

const LEGACY_CONFLICT_RE =
  /<<<<<<< ([^\n]*)\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> ([^\n]*)(?:\n|$)/g;

function parseLegacyConflictSegments(str) {
  const re = new RegExp(LEGACY_CONFLICT_RE.source, "g");
  const segments = [];
  let last = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) {
      segments.push({ type: "text", text: str.slice(last, m.index) });
    }
    segments.push({
      type: "conflict",
      oursLabel: m[1],
      ours: m[2],
      theirs: m[3],
      theirsLabel: m[4],
    });
    last = m.index + m[0].length;
  }
  if (!segments.length) return null;
  if (last < str.length) {
    segments.push({ type: "text", text: str.slice(last) });
  }
  return segments;
}

/** Convert legacy <<<<<<< hunks to structured nodes. No-op if none. */
export function migrateLegacyConflictHtml(html) {
  const s = String(html || "");
  if (!s.includes("<<<<<<< ")) return s;
  const segs = parseLegacyConflictSegments(s);
  if (!segs) return s;
  return segs
    .map((seg) =>
      seg.type === "text"
        ? seg.text
        : formatConflictMarkers(
            seg.oursLabel,
            seg.ours,
            seg.theirsLabel,
            seg.theirs
          )
    )
    .join("");
}

function parseStructuredConflictSegments(html) {
  const raw = String(html || "");
  if (!raw || !raw.includes("data-kindred-text-conflict")) return null;
  const doc = new DOMParser().parseFromString(
    `<div id="__kindred_root">${raw}</div>`,
    "text/html"
  );
  const root = doc.getElementById("__kindred_root");
  if (!root) return null;
  const nodes = [...root.querySelectorAll("[data-kindred-text-conflict]")];
  if (!nodes.length) return null;

  const conflicts = nodes.map((el) => ({
    type: "conflict",
    oursLabel: el.getAttribute("data-kindred-label-ours") || "",
    theirsLabel: el.getAttribute("data-kindred-label-theirs") || "",
    ours: el.getAttribute("data-kindred-ours") || "",
    theirs: el.getAttribute("data-kindred-theirs") || "",
  }));

  const ph = (i) => `\uE000KINDRED_TC_${i}\uE000`;
  nodes.forEach((el, i) => el.replaceWith(doc.createTextNode(ph(i))));
  let rest = root.innerHTML;
  const segments = [];
  for (let i = 0; i < conflicts.length; i++) {
    const token = ph(i);
    const idx = rest.indexOf(token);
    if (idx < 0) return null;
    if (idx > 0) segments.push({ type: "text", text: rest.slice(0, idx) });
    segments.push(conflicts[i]);
    rest = rest.slice(idx + token.length);
  }
  if (rest) segments.push({ type: "text", text: rest });
  return segments;
}

/** Parse structured text conflicts only (legacy markers are not protocol). */
export function parseConflictSegments(text) {
  return parseStructuredConflictSegments(text);
}

export function conflictMarkerCount(text) {
  const segs = parseConflictSegments(text);
  if (!segs) return 0;
  let n = 0;
  for (const s of segs) if (s.type === "conflict") n++;
  return n;
}

/** True when an element actually has the align-conflict attribute (not body text). */
export function htmlHasAlignConflict(html) {
  return alignConflictCount(html) > 0;
}

export function alignConflictCount(html) {
  const raw = String(html || "");
  if (!raw || !raw.includes("data-kindred-align-ours")) return 0;
  const doc = new DOMParser().parseFromString(raw, "text/html");
  return doc.body.querySelectorAll("[data-kindred-align-ours]").length;
}

export function unresolvedMergeConflictCount(html) {
  return conflictMarkerCount(html) + alignConflictCount(html);
}

/**
 * Strip Kindred merge protocol from HTML (import / non-merge loads).
 * Replaces text-conflict nodes with theirs-free ours HTML; drops align protocol attrs.
 */
export function stripKindredProtocol(html) {
  const raw = String(html || "");
  if (!raw) return "";
  if (
    !raw.includes("data-kindred-") &&
    !raw.includes("<<<<<<< ")
  ) {
    return raw;
  }
  let s = raw;
  if (s.includes("<<<<<<< ")) {
    const segs = parseLegacyConflictSegments(s);
    if (segs) {
      s = segs
        .map((seg) => (seg.type === "text" ? seg.text : seg.ours || ""))
        .join("");
    }
  }
  const doc = new DOMParser().parseFromString(
    `<div id="__kindred_root">${s}</div>`,
    "text/html"
  );
  const root = doc.getElementById("__kindred_root");
  if (!root) return raw;
  root.querySelectorAll("[data-kindred-text-conflict]").forEach((el) => {
    const ours = el.getAttribute("data-kindred-ours") || "";
    if (!ours) {
      el.remove();
      return;
    }
    const wrap = doc.createElement("div");
    wrap.innerHTML = ours;
    const frag = doc.createDocumentFragment();
    while (wrap.firstChild) frag.appendChild(wrap.firstChild);
    el.replaceWith(frag);
  });
  root.querySelectorAll("[data-kindred-conflict]").forEach((el) => {
    el.remove();
  });
  root.querySelectorAll("[data-kindred-align-ours]").forEach((el) => {
    el.removeAttribute("data-kindred-align-ours");
    el.removeAttribute("data-kindred-align-theirs");
    el.removeAttribute("data-kindred-align-label-ours");
    el.removeAttribute("data-kindred-align-label-theirs");
  });
  return root.innerHTML;
}

export function joinConflictBoth(ours, theirs) {
  if (!ours) return theirs || "";
  if (!theirs) return ours;
  if (/\s$/.test(ours) || /^\s/.test(theirs)) return ours + theirs;
  return `${ours} ${theirs}`;
}

/** Build TipTap HTML for conflict view: text chunks + empty anchors for widgets. */
export function conflictDisplayHtml(markedHtml) {
  const segments = parseConflictSegments(markedHtml);
  if (!segments) return ensureHtml(markedHtml);
  let html = "";
  let conflictIndex = 0;
  for (const seg of segments) {
    if (seg.type === "text") {
      html += seg.text || "";
      continue;
    }
    html += `<span data-kindred-conflict="${conflictIndex}"></span>`;
    conflictIndex++;
  }
  return html || "<p></p>";
}

/**
 * Reassemble marked HTML: TipTap clean edits + original unresolved conflict sides.
 * Returns null if anchor count/order does not match (keeps prior marked HTML).
 *
 * Replaces each conflict anchor in-place so mid-paragraph typing stays in the same
 * <p> as the markers.
 */
export function mergeCleanEditsIntoMarked(markedHtml, tipTapHtml) {
  const segments = parseConflictSegments(markedHtml);
  if (!segments) return tipTapHtml || "";
  const conflicts = segments.filter((s) => s.type === "conflict");
  if (!conflicts.length) return tipTapHtml || "";

  const doc = new DOMParser().parseFromString(
    `<div id="__kindred_root">${tipTapHtml || ""}</div>`,
    "text/html"
  );
  const root = doc.getElementById("__kindred_root");
  if (!root) return null;

  const anchors = [...root.querySelectorAll("[data-kindred-conflict]")];
  if (anchors.length !== conflicts.length) return null;
  for (let i = 0; i < anchors.length; i++) {
    if (Number(anchors[i].getAttribute("data-kindred-conflict")) !== i) return null;
  }

  const ph = (i) => `\uE000KINDRED_CONFLICT_${i}\uE000`;
  for (let i = 0; i < anchors.length; i++) {
    anchors[i].replaceWith(doc.createTextNode(ph(i)));
  }

  let out = root.innerHTML;
  for (let i = 0; i < conflicts.length; i++) {
    const seg = conflicts[i];
    const markers = formatConflictMarkers(
      seg.oursLabel,
      seg.ours,
      seg.theirsLabel,
      seg.theirs
    );
    if (!out.includes(ph(i))) return null;
    out = out.split(ph(i)).join(markers);
  }

  return prettyPrintHtml(out);
}

function conflictNodePos(doc, index) {
  let found = null;
  doc.descendants((node, pos) => {
    if (node.type.name === "conflictParagraph" && node.attrs.conflictIndex === index) {
      found = pos;
      return false;
    }
  });
  return found;
}

/**
 * Map plain-text offsets (TipTap getText blockSeparator) ↔ ProseMirror positions.
 * Returns { plainToPm, pmRanges } where plainToPm[i] is PM pos for plain offset i
 * (length plainLen+1), and text in doc maps continuously within textblocks.
 */
function buildPlainPmMap(doc, blockSep = BLOCK_SEP) {
  const plainToPm = [];
  let plain = 0;
  let firstBlock = true;

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    if (!firstBlock) {
      for (let i = 0; i < blockSep.length; i++) {
        plainToPm[plain + i] = pos;
      }
      plain += blockSep.length;
    }
    firstBlock = false;
    let inner = pos + 1;
    node.forEach((child, offset) => {
      if (child.isText) {
        const startPlain = plain;
        const startPm = pos + 1 + offset;
        for (let i = 0; i <= child.text.length; i++) {
          plainToPm[startPlain + i] = startPm + i;
        }
        plain += child.text.length;
        inner = startPm + child.text.length;
      } else if (child.isAtom || child.isLeaf) {
        // hardBreak etc. — count as \n in getText? TipTap hardBreak is usually \n
        plainToPm[plain] = pos + 1 + offset;
        plain += 1;
        plainToPm[plain] = pos + 1 + offset + child.nodeSize;
      }
    });
    void inner;
  });

  if (!plainToPm.length) {
    plainToPm[0] = 1;
  }
  const plainLen = Math.max(0, plainToPm.length - 1);
  return { plainToPm, plainLen };
}

function pmPosForPlain(map, offset) {
  const o = Math.max(0, Math.min(offset, map.plainLen));
  return map.plainToPm[o] ?? map.plainToPm[map.plainLen] ?? 1;
}

function createDeleteWidget(text) {
  return (view, getPos) => {
    const span = document.createElement("span");
    span.className = "diff-del";
    span.textContent = text;
    span.contentEditable = "false";
    span.setAttribute("data-diff-del", "1");
    return span;
  };
}

function createConflictWidget(seg, index, onAction, conflictMode = "merge") {
  return () => {
    const wrap = document.createElement("span");
    wrap.className = "merge-conflict";
    wrap.contentEditable = "false";
    wrap.dataset.conflictIndex = String(index);
    wrap.dataset.oursLabel = seg.oursLabel;
    wrap.dataset.theirsLabel = seg.theirsLabel;

    const formatOnly = isFormatOnlyConflict(seg.ours, seg.theirs);
    const review = conflictMode === "review";

    const oursBtn = document.createElement("button");
    oursBtn.type = "button";
    oursBtn.className = "merge-conflict-btn merge-conflict-ours";
    oursBtn.title = "Keep Current";
    fillConflictBtn(oursBtn, seg.ours);
    oursBtn.dataset.conflictAction = "ours";
    oursBtn.dataset.conflictIndex = String(index);

    const theirsBtn = document.createElement("button");
    theirsBtn.type = "button";
    theirsBtn.className = "merge-conflict-btn merge-conflict-theirs";
    theirsBtn.title = review ? "Keep Dirty" : "Keep Theirs";
    fillConflictBtn(theirsBtn, seg.theirs);
    theirsBtn.dataset.conflictAction = "theirs";
    theirsBtn.dataset.conflictIndex = String(index);

    const click = (action) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      onAction?.(action, index);
    };
    oursBtn.addEventListener("mousedown", click("ours"));
    theirsBtn.addEventListener("mousedown", click("theirs"));

    const eitherEmpty = !stripHtml(seg.ours) || !stripHtml(seg.theirs);
    if (formatOnly || eitherEmpty) {
      wrap.append(oursBtn, theirsBtn);
      return wrap;
    }

    const bothBtn = document.createElement("button");
    bothBtn.type = "button";
    bothBtn.className = "merge-conflict-btn merge-conflict-both";
    bothBtn.title = "Keep Both";
    bothBtn.textContent = "+";
    bothBtn.dataset.conflictAction = "both";
    bothBtn.dataset.conflictIndex = String(index);
    bothBtn.addEventListener("mousedown", click("both"));

    wrap.append(oursBtn, bothBtn, theirsBtn);
    return wrap;
  };
}

function createAlignConflictWidget(attrs, paraPos, onAction, conflictMode = "merge") {
  return (view) => {
    const wrap = document.createElement("span");
    wrap.className = "merge-conflict merge-align-conflict";
    wrap.contentEditable = "false";

    const oursAlign = attrs.alignOurs || "left";
    const theirsAlign = attrs.alignTheirs || "left";
    const review = conflictMode === "review";

    const oursBtn = document.createElement("button");
    oursBtn.type = "button";
    oursBtn.className = "merge-conflict-btn merge-conflict-ours";
    oursBtn.title = "Keep Current alignment";
    oursBtn.innerHTML = alignPillContent(oursAlign);

    const theirsBtn = document.createElement("button");
    theirsBtn.type = "button";
    theirsBtn.className = "merge-conflict-btn merge-conflict-theirs";
    theirsBtn.title = review ? "Keep Dirty alignment" : "Keep Incoming alignment";
    theirsBtn.innerHTML = alignPillContent(theirsAlign);

    const setPreview = (align, side) => {
      const tr = view.state.tr.setMeta(overlayKey, {
        type: "alignPreview",
        preview: { paraPos, align: align || oursAlign, side: side || "ours" },
      });
      tr.setMeta("addToHistory", false);
      view.dispatch(tr);
    };

    theirsBtn.addEventListener("mouseenter", () => {
      setPreview(theirsAlign, "theirs");
    });
    theirsBtn.addEventListener("mouseleave", () => {
      setPreview(oursAlign, "ours");
    });
    oursBtn.addEventListener("mouseenter", () => {
      setPreview(oursAlign, "ours");
    });
    oursBtn.addEventListener("mouseleave", () => {
      setPreview(oursAlign, "ours");
    });

    const click = (action) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPreview(oursAlign, "ours");
      onAction?.(action, paraPos);
    };
    oursBtn.addEventListener("mousedown", click("ours"));
    theirsBtn.addEventListener("mousedown", click("theirs"));

    wrap.append(oursBtn, theirsBtn);
    return wrap;
  };
}

function appendAlignConflictDecorations(
  doc,
  decorations,
  onAlignConflictAction,
  alignPreview,
  conflictMode = "merge"
) {
  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph") return;
    if (!node.attrs.alignOurs || !node.attrs.alignTheirs) return;
    decorations.push(
      Decoration.widget(
        pos,
        createAlignConflictWidget(
          node.attrs,
          pos,
          onAlignConflictAction,
          conflictMode
        ),
        {
          side: -1,
          key: `align-${pos}:${conflictMode}:${node.attrs.alignOurs}|${node.attrs.alignTheirs}`,
        }
      )
    );
    const oursAlign = node.attrs.alignOurs || "left";
    const previewActive =
      alignPreview && alignPreview.paraPos === pos && alignPreview.align;
    const previewAlign = previewActive ? alignPreview.align : oursAlign;
    const previewSide =
      previewActive && alignPreview.side === "theirs" ? "theirs" : "ours";
    const sideColor =
      previewSide === "theirs" ? "var(--blue-text)" : "var(--orange-text)";
    const sideBg =
      previewSide === "theirs" ? "var(--blue-bg)" : "var(--orange-bg)";
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `kindred-align-preview kindred-align-preview-${previewAlign} kindred-align-side-${previewSide}`,
        style: `text-align: ${previewAlign} !important; box-sizing: border-box; border-radius: 4px; padding: 4px 6px; background: ${sideBg};`,
      })
    );
  });
}

function buildOverlayDecorations(doc, meta, diffsFn) {
  const decorations = [];
  if (!meta) return DecorationSet.empty;
  const conflictMode = meta.conflictMode === "review" ? "review" : "merge";

  if (meta.conflicts && meta.conflicts.length) {
    let ci = 0;
    for (const seg of meta.conflicts) {
      if (seg.type !== "conflict") continue;
      const pos = conflictNodePos(doc, ci);
      if (pos != null) {
        decorations.push(
          Decoration.widget(
            pos,
            createConflictWidget(seg, ci, meta.onConflictAction, conflictMode),
            {
              side: 0,
              key: `conflict-${ci}:${conflictMode}:${String(seg.ours || "").slice(0, 40)}|${String(seg.theirs || "").slice(0, 40)}`,
            }
          )
        );
      }
      ci++;
    }
    appendAlignConflictDecorations(
      doc,
      decorations,
      meta.onAlignConflictAction,
      meta.alignPreview,
      conflictMode
    );
    return DecorationSet.create(doc, decorations);
  }

  appendAlignConflictDecorations(
    doc,
    decorations,
    meta.onAlignConflictAction,
    meta.alignPreview,
    conflictMode
  );

  const baseline = meta.baseline || "";
  const currentPlain = meta.currentPlain || "";
  const hl = meta.highlight;
  const showDiffs = meta.showDiffs !== false;
  if (!diffsFn) {
    return decorations.length
      ? DecorationSet.create(doc, decorations)
      : DecorationSet.empty;
  }
  // Text mode: map highlight without painting insert/delete chrome.
  if (!showDiffs && !hl) {
    return decorations.length
      ? DecorationSet.create(doc, decorations)
      : DecorationSet.empty;
  }
  // Empty baseline + content => whole doc is an insert (e.g. first commit).
  if (!baseline && !currentPlain && !hl) {
    return decorations.length
      ? DecorationSet.create(doc, decorations)
      : DecorationSet.empty;
  }
  if (baseline && baseline === currentPlain && !hl) {
    return decorations.length
      ? DecorationSet.create(doc, decorations)
      : DecorationSet.empty;
  }

  const map = buildPlainPmMap(doc, BLOCK_SEP);
  const parts = !baseline
    ? currentPlain
      ? [[DIFF_INSERT, currentPlain]]
      : []
    : baseline === currentPlain
      ? currentPlain
        ? [[DIFF_EQUAL, currentPlain]]
        : []
      : diffsFn(baseline, currentPlain);

  let basePos = 0;
  let curPos = 0;

  function addInline(fromPlain, toPlain, className) {
    if (toPlain <= fromPlain) return;
    const from = pmPosForPlain(map, fromPlain);
    const to = pmPosForPlain(map, toPlain);
    if (to > from) {
      decorations.push(Decoration.inline(from, to, { class: className }));
    }
  }

  function paintEqual(text, baseStart) {
    if (!hl || !text) return;
    const absEnd = baseStart + text.length;
    if (absEnd <= hl.start || baseStart >= hl.end) return;
    const fromPlain = curPos + Math.max(0, hl.start - baseStart);
    const toPlain = curPos + Math.min(text.length, hl.end - baseStart);
    addInline(fromPlain, toPlain, "sent-hl");
  }

  for (const [op, data] of parts) {
    if (op === DIFF_INSERT) {
      const fromPlain = curPos;
      const toPlain = curPos + data.length;
      if (showDiffs) {
        let cls = "diff-ins";
        if (hl && basePos >= hl.start && basePos < hl.end) {
          cls = "diff-ins sent-hl";
        }
        addInline(fromPlain, toPlain, cls);
      } else if (hl && basePos >= hl.start && basePos < hl.end) {
        addInline(fromPlain, toPlain, "sent-hl");
      }
      curPos += data.length;
    } else if (op === DIFF_DELETE) {
      if (showDiffs) {
        const pm = pmPosForPlain(map, curPos);
        decorations.push(
          Decoration.widget(pm, createDeleteWidget(data), {
            side: -1,
            key: `del-${basePos}-${data.length}`,
          })
        );
      }
      basePos += data.length;
    } else {
      paintEqual(data, basePos);
      basePos += data.length;
      curPos += data.length;
    }
  }

  return DecorationSet.create(doc, decorations);
}

const KindredOverlay = Extension.create({
  name: "kindredOverlay",

  addOptions() {
    return {
      diffsFn: null,
      onConflictAction: null,
      onAlignConflictAction: null,
    };
  },

  addStorage() {
    return {
      baseline: "",
      currentPlain: "",
      highlight: null,
      showDiffs: true,
      conflicts: null,
      markedHtml: "",
    };
  },

  addCommands() {
    return {
      setKindredOverlay:
        (partial) =>
          ({ tr, dispatch }) => {
            if (dispatch) {
              tr.setMeta(overlayKey, { type: "set", partial });
              tr.setMeta("addToHistory", false);
              dispatch(tr);
            }
            return true;
          },
    };
  },

  addProseMirrorPlugins() {
    const extension = this;
    return [
      new Plugin({
        key: overlayKey,
        state: {
          init() {
            return {
              baseline: "",
              currentPlain: "",
              highlight: null,
              showDiffs: true,
              conflicts: null,
              markedHtml: "",
              conflictMode: "merge",
              alignPreview: null,
              decorations: DecorationSet.empty,
            };
          },
          apply(tr, prev, _oldState, newState) {
            const meta = tr.getMeta(overlayKey);
            let next = { ...prev };
            if (meta?.type === "set" && meta.partial) {
              next = { ...next, ...meta.partial };
              Object.assign(extension.storage, {
                baseline: next.baseline,
                currentPlain: next.currentPlain,
                highlight: next.highlight,
                showDiffs: next.showDiffs,
                conflicts: next.conflicts,
                markedHtml: next.markedHtml,
                conflictMode: next.conflictMode,
              });
            }
            if (meta?.type === "alignPreview") {
              next.alignPreview = meta.preview || null;
            }
            if (meta?.type === "set" || meta?.type === "alignPreview" || tr.docChanged) {
              next.decorations = buildOverlayDecorations(
                newState.doc,
                {
                  baseline: next.baseline,
                  currentPlain: next.currentPlain,
                  highlight: next.highlight,
                  showDiffs: next.showDiffs,
                  conflicts: next.conflicts,
                  conflictMode: next.conflictMode,
                  alignPreview: next.alignPreview,
                  onConflictAction: extension.options.onConflictAction,
                  onAlignConflictAction: extension.options.onAlignConflictAction,
                },
                extension.options.diffsFn
              );
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            return overlayKey.getState(state)?.decorations || DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

function colorToHex(value) {
  const raw = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const r = raw[1];
    const g = raw[2];
    const b = raw[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(raw);
  if (!rgb) return null;
  const hex = (n) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`;
}

function normalizeToolbarFontSize(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (/^\d+(\.\d+)?$/.test(raw)) return `${raw}px`;
  const m = /^(\d+(\.\d+)?)(px|pt|em|rem|%)$/.exec(raw);
  return m ? `${m[1]}${m[3]}` : raw.replace(/\s+/g, "");
}

function fontSizeToToolbarNumber(value, fallback = 14) {
  const normalized = normalizeToolbarFontSize(value);
  const m = /^(\d+(\.\d+)?)/.exec(normalized);
  if (!m) return fallback;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeToolbarFontFamily(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/["']/g, "")
    .toLowerCase();
}

function syncSelectValue(select, current, normalize, fallback = "") {
  if (!select) return;
  select.classList.remove("is-active");
  const normalized = normalize(current);
  let match = "";
  for (const opt of select.options) {
    if (!opt.value) continue;
    if (normalize(opt.value) === normalized) {
      match = opt.value;
      break;
    }
  }
  if (!match && fallback) {
    const fallbackNorm = normalize(fallback);
    for (const opt of select.options) {
      if (!opt.value) continue;
      if (normalize(opt.value) === fallbackNorm) {
        select.value = opt.value;
        return;
      }
    }
  }
  select.value = match;
}

function syncToolbar(editor, toolbarEl) {
  if (!toolbarEl) return;
  toolbarEl.querySelectorAll("[data-cmd]").forEach((btn) => {
    const cmd = btn.dataset.cmd;
    let active = false;
    if (cmd === "bold") active = editor.isActive("bold");
    else if (cmd === "italic") active = editor.isActive("italic");
    else if (cmd === "underline") active = editor.isActive("underline");
    else if (cmd === "strike") active = editor.isActive("strike");
    else if (cmd === "alignLeft") active = editor.isActive({ textAlign: "left" });
    else if (cmd === "alignCenter") active = editor.isActive({ textAlign: "center" });
    else if (cmd === "alignRight") active = editor.isActive({ textAlign: "right" });
    else if (cmd === "alignJustify") active = editor.isActive({ textAlign: "justify" });
    btn.classList.toggle("is-active", active);
  });
  const attrs = editor.getAttributes("textStyle");
  const colorInput = toolbarEl.querySelector("[data-color-input]");
  const colorSwatch = toolbarEl.querySelector(".tb-color-swatch");
  if (colorInput) {
    const hex = colorToHex(attrs.color);
    if (hex) colorInput.value = hex;
    if (colorSwatch) colorSwatch.style.background = hex || "currentColor";
    colorInput.closest(".toolbar-color")?.classList.toggle("is-active", Boolean(hex));
  }
  const fontSizeInput = toolbarEl.querySelector("[data-font-size]");
  if (fontSizeInput && document.activeElement !== fontSizeInput) {
    const next = String(fontSizeToToolbarNumber(attrs.fontSize, 14));
    if (fontSizeInput.value !== next) fontSizeInput.value = next;
  }
  const fontFamilySelect = toolbarEl.querySelector("[data-font-family]");
  const fontFamilyTrigger = toolbarEl.querySelector("[data-font-family-trigger]");
  if (
    fontFamilySelect &&
    document.activeElement !== fontFamilySelect &&
    document.activeElement !== fontFamilyTrigger
  ) {
    syncSelectValue(
      fontFamilySelect,
      attrs.fontFamily,
      normalizeToolbarFontFamily,
      DEFAULT_FONT_FAMILY
    );
    const name = fontNameFromCssValue(fontFamilySelect.value);
    if (name) loadGoogleFont(name);
  }
}

export function bindToolbar(editor, toolbarEl) {
  if (!toolbarEl) return () => { };
  const colorInput = toolbarEl.querySelector("[data-color-input]");
  const fontSizeInput = toolbarEl.querySelector("[data-font-size]");
  const fontFamilySelect = toolbarEl.querySelector("[data-font-family]");
  const fontFamilyPicker = fontFamilySelect
    ? mountFontFamilyPicker(fontFamilySelect)
    : null;
  const fontFamilyTrigger = toolbarEl.querySelector("[data-font-family-trigger]");
  const fontFamilyPanel = toolbarEl.querySelector("[data-font-family-panel]");
  let stashedSelection = null;

  const isColorPickerOpen = () => Boolean(document.querySelector(".clr-picker.clr-open"));
  const isChatComposerActive = () => {
    const composer = document.getElementById("chat-composer");
    if (!composer || composer.hidden) return false;
    if (composer.dataset.keepSelection === "1") return true;
    return Boolean(document.activeElement && composer.contains(document.activeElement));
  };
  const isKeepTargetActive = () => {
    const el = document.activeElement;
    if (el && (el === fontSizeInput || el === fontFamilySelect || el === colorInput)) return true;
    if (el && fontFamilyTrigger && (el === fontFamilyTrigger || fontFamilyPanel?.contains(el))) {
      return true;
    }
    if (isColorPickerOpen()) return true;
    if (isChatComposerActive()) return true;
    return false;
  };
  const stashSelection = () => {
    const { from, to } = editor.state.selection;
    stashedSelection = { from, to };
    editor.commands.setKeptSelection({ from, to });
  };
  const clearStashedSelection = () => {
    stashedSelection = null;
    if (keptSelectionKey.getState(editor.state)) {
      editor.commands.clearKeptSelection();
    }
  };
  const scheduleClearIfNoKeepTarget = () => {
    requestAnimationFrame(() => {
      if (isKeepTargetActive()) return;
      clearStashedSelection();
    });
  };

  const onClick = (e) => {
    const btn = e.target.closest("[data-cmd]");
    if (!btn || !toolbarEl.contains(btn)) return;
    e.preventDefault();
    const cmd = btn.dataset.cmd;
    const chain = editor.chain().focus();
    if (cmd === "bold") chain.toggleBold().run();
    else if (cmd === "italic") chain.toggleItalic().run();
    else if (cmd === "underline") chain.toggleUnderline().run();
    else if (cmd === "strike") chain.toggleStrike().run();
    else if (cmd === "alignLeft") chain.setTextAlign("left").run();
    else if (cmd === "alignCenter") chain.setTextAlign("center").run();
    else if (cmd === "alignRight") chain.setTextAlign("right").run();
    else if (cmd === "alignJustify") chain.setTextAlign("justify").run();
    else if (cmd === "unsetColor") chain.unsetColor().run();
  };
  const onColor = (e) => {
    const value = e.target.value;
    if (!value) return;
    const pickerOpen = isColorPickerOpen();
    const chain = editor.chain();
    if (!pickerOpen) chain.focus();
    if (stashedSelection) chain.setTextSelection(stashedSelection);
    chain.setColor(value).run();
    if (pickerOpen && stashedSelection) {
      editor.commands.setKeptSelection(stashedSelection);
    } else if (!pickerOpen) {
      clearStashedSelection();
    }
  };
  const applyFontSize = ({ returnFocus = false } = {}) => {
    if (!fontSizeInput) return;
    const n = Number(fontSizeInput.value);
    const chain = returnFocus ? editor.chain().focus() : editor.chain();
    if (stashedSelection) {
      chain.setTextSelection(stashedSelection);
    }
    if (!Number.isFinite(n) || n <= 0) {
      fontSizeInput.value = "14";
      chain.unsetFontSize().run();
      if (returnFocus) clearStashedSelection();
      else if (stashedSelection) {
        editor.commands.setKeptSelection(stashedSelection);
      }
      return;
    }
    const clamped = Math.min(96, Math.max(8, Math.round(n)));
    if (String(clamped) !== fontSizeInput.value) fontSizeInput.value = String(clamped);
    if (clamped === 14) chain.unsetFontSize().run();
    else chain.setFontSize(`${clamped}px`).run();
    if (returnFocus) clearStashedSelection();
    else if (stashedSelection) {
      editor.commands.setKeptSelection(stashedSelection);
    }
  };
  const onFontSizeKeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyFontSize({ returnFocus: true });
    }
  };
  const onFontSizeChange = () => applyFontSize({ returnFocus: false });
  const onFontFamily = () => {
    const value = fontFamilySelect?.value || DEFAULT_FONT_FAMILY;
    const name = fontNameFromCssValue(value);
    if (name) loadGoogleFont(name);
    const chain = editor.chain().focus();
    if (stashedSelection) chain.setTextSelection(stashedSelection);
    if (!value || normalizeToolbarFontFamily(value) === normalizeToolbarFontFamily(DEFAULT_FONT_FAMILY)) {
      chain.unsetFontFamily().run();
    } else {
      chain.setFontFamily(value).run();
    }
    clearStashedSelection();
  };
  const onEditorPointerDown = (e) => {
    if (toolbarEl.contains(e.target)) return;
    clearStashedSelection();
  };
  const onEditorFocus = () => clearStashedSelection();
  const onDocPointerDown = (e) => {
    if (!stashedSelection && !keptSelectionKey.getState(editor.state)) return;
    if (toolbarEl.contains(e.target)) return;
    if (e.target.closest?.("#chat-composer")) return;
    if (e.target.closest?.(".clr-picker")) {
      // Coloris may close on this click (Done / outside); clear after dismiss.
      requestAnimationFrame(() => {
        scheduleClearIfNoKeepTarget();
      });
      return;
    }
    scheduleClearIfNoKeepTarget();
  };

  toolbarEl.addEventListener("click", onClick);
  colorInput?.addEventListener("mousedown", stashSelection);
  colorInput?.addEventListener("focus", stashSelection);
  colorInput?.addEventListener("blur", scheduleClearIfNoKeepTarget);
  colorInput?.addEventListener("input", onColor);
  colorInput?.addEventListener("change", onColor);
  fontSizeInput?.addEventListener("mousedown", stashSelection);
  fontSizeInput?.addEventListener("focus", stashSelection);
  fontSizeInput?.addEventListener("change", onFontSizeChange);
  fontSizeInput?.addEventListener("keydown", onFontSizeKeydown);
  fontSizeInput?.addEventListener("blur", scheduleClearIfNoKeepTarget);
  fontFamilySelect?.addEventListener("mousedown", stashSelection);
  fontFamilySelect?.addEventListener("focus", stashSelection);
  fontFamilySelect?.addEventListener("blur", scheduleClearIfNoKeepTarget);
  fontFamilySelect?.addEventListener("change", onFontFamily);
  fontFamilyTrigger?.addEventListener("mousedown", stashSelection);
  fontFamilyTrigger?.addEventListener("focus", stashSelection);
  fontFamilyTrigger?.addEventListener("blur", scheduleClearIfNoKeepTarget);
  fontFamilyPanel?.addEventListener("mousedown", stashSelection);
  editor.view.dom.addEventListener("pointerdown", onEditorPointerDown);
  editor.on("focus", onEditorFocus);
  document.addEventListener("pointerdown", onDocPointerDown);
  const onSel = () => syncToolbar(editor, toolbarEl);
  editor.on("selectionUpdate", onSel);
  editor.on("transaction", onSel);
  syncToolbar(editor, toolbarEl);
  return () => {
    toolbarEl.removeEventListener("click", onClick);
    colorInput?.removeEventListener("mousedown", stashSelection);
    colorInput?.removeEventListener("focus", stashSelection);
    colorInput?.removeEventListener("blur", scheduleClearIfNoKeepTarget);
    colorInput?.removeEventListener("input", onColor);
    colorInput?.removeEventListener("change", onColor);
    fontSizeInput?.removeEventListener("mousedown", stashSelection);
    fontSizeInput?.removeEventListener("focus", stashSelection);
    fontSizeInput?.removeEventListener("change", onFontSizeChange);
    fontSizeInput?.removeEventListener("keydown", onFontSizeKeydown);
    fontSizeInput?.removeEventListener("blur", scheduleClearIfNoKeepTarget);
    fontFamilySelect?.removeEventListener("mousedown", stashSelection);
    fontFamilySelect?.removeEventListener("focus", stashSelection);
    fontFamilySelect?.removeEventListener("blur", scheduleClearIfNoKeepTarget);
    fontFamilySelect?.removeEventListener("change", onFontFamily);
    fontFamilyTrigger?.removeEventListener("mousedown", stashSelection);
    fontFamilyTrigger?.removeEventListener("focus", stashSelection);
    fontFamilyTrigger?.removeEventListener("blur", scheduleClearIfNoKeepTarget);
    fontFamilyPanel?.removeEventListener("mousedown", stashSelection);
    fontFamilyPicker?.destroy?.();
    editor.view.dom.removeEventListener("pointerdown", onEditorPointerDown);
    editor.off("focus", onEditorFocus);
    document.removeEventListener("pointerdown", onDocPointerDown);
    editor.off("selectionUpdate", onSel);
    editor.off("transaction", onSel);
  };
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.element
 * @param {string} [opts.content]
 * @param {function} [opts.diffsFn]
 * @param {function} [opts.onConflictAction]
 * @param {function} [opts.onAlignConflictAction]
 * @param {function} [opts.onUpdate]
 * @param {string} [opts.placeholder]
 */
export function createKindredEditor({
  element,
  content = "",
  diffsFn = null,
  onConflictAction = null,
  onAlignConflictAction = null,
  onUpdate = null,
  placeholder = "Paste or type your text here. Double-click to import.",
} = {}) {
  const editor = new Editor({
    element,
    autofocus: true,
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        paragraph: false,
      }),
      KindredParagraph,
      ConflictParagraph,
      Underline,
      TextStyle,
      Color,
      FontSize,
      FontFamily,
      KeptSelection,
      TextAlign.configure({ types: ["paragraph"] }),
      Placeholder.configure({ placeholder }),
      KindredOverlay.configure({ diffsFn, onConflictAction, onAlignConflictAction }),
    ],
    content: ensureHtml(content),
    editorProps: {
      attributes: {
        class: "tiptap ProseMirror",
        spellcheck: "true",
      },
      handlePaste(view, event) {
        const text = pasteTextFromClipboard(event.clipboardData);
        if (text == null) return false;
        const { state, dispatch } = view;
        const { from, to } = state.selection;
        dispatch(state.tr.insertText(text, from, to));
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const text = pasteTextFromClipboard(event.dataTransfer);
        if (text == null) return false;
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (!coords) return false;
        event.preventDefault();
        const { state, dispatch } = view;
        dispatch(state.tr.insertText(text, coords.pos));
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      onUpdate?.(ed);
    },
  });

  return editor;
}

export function getPlain(editor) {
  if (!editor) return "";
  return editor.getText({ blockSeparator: BLOCK_SEP }).replace(/\u00a0/g, " ");
}

export function getHtml(editor) {
  if (!editor) return "";
  return canonicalizeTextHtml(editor.getHTML());
}

export function setHtml(editor, html, { emitUpdate = false } = {}) {
  if (!editor) return;
  editor.commands.setContent(ensureHtml(html), emitUpdate);
}

export function setOverlay(editor, partial) {
  if (!editor) return;
  editor.commands.setKindredOverlay(partial);
}

export function refreshOverlay(editor, {
  baseline = "",
  currentPlain = "",
  highlight = null,
  showDiffs = true,
  markedHtml = "",
  conflictMode = "merge",
} = {}) {
  if (!editor) return;
  const conflicts = parseConflictSegments(markedHtml);
  setOverlay(editor, {
    baseline: conflicts ? "" : baseline,
    currentPlain: conflicts ? "" : currentPlain,
    highlight: conflicts ? null : highlight,
    showDiffs: conflicts ? true : showDiffs,
    conflicts,
    markedHtml: conflicts ? markedHtml : "",
    conflictMode: conflictMode === "review" ? "review" : "merge",
  });
}

export { BLOCK_SEP, formatConflictMarkers };
