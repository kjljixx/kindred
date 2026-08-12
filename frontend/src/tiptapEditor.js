import { Editor, Extension, Node as TiptapNode } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import Placeholder from "@tiptap/extension-placeholder";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const keptSelectionKey = new PluginKey("keptSelection");

/** Fake selection highlight while toolbar controls hold focus. */
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
            const from = tr.mapping.map(prev.from);
            const to = tr.mapping.map(prev.to);
            if (from === to) return null;
            const max = tr.doc.content.size;
            return {
              from: Math.max(0, Math.min(from, max)),
              to: Math.max(0, Math.min(to, max)),
            };
          },
        },
        props: {
          decorations(state) {
            const range = keptSelectionKey.getState(state);
            if (!range || range.from >= range.to) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.inline(range.from, range.to, { class: "toolbar-kept-selection" }),
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

function formatConflictMarkers(labelOurs, oursStr, labelTheirs, theirsStr) {
  const a = oursStr.endsWith("\n") ? oursStr : `${oursStr}\n`;
  const b = theirsStr.endsWith("\n") ? theirsStr : `${theirsStr}\n`;
  return `<<<<<<< ${labelOurs}\n${a}=======\n${b}>>>>>>> ${labelTheirs}\n`;
}

export function parseConflictSegments(text) {
  const str = text || "";
  const re =
    /<<<<<<< ([^\n]*)\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> ([^\n]*)(?:\n|$)/g;
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

export function conflictMarkerCount(text) {
  const segs = parseConflictSegments(text);
  if (!segs) return 0;
  let n = 0;
  for (const s of segs) if (s.type === "conflict") n++;
  return n;
}

export function htmlHasAlignConflict(html) {
  return /\bdata-kindred-align-ours\s*=/i.test(String(html || ""));
}

export function alignConflictCount(html) {
  const s = String(html || "");
  const re = /\bdata-kindred-align-ours\s*=/gi;
  let n = 0;
  while (re.exec(s)) n++;
  return n;
}

export function unresolvedMergeConflictCount(html) {
  return conflictMarkerCount(html) + alignConflictCount(html);
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
  if (!diffsFn) {
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
      let cls = "diff-ins";
      if (hl && basePos >= hl.start && basePos < hl.end) {
        cls = "diff-ins sent-hl";
      }
      addInline(fromPlain, toPlain, cls);
      curPos += data.length;
    } else if (op === DIFF_DELETE) {
      const pm = pmPosForPlain(map, curPos);
      decorations.push(
        Decoration.widget(pm, createDeleteWidget(data), {
          side: -1,
          key: `del-${basePos}-${data.length}`,
        })
      );
      if (hl) {
        const absEnd = basePos + data.length;
        if (!(absEnd <= hl.start || basePos >= hl.end)) {
          // Ghost is a widget; sent-hl on deletes is visual via widget class if needed.
        }
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
  syncSelectValue(
    toolbarEl.querySelector("[data-font-family]"),
    attrs.fontFamily,
    normalizeToolbarFontFamily
  );
}

export function bindToolbar(editor, toolbarEl) {
  if (!toolbarEl) return () => { };
  let stashedFontSizeSelection = null;
  const stashFontSizeSelection = () => {
    const { from, to } = editor.state.selection;
    if (from === to) return;
    stashedFontSizeSelection = { from, to };
    editor.commands.setKeptSelection({ from, to });
  };
  const clearStashedFontSizeSelection = () => {
    stashedFontSizeSelection = null;
    if (keptSelectionKey.getState(editor.state)) {
      editor.commands.clearKeptSelection();
    }
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
  const colorInput = toolbarEl.querySelector("[data-color-input]");
  const onColor = (e) => {
    const value = e.target.value;
    if (!value) return;
    const pickerOpen = Boolean(document.querySelector(".clr-picker.clr-open"));
    const chain = editor.chain();
    if (!pickerOpen) chain.focus();
    chain.setColor(value).run();
  };
  const fontSizeInput = toolbarEl.querySelector("[data-font-size]");
  const fontFamilySelect = toolbarEl.querySelector("[data-font-family]");
  const applyFontSize = ({ returnFocus = false } = {}) => {
    if (!fontSizeInput) return;
    const n = Number(fontSizeInput.value);
    const chain = returnFocus ? editor.chain().focus() : editor.chain();
    if (stashedFontSizeSelection) {
      chain.setTextSelection(stashedFontSizeSelection);
    }
    if (!Number.isFinite(n) || n <= 0) {
      fontSizeInput.value = "14";
      chain.unsetFontSize().run();
      if (returnFocus) clearStashedFontSizeSelection();
      else if (stashedFontSizeSelection) {
        editor.commands.setKeptSelection(stashedFontSizeSelection);
      }
      return;
    }
    const clamped = Math.min(96, Math.max(8, Math.round(n)));
    if (String(clamped) !== fontSizeInput.value) fontSizeInput.value = String(clamped);
    if (clamped === 14) chain.unsetFontSize().run();
    else chain.setFontSize(`${clamped}px`).run();
    if (returnFocus) clearStashedFontSizeSelection();
    else if (stashedFontSizeSelection) {
      editor.commands.setKeptSelection(stashedFontSizeSelection);
    }
  };
  const onFontSizeKeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyFontSize({ returnFocus: true });
    }
  };
  const onFontSizeChange = () => applyFontSize({ returnFocus: false });
  const onFontSizeBlur = () => {
    requestAnimationFrame(() => {
      if (document.activeElement === fontSizeInput) return;
      clearStashedFontSizeSelection();
    });
  };
  const onFontFamily = () => {
    const value = fontFamilySelect?.value || "";
    const chain = editor.chain().focus();
    if (!value) chain.unsetFontFamily().run();
    else chain.setFontFamily(value).run();
  };
  const onEditorPointerDown = (e) => {
    if (toolbarEl.contains(e.target)) return;
    clearStashedFontSizeSelection();
  };
  toolbarEl.addEventListener("click", onClick);
  colorInput?.addEventListener("input", onColor);
  colorInput?.addEventListener("change", onColor);
  fontSizeInput?.addEventListener("mousedown", stashFontSizeSelection);
  fontSizeInput?.addEventListener("focus", stashFontSizeSelection);
  fontSizeInput?.addEventListener("change", onFontSizeChange);
  fontSizeInput?.addEventListener("keydown", onFontSizeKeydown);
  fontSizeInput?.addEventListener("blur", onFontSizeBlur);
  fontFamilySelect?.addEventListener("change", onFontFamily);
  editor.view.dom.addEventListener("pointerdown", onEditorPointerDown);
  const onSel = () => syncToolbar(editor, toolbarEl);
  editor.on("selectionUpdate", onSel);
  editor.on("transaction", onSel);
  syncToolbar(editor, toolbarEl);
  return () => {
    toolbarEl.removeEventListener("click", onClick);
    colorInput?.removeEventListener("input", onColor);
    colorInput?.removeEventListener("change", onColor);
    fontSizeInput?.removeEventListener("mousedown", stashFontSizeSelection);
    fontSizeInput?.removeEventListener("focus", stashFontSizeSelection);
    fontSizeInput?.removeEventListener("change", onFontSizeChange);
    fontSizeInput?.removeEventListener("keydown", onFontSizeKeydown);
    fontSizeInput?.removeEventListener("blur", onFontSizeBlur);
    fontFamilySelect?.removeEventListener("change", onFontFamily);
    editor.view.dom.removeEventListener("pointerdown", onEditorPointerDown);
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
  markedHtml = "",
  conflictMode = "merge",
} = {}) {
  if (!editor) return;
  const conflicts = parseConflictSegments(markedHtml);
  setOverlay(editor, {
    baseline: conflicts ? "" : baseline,
    currentPlain: conflicts ? "" : currentPlain,
    highlight: conflicts ? null : highlight,
    conflicts,
    markedHtml: conflicts ? markedHtml : "",
    conflictMode: conflictMode === "review" ? "review" : "merge",
  });
}

export { BLOCK_SEP, formatConflictMarkers };
