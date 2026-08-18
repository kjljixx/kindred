import { CONFIG } from "./config.js";

let sequence = 0;
let traceSequence = 0;
let activeTrace = null;

function debugConfig() {
  return CONFIG.debug || {};
}

function scopeEnabled(scope) {
  const config = debugConfig();
  if (!config.enabled) return false;
  const scopes = config.scopes;
  return !scopes || scopes[scope] !== false;
}

function previewText(value, limit = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function nodeText(node) {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (typeof node.textContent === "string") return node.textContent;
  return (node.content || []).map(nodeText).join(" ");
}

export function startTrace(scope, event, data = {}) {
  traceSequence += 1;
  activeTrace = traceSequence;
  debugEvent(scope, event, data);
  return activeTrace;
}

export function currentTrace() {
  return activeTrace;
}

export function debugEvent(scope, event, data = {}) {
  if (!scopeEnabled(scope)) return;
  sequence += 1;
  console.debug(`[kindred:${sequence}:trace=${activeTrace ?? "-"}:${scope}:${event}]`, data);
}

export function debugVerbose(scope, event, data = {}) {
  if (!debugConfig().verbose) return;
  debugEvent(scope, event, data);
}

export function summarizeEditor(editor) {
  if (!editor?.state) return null;
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;
  const summary = {
    html: previewText(editor.getHTML?.() || "", 400),
    selection: {
      from: selection.from,
      to: selection.to,
      empty: selection.empty,
    },
    cursor: {
      depth: $from.depth,
      parent: $from.parent.type.name,
      parentText: previewText($from.parent.textContent, 120),
      parentOffset: $from.parentOffset,
    },
  };
  if (debugConfig().verbose) summary.doc = state.doc.toJSON();
  return summary;
}

export function summarizeTransaction(transaction) {
  const summary = {
    docChanged: transaction.docChanged,
    selectionSet: transaction.selectionSet,
    appended: Boolean(transaction.getMeta("appendedTransaction")),
    uiEvent: transaction.getMeta("uiEvent"),
    addToHistory: transaction.getMeta("addToHistory"),
    steps: transaction.steps.map((step) => step.toJSON()),
  };
  return summary;
}

export function summarizeBlock(node, extras = {}) {
  if (!node) return null;
  return {
    type: node.type?.name || node.type || null,
    text: previewText(nodeText(node), 120),
    listType: node.listType || null,
    ...extras,
  };
}

export function summarizeAlignOp(op) {
  return {
    type: op.type,
    path: op.path,
    level: op.level,
    side: op.side,
    baseType: op.base?.type || null,
    oursType: op.ours?.type || null,
    theirsType: op.theirs?.type || null,
    nodeType: op.node?.type || null,
  };
}
