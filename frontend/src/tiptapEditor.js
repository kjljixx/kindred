import { Editor, Extension, Node as TiptapNode } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  canonicalizeTextHtml,
  docToPlainText,
  kindredContentExtensions,
  prettyPrintHtml,
  blockToHtml
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
      Tab: () => {
        if (this.editor.isActive("listItem")) {
          return this.editor.commands.sinkListItem();
        }
        return this.editor.commands.insertContent("\t");
      },
      "Shift-Tab": () => {
        if (this.editor.isActive("listItem")) {
          return this.editor.commands.liftListItem();
        }
        return false;
      },
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
          ({ tr, state, dispatch }) => {
            if (dispatch) {
              tr.setMeta(keptSelectionKey, null);
              tr.setMeta("addToHistory", false);
              // Preserve active storedMarks so this transaction doesn't reset them
              if (state.storedMarks) tr.setStoredMarks(state.storedMarks);
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
      if (tag === "MARK") {
        const el = document.createElement("mark");
        const style = child.getAttribute("style") || "";
        const keepBg = /(?:^|;)\s*background-color\s*:/i.test(style);
        if (keepBg && child.style.backgroundColor) {
          el.style.backgroundColor = child.style.backgroundColor;
        }
        walk(child, el);
        into.appendChild(el);
        continue;
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

export function htmlHasListConflict(html) {
  return listConflictCount(html) > 0;
}

function listConflictCount(html) {
  const raw = String(html || "");
  if (!raw || !raw.includes("data-kindred-list-ours")) return 0;
  const doc = new DOMParser().parseFromString(raw, "text/html");
  return doc.body.querySelectorAll("[data-kindred-list-ours]").length;
}

export function unresolvedMergeConflictCount(html) {
  return (
    conflictMarkerCount(html) +
    alignConflictCount(html) +
    tableConflictCount(html) +
    listConflictCount(html)
  );
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
  root.querySelectorAll("[data-kindred-list-ours]").forEach((el) => {
    el.removeAttribute("data-kindred-list-ours");
    el.removeAttribute("data-kindred-list-theirs");
    el.removeAttribute("data-kindred-list-label-ours");
    el.removeAttribute("data-kindred-list-label-theirs");
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
 * Map canonical plain-text offsets (docToPlainText) ↔ ProseMirror positions.
 * Returns { plainToPm, plainLen } where plainToPm[i] is PM pos for plain offset i.
 */
function buildPlainPmMap(doc) {
  const plainToPm = [];
  let plain = 0;

  function appendSep(sep, pmPos) {
    for (let i = 0; i < sep.length; i++) {
      plainToPm[plain + i] = pmPos;
    }
    plain += sep.length;
  }

  function appendText(text, startPm) {
    const normalized = String(text || "").replace(/\u00a0/g, " ");
    for (let i = 0; i <= normalized.length; i++) {
      plainToPm[plain + i] = startPm + i;
    }
    plain += normalized.length;
  }

  function joinChildren(node, pos, sep, filterEmpty = false) {
    const isDoc = node.type?.name === "doc" || node.name === "doc";
    const entries = [];
    node.forEach((child, offset) => {
      const childPos = isDoc ? offset : pos + 1 + offset;
      entries.push({ child, pos: childPos });
    });
    const segments = filterEmpty
      ? entries.filter(({ child }) => docToPlainText(child))
      : entries;
    let first = true;
    for (const { child, pos: childPos } of segments) {
      if (!first) appendSep(sep, childPos);
      first = false;
      walkNode(child, childPos);
    }
  }

  function walkNode(node, pos) {
    if (node.isText) {
      appendText(node.text, pos);
      return;
    }

    const type = node.type.name;
    if (type === "paragraph" || type === "listItem") {
      joinChildren(node, pos, "");
    } else if (type === "bulletList" || type === "orderedList" || type === "table") {
      joinChildren(node, pos, "\n");
    } else if (type === "tableRow") {
      joinChildren(node, pos, "\t");
    } else if (type === "tableCell" || type === "tableHeader") {
      joinChildren(node, pos, " ");
    } else {
      joinChildren(node, pos, "\n\n", true);
    }
  }

  walkNode(doc, 0);

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

function createListPreviewWidget(listHtml, side) {
  return () => {
    const wrap = document.createElement("div");
    wrap.className = `kindred-list-preview kindred-list-side-${side}`;
    wrap.contentEditable = "false";
    wrap.innerHTML = listHtml || "";
    return wrap;
  };
}

function createListConflictWidget(attrs, listPos, onAction, conflictMode = "merge") {
  return (view) => {
    const wrap = document.createElement("div");
    wrap.className = "merge-conflict merge-list-conflict";
    wrap.contentEditable = "false";
    const review = conflictMode === "review";

    const oursBtn = document.createElement("button");
    oursBtn.type = "button";
    oursBtn.className = "merge-conflict-btn merge-conflict-ours";
    oursBtn.title = "Keep Current list";
    oursBtn.textContent = attrs.listLabelOurs || "Current";

    const theirsBtn = document.createElement("button");
    theirsBtn.type = "button";
    theirsBtn.className = "merge-conflict-btn merge-conflict-theirs";
    theirsBtn.title = review ? "Keep Dirty list" : "Keep Incoming list";
    theirsBtn.textContent =
      attrs.listLabelTheirs || (review ? "Dirty" : "Theirs");

    const setPreview = (side) => {
      const tr = view.state.tr.setMeta(overlayKey, {
        type: "listPreview",
        preview: side ? { listPos, side } : null,
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
      onAction?.(action, listPos);
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
    
    // Check if conflict attributes exist (even if one side is an empty string for deletion)
    const hasConflict =
      node.attrs.tableOurs !== null ||
      node.attrs.tableTheirs !== null ||
      Boolean(node.attrs.tableLabelOurs || node.attrs.tableLabelTheirs);
    if (!hasConflict) return;

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
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          style: "display: none !important;",
        })
      );
      if (node.attrs.tableTheirs && node.attrs.tableTheirs.trim()) {
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
      }
    } else {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: "kindred-table-conflict-node kindred-table-side-ours",
        })
      );
    }
  });
}

function appendListConflictDecorations(
  doc,
  decorations,
  onListConflictAction,
  listPreview,
  conflictMode = "merge"
) {
  doc.descendants((node, pos) => {
    if (node.type.name !== "bulletList" && node.type.name !== "orderedList") return;

    const hasConflict =
      node.attrs.listOurs !== null ||
      node.attrs.listTheirs !== null ||
      Boolean(node.attrs.listLabelOurs || node.attrs.listLabelTheirs);
    if (!hasConflict) return;

    decorations.push(
      Decoration.widget(
        pos,
        createListConflictWidget(
          node.attrs,
          pos,
          onListConflictAction,
          conflictMode
        ),
        {
          side: -1,
          key: `list-conflict-${pos}:${conflictMode}`,
        }
      )
    );

    const isHoverTheirs =
      listPreview &&
      listPreview.listPos === pos &&
      listPreview.side === "theirs";

    if (isHoverTheirs) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          style: "display: none !important;",
        })
      );
      if (node.attrs.listTheirs && node.attrs.listTheirs.trim()) {
        decorations.push(
          Decoration.widget(
            pos,
            createListPreviewWidget(node.attrs.listTheirs, "theirs"),
            {
              side: 0,
              key: `list-theirs-preview-${pos}`,
            }
          )
        );
      }
    } else {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: "kindred-list-conflict-node kindred-list-side-ours",
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

  const addedMap = new Map();
  for (const html of tableDiffs.added || []) {
    addedMap.set(html, (addedMap.get(html) || 0) + 1);
  }

  const replacementsMap = new Map();
  for (const rep of tableDiffs.replacements || []) {
    replacementsMap.set(rep.newHtml, rep.oldHtml);
  }

  doc.descendants((node, pos) => {
    if (node.type.name !== "table") return;
    const html = blockToHtml(node);

    // If this table replaced an older table, render the red deleted table directly above it
    if (replacementsMap.has(html)) {
      const oldHtml = replacementsMap.get(html);
      decorations.push(
        Decoration.widget(pos, createDeletedTableWidget(oldHtml), {
          side: -1,
          key: `deleted-table-${pos}`,
        })
      );
    }

    // Only highlight this table green if it is actually in the added/modified list
    const count = addedMap.get(html) || 0;
    if (count > 0) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { class: "diff-table-ins" })
      );
      addedMap.set(html, count - 1);
    }
  });

  // Standalone deletes (tables removed without a replacement)
  for (const [index, html] of (tableDiffs.deleted || []).entries()) {
    decorations.push(
      Decoration.widget(0, createDeletedTableWidget(html), {
        side: -1,
        key: `deleted-table-standalone-${index}`,
      })
    );
  }
}

