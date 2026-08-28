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
import { bindLongPress } from "./longPress.js";
import {
  DEFAULT_FONT_FAMILY,
  fontNameFromCssValue,
  loadGoogleFont,
  mountFontFamilyPicker,
} from "./fontCatalog.js";
import { SelectionUnits } from "./selectionUnits.js";
import { diffTable, parseTableConflicts } from "./tableDaff.js";
import { parseListConflicts } from "./listAlign.js";
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

const SAFE_CONFLICT_IMAGE_SRC = /^(?:https?:|data:image\/|kindred-image:assets\/[a-f0-9]{64}\.[a-z0-9]+)$/i;

function conflictImageFromHtml(html) {
  const root = document.createElement("div");
  root.innerHTML = String(html || "");
  let image = null;
  let valid = true;

  function walk(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue?.trim()) valid = false;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) {
        valid = false;
        continue;
      }
      if (child.tagName === "IMG") {
        if (image) valid = false;
        image = child;
        continue;
      }
      if (child.tagName !== "P" && child.tagName !== "DIV") valid = false;
      walk(child);
    }
  }

  walk(root);
  const src = image?.getAttribute("src") || "";
  if (!valid || !image || !SAFE_CONFLICT_IMAGE_SRC.test(src)) return null;
  return {
    src,
    alt: image.getAttribute("alt") || "",
    title: image.getAttribute("title") || "",
  };
}

/** True when both conflict sides are whole image blocks (or one side is absent). */
export function isImageOnlyConflictSegment(segment) {
  if (!segment || segment.type !== "conflict") return false;
  const ours = conflictImageFromHtml(segment.ours);
  const theirs = conflictImageFromHtml(segment.theirs);
  const oursEmpty = !stripHtml(segment.ours);
  const theirsEmpty = !stripHtml(segment.theirs);
  return Boolean((ours || theirs) && (ours || oursEmpty) && (theirs || theirsEmpty));
}

