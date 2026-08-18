import { Editor, Extension, Node as TiptapNode } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  canonicalizeTextHtml,
  kindredContentExtensions,
  prettyPrintHtml,
} from "./kindredSchema.js";
import {
  DEFAULT_FONT_FAMILY,
  fontNameFromCssValue,
  loadGoogleFont,
  mountFontFamilyPicker,
} from "./fontCatalog.js";
import { SelectionUnits } from "./selectionUnits.js";
import {
  debugEvent,
  debugVerbose,
  startTrace,
  summarizeEditor,
  summarizeTransaction,
} from "./debug.js";

const keptSelectionKey = new PluginKey("keptSelection");

function createKeptCaretWidget() {
  const el = document.createElement("span");
  el.className = "toolbar-kept-caret";
  el.contentEditable = "false";
  el.setAttribute("aria-hidden", "true");
  return el;
}

const InputDebug = Extension.create({
  name: "inputDebug",
  priority: 10000,
  addKeyboardShortcuts() {
    const logKey = (key) => () => {
      startTrace("input", key, { editor: summarizeEditor(this.editor) });
      return false;
    };
    return {
      Backspace: logKey("Backspace"),
      Enter: logKey("Enter"),
      Tab: logKey("Tab"),
      "Shift-Tab": logKey("Shift-Tab"),
    };
  },
});

const TabIndent = Extension.create({
  name: "tabIndent",
  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.insertContent("\t"),
    };
  },
});

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

const ALIGN_LABEL = {
  left: "Left",
  center: "Center",
  right: "Right",
  justify: "Justify",
};

function alignPillContent(align) {
  const key = String(align || "left").toLowerCase();
  return ALIGN_LABEL[key] || ALIGN_LABEL.left;
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

function openModifiedClickLink(event) {
  if (!event.ctrlKey && !event.metaKey) return false;
  const link = event.target.closest?.("a[href]");
  if (!link) return false;

  event.preventDefault();
  const opened = window.open(link.href, "_blank");
  if (opened) {
    opened.opener = null;
    opened.focus();
  }
  return true;
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
  "MARK",
  "A",
  "BR",
]);

/** Inline-safe HTML for conflict button labels (TipTap marks only). */
function conflictPreviewHtml(html) {
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
      if (tag === "IMG") {
        const src = child.getAttribute("src");
        if (!src || !/^(https?:|data:image\/)/i.test(src)) continue;
        const image = document.createElement("img");
        image.src = src;
        image.alt = child.getAttribute("alt") || "Image";
        into.appendChild(image);
        continue;
      }
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
          tag === "B" ? "strong" : tag === "I" ? "em" : tag === "A" ? "span" : tag.toLowerCase()
        );
        if (tag === "A") {
          el.style.textDecoration = "underline";
        }
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

