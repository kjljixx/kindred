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
import { BulletList, OrderedList } from "@tiptap/extension-list";

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
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => element.style.backgroundColor || null,
        renderHTML: (attributes) => {
          if (!attributes.color) return {};
          return { style: `background-color: ${attributes.color}` };
        },
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "mark",
      },
      {
        tag: "span",
        getAttrs: (element) => {
          const bg = element.style?.backgroundColor;
          return bg ? {} : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mark", HTMLAttributes, 0];
  },
  addCommands() {
    return {
      setHighlight:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, attributes),
      toggleHighlight:
        (attributes) =>
        ({ commands }) =>
          commands.toggleMark(this.name, attributes),
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
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

function listConflictAttributes() {
  return {
    listOurs: {
      default: null,
      parseHTML: (el) => attrOrNull(el, "data-kindred-list-ours"),
      renderHTML: (attrs) =>
        attrs.listOurs ? { "data-kindred-list-ours": attrs.listOurs } : {},
    },
    listTheirs: {
      default: null,
      parseHTML: (el) => attrOrNull(el, "data-kindred-list-theirs"),
      renderHTML: (attrs) =>
        attrs.listTheirs ? { "data-kindred-list-theirs": attrs.listTheirs } : {},
    },
    listLabelOurs: {
      default: null,
      parseHTML: (el) => attrOrNull(el, "data-kindred-list-label-ours"),
      renderHTML: (attrs) =>
        attrs.listLabelOurs
          ? { "data-kindred-list-label-ours": attrs.listLabelOurs }
          : {},
    },
    listLabelTheirs: {
      default: null,
      parseHTML: (el) => attrOrNull(el, "data-kindred-list-label-theirs"),
      renderHTML: (attrs) =>
        attrs.listLabelTheirs
          ? { "data-kindred-list-label-theirs": attrs.listLabelTheirs }
          : {},
    },
  };
}

/** Bullet list with optional 3-way/review conflict attrs. */
const KindredBulletList = BulletList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...listConflictAttributes(),
    };
  },
});

/** Ordered list with optional 3-way/review conflict attrs. */
const KindredOrderedList = OrderedList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...listConflictAttributes(),
    };
  },
});

/** Table node with optional 3-way/review conflict attrs. */
const KindredTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tableConflicts: {
        default: null,
        parseHTML: (el) => attrOrNull(el, "data-kindred-table-conflicts"),
        renderHTML: (attrs) =>
          attrs.tableConflicts
            ? { "data-kindred-table-conflicts": attrs.tableConflicts }
            : {},
      },
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
 * Never injects \n before closing tags (that would sit inside paragraph text).
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
    "p, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, pre, div, td, th"
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
      bulletList: false,
      orderedList: false,

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
    KindredBulletList,
    KindredOrderedList,
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

export function isTableBlock(node) {
  return node?.type === "table" || node?.type?.name === "table";
}

export function isListBlock(node) {
  const type = node?.type?.name || node?.type;
  return type === "bulletList" || type === "orderedList";
}

export function isStructuralBlock(node) {
  return isTableBlock(node) || isListBlock(node);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function pmNodeChildren(node) {
  if (node.content?.content) return node.content.content;
  if (Array.isArray(node.content)) return node.content;
  if (!node.forEach) return [];
  const kids = [];
  node.forEach((child) => kids.push(child));
  return kids;
}

/** Canonical plain text for PM JSON nodes and live ProseMirror docs. */
export function docToPlainText(node) {
  if (!node) return "";
  if (node.type === "text" || node.isText) {
    return String(node.text || "").replace(/\u00a0/g, " ");
  }

  const kids = pmNodeChildren(node);
  const type = node.type?.name || node.type;

  if (type === "paragraph") {
    return kids.map(docToPlainText).join("");
  }
  if (type === "listItem") {
    return kids.map(docToPlainText).join("");
  }
  if (type === "bulletList" || type === "orderedList") {
    return kids.map(docToPlainText).join("\n");
  }
  if (type === "table") {
    return kids.map(docToPlainText).join("\n");
  }
  if (type === "tableRow") {
    return kids.map(docToPlainText).join("\t");
  }
  if (type === "tableCell" || type === "tableHeader") {
    return kids.map(docToPlainText).join(" ");
  }

  return kids.map(docToPlainText).filter(Boolean).join("\n\n");
}

function stripConflictMarkersFromHtml(html) {
  const raw = String(html ?? "");
  if (!raw.includes("data-kindred-")) return raw;
  const doc = new DOMParser().parseFromString(raw, "text/html");
  const root = doc.body;
  root.querySelectorAll("[data-kindred-text-conflict]").forEach((el) => el.remove());
  root.querySelectorAll("[data-kindred-conflict]").forEach((el) => el.remove());
  return root.innerHTML;
}

export function htmlToPlainText(html) {
  const doc = htmlToDoc(stripConflictMarkersFromHtml(html));
  return docToPlainText(doc);
}

function isEmptyParagraphNode(node) {
  return node?.type === "paragraph" && !docToPlainText(node).trim();
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
  if (fam === "p") return `p:${docToPlainText(node).trim()}`;
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