function fillImageConflictBtn(button, image, sideLabel, html) {
  button.innerHTML = "";
  const fileNames = conflictFileNames(html);
  const name = fileNames[0] || image?.alt || "";
  button.setAttribute("aria-label", image ? `${sideLabel}: ${name || "Image"}` : `${sideLabel}: Remove`);
  if (!image) {
    button.textContent = "Remove";
    return;
  }

  const preview = document.createElement("img");
  preview.setAttribute("src", image.src);
  preview.alt = image.alt || `${sideLabel} image`;
  if (image.title) preview.title = image.title;
  button.appendChild(preview);
  if (fileNames.length) appendConflictFileNames(button, fileNames);
}

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
        if (!src || !SAFE_CONFLICT_IMAGE_SRC.test(src)) continue;
        const image = document.createElement("img");
        image.setAttribute("src", src);
        image.alt = child.getAttribute("alt") || "Image";
        if (child.getAttribute("title")) image.title = child.getAttribute("title");
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
export function formatConflictMarkers(
  labelOurs,
  oursStr,
  labelTheirs,
  theirsStr,
  oursState = "",
  theirsState = ""
) {
  return (
    `<span data-kindred-text-conflict` +
    ` data-kindred-label-ours="${escapeHtml(labelOurs)}"` +
    ` data-kindred-label-theirs="${escapeHtml(labelTheirs)}"` +
    ` data-kindred-ours="${escapeHtml(oursStr)}"` +
    ` data-kindred-theirs="${escapeHtml(theirsStr)}"` +
    (oursState ? ` data-kindred-ours-state="${escapeHtml(oursState)}"` : "") +
    (theirsState ? ` data-kindred-theirs-state="${escapeHtml(theirsState)}"` : "") +
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
    oursState: el.getAttribute("data-kindred-ours-state") || "",
    theirsState: el.getAttribute("data-kindred-theirs-state") || "",
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

export function resolveBlockStateConflicts(html, side, targetIndex = null) {
  const doc = new DOMParser().parseFromString(
    `<div id="__kindred_block_conflicts">${html || ""}</div>`,
    "text/html"
  );
  const root = doc.getElementById("__kindred_block_conflicts");
  if (!root) return html || "<p></p>";

  const markers = [...root.querySelectorAll("[data-kindred-text-conflict]")];
  markers.forEach((marker, index) => {
    if (targetIndex != null && index !== targetIndex) return;
    const oursState = marker.getAttribute("data-kindred-ours-state") || "";
    const theirsState = marker.getAttribute("data-kindred-theirs-state") || "";
    if (oursState !== "deleted" && theirsState !== "deleted") return;

    const shell = marker.parentElement?.tagName === "P" ? marker.parentElement : marker;
    const state = marker.getAttribute(`data-kindred-${side}-state`) || "";
    const chosen = marker.getAttribute(`data-kindred-${side}`) || "";
    if (state === "deleted" || !chosen.trim()) {
      shell.remove();
      return;
    }

    const replacementRoot = doc.createElement("div");
    replacementRoot.innerHTML = chosen;
    const replacements = [...replacementRoot.childNodes]
      .map((node) => doc.importNode(node, true));
    shell.replaceWith(...replacements);
  });

  return root.innerHTML || "<p></p>";
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
  if (!raw || !raw.includes("data-kindred-table-")) return 0;
  const doc = new DOMParser().parseFromString(raw, "text/html");
  let count = 0;
  doc.body.querySelectorAll("table").forEach((table) => {
    const granular = parseTableConflicts(
      table.getAttribute("data-kindred-table-conflicts")
    );
    if (granular) {
      count += granular.conflicts.length;
      return;
    }
    if (
      table.hasAttribute("data-kindred-table-ours") ||
      table.hasAttribute("data-kindred-table-theirs") ||
      table.hasAttribute("data-kindred-table-label-ours") ||
      table.hasAttribute("data-kindred-table-label-theirs")
    ) {
      count += 1;
    }
  });
  return count;
}

export function htmlHasListConflict(html) {
  return listConflictCount(html) > 0;
}

function listConflictCount(html) {
  const raw = String(html || "");
  if (!raw || !raw.includes("data-kindred-list")) return 0;
  const doc = new DOMParser().parseFromString(raw, "text/html");
  let count = 0;
  doc.body.querySelectorAll("ul, ol").forEach((list) => {
    const granular = parseListConflicts(
      list.getAttribute("data-kindred-list-conflicts")
    );
    if (granular) {
      count += granular.conflicts.length;
      return;
    }
    if (list.hasAttribute("data-kindred-list-ours")) count += 1;
  });
  return count;
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
  root.querySelectorAll("[data-kindred-table-conflicts]").forEach((el) => {
    el.removeAttribute("data-kindred-table-conflicts");
  });
  root.querySelectorAll("[data-kindred-list-ours]").forEach((el) => {
    el.removeAttribute("data-kindred-list-ours");
    el.removeAttribute("data-kindred-list-theirs");
    el.removeAttribute("data-kindred-list-label-ours");
    el.removeAttribute("data-kindred-list-label-theirs");
  });
  root.querySelectorAll("[data-kindred-list-conflicts]").forEach((el) => {
    el.removeAttribute("data-kindred-list-conflicts");
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
      seg.theirs,
      seg.oursState,
      seg.theirsState
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

export function plainOffsetsToPmRange(doc, start, end) {
  const map = buildPlainPmMap(doc);
  return { from: pmPosForPlain(map, start), to: pmPosForPlain(map, end) };
}

export function plainOffsetForPmPos(doc, pmPos) {
  const map = buildPlainPmMap(doc);
  let offset = 0;
  for (let i = 0; i <= map.plainLen; i++) {
    if (map.plainToPm[i] <= pmPos) offset = i;
    else break;
  }
  return offset;
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
    if (seg.oursState) wrap.dataset.oursState = seg.oursState;
    if (seg.theirsState) wrap.dataset.theirsState = seg.theirsState;

    const formatOnly = isFormatOnlyConflict(seg.ours, seg.theirs);
    const review = conflictMode === "review";
    const imageOnly = isImageOnlyConflictSegment(seg);

    if (imageOnly) {
      const oursImage = conflictImageFromHtml(seg.ours);
      const theirsImage = conflictImageFromHtml(seg.theirs);
      const theirsLabel = review ? "Dirty" : "Incoming";
      wrap.className = "merge-conflict merge-image-conflict";
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-label", "Image conflict");

      const makeImageBtn = (image, action, side, label) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "merge-conflict-btn merge-conflict-" + side + " merge-image-conflict-btn";
        button.title = image ? "Keep " + label : label + ": Remove";
        button.dataset.conflictAction = action;
        button.dataset.conflictIndex = String(index);
        fillImageConflictBtn(button, image, label, image ? (action === "ours" ? seg.ours : seg.theirs) : "");
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          onAction?.(action, index);
        });
        return button;
      };

      wrap.append(
        makeImageBtn(oursImage, "ours", "ours", "Current"),
        makeImageBtn(theirsImage, "theirs", "theirs", theirsLabel)
      );
      return wrap;
    }

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

function isTouchConflictInput() {
  return window.matchMedia("(hover: none), (pointer: coarse)").matches;
}

function bindConflictChoice({ view, oursBtn, theirsBtn, currentSide = "ours", preview, commit }) {
  let activeSide = currentSide;
  const buttons = { ours: oursBtn, theirs: theirsBtn };
  for (const [key, button] of Object.entries(buttons)) {
    button.dataset.conflictState = key === currentSide ? "current" : "";
  }
  const setState = (side) => {
    activeSide = side || currentSide;
    for (const [key, button] of Object.entries(buttons)) {
      button.dataset.conflictState = key === activeSide ? (key === currentSide ? "current" : "preview") : "";
    }
    preview?.(side);
  };
  const choose = (side) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isTouchConflictInput()) {
      if (side === activeSide) commit?.(side);
      else setState(side);
      return;
    }
    commit?.(side);
  };
  oursBtn.addEventListener("click", choose("ours"));
  theirsBtn.addEventListener("click", choose("theirs"));
  return () => {
    oursBtn.removeEventListener("click", choose("ours"));
    theirsBtn.removeEventListener("click", choose("theirs"));
    if (view) setState(null);
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

    const desktopPreview = (side) => setPreview(side === "theirs" ? theirsAlign : oursAlign, side);
    theirsBtn.addEventListener("mouseenter", () => { if (!isTouchConflictInput()) desktopPreview("theirs"); });
    theirsBtn.addEventListener("mouseleave", () => { if (!isTouchConflictInput()) desktopPreview("ours"); });
    oursBtn.addEventListener("mouseenter", () => { if (!isTouchConflictInput()) desktopPreview("ours"); });
    oursBtn.addEventListener("mouseleave", () => { if (!isTouchConflictInput()) desktopPreview("ours"); });
    bindConflictChoice({ view, oursBtn, theirsBtn, preview: desktopPreview, commit: (side) => { setPreview(oursAlign, "ours"); onAction?.(side, paraPos); } });

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

function createTableCellConflictWidget(
  conflict,
  tablePos,
  onAction,
  conflictMode = "merge"
) {
  return () => {
    const wrap = document.createElement("span");
    wrap.className = "merge-conflict merge-table-cell-conflict";
    wrap.contentEditable = "false";
    wrap.dataset.tableConflictId = conflict.id;
    const review = conflictMode === "review";

    const oursBtn = document.createElement("button");
    oursBtn.type = "button";
    oursBtn.className = "merge-conflict-btn merge-conflict-ours";
    oursBtn.title = "Keep Current cell";
    fillConflictBtn(oursBtn, conflict.oursHtml);

    const theirsBtn = document.createElement("button");
    theirsBtn.type = "button";
    theirsBtn.className = "merge-conflict-btn merge-conflict-theirs";
    theirsBtn.title = review ? "Keep Dirty cell" : "Keep Incoming cell";
    fillConflictBtn(theirsBtn, conflict.theirsHtml);

    const choose = (side) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      onAction?.(side, tablePos, conflict.id);
    };
    oursBtn.addEventListener("mousedown", choose("ours"));
    theirsBtn.addEventListener("mousedown", choose("theirs"));
    wrap.append(oursBtn, theirsBtn);
    return wrap;
  };
}

function structuralChoiceLabel(noun, exists, otherExists, side, review) {
  return exists ? "Keep" : "Remove";
}

function createTableRowConflictWidget(
  conflict,
  tablePos,
  onAction,
  conflictMode = "merge"
) {
  return () => {
    const wrap = document.createElement("span");
    wrap.className = "merge-conflict merge-table-row-conflict";
    wrap.contentEditable = "false";
    wrap.dataset.tableConflictId = conflict.id;
    const review = conflictMode === "review";

    const oursBtn = document.createElement("button");
    oursBtn.type = "button";
    oursBtn.className = "merge-conflict-btn merge-conflict-ours";
    const oursLabel = structuralChoiceLabel(
      "row",
      Boolean(conflict.oursHtml),
      Boolean(conflict.theirsHtml),
      "ours",
      review
    );
    oursBtn.title = oursLabel;
    oursBtn.textContent = oursLabel;

    const theirsBtn = document.createElement("button");
    theirsBtn.type = "button";
    theirsBtn.className = "merge-conflict-btn merge-conflict-theirs";
    const theirsLabel = structuralChoiceLabel(
      "row",
      Boolean(conflict.theirsHtml),
      Boolean(conflict.oursHtml),
      "theirs",
      review
    );
    theirsBtn.title = theirsLabel;
    theirsBtn.textContent = theirsLabel;

    const choose = (side) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      onAction?.(side, tablePos, conflict.id);
    };
    oursBtn.addEventListener("mousedown", choose("ours"));
    theirsBtn.addEventListener("mousedown", choose("theirs"));
    wrap.append(oursBtn, theirsBtn);
    return wrap;
  };
}

function createTableColumnConflictWidget(
  conflict,
  tablePos,
  onAction,
  conflictMode = "merge"
) {
  return () => {
    const wrap = document.createElement("span");
    wrap.className = "merge-conflict merge-table-column-conflict";
    wrap.contentEditable = "false";
    wrap.dataset.tableConflictId = conflict.id;
    const review = conflictMode === "review";

    const oursBtn = document.createElement("button");
    oursBtn.type = "button";
    oursBtn.className = "merge-conflict-btn merge-conflict-ours";
    const oursLabel = structuralChoiceLabel(
      "column",
      conflict.oursExists,
      conflict.theirsExists,
      "ours",
      review
    );
    oursBtn.title = oursLabel;
    oursBtn.textContent = oursLabel;

    const theirsBtn = document.createElement("button");
    theirsBtn.type = "button";
    theirsBtn.className = "merge-conflict-btn merge-conflict-theirs";
    const theirsLabel = structuralChoiceLabel(
      "column",
      conflict.theirsExists,
      conflict.oursExists,
      "theirs",
      review
    );
    theirsBtn.title = theirsLabel;
    theirsBtn.textContent = theirsLabel;

    const choose = (side) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      onAction?.(side, tablePos, conflict.id);
    };
    oursBtn.addEventListener("mousedown", choose("ours"));
    theirsBtn.addEventListener("mousedown", choose("theirs"));
    wrap.append(oursBtn, theirsBtn);
    return wrap;
  };
}