function conflictFileNames(html) {
  const root = document.createElement("div");
  root.innerHTML = String(html || "");
  const names = new Set();

  root.querySelectorAll("img[src]").forEach((image) => {
    const alt = (image.getAttribute("alt") || "").trim();
    const src = image.getAttribute("src") || "";
    const sourceName = src.startsWith("data:image/")
      ? ""
      : decodeURIComponent(src.split(/[?#]/, 1)[0].split("/").pop() || "");
    const name = alt || sourceName;
    if (name && name !== "Image") names.add(name);
  });

  return [...names];
}

function appendConflictFileNames(button, fileNames) {
  for (const name of fileNames) {
    const label = document.createElement("span");
    label.className = "merge-conflict-file-name";
    label.textContent = name;
    button.appendChild(label);
  }
}

function fillConflictBtn(btn, html) {
  const preview = conflictPreviewHtml(html);
  const plainIn = stripHtml(html);
  const plainOut = stripHtml(preview);
  const fileNames = conflictFileNames(html);
  if (preview && (plainOut || fileNames.length)) {
    btn.innerHTML = preview;
    appendConflictFileNames(btn, fileNames);
    return;
  }
  if (plainIn) {
    btn.textContent = plainIn;
    appendConflictFileNames(btn, fileNames);
    return;
  }
  if (fileNames.length) {
    appendConflictFileNames(btn, fileNames);
    return;
  }
  btn.textContent = "\u00a0";
}

/**
 * Text body for TipTap is always getHTML() output.
 * Do not sniff clipboard/source HTML into the document schema.
 */
function ensureHtml(content) {
  if (!content) return "<p></p>";
  return content;
}

/** Structured text-conflict node (not git textual markers). */
export function formatConflictMarkers(labelOurs, oursStr, labelTheirs, theirsStr) {
  return (
    `<span data-kindred-text-conflict` +
    ` data-kindred-label-ours="${escapeHtml(labelOurs)}"` +
    ` data-kindred-label-theirs="${escapeHtml(labelTheirs)}"` +
    ` data-kindred-ours="${escapeHtml(oursStr)}"` +
    ` data-kindred-theirs="${escapeHtml(theirsStr)}"` +
    `></span>`
  );
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

/** Parse structured text conflicts. */
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

function alignConflictCount(html) {
  const raw = String(html || "");
  if (!raw || !raw.includes("data-kindred-align-ours")) return 0;
  const doc = new DOMParser().parseFromString(raw, "text/html");
  return doc.body.querySelectorAll("[data-kindred-align-ours]").length;
}

export function htmlHasTableConflict(html) {
  return tableConflictCount(html) > 0;
}

function tableConflictCount(html) {
  const raw = String(html || "");
  if (!raw || !raw.includes("data-kindred-table-ours")) return 0;
  const doc = new DOMParser().parseFromString(raw, "text/html");
  return doc.body.querySelectorAll("[data-kindred-table-ours]").length;
}

export function unresolvedMergeConflictCount(html) {
  return conflictMarkerCount(html) + alignConflictCount(html) + tableConflictCount(html);
}

/**
 * Strip Kindred merge protocol from HTML (import / non-merge loads).
 * Replaces text-conflict nodes with theirs-free ours HTML; drops align protocol attrs.
 */
export function stripKindredProtocol(html) {
  const raw = String(html || "");
  if (!raw) return "";
  if (!raw.includes("data-kindred-")) return raw;
  const doc = new DOMParser().parseFromString(
    `<div id="__kindred_root">${raw}</div>`,
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
  root.querySelectorAll("[data-kindred-table-ours]").forEach((el) => {
    el.removeAttribute("data-kindred-table-ours");
    el.removeAttribute("data-kindred-table-theirs");
    el.removeAttribute("data-kindred-table-label-ours");
    el.removeAttribute("data-kindred-table-label-theirs");
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

function createDeleteWidget(text, html = "") {
  return (view, getPos) => {
    const span = document.createElement("span");
    span.className = "diff-del";
    span.contentEditable = "false";
    span.setAttribute("data-diff-del", "1");
    if (html) {
      const preview = conflictPreviewHtml(html);
      if (preview) span.innerHTML = preview;
      else span.textContent = text || stripHtml(html);
    } else {
      span.textContent = text;
    }
    return span;
  };
}

function imageKey(image) {
  return `${image?.src || ""}\u0000${image?.alt || ""}\u0000${image?.title || ""}`;
}

function createDeletedImageWidget(image) {
  return () => {
    const wrap = document.createElement("span");
    wrap.className = "diff-image-del";
    wrap.contentEditable = "false";
    const preview = document.createElement("img");
    preview.src = image.src;
    preview.alt = image.alt || "Deleted image";
    if (image.title) preview.title = image.title;
    wrap.appendChild(preview);
    return wrap;
  };
}

function appendImageDiffDecorations(doc, decorations, imageDiffs) {
  if (!imageDiffs) return;
  const added = new Map();
  for (const image of imageDiffs.added || []) {
    const key = imageKey(image);
    added.set(key, (added.get(key) || 0) + 1);
  }
  doc.descendants((node, pos) => {
    if (node.type.name !== "image") return;
    const key = imageKey(node.attrs);
    const count = added.get(key) || 0;
    if (!count) return;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, { class: "diff-image-ins" })
    );
    added.set(key, count - 1);
  });
  for (const [index, image] of (imageDiffs.deleted || []).entries()) {
    decorations.push(
      Decoration.widget(0, createDeletedImageWidget(image), {
        side: -1,
        key: `deleted-image-${index}-${imageKey(image)}`,
      })
    );
  }
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

function createTablePreviewWidget(tableHtml, side) {
  return () => {
    const wrap = document.createElement("div");
    wrap.className = `tableWrapper kindred-table-preview kindred-table-side-${side}`;
    wrap.contentEditable = "false";
    wrap.innerHTML = tableHtml || "";
    return wrap;
  };
}

function createTableConflictWidget(attrs, tablePos, onAction, conflictMode = "merge") {
  return (view) => {
    const wrap = document.createElement("div");
    wrap.className = "merge-conflict merge-table-conflict";
    wrap.contentEditable = "false";
    const review = conflictMode === "review";

    const oursBtn = document.createElement("button");
    oursBtn.type = "button";
    oursBtn.className = "merge-conflict-btn merge-conflict-ours";
    oursBtn.title = "Keep Current table";
    oursBtn.textContent = "Current";

    const theirsBtn = document.createElement("button");
    theirsBtn.type = "button";
    theirsBtn.className = "merge-conflict-btn merge-conflict-theirs";
    theirsBtn.title = review ? "Keep Dirty table" : "Keep Incoming table";
    theirsBtn.textContent = review ? "Dirty" : "Theirs";

    const setPreview = (side) => {
      const tr = view.state.tr.setMeta(overlayKey, {
        type: "tablePreview",
        preview: side ? { tablePos, side } : null,
      });
      tr.setMeta("addToHistory", false);
      view.dispatch(tr);
    };

    theirsBtn.addEventListener("mouseenter", () => setPreview("theirs"));
    theirsBtn.addEventListener("mouseleave", () => setPreview(null));
    oursBtn.addEventListener("mouseenter", () => setPreview("ours"));
    oursBtn.addEventListener("mouseleave", () => setPreview(null));

    const click = (action) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPreview(null);
      onAction?.(action, tablePos);
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

function appendTableConflictDecorations(
  doc,
  decorations,
  onTableConflictAction,
  tablePreview,
  conflictMode = "merge"
) {
  doc.descendants((node, pos) => {
    if (node.type.name !== "table") return;
    if (!node.attrs.tableOurs || !node.attrs.tableTheirs) return;

    decorations.push(
      Decoration.widget(
        pos,
        createTableConflictWidget(
          node.attrs,
          pos,
          onTableConflictAction,
          conflictMode
        ),
        {
          side: -1,
          key: `table-conflict-${pos}:${conflictMode}`,
        }
      )
    );

    const isHoverTheirs =
      tablePreview &&
      tablePreview.tablePos === pos &&
      tablePreview.side === "theirs";

    if (isHoverTheirs) {
      // Hide live (ours) table and display the incoming (theirs) table preview
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          style: "display: none !important;",
        })
      );
      decorations.push(
        Decoration.widget(
          pos,
          createTablePreviewWidget(node.attrs.tableTheirs, "theirs"),
          {
            side: 0,
            key: `table-theirs-preview-${pos}`,
          }
        )
      );
    } else {
      // Show live (ours) table with orange side styling
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: "kindred-table-conflict-node kindred-table-side-ours",
        })
      );
    }
  });
}

function createDeletedTableWidget(tableHtml) {
  return () => {
    const wrap = document.createElement("div");
    wrap.className = "diff-table-del";
    wrap.contentEditable = "false";
    wrap.innerHTML = tableHtml || "";
    return wrap;
  };
}

function appendTableDiffDecorations(doc, decorations, tableDiffs) {
  if (!tableDiffs) return;
  if (tableDiffs.added?.length) {
    doc.descendants((node, pos) => {
      if (node.type.name !== "table") return;
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { class: "diff-table-ins" })
      );
    });
  }
  for (const [index, html] of (tableDiffs.deleted || []).entries()) {
    decorations.push(
      Decoration.widget(0, createDeletedTableWidget(html), {
        side: -1,
        key: `deleted-table-${index}`,
      })
    );
  }
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
    appendTableConflictDecorations(
      doc,
      decorations,
      meta.onTableConflictAction,
      meta.tablePreview,
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
  appendTableConflictDecorations(
    doc,
    decorations,
    meta.onTableConflictAction,
    meta.tablePreview,
    conflictMode
  );

  const baseline = meta.baseline || "";
  const currentPlain = meta.currentPlain || "";
  const hl = meta.highlight;
  const showDiffs = meta.showDiffs !== false;
  const formatHunks = meta.formatHunks || [];
  const imageDiffs = meta.imageDiffs || null;
  const tableDiffs = meta.tableDiffs || null;
  const hasFormat = showDiffs && formatHunks.length > 0;
  const hasImageDiffs =
    showDiffs &&
    ((imageDiffs?.added?.length || 0) + (imageDiffs?.deleted?.length || 0) > 0);
  const hasTableDiffs =
    showDiffs &&
    ((tableDiffs?.added?.length || 0) + (tableDiffs?.deleted?.length || 0) > 0);
  
  if (!diffsFn && !hasFormat && !hasImageDiffs) {
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
  if (!baseline && !currentPlain && !hl && !hasFormat && !hasImageDiffs && !hasTableDiffs) {
    return decorations.length
      ? DecorationSet.create(doc, decorations)
      : DecorationSet.empty;
  }
  if (baseline && baseline === currentPlain && !hl && !hasFormat && !hasImageDiffs && !hasTableDiffs) {
    return decorations.length
      ? DecorationSet.create(doc, decorations)
      : DecorationSet.empty;
  }

  const map = buildPlainPmMap(doc, BLOCK_SEP);
  debugEvent("diff", "calculate", {
    baseline,
    currentPlain,
    showDiffs,
    highlight: hl,
    formatHunkCount: formatHunks.length,
    imageDiffs,
    tableDiffs,
  });

  const parts = !baseline
    ? currentPlain
      ? [[DIFF_INSERT, currentPlain]]
      : []
    : baseline === currentPlain
      ? currentPlain
        ? [[DIFF_EQUAL, currentPlain]]
        : []
      : typeof diffsFn === "function"
        ? diffsFn(baseline, currentPlain)
        : [];

  debugEvent("diff", "result", {
    partCount: parts.length,
    parts,
    plainLen: map.plainLen,
  });
  debugVerbose("diff", "pm-map", { map, doc: doc.toJSON() });

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

  if (hl?.replacement != null) {
    const fromPlain = Math.max(0, hl.start || 0);
    const toPlain = Math.max(fromPlain, hl.end || fromPlain);
    const from = pmPosForPlain(map, fromPlain);
    const to = pmPosForPlain(map, toPlain);
    if (to > from) {
      decorations.push(
        Decoration.inline(from, to, { class: "suggest-preview-original" })
      );
    }
    const preview = document.createElement("span");
    preview.className = "suggest-preview-replacement";
    preview.textContent = String(hl.replacement);
    decorations.push(
      Decoration.widget(from, preview, { side: -1, key: "suggestion-preview" })
    );
    return DecorationSet.create(doc, decorations);
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
        debugEvent("diff", "insert-decoration", {
          text: data,
          fromPlain,
          toPlain,
          fromPm: pmPosForPlain(map, fromPlain),
          toPm: pmPosForPlain(map, toPlain),
          className: cls,
        });
        addInline(fromPlain, toPlain, cls);
      } else if (hl && basePos >= hl.start && basePos < hl.end) {
        addInline(fromPlain, toPlain, "sent-hl");
      }
      curPos += data.length;
    } else if (op === DIFF_DELETE) {
      if (showDiffs) {
        const pm = pmPosForPlain(map, curPos);
        debugEvent("diff", "delete-decoration", {
          text: data,
          basePos,
          curPos,
          pm,
        });
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

  if (hasFormat) {
    for (const hunk of formatHunks) {
      const from = hunk.from || 0;
      const to = hunk.to || 0;
      if (to <= from) continue;
      addInline(from, to, "diff-ins");
      decorations.push(
        Decoration.widget(
          pmPosForPlain(map, from),
          createDeleteWidget("", hunk.oldHtml || ""),
          { side: -1, key: `fmt-${from}-${to}` }
        )
      );
    }
  }

  if (showDiffs) {
    appendImageDiffDecorations(doc, decorations, imageDiffs);
    appendTableDiffDecorations(doc, decorations, tableDiffs);
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
      onTableConflictAction: null,
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
      formatHunks: [],
      imageDiffs: null,
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
              tablePreview: null,
              formatHunks: [],
              imageDiffs: null,
              tableDiffs: null,
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
                formatHunks: next.formatHunks,
                imageDiffs: next.imageDiffs,
                tableDiffs: next.tableDiffs,
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
                  formatHunks: next.formatHunks,
                  imageDiffs: next.imageDiffs,
                  tableDiffs: next.tableDiffs,
                  onConflictAction: extension.options.onConflictAction,
                  onAlignConflictAction: extension.options.onAlignConflictAction,
                  onTableConflictAction: extension.options.onTableConflictAction,
                },
                extension.options.diffsFn
              );
            }
            if (meta?.type === "tablePreview") {
              next.tablePreview = meta.preview || null;
            }
            if (
              meta?.type === "set" ||
              meta?.type === "alignPreview" ||
              meta?.type === "tablePreview" ||
              tr.docChanged
            ) {
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
                  tablePreview: next.tablePreview,
                  formatHunks: next.formatHunks,
                  imageDiffs: next.imageDiffs,
                  tableDiffs: next.tableDiffs,
                  onConflictAction: extension.options.onConflictAction,
                  onAlignConflictAction: extension.options.onAlignConflictAction,
                  onTableConflictAction: extension.options.onTableConflictAction,
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

function fontSizeToToolbarNumber(value, fallback = 16) {
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

function syncToolbar(editor, toolbarEl, lockedMarks = null) {
  if (!toolbarEl) return;
  const lockedMark = (name) => lockedMarks?.find((mark) => mark.type === name) || null;
  const markIsActive = (name) => lockedMarks ? Boolean(lockedMark(name)) : editor.isActive(name);
  toolbarEl.querySelectorAll("[data-cmd]").forEach((btn) => {
    const cmd = btn.dataset.cmd;
    let active = false;
    if (cmd === "bold") active = markIsActive("bold");
    else if (cmd === "italic") active = markIsActive("italic");
    else if (cmd === "underline") active = markIsActive("underline");
    else if (cmd === "strike") active = markIsActive("strike");
    else if (cmd === "highlight") active = markIsActive("highlight");
    else if (cmd === "link") active = markIsActive("link");
    else if (cmd === "alignLeft") active = editor.isActive({ textAlign: "left" });
    else if (cmd === "alignCenter") active = editor.isActive({ textAlign: "center" });
    else if (cmd === "alignRight") active = editor.isActive({ textAlign: "right" });
    else if (cmd === "alignJustify") active = editor.isActive({ textAlign: "justify" });
    btn.classList.toggle("is-active", active);
  });
  const attrs = lockedMarks ? lockedMark("textStyle")?.attrs || {} : editor.getAttributes("textStyle");
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
    const next = String(fontSizeToToolbarNumber(attrs.fontSize, 16));
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
  const inTable = editor.isActive("table");
  const tableTools = toolbarEl.querySelector("[data-table-tools]");
  if (tableTools) {
    tableTools.hidden = !inTable;
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
  const imageInput = toolbarEl.querySelector("[data-image-input]");
  const formatLockButton = toolbarEl.querySelector("[data-format-lock]");
  let stashedSelection = null;
  let formatLock = false;
  let lockedMarks = null;

  const rememberCurrentFormatting = () => {
    const { state } = editor;
    lockedMarks = (state.storedMarks || state.selection.$from.marks()).map((mark) => mark.toJSON());
  };
  const applyLockedFormatting = () => {
    if (!formatLock || !lockedMarks) return;
    const marks = lockedMarks.map((mark) => editor.schema.markFromJSON(mark));
    editor.view.dispatch(editor.state.tr.setStoredMarks(marks).setMeta("addToHistory", false));
  };
  const setFormatLock = (enabled) => {
    formatLock = enabled;
    if (enabled) rememberCurrentFormatting();
    else lockedMarks = null;
    formatLockButton?.classList.toggle("is-active", enabled);
    formatLockButton?.setAttribute("aria-pressed", String(enabled));
    syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
  };
  const onFormatLockPointerDown = (event) => event.preventDefault();
  const onFormatLockClick = (event) => {
    event.preventDefault();
    setFormatLock(!formatLock);
  };

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
    else if (cmd === "highlight") chain.toggleHighlight().run();
    else if (cmd === "link") {
      const href = window.prompt("Link URL", editor.getAttributes("link").href || "");
      if (href === null) return;
      const normalized = href.trim();
      if (!normalized) chain.unsetLink().run();
      else {
        const safeHref = /^(https?:|mailto:|#|\/)/i.test(normalized) ? normalized : `https://${normalized}`;
        chain.setLink({ href: safeHref, target: "_blank", rel: "noopener noreferrer nofollow" }).run();
      }
    } else if (cmd === "image") {
      imageInput?.click();
      return;
    } else if (cmd === "table") {
      chain.insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run();
      return;
    }
    else if (cmd === "addRowAfter") {
      chain.addRowAfter().run();
      return;
    }
    else if (cmd === "deleteRow") {
      chain.deleteRow().run();
      return;
    }
    else if (cmd === "addColumnAfter") {
      chain.addColumnAfter().run();
      return;
    }
    else if (cmd === "deleteColumn") {
      chain.deleteColumn().run();
      return;
    }
    else if (cmd === "deleteTable") {
      chain.deleteTable().run();
      return;
    }
    else if (cmd === "alignLeft") chain.setTextAlign("left").run();
    else if (cmd === "alignCenter") chain.setTextAlign("center").run();
    else if (cmd === "alignRight") chain.setTextAlign("right").run();
    else if (cmd === "alignJustify") chain.setTextAlign("justify").run();
    if (formatLock) {
      rememberCurrentFormatting();
    }
    syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
  };
  const onImage = () => {
    const file = imageInput?.files?.[0];
    if (!file?.type.startsWith("image/")) return;
    imageInput.value = "";
    editor.emit("kindredImage", { file });
  };
  const onColor = (e) => {
    const value = e.target.value;
    if (!value) return;
    const pickerOpen = isColorPickerOpen();
    const chain = editor.chain();
    if (!pickerOpen) chain.focus();
    if (stashedSelection) chain.setTextSelection(stashedSelection);
    chain.setColor(value).run();
    if (formatLock) {
      rememberCurrentFormatting();
    }
    syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
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
      fontSizeInput.value = "16";
      chain.unsetFontSize().run();
      if (formatLock) {
        rememberCurrentFormatting();
      }
      syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
      if (returnFocus) clearStashedSelection();
      else if (stashedSelection) {
        editor.commands.setKeptSelection(stashedSelection);
      }
      return;
    }
    const clamped = Math.min(96, Math.max(8, Math.round(n)));
    if (String(clamped) !== fontSizeInput.value) fontSizeInput.value = String(clamped);
    if (clamped === 16) chain.unsetFontSize().run();
    else chain.setFontSize(`${clamped}px`).run();
    if (formatLock) {
      rememberCurrentFormatting();
    }
    syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
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
    if (formatLock) {
      rememberCurrentFormatting();
    }
    syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
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
  formatLockButton?.addEventListener("mousedown", onFormatLockPointerDown);
  formatLockButton?.addEventListener("click", onFormatLockClick);
  imageInput?.addEventListener("change", onImage);
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
  const onTransaction = () => {
    syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
  };
  editor.on("transaction", onTransaction);
  const onSel = () => {
    applyLockedFormatting();
    syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
  };
  editor.on("selectionUpdate", onSel);
  syncToolbar(editor, toolbarEl);
  return () => {
    toolbarEl.removeEventListener("click", onClick);
    formatLockButton?.removeEventListener("mousedown", onFormatLockPointerDown);
    formatLockButton?.removeEventListener("click", onFormatLockClick);
    imageInput?.removeEventListener("change", onImage);
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
  onTableConflictAction = null,
  onUpdate = null,
  placeholder = "Paste or type your text here. Double-click to import.",
} = {}) {
  const editor = new Editor({
    element,
    autofocus: true,
    extensions: [
      ...kindredContentExtensions(),
      InputDebug,
      TabIndent,
      ConflictParagraph,
      KeptSelection,
      SelectionUnits,
      Placeholder.configure({ placeholder }),
      KindredOverlay.configure({ diffsFn, onConflictAction, onAlignConflictAction, onTableConflictAction }),
    ],
    content: ensureHtml(content),
    editorProps: {
      attributes: {
        class: "tiptap ProseMirror",
        spellcheck: "true",
      },
      handleDOMEvents: {
        mousedown(_view, event) {
          return openModifiedClickLink(event);
        },
      },
      // Remove handlePaste and handleDrop to let TipTap parse HTML & paragraphs natively
    },
    onTransaction: ({ editor: ed, transaction }) => {
      if (!transaction.docChanged && !transaction.selectionSet) return;
      debugEvent("editor", "transaction", {
        transaction: summarizeTransaction(transaction),
        editor: summarizeEditor(ed),
      });
    },
    onUpdate: ({ editor: ed }) => {
      debugEvent("editor", "update", { editor: summarizeEditor(ed) });
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

export function setHtml(editor, html, { emitUpdate = false, source = "unknown" } = {}) {
  if (!editor) return;
  const incoming = ensureHtml(html);
  debugEvent("editor", "setHtml", {
    source,
    emitUpdate,
    same: canonicalizeTextHtml(editor.getHTML()) === canonicalizeTextHtml(incoming),
    currentHtml: editor.getHTML(),
    incomingHtml: incoming,
  });
  editor.commands.setContent(incoming, emitUpdate);
}

function setOverlay(editor, partial) {
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
  formatHunks = [],
  imageDiffs = null,
  tableDiffs = null,
} = {}) {
  if (!editor) return;
  const conflicts = parseConflictSegments(markedHtml);
  debugEvent("diff", "overlay-refresh", {
    baseline,
    currentPlain,
    showDiffs,
    conflictMode,
    conflictCount: conflicts?.filter?.((segment) => segment.type === "conflict").length || 0,
    formatHunkCount: formatHunks.length,
    imageDiffs,
    tableDiffs,
  });
  setOverlay(editor, {
    baseline: conflicts ? "" : baseline,
    currentPlain: conflicts ? "" : currentPlain,
    highlight: conflicts ? null : highlight,
    showDiffs: conflicts ? true : showDiffs,
    conflicts,
    markedHtml: conflicts ? markedHtml : "",
    conflictMode: conflictMode === "review" ? "review" : "merge",
    formatHunks: conflicts ? [] : formatHunks,
    imageDiffs: conflicts ? null : imageDiffs,
    tableDiffs: conflicts ? null : tableDiffs,
  });
}
