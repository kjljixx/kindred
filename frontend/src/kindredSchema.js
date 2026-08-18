/**
 * Shared TipTap content schema + HTML ↔ PM JSON bridge (DocIR).
 * Used by the live editor, headless merge/review, and Diff — one schema only.
 */
import { Extension, Mark, Node as TiptapNode, generateHTML, generateJSON } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";

function safeLinkHref(value) {
  const href = String(value || "").trim();
  return /^(https?:|mailto:|#|\/)/i.test(href) ? href : null;
}

function safeImageSrc(value) {
  const src = String(value || "").trim();
  return /^(https?:|data:image\/|kindred-image:assets\/)/i.test(src) ? src : null;
}

const Highlight = Mark.create({
  name: "highlight",
  parseHTML() {
    return [{ tag: "mark" }];
  },
  renderHTML() {
    return ["mark", 0];
  },
  addCommands() {
    return {
      toggleHighlight: () => ({ commands }) => commands.toggleMark(this.name),
    };
  },
});

const Image = TiptapNode.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      title: { default: null },
    };
  },
  parseHTML() {
    return [{
      tag: "img[src]",
      getAttrs: (element) => {
        const src = safeImageSrc(element.getAttribute("src"));
        return src
          ? {
              src,
              alt: element.getAttribute("alt") || "",
              title: element.getAttribute("title"),
            }
          : false;
      },
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", HTMLAttributes];
  },
  addCommands() {
    return {
      setImage: (attrs) => ({ commands }) => commands.insertContent({ type: this.name, attrs }),
    };
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

function attrOrNull(el, name) {
  const v = el.getAttribute(name);
  return v == null || v === "" ? null : v;
}

/** Paragraph with optional Review align-conflict attrs. */
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
          attrs.alignTheirs
            ? { "data-kindred-align-theirs": attrs.alignTheirs }
            : {},
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

/** Table node with optional 3-way/review conflict attrs. */
const KindredTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tableOurs: {
        default: null,
        parseHTML: (el) => attrOrNull(el, "data-kindred-table-ours"),
        renderHTML: (attrs) =>
          attrs.tableOurs ? { "data-kindred-table-ours": attrs.tableOurs } : {},
      },
      tableTheirs: {
        default: null,
        parseHTML: (el) => attrOrNull(el, "data-kindred-table-theirs"),
        renderHTML: (attrs) =>
          attrs.tableTheirs
            ? { "data-kindred-table-theirs": attrs.tableTheirs }
            : {},
      },
      tableLabelOurs: {
        default: null,
        parseHTML: (el) => attrOrNull(el, "data-kindred-table-label-ours"),
        renderHTML: (attrs) =>
          attrs.tableLabelOurs
            ? { "data-kindred-table-label-ours": attrs.tableLabelOurs }
            : {},
      },
      tableLabelTheirs: {
        default: null,
        parseHTML: (el) => attrOrNull(el, "data-kindred-table-label-theirs"),
        renderHTML: (attrs) =>
          attrs.tableLabelTheirs
            ? { "data-kindred-table-label-theirs": attrs.tableLabelTheirs }
            : {},
      },
    };
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const View = this.options.View;
      const safeGetPos = typeof getPos === "function" ? getPos : () => 0;
      return new View(node, this.options.cellMinWidth, editor.view, safeGetPos);
    };
  },
});

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
      /><(p|h[1-6]|ul|ol|li|blockquote|pre|hr|div|table|tr|td|th|img)(\s[^>]*)?>/gi,
      ">\n<$1$2>"
    )
    .trim();
}

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

/** Mark-preserving HTML normalize for save + dirty compare. */
export function canonicalizeTextHtml(html) {
  const raw = String(html || "").trim();
  if (!raw) return "";
  const doc = new DOMParser().parseFromString(raw, "text/html");
  const root = doc.body;
  for (const el of root.querySelectorAll(
    "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, div, td, th"
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

/** Content extensions shared by editor and headless HTML↔JSON (no UI plugins). */
export function kindredContentExtensions() {
  return [
    StarterKit.configure({
      heading: false,
      blockquote: false,
      codeBlock: false,
      code: false,
      horizontalRule: false,
      paragraph: false,
    
      link: {
        autolink: true,
        linkOnPaste: true,
        openOnClick: false,
        defaultProtocol: "https",
        HTMLAttributes: {
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
        validate: (href) => Boolean(safeLinkHref(href)),
      },
    
      underline: {},
    }),
    KindredParagraph,
    Highlight,
    Image,
    KindredTable.configure({
      resizable: true,
      lastColumnResizable: false
    }),
    TableRow,
    TableCell,
    TableHeader,
    TextStyle,
    Color,
    FontSize,
    FontFamily,
    TextAlign.configure({ types: ["paragraph"] }),
  ];
}

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Plain text of a PM JSON node (for signatures / empty checks). */
export function nodePlainText(node) {
  if (!node) return "";
  if (node.type === "text") return String(node.text || "").replace(/\u00a0/g, " ");
  const kids = node.content || [];
  if (node.type === "paragraph") {
    return kids.map(nodePlainText).join("");
  }
  return kids.map(nodePlainText).filter(Boolean).join("\n\n");
}

function isEmptyParagraphNode(node) {
  return node?.type === "paragraph" && !nodePlainText(node).trim();
}

/** Family key for block LCS (lists/tables plug in here later). */
export function blockFamily(node) {
  if (!node) return "";
  if (node.type === "paragraph") return "p";
  if (node.type === "bulletList") return "ul";
  if (node.type === "orderedList") return "ol";
  if (node.type === "table") return "table";
  return `other:${node.type}`;
}

/**
 * Content signature for LCS. Paragraphs use plain text; lists/tables will use
 * item/row signatures when those nodes are in the schema again.
 */
export function blockSignature(node) {
  if (!node) return "";
  const fam = blockFamily(node);
  if (fam === "p") return `p:${nodePlainText(node).trim()}`;
  return `${fam}:${JSON.stringify(node)}`;
}

export function significantBlocks(doc) {
  const blocks = doc?.content || [];
  return blocks;
}

export function normalizeDoc(doc) {
  const raw = doc && doc.type === "doc" ? cloneJson(doc) : cloneJson(EMPTY_DOC);
  const content = Array.isArray(raw.content) ? raw.content : [];
  raw.content = content.length ? content : [{ type: "paragraph" }];
  return raw;
}

export function htmlToDoc(html) {
  const raw = String(html || "").trim() || "<p></p>";
  try {
    const json = generateJSON(raw, kindredContentExtensions());
    return normalizeDoc(json);
  } catch {
    return normalizeDoc(EMPTY_DOC);
  }
}

function docToHtml(doc) {
  const normalized = normalizeDoc(doc);
  try {
    return canonicalizeTextHtml(generateHTML(normalized, kindredContentExtensions()));
  } catch {
    return "<p></p>";
  }
}

/** Serialize one top-level block node to HTML. */
export function blockToHtml(node) {
  if (!node) return "<p></p>";
  return docToHtml({ type: "doc", content: [cloneJson(node)] });
}