function createTableConflictWidget(attrs, tablePos, onAction, conflictMode = "merge") {
  return (view) => {
    const wrap = document.createElement("div");
    wrap.className = "merge-conflict merge-table-conflict";
    wrap.contentEditable = "false";
    const review = conflictMode === "review";
    const oursExists = Boolean(attrs.tableOurs?.trim());
    const theirsExists = Boolean(attrs.tableTheirs?.trim());

    const oursBtn = document.createElement("button");
    oursBtn.type = "button";
    oursBtn.className = "merge-conflict-btn merge-conflict-ours";
    const oursLabel = structuralChoiceLabel(
      "table",
      oursExists,
      theirsExists,
      "ours",
      review
    );
    oursBtn.title = oursLabel;
    oursBtn.textContent = oursLabel;

    const theirsBtn = document.createElement("button");
    theirsBtn.type = "button";
    theirsBtn.className = "merge-conflict-btn merge-conflict-theirs";
    const theirsLabel = structuralChoiceLabel(
      "table",
      theirsExists,
      oursExists,
      "theirs",
      review
    );
    theirsBtn.title = theirsLabel;
    theirsBtn.textContent = theirsLabel;

    const setPreview = (side) => {
      const tr = view.state.tr.setMeta(overlayKey, {
        type: "tablePreview",
        preview: side ? { tablePos, side } : null,
      });
      tr.setMeta("addToHistory", false);
      view.dispatch(tr);
    };

    theirsBtn.addEventListener("mouseenter", () => { if (!isTouchConflictInput()) setPreview("theirs"); });
    theirsBtn.addEventListener("mouseleave", () => { if (!isTouchConflictInput()) setPreview(null); });
    oursBtn.addEventListener("mouseenter", () => { if (!isTouchConflictInput()) setPreview("ours"); });
    oursBtn.addEventListener("mouseleave", () => { if (!isTouchConflictInput()) setPreview(null); });
    const choose = (side) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      setPreview(null);
      onAction?.(side, tablePos);
    };
    oursBtn.addEventListener("mousedown", choose("ours"));
    theirsBtn.addEventListener("mousedown", choose("theirs"));

    wrap.append(oursBtn, theirsBtn);
    return wrap;
  };
}