function createDeletedListWidget(listHtml) {
  return () => {
    const wrap = document.createElement("div");
    wrap.className = "diff-list-del";
    wrap.contentEditable = "false";
    wrap.innerHTML = listHtml || "";
    return wrap;
  };
}

function appendListDiffDecorations(doc, decorations, listDiffs) {
  if (!listDiffs) return;

  const addedMap = new Map();
  for (const html of listDiffs.added || []) {
    addedMap.set(html, (addedMap.get(html) || 0) + 1);
  }

  const replacementsMap = new Map();
  for (const rep of listDiffs.replacements || []) {
    replacementsMap.set(rep.newHtml, rep.oldHtml);
  }

  doc.descendants((node, pos) => {
    if (node.type.name !== "bulletList" && node.type.name !== "orderedList") return;
    const html = blockToHtml(node);

    if (replacementsMap.has(html)) {
      const oldHtml = replacementsMap.get(html);
      decorations.push(
        Decoration.widget(pos, createDeletedListWidget(oldHtml), {
          side: -1,
          key: `deleted-list-${pos}`,
        })
      );
    }

    const count = addedMap.get(html) || 0;
    if (count > 0) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { class: "diff-list-ins" })
      );
      addedMap.set(html, count - 1);
    }
  });

  for (const [index, html] of (listDiffs.deleted || []).entries()) {
    decorations.push(
      Decoration.widget(0, createDeletedListWidget(html), {
        side: -1,
        key: `deleted-list-standalone-${index}`,
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
    appendListConflictDecorations(
      doc,
      decorations,
      meta.onListConflictAction,
      meta.listPreview,
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
  appendListConflictDecorations(
    doc,
    decorations,
    meta.onListConflictAction,
    meta.listPreview,
    conflictMode
  );

  const baseline = meta.baseline || "";
  const currentPlain = meta.currentPlain || "";
  const hl = meta.highlight;
  const showDiffs = meta.showDiffs !== false;
  const formatHunks = meta.formatHunks || [];
  const imageDiffs = meta.imageDiffs || null;
  const tableDiffs = meta.tableDiffs || null;
  const listDiffs = meta.listDiffs || null;
  const hasFormat = showDiffs && formatHunks.length > 0;
  const hasImageDiffs =
    showDiffs &&
    ((imageDiffs?.added?.length || 0) + (imageDiffs?.deleted?.length || 0) > 0);
  const hasTableDiffs =
    showDiffs &&
    ((tableDiffs?.added?.length || 0) + (tableDiffs?.deleted?.length || 0) > 0);
  const hasListDiffs =
    showDiffs &&
    ((listDiffs?.added?.length || 0) + (listDiffs?.deleted?.length || 0) > 0);

  if (!diffsFn && !hasFormat && !hasImageDiffs && !hasTableDiffs && !hasListDiffs) {
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
  if (!baseline && !currentPlain && !hl && !hasFormat && !hasImageDiffs && !hasTableDiffs && !hasListDiffs) {
    return decorations.length
      ? DecorationSet.create(doc, decorations)
      : DecorationSet.empty;
  }
  if (baseline && baseline === currentPlain && !hl && !hasFormat && !hasImageDiffs && !hasTableDiffs && !hasListDiffs) {
    return decorations.length
      ? DecorationSet.create(doc, decorations)
      : DecorationSet.empty;
  }

  const map = buildPlainPmMap(doc);
  debugEvent("diff", "calculate", {
    baseline,
    currentPlain,
    showDiffs,
    highlight: hl,
    formatHunkCount: formatHunks.length,
    imageDiffs,
    tableDiffs,
    listDiffs,
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
    appendListDiffDecorations(doc, decorations, listDiffs);
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
      onListConflictAction: null,
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
              listPreview: null,
              formatHunks: [],
              imageDiffs: null,
              tableDiffs: null,
              listDiffs: null,
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
                listDiffs: next.listDiffs,
              });
            }
            if (meta?.type === "alignPreview") {
              next.alignPreview = meta.preview || null;
            }
            if (meta?.type === "tablePreview") {
              next.tablePreview = meta.preview || null;
            }
            if (meta?.type === "listPreview") {
              next.listPreview = meta.preview || null;
            }
            if (
              meta?.type === "set" ||
              meta?.type === "alignPreview" ||
              meta?.type === "tablePreview" ||
              meta?.type === "listPreview" ||
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
                  listPreview: next.listPreview,
                  formatHunks: next.formatHunks,
                  imageDiffs: next.imageDiffs,
                  tableDiffs: next.tableDiffs,
                  listDiffs: next.listDiffs,
                  onConflictAction: extension.options.onConflictAction,
                  onAlignConflictAction: extension.options.onAlignConflictAction,
                  onTableConflictAction: extension.options.onTableConflictAction,
                  onListConflictAction: extension.options.onListConflictAction,
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

  let activeAlignCmd = "alignLeft";
  if (editor.isActive({ textAlign: "center" })) activeAlignCmd = "alignCenter";
  else if (editor.isActive({ textAlign: "right" })) activeAlignCmd = "alignRight";
  else if (editor.isActive({ textAlign: "justify" })) activeAlignCmd = "alignJustify";

  toolbarEl.querySelectorAll("[data-cmd]").forEach((btn) => {
    const cmd = btn.dataset.cmd;
    let active = false;
    if (cmd === "bold") active = markIsActive("bold");
    else if (cmd === "italic") active = markIsActive("italic");
    else if (cmd === "underline") active = markIsActive("underline");
    else if (cmd === "strike") active = markIsActive("strike");
    else if (cmd === "link") active = markIsActive("link");
    else if (cmd === "alignLeft") active = editor.isActive({ textAlign: "left" });
    else if (cmd === "alignCenter") active = editor.isActive({ textAlign: "center" });
    else if (cmd === "alignRight") active = editor.isActive({ textAlign: "right" });
    else if (cmd === "alignJustify") active = editor.isActive({ textAlign: "justify" });
    else if (cmd === "bulletList") active = editor.isActive("bulletList");
    else if (cmd === "orderedList") active = editor.isActive("orderedList");
    btn.classList.toggle("is-active", active);
  });

  const alignTrigger = toolbarEl.querySelector("[data-align-trigger]");
  const activeAlignBtn = toolbarEl.querySelector(`[data-cmd="${activeAlignCmd}"]`);
  if (alignTrigger && activeAlignBtn && alignTrigger.dataset.currentAlign !== activeAlignCmd) {
    alignTrigger.dataset.currentAlign = activeAlignCmd;
    alignTrigger.innerHTML = activeAlignBtn.innerHTML;
    alignTrigger.title = activeAlignBtn.title;
    alignTrigger.setAttribute(
      "aria-label",
      activeAlignBtn.getAttribute("aria-label") || activeAlignBtn.title
    );
  }

  const attrs = lockedMarks ? lockedMark("textStyle")?.attrs || {} : editor.getAttributes("textStyle");
  const colorInput = toolbarEl.querySelector("[data-color-input]");
  const colorSwatch = toolbarEl.querySelector(".tb-color-swatch");
  if (colorInput) {
    const hex = colorToHex(attrs.color);
    if (hex) colorInput.value = hex;
    if (colorSwatch) colorSwatch.style.background = hex || "currentColor";
    colorInput.closest(".toolbar-color")?.classList.toggle("is-active", Boolean(hex));
  }
  const highlightAttrs = lockedMarks
    ? lockedMark("highlight")?.attrs || {}
    : editor.getAttributes("highlight");
  const highlightInput = toolbarEl.querySelector("[data-highlight-input]");
  const highlightSwatch = toolbarEl.querySelector(".tb-highlight-swatch");
  const highlightBtn = toolbarEl.querySelector("[data-highlight-btn]");
  const hlColor = highlightAttrs.color;
  if (highlightInput && hlColor) {
    highlightInput.value = hlColor;
  }
  if (highlightSwatch) highlightSwatch.style.background = hlColor || "#75720c";
  const isHlActive = lockedMarks
    ? Boolean(lockedMark("highlight"))
    : editor.isActive("highlight");

  highlightBtn?.classList.toggle("is-active", isHlActive);
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
  const highlightInput = toolbarEl.querySelector("[data-highlight-input]");
  const highlightBtn = toolbarEl.querySelector("[data-highlight-btn]");
  const fontSizeInput = toolbarEl.querySelector("[data-font-size]");
  const fontFamilySelect = toolbarEl.querySelector("[data-font-family]");
  const fontFamilyPicker = fontFamilySelect
    ? mountFontFamilyPicker(fontFamilySelect)
    : null;
  const fontFamilyTrigger = toolbarEl.querySelector("[data-font-family-trigger]");
  const fontFamilyPanel = toolbarEl.querySelector("[data-font-family-panel]");
  const alignTrigger = toolbarEl.querySelector("[data-align-trigger]");
  const alignMenu = toolbarEl.querySelector("[data-align-menu]");
  const imageInput = toolbarEl.querySelector("[data-image-input]");
  const formatLockButton = toolbarEl.querySelector("[data-format-lock]");
  let stashedSelection = null;
  let formatLock = false;
  let lockedMarks = null;
  let lastHighlightColor = "rgba(117, 114, 12, 1.0)";

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
  
  const setAlignMenuOpen = (open) => {
    if (!alignMenu || !alignTrigger) return;
    alignMenu.hidden = !open;
    alignTrigger.setAttribute("aria-expanded", String(open));
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
    if (el && (el === fontSizeInput || el === fontFamilySelect || el === colorInput || el === highlightInput)) return true;
    if (el && fontFamilyTrigger && (el === fontFamilyTrigger || fontFamilyPanel?.contains(el))) {
      return true;
    }
    if (el && alignTrigger && (el === alignTrigger || alignMenu?.contains(el))) {
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

  const onAlignTriggerClick = (e) => {
    e.preventDefault();
    setAlignMenuOpen(alignMenu?.hidden ?? true);
  };

  const onDocClick = (e) => {
    if (alignMenu && !alignMenu.hidden && !alignTrigger?.contains(e.target) && !alignMenu.contains(e.target)) {
      setAlignMenuOpen(false);
    }
  };

  const onDocKeydown = (e) => {
    if (e.key === "Escape" && alignMenu && !alignMenu.hidden) {
      setAlignMenuOpen(false);
      alignTrigger?.focus();
    }
  };

  // Update onClick to close the menu on alignment command:
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
    else if (cmd === "alignLeft") { chain.setTextAlign("left").run(); setAlignMenuOpen(false); }
    else if (cmd === "alignCenter") { chain.setTextAlign("center").run(); setAlignMenuOpen(false); }
    else if (cmd === "alignRight") { chain.setTextAlign("right").run(); setAlignMenuOpen(false); }
    else if (cmd === "alignJustify") { chain.setTextAlign("justify").run(); setAlignMenuOpen(false); }
    else if (cmd === "bulletList") chain.toggleBulletList().run();
    else if (cmd === "orderedList") chain.toggleOrderedList().run();
    if (formatLock) {
      rememberCurrentFormatting();
    }
    syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
  };
  const onHighlightClick = (e) => {
    e.preventDefault();
    const chain = editor.chain().focus();
    if (stashedSelection) chain.setTextSelection(stashedSelection);
    
    // Clear kept selection within the SAME chain before setting stored marks
    chain.clearKeptSelection();

    if (editor.isActive("highlight")) {
      chain.unsetHighlight().run();
    } else {
      chain.setHighlight({ color: lastHighlightColor }).run();
    }

    if (formatLock) {
      rememberCurrentFormatting();
    }
    syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
    stashedSelection = null;
  };
  const openHighlightPicker = () => {
    if (!highlightInput || !highlightBtn) return;

    // 1. Measure the exact screen position of the 'H' button
    const rect = highlightBtn.getBoundingClientRect();

    // 2. Temporarily project the input over the button's exact coordinates
    Object.assign(highlightInput.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      opacity: "0",
      pointerEvents: "auto",
      zIndex: "1000",
    });

    highlightInput.value = lastHighlightColor;

    // 3. Trigger Coloris on the input now anchored to the button
    highlightInput.focus();
    highlightInput.click();

    // 4. Reset pointer-events after Coloris reads the bounding rect
    requestAnimationFrame(() => {
      highlightInput.style.pointerEvents = "none";
    });
  };

  const onHighlightContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openHighlightPicker();
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
  const onHighlightColor = (e) => {
    const value = e.target.value;
    if (!value) return;
    lastHighlightColor = value;
    const pickerOpen = isColorPickerOpen();
    const chain = editor.chain();
    if (!pickerOpen) chain.focus();
    if (stashedSelection) chain.setTextSelection(stashedSelection);
    chain.setHighlight({ color: value }).run();
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

  alignTrigger?.addEventListener("click", onAlignTriggerClick);
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeydown);
  toolbarEl.addEventListener("click", onClick);
  formatLockButton?.addEventListener("mousedown", onFormatLockPointerDown);
  formatLockButton?.addEventListener("click", onFormatLockClick);
  imageInput?.addEventListener("change", onImage);
  colorInput?.addEventListener("mousedown", stashSelection);
  colorInput?.addEventListener("focus", stashSelection);
  colorInput?.addEventListener("blur", scheduleClearIfNoKeepTarget);
  colorInput?.addEventListener("input", onColor);
  colorInput?.addEventListener("change", onColor);
  highlightBtn?.addEventListener("mousedown", stashSelection);
  highlightBtn?.addEventListener("click", onHighlightClick);
  highlightBtn?.addEventListener("contextmenu", onHighlightContextMenu);
  highlightInput?.addEventListener("mousedown", stashSelection);
  highlightInput?.addEventListener("focus", stashSelection);
  highlightInput?.addEventListener("blur", scheduleClearIfNoKeepTarget);
  highlightInput?.addEventListener("input", onHighlightColor);
  highlightInput?.addEventListener("change", onHighlightColor);
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
    alignTrigger?.removeEventListener("click", onAlignTriggerClick);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onDocKeydown);
    toolbarEl.removeEventListener("click", onClick);
    formatLockButton?.removeEventListener("mousedown", onFormatLockPointerDown);
    formatLockButton?.removeEventListener("click", onFormatLockClick);
    imageInput?.removeEventListener("change", onImage);
    colorInput?.removeEventListener("mousedown", stashSelection);
    colorInput?.removeEventListener("focus", stashSelection);
    colorInput?.removeEventListener("blur", scheduleClearIfNoKeepTarget);
    colorInput?.removeEventListener("input", onColor);
    colorInput?.removeEventListener("change", onColor);
    highlightBtn?.removeEventListener("mousedown", stashSelection);
    highlightBtn?.removeEventListener("click", onHighlightClick);
    highlightBtn?.removeEventListener("contextmenu", onHighlightContextMenu);
    highlightInput?.removeEventListener("mousedown", stashSelection);
    highlightInput?.removeEventListener("focus", stashSelection);
    highlightInput?.removeEventListener("blur", scheduleClearIfNoKeepTarget);
    highlightInput?.removeEventListener("input", onHighlightColor);
    highlightInput?.removeEventListener("change", onHighlightColor);
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
  onListConflictAction = null,
  onUpdate = null,
  placeholder = "Paste or type your text here. Double-click to import.",
} = {}) {
  const pendingSyncEditorSteps = [];
  let isRecordingSteps = false;

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
      KindredOverlay.configure({ diffsFn, onConflictAction, onAlignConflictAction, onTableConflictAction, onListConflictAction }),
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
    },
    onTransaction: ({ editor: ed, transaction }) => {
      if (isRecordingSteps && transaction.docChanged) {
        pendingSyncEditorSteps.push(...transaction.steps);
      }
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

  editor.startRecordingEditorSteps = () => { isRecordingSteps = true; };
  editor.getPendingSyncEditorSteps = () => [...pendingSyncEditorSteps];
  editor.clearPendingSyncEditorSteps = () => { pendingSyncEditorSteps.length = 0; };
  editor.prependPendingSyncEditorSteps = (failedSteps) => {pendingSyncEditorSteps.unshift(...failedSteps);};

  return editor;
}

export function getPlain(editor) {
  if (!editor?.state?.doc) return "";
  return docToPlainText(editor.state.doc);
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
  listDiffs = null,
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
    listDiffs,
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
    listDiffs: conflicts ? null : listDiffs,
  });
}