function createListPreviewWidget(listHtml, side) {
  return () => {
    const wrap = document.createElement("div");
    wrap.className = `kindred-list-preview kindred-list-side-${side}`;
    wrap.contentEditable = "false";
    if (String(listHtml || "").trim()) {
      wrap.innerHTML = listHtml;
    } else {
      wrap.innerHTML = "<p></p>";
    }
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

    theirsBtn.addEventListener("mouseenter", () => { if (!isTouchConflictInput()) setPreview("theirs"); });
    theirsBtn.addEventListener("mouseleave", () => { if (!isTouchConflictInput()) setPreview(null); });
    oursBtn.addEventListener("mouseenter", () => { if (!isTouchConflictInput()) setPreview("ours"); });
    oursBtn.addEventListener("mouseleave", () => { if (!isTouchConflictInput()) setPreview(null); });
    bindConflictChoice({ view, oursBtn, theirsBtn, preview: setPreview, commit: (side) => { setPreview(null); onAction?.(side, listPos); } });

    wrap.append(oursBtn, theirsBtn);
    return wrap;
  };
}

function createListItemStructuralConflictWidget(
  conflict,
  listPos,
  onAction,
  conflictMode = "merge"
) {
  return () => {
    const wrap = document.createElement("span");
    wrap.className = "merge-conflict merge-list-item-conflict";
    wrap.contentEditable = "false";
    wrap.dataset.listConflictId = conflict.id;
    const review = conflictMode === "review";

    const oursBtn = document.createElement("button");
    oursBtn.type = "button";
    oursBtn.className = "merge-conflict-btn merge-conflict-ours";
    const oursLabel = structuralChoiceLabel(
      "item",
      Boolean(conflict.oursHtml),
      Boolean(conflict.theirsHtml),
      "ours",
      review
    );
    oursBtn.title = oursLabel;
    oursBtn.textContent = oursLabel;

    const theirsBtn = document.createElement("button");
    theirsBtn.type = "button";
    theirsBtn.className = "merge-conflict-btn merge-conflict-theirs";
    const theirsLabel = structuralChoiceLabel(
      "item",
      Boolean(conflict.theirsHtml),
      Boolean(conflict.oursHtml),
      "theirs",
      review
    );
    theirsBtn.title = theirsLabel;
    theirsBtn.textContent = theirsLabel;

    const choose = (side) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      onAction?.(side, listPos, conflict.id);
    };
    oursBtn.addEventListener("mousedown", choose("ours"));
    theirsBtn.addEventListener("mousedown", choose("theirs"));
    wrap.append(oursBtn, theirsBtn);
    return wrap;
  };
}

function createListIndentConflictWidget(
  conflict,
  listPos,
  onAction,
  conflictMode = "merge"
) {
  return () => {
    const wrap = document.createElement("span");
    wrap.className = "merge-conflict merge-list-indent-conflict";
    wrap.contentEditable = "false";
    wrap.dataset.listConflictId = conflict.id;

    const outdentBtn = document.createElement("button");
    outdentBtn.type = "button";
    outdentBtn.className = "merge-conflict-btn merge-conflict-ours";
    outdentBtn.title = "Outdent";
    outdentBtn.textContent = "Outdent";

    const indentBtn = document.createElement("button");
    indentBtn.type = "button";
    indentBtn.className = "merge-conflict-btn merge-conflict-theirs";
    indentBtn.title = "Indent";
    indentBtn.textContent = "Indent";

    const choose = (side) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      onAction?.(side, listPos, conflict.id);
    };
    outdentBtn.addEventListener("mousedown", choose("outdent"));
    indentBtn.addEventListener("mousedown", choose("indent"));
    wrap.append(outdentBtn, indentBtn);
    return wrap;
  };
}

function listConflictSideClass(conflict) {
  if (conflict.kind === "indent") return "kindred-list-side-theirs";
  const hasOurs = Boolean(conflict.oursHtml?.trim());
  const hasTheirs = Boolean(conflict.theirsHtml?.trim());
  if (hasOurs && !hasTheirs) return "kindred-list-side-ours";
  if (hasTheirs && !hasOurs) return "kindred-list-side-theirs";
  return hasTheirs ? "kindred-list-side-theirs" : "kindred-list-side-ours";
}

function appendListItemConflictDecorations(
  listNode,
  listPos,
  decorations,
  conflicts,
  onListConflictAction,
  conflictMode
) {
  const liveItems = listItemsWithPositions(listNode, listPos);
  for (const conflict of conflicts) {
    if (conflict.kind === "content") continue;
    const live = liveItems[conflict.itemIndex];
    if (!live) continue;
    const widgetFn =
      conflict.kind === "item"
        ? createListItemStructuralConflictWidget(
            conflict,
            listPos,
            onListConflictAction,
            conflictMode
          )
        : conflict.kind === "indent"
          ? createListIndentConflictWidget(
              conflict,
              listPos,
              onListConflictAction,
              conflictMode
            )
          : null;
    if (!widgetFn) continue;
    decorations.push(
      Decoration.widget(live.linePos, widgetFn, {
        side: -1,
        key: `list-${conflict.kind}-conflict-${listPos}-${conflict.id}:${conflictMode}`,
      })
    );
    decorations.push(
      Decoration.node(live.pos, live.pos + live.node.nodeSize, {
        class: `kindred-list-item-conflict-node ${listConflictSideClass(conflict)}`,
      })
    );
  }
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

function appendTableCellConflictDecorations(
  tableNode,
  tablePos,
  decorations,
  conflicts,
  onTableConflictAction,
  conflictMode
) {
  for (const conflict of conflicts) {
    if (conflict.kind !== "cell") continue;
    if (conflict.rowIndex >= tableNode.childCount) continue;
    const rowNode = tableNode.child(conflict.rowIndex);
    if (conflict.columnIndex >= rowNode.childCount) continue;
    const rowPos = tableRowPos(tableNode, tablePos, conflict.rowIndex);
    const cellNode = rowNode.child(conflict.columnIndex);
    const cellPos = tableCellPos(rowNode, rowPos, conflict.columnIndex);
    decorations.push(
      Decoration.widget(
        cellPos + 1,
        createTableCellConflictWidget(
          conflict,
          tablePos,
          onTableConflictAction,
          conflictMode
        ),
        {
          side: -1,
          key: `table-cell-conflict-${tablePos}-${conflict.id}:${conflictMode}`,
        }
      )
    );
    decorations.push(
      Decoration.node(cellPos, cellPos + cellNode.nodeSize, {
        class: "kindred-table-cell-conflict-node",
      })
    );
  }
}

function appendTableRowConflictDecorations(
  tableNode,
  tablePos,
  decorations,
  conflicts,
  onTableConflictAction,
  conflictMode
) {
  for (const conflict of conflicts) {
    if (conflict.kind !== "row") continue;
    if (conflict.rowIndex >= tableNode.childCount) continue;
    const rowNode = tableNode.child(conflict.rowIndex);
    if (!rowNode.childCount) continue;
    const rowPos = tableRowPos(tableNode, tablePos, conflict.rowIndex);
    const firstCellPos = tableCellPos(rowNode, rowPos, 0);
    decorations.push(
      Decoration.widget(
        firstCellPos + 1,
        createTableRowConflictWidget(
          conflict,
          tablePos,
          onTableConflictAction,
          conflictMode
        ),
        {
          side: -1,
          key: `table-row-conflict-${tablePos}-${conflict.id}:${conflictMode}`,
        }
      )
    );
    decorations.push(
      Decoration.node(rowPos, rowPos + rowNode.nodeSize, {
        class: `kindred-table-row-conflict-node kindred-table-side-${
          conflict.oursHtml ? "ours" : "theirs"
        }`,
      })
    );
  }
}

function appendTableColumnConflictDecorations(
  tableNode,
  tablePos,
  decorations,
  conflicts,
  onTableConflictAction,
  conflictMode
) {
  for (const conflict of conflicts) {
    if (conflict.kind !== "column" || !tableNode.childCount) continue;
    const firstRow = tableNode.child(0);
    if (conflict.columnIndex >= firstRow.childCount) continue;
    const firstRowPos = tableRowPos(tableNode, tablePos, 0);
    const firstCellPos = tableCellPos(
      firstRow,
      firstRowPos,
      conflict.columnIndex
    );
    decorations.push(
      Decoration.widget(
        firstCellPos + 1,
        createTableColumnConflictWidget(
          conflict,
          tablePos,
          onTableConflictAction,
          conflictMode
        ),
        {
          side: -1,
          key: `table-column-conflict-${tablePos}-${conflict.id}:${conflictMode}`,
        }
      )
    );
    for (let rowIndex = 0; rowIndex < tableNode.childCount; rowIndex++) {
      const rowNode = tableNode.child(rowIndex);
      if (conflict.columnIndex >= rowNode.childCount) continue;
      const rowPos = tableRowPos(tableNode, tablePos, rowIndex);
      const cellNode = rowNode.child(conflict.columnIndex);
      const cellPos = tableCellPos(rowNode, rowPos, conflict.columnIndex);
      decorations.push(
        Decoration.node(cellPos, cellPos + cellNode.nodeSize, {
          class: `kindred-table-column-conflict-node kindred-table-side-${
            conflict.oursExists ? "ours" : "theirs"
          }`,
        })
      );
    }
  }
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
    const granular = parseTableConflicts(node.attrs.tableConflicts);
    if (granular?.conflicts.length) {
      appendTableCellConflictDecorations(
        node,
        pos,
        decorations,
        granular.conflicts,
        onTableConflictAction,
        conflictMode
      );
      appendTableRowConflictDecorations(
        node,
        pos,
        decorations,
        granular.conflicts,
        onTableConflictAction,
        conflictMode
      );
      appendTableColumnConflictDecorations(
        node,
        pos,
        decorations,
        granular.conflicts,
        onTableConflictAction,
        conflictMode
      );
      return false;
    }
    
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

    const granular = parseListConflicts(node.attrs.listConflicts);
    if (granular?.conflicts.length) {
      appendListItemConflictDecorations(
        node,
        pos,
        decorations,
        granular.conflicts,
        onListConflictAction,
        conflictMode
      );
      return false;
    }

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

    const activePreviewSide =
      listPreview &&
      listPreview.listPos === pos &&
      (listPreview.side === "theirs" || listPreview.side === "ours")
        ? listPreview.side
        : "ours";
    const previewHtml =
      activePreviewSide === "theirs" ? node.attrs.listTheirs : node.attrs.listOurs;

    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        style: "display: none !important;",
      })
    );
    decorations.push(
      Decoration.widget(
        pos,
        createListPreviewWidget(previewHtml || "", activePreviewSide),
        {
          side: 0,
          key: `list-${activePreviewSide}-preview-${pos}`,
        }
      )
    );
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

function createDeletedTableCellWidget(cellHtml) {
  return () => {
    const deleted = document.createElement("div");
    deleted.className = "diff-table-cell-del";
    deleted.contentEditable = "false";
    deleted.innerHTML = cellHtml || "";
    return deleted;
  };
}

function createDeletedTableRowWidget(rowHtml) {
  return () => {
    const table = document.createElement("table");
    table.innerHTML = `<tbody>${rowHtml || ""}</tbody>`;
    const row = table.querySelector("tr") || document.createElement("tr");
    row.classList.add("diff-table-row-del");
    row.contentEditable = "false";
    return row;
  };
}

function createDeletedTableColumnWidget(cellHtml) {
  return () => {
    const table = document.createElement("table");
    table.innerHTML = `<tbody><tr>${cellHtml || ""}</tr></tbody>`;
    const cell = table.querySelector("td, th") || document.createElement("td");
    cell.classList.add("diff-table-column-del");
    cell.contentEditable = "false";
    return cell;
  };
}

function tableRowPos(tableNode, tablePos, rowIndex) {
  let pos = tablePos + 1;
  for (let index = 0; index < rowIndex; index++) {
    pos += tableNode.child(index).nodeSize;
  }
  return pos;
}

function tableCellPos(rowNode, rowPos, columnIndex) {
  let pos = rowPos + 1;
  for (let index = 0; index < columnIndex; index++) {
    pos += rowNode.child(index).nodeSize;
  }
  return pos;
}

function appendChangedTableCellDecorations(
  tableNode,
  tablePos,
  decorations,
  changes
) {
  for (const change of changes) {
    const row = tableNode.child(change.rowIndex);
    const cell = row?.child(change.columnIndex);
    const content = cell?.firstChild;
    if (!row || !cell || !content) continue;

    let rowOffset = 0;
    for (let index = 0; index < change.rowIndex; index++) {
      rowOffset += tableNode.child(index).nodeSize;
    }
    let cellOffset = 0;
    for (let index = 0; index < change.columnIndex; index++) {
      cellOffset += row.child(index).nodeSize;
    }
    const cellPos = tablePos + 2 + rowOffset + cellOffset;
    const contentPos = cellPos + 1;

    decorations.push(
      Decoration.widget(
        contentPos,
        createDeletedTableCellWidget(change.beforeHtml),
        {
          side: -1,
          key: `deleted-table-cell-${tablePos}-${change.rowIndex}-${change.columnIndex}`,
        }
      )
    );
    decorations.push(
      Decoration.node(contentPos, contentPos + content.nodeSize, {
        class: "diff-table-cell-ins",
      })
    );
  }
}

function appendDeletedTableRowDecorations(
  tableNode,
  tablePos,
  decorations,
  rows
) {
  for (const row of rows) {
    if (row.action !== "delete") continue;
    decorations.push(
      Decoration.widget(
        tableRowPos(tableNode, tablePos, row.insertAt),
        createDeletedTableRowWidget(row.beforeHtml),
        {
          side: -1,
          key: `deleted-table-row-${tablePos}-${row.beforeIndex}`,
        }
      )
    );
  }
}

function appendInsertedTableRowDecorations(
  tableNode,
  tablePos,
  decorations,
  rows
) {
  for (const row of rows) {
    if (row.action !== "insert") continue;
    const rowNode = tableNode.child(row.afterIndex);
    const rowPos = tableRowPos(tableNode, tablePos, row.afterIndex);
    decorations.push(
      Decoration.node(rowPos, rowPos + rowNode.nodeSize, {
        class: "diff-table-row-ins",
      })
    );
  }
}

function appendDeletedTableColumnDecorations(
  tableNode,
  tablePos,
  decorations,
  columns,
  rows
) {
  for (const column of columns) {
    if (column.action !== "delete") continue;
    for (const row of rows) {
      if (row.afterIndex == null) continue;
      const rowNode = tableNode.child(row.afterIndex);
      const rowPos = tableRowPos(tableNode, tablePos, row.afterIndex);
      decorations.push(
        Decoration.widget(
          tableCellPos(rowNode, rowPos, column.insertAt),
          createDeletedTableColumnWidget(
            row.beforeIndex == null
              ? ""
              : column.beforeCellsHtml[row.beforeIndex]
          ),
          {
            side: -1,
            key: `deleted-table-column-${tablePos}-${row.beforeIndex}-${column.beforeIndex}`,
          }
        )
      );
    }
  }
}

function appendInsertedTableColumnDecorations(
  tableNode,
  tablePos,
  decorations,
  columns,
  rows
) {
  for (const column of columns) {
    if (column.action !== "insert") continue;
    for (const row of rows) {
      if (row.afterIndex == null) continue;
      const rowNode = tableNode.child(row.afterIndex);
      if (column.afterIndex >= rowNode.childCount) continue;
      const rowPos = tableRowPos(tableNode, tablePos, row.afterIndex);
      const cellNode = rowNode.child(column.afterIndex);
      const cellPos = tableCellPos(rowNode, rowPos, column.afterIndex);
      decorations.push(
        Decoration.node(cellPos, cellPos + cellNode.nodeSize, {
          class: "diff-table-column-ins",
        })
      );
    }
  }
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
      const tableDiff = diffTable(oldHtml, html);
      const hasRowChanges = tableDiff.rows.some((row) => row.action !== "equal");
      const hasColumnChanges = tableDiff.columns.some(
        (column) => column.action !== "equal"
      );
      if (tableDiff.cells.length || hasRowChanges || hasColumnChanges) {
        appendChangedTableCellDecorations(
          node,
          pos,
          decorations,
          tableDiff.cells
        );
        appendDeletedTableRowDecorations(
          node,
          pos,
          decorations,
          tableDiff.rows
        );
        appendInsertedTableRowDecorations(
          node,
          pos,
          decorations,
          tableDiff.rows
        );
        appendDeletedTableColumnDecorations(
          node,
          pos,
          decorations,
          tableDiff.columns,
          tableDiff.rows
        );
        appendInsertedTableColumnDecorations(
          node,
          pos,
          decorations,
          tableDiff.columns,
          tableDiff.rows
        );
      } else {
        decorations.push(
          Decoration.widget(pos, createDeletedTableWidget(oldHtml), {
            side: -1,
            key: `deleted-table-${pos}`,
          })
        );
      }
    }

    // Only highlight this table green if it is actually in the added/modified list
    const count = addedMap.get(html) || 0;
    if (count > 0 && !replacementsMap.has(html)) {
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

function createDeletedListItemWidget(itemHtml, depthShift = 0) {
  return () => {
    const parsed = new DOMParser().parseFromString(itemHtml || "<li><p></p></li>", "text/html");
    const item = parsed.body.querySelector("li") || parsed.body.firstElementChild;
    const li = item ? document.importNode(item, true) : document.createElement("li");
    li.classList.add("diff-list-item-del");
    li.contentEditable = "false";
    li.style.setProperty("--diff-depth-shift", String(depthShift));
    li.querySelectorAll("ul, ol").forEach((nested) => nested.remove());
    return li;
  };
}

function listItemsWithPositions(list, listPos) {
  const items = [];
  const ownText = (item) => {
    const parts = [];
    item.forEach((child) => {
      if (child.type.name !== "bulletList" && child.type.name !== "orderedList") {
        parts.push(docToPlainText(child));
      }
    });
    return parts.join("");
  };
  const walk = (container, containerPos, depth) => {
    container.forEach((child, offset) => {
      const childPos = containerPos + 1 + offset;
      if (child.type.name !== "listItem") return;
      const lineNode = child.firstChild;
      items.push({
        node: child,
        pos: childPos,
        lineNode,
        linePos: childPos + 1,
        lineSize: lineNode?.nodeSize || 1,
        depth,
        text: ownText(child),
      });
      child.forEach((nested, nestedOffset) => {
        if (nested.type.name === "bulletList" || nested.type.name === "orderedList") {
          walk(nested, childPos + 1 + nestedOffset, depth + 1);
        }
      });
    });
  };
  walk(list, listPos, 0);
  return items;
}

function listWordDiffParts(oldText, newText) {
  const tokenize = (value) => String(value || "").match(/\s+|[A-Za-z0-9_]+|[^\w\s]/g) || [];
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  const dp = Array.from({ length: oldTokens.length + 1 }, () =>
    new Array(newTokens.length + 1).fill(0)
  );
  for (let i = 1; i <= oldTokens.length; i++) {
    for (let j = 1; j <= newTokens.length; j++) {
      dp[i][j] = oldTokens[i - 1] === newTokens[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const reversed = [];
  let i = oldTokens.length;
  let j = newTokens.length;
  while (i || j) {
    if (i && j && oldTokens[i - 1] === newTokens[j - 1]) {
      reversed.push([DIFF_EQUAL, oldTokens[i - 1]]); i--; j--;
    } else if (j && (!i || dp[i][j - 1] >= dp[i - 1][j])) {
      reversed.push([DIFF_INSERT, newTokens[j - 1]]); j--;
    } else {
      reversed.push([DIFF_DELETE, oldTokens[i - 1]]); i--;
    }
  }
  reversed.reverse();
  return reversed.reduce((parts, [kind, text]) => {
    const last = parts[parts.length - 1];
    if (last && last[0] === kind) last[1] += text;
    else parts.push([kind, text]);
    return parts;
  }, []);
}

function appendListItemTextDiff(item, oldText, newText, decorations, key) {
  if (!item || oldText === newText) return;
  const parts = listWordDiffParts(oldText, newText);
  let currentOffset = 0;
  for (const [op, text] of parts) {
    if (!text) continue;
    if (op === DIFF_INSERT) {
      decorations.push(
        Decoration.inline(
          item.linePos + 1 + currentOffset,
          item.linePos + 1 + currentOffset + text.length,
          { class: "diff-ins" }
        )
      );
      currentOffset += text.length;
    } else if (op === DIFF_DELETE) {
      decorations.push(
        Decoration.widget(
          item.linePos + 1 + currentOffset,
          createDeleteWidget(text),
          { side: -1, key: `list-del-${key}-${currentOffset}` }
        )
      );
    } else {
      currentOffset += text.length;
    }
  }
}

function appendListDiffDecorations(doc, decorations, listDiffs, diffsFn) {
  if (!listDiffs) return;
  const renderedLists = new Set();

  doc.descendants((node, pos) => {
    if (node.type.name !== "bulletList" && node.type.name !== "orderedList") return;
    const html = blockToHtml(node);
    const replacement = (listDiffs.replacements || []).find((rep) => rep.newHtml === html);
    if (!replacement) return;
    renderedLists.add(replacement);
    const liveItems = listItemsWithPositions(node, pos);
    const topLevelItems = liveItems.filter((item) => item.depth === 0);
    const oldGhosts = [];
    for (const [changeIndex, change] of (replacement.items || []).entries()) {
      if (change.action === "equal") continue;
      const live = change.newIndex == null ? null : liveItems[change.newIndex];
      if (change.action === "insert") {
        if (live) decorations.push(Decoration.node(live.linePos, live.linePos + live.lineSize, { class: "diff-list-item-ins" }));
        continue;
      }
      if (change.action === "edit") {
        appendListItemTextDiff(live, change.oldText, change.newText, decorations, `${pos}-${changeIndex}`);
        continue;
      }
      if (change.action === "move" || change.action === "move-edit") {
        if (live) {
          decorations.push(Decoration.node(live.linePos, live.linePos + live.lineSize, { class: "diff-list-item-ins" }));
          if (change.action === "move-edit") {
            appendListItemTextDiff(live, change.oldText, change.newText, decorations, `${pos}-${changeIndex}`);
          }
          oldGhosts.push({
            html: change.oldHtml,
            shift: change.oldDepth - change.newDepth,
            targetIndex: change.newIndex,
            oldDepth: change.oldDepth,
            newDepth: change.newDepth,
            oldPath: change.oldPath,
            key: `${pos}-${changeIndex}`,
          });
        }
        continue;
      }
      if (change.action === "delete") {
        oldGhosts.push({
          html: change.html,
          shift: 0,
          targetIndex: change.oldIndex,
          key: `${pos}-${changeIndex}`,
        });
      }
    }
    for (const ghost of oldGhosts) {
      const targetItems = ghost.oldDepth < ghost.newDepth ? topLevelItems : liveItems;
      const targetIndex = ghost.oldDepth < ghost.newDepth
        ? ghost.oldPath?.[0] ?? targetItems.length
        : ghost.targetIndex;
      const target = targetIndex < targetItems.length
        ? targetItems[targetIndex]
        : null;
      const targetPos = target?.pos ?? pos + node.nodeSize - 1;
      const depthShift = ghost.oldDepth == null
        ? ghost.shift
        : ghost.oldDepth - (target?.depth ?? 0);
      decorations.push(Decoration.widget(targetPos, createDeletedListItemWidget(ghost.html, depthShift), { side: -1, key: `deleted-list-item-${ghost.key}` }));
    }
  });

  for (const [index, replacement] of (listDiffs.replacements || []).entries()) {
    if (replacement.newHtml || renderedLists.has(replacement)) continue;
    if (replacement.oldHtml) {
      decorations.push(
        Decoration.widget(0, createDeletedListWidget(replacement.oldHtml), {
          side: -1,
          key: `deleted-list-standalone-${index}`,
        })
      );
    }
  }
}

function buildOverlayDecorations(doc, meta, diffsFn) {
  const decorations = [];
  if (!meta) return DecorationSet.empty;
  const conflictMode = meta.conflictMode === "review" ? "review" : "merge";
  const showConflictChrome = meta.showConflictChrome !== false;

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
              key: `conflict-${ci}:${conflictMode}:${seg.oursState}|${seg.theirsState}:${String(seg.ours || "").slice(0, 40)}|${String(seg.theirs || "").slice(0, 40)}`,
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

  if (showConflictChrome) {
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
  }

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
    ((listDiffs?.added?.length || 0) +
      (listDiffs?.deleted?.length || 0) +
      (listDiffs?.replacements?.length || 0) > 0);

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

  const standaloneAddedTables = new Map();
  for (const html of tableDiffs?.added || []) {
    standaloneAddedTables.set(html, (standaloneAddedTables.get(html) || 0) + 1);
  }
  for (const replacement of tableDiffs?.replacements || []) {
    const count = standaloneAddedTables.get(replacement.newHtml) || 0;
    if (count > 1) standaloneAddedTables.set(replacement.newHtml, count - 1);
    else standaloneAddedTables.delete(replacement.newHtml);
  }

  function deletedTextPosition(pm) {
    let tableStart = null;
    doc.descendants((node, pos) => {
      if (node.type.name !== "table") return;
      if (pm <= pos || pm >= pos + node.nodeSize) return false;
      if (standaloneAddedTables.has(blockToHtml(node))) tableStart = pos;
      return false;
    });
    return tableStart ?? pm;
  }

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
        const pm = deletedTextPosition(pmPosForPlain(map, curPos));
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
    appendListDiffDecorations(doc, decorations, listDiffs, diffsFn);
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
              showConflictChrome: false,
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
                showConflictChrome: next.showConflictChrome,
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
                  showConflictChrome: next.showConflictChrome !== false,
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

const DEFAULT_FONT_SIZE_PT = 12;

function normalizeToolbarFontSize(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (/^\d+(\.\d+)?$/.test(raw)) return `${raw}pt`;
  const m = /^(\d+(\.\d+)?)(px|pt|em|rem|%)$/.exec(raw);
  return m ? `${m[1]}${m[3]}` : raw.replace(/\s+/g, "");
}

function fontSizeToToolbarNumber(value, fallback = DEFAULT_FONT_SIZE_PT) {
  const normalized = normalizeToolbarFontSize(value);
  const m = /^(\d+(\.\d+)?)(px|pt|em|rem|%)?$/.exec(normalized);
  if (!m) return fallback;
  let n = Number(m[1]);
  const unit = m[3] || "pt";
  if (unit === "px") n = Math.round(n * 0.75);
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
    const next = String(fontSizeToToolbarNumber(attrs.fontSize, DEFAULT_FONT_SIZE_PT));
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

export function bindToolbar(editor, toolbarEl, { onStateChange } = {}) {
  if (!toolbarEl) return { destroy() {}, getState() { return {}; }, applyState() {} };
  const colorInput = toolbarEl.querySelector("[data-color-input]");
  const highlightInput = toolbarEl.querySelector("[data-highlight-input]");
  const highlightBtn = toolbarEl.querySelector("[data-highlight-btn]");
  const highlightSwatch = toolbarEl.querySelector(".tb-highlight-swatch");
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

  const getToolbarState = () => ({
    formatLock,
    lockedMarks: formatLock && lockedMarks?.length ? lockedMarks : null,
    lastHighlightColor,
  });
  const notifyStateChange = () => {
    onStateChange?.(getToolbarState());
  };
  const applyToolbarState = (state) => {
    if (!state || typeof state !== "object") return;
    if (typeof state.lastHighlightColor === "string" && state.lastHighlightColor.trim()) {
      lastHighlightColor = state.lastHighlightColor.trim();
      if (highlightInput) highlightInput.value = lastHighlightColor;
      if (highlightSwatch) highlightSwatch.style.background = lastHighlightColor;
    }
    if (state.formatLock) {
      if (Array.isArray(state.lockedMarks) && state.lockedMarks.length) {
        lockedMarks = state.lockedMarks;
      } else {
        rememberCurrentFormatting();
      }
      formatLock = true;
      formatLockButton?.classList.toggle("is-active", true);
      formatLockButton?.setAttribute("aria-pressed", "true");
      applyLockedFormatting();
    } else {
      formatLock = false;
      lockedMarks = null;
      formatLockButton?.classList.toggle("is-active", false);
      formatLockButton?.setAttribute("aria-pressed", "false");
    }
    syncToolbar(editor, toolbarEl, formatLock ? lockedMarks : null);
  };

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
    notifyStateChange();
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
  const removeHighlightLongPress = bindLongPress(highlightBtn, () => {
    openHighlightPicker();
    return true;
  });
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
    notifyStateChange();
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
      fontSizeInput.value = String(DEFAULT_FONT_SIZE_PT);
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
    if (clamped === DEFAULT_FONT_SIZE_PT) chain.unsetFontSize().run();
    else chain.setFontSize(`${clamped}pt`).run();
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
  return {
    getState: getToolbarState,
    applyState: applyToolbarState,
    destroy() {
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
    removeHighlightLongPress();
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
    },
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
  showConflictChrome = false,
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
    showConflictChrome,
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
    showConflictChrome: conflicts ? true : showConflictChrome,
    formatHunks: conflicts ? [] : formatHunks,
    imageDiffs: conflicts ? null : imageDiffs,
    tableDiffs: conflicts ? null : tableDiffs,
    listDiffs: conflicts ? null : listDiffs,
  });
}
