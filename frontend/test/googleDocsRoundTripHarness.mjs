import { Window } from "happy-dom";
import { Editor } from "@tiptap/core";

const browser = new Window();
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  DOMParser: browser.DOMParser,
  Node: browser.Node,
  HTMLElement: browser.HTMLElement,
  KeyboardEvent: browser.KeyboardEvent,
  getComputedStyle: browser.getComputedStyle.bind(browser),
});
console.debug = (...values) => console.error(...values);

const { default: DOMPurify } = await import("dompurify");
// DOMPurify does not support Happy DOM and unwraps ordered lists there.
DOMPurify.sanitize = (html) => String(html);
const { kindredContentExtensions, blockToHtml, htmlToDoc } = await import("../src/kindredSchema.js");
const {
  analyzeTableStructureChanges,
  buildProseMirrorToGoogleDocsPositionMap,
  mapProseMirrorPositionToGoogleDocsPosition,
  googleDocumentToKindredHtml,
  transactionsToGoogleDocsBatchUpdateRequests,
  transactionToGoogleDocsBatchUpdateRequests,
} = await import("../src/gdocsSync.js");

function normalizeDocument(document) {
  const json = document.toJSON ? document.toJSON() : document;
  const html = (json.content || []).map((block) => blockToHtml(block)).join("") || "<p></p>";
  return htmlToDoc(html);
}

function appendTextTransaction(editor, needle, text) {
  let position = null;
  editor.state.doc.descendants((node, offset) => {
    if (!node.isText || position != null) return;
    const index = node.text.indexOf(needle);
    if (index >= 0) position = offset + index + needle.length;
  });
  if (position == null) throw new Error(`Text not found: ${needle}`);
  return editor.state.tr.insertText(text, position);
}

function textRange(editor, needle, occurrence = 0) {
  let matches = 0;
  let range = null;
  editor.state.doc.descendants((node, paragraphPosition) => {
    if (range || node.type.name !== "paragraph") return;
    let textOffset = node.textContent.indexOf(needle);
    while (textOffset >= 0) {
      if (matches === occurrence) {
        const positionAtOffset = (offset) => {
          let position = null;
          let consumed = 0;
          node.descendants((child, childPosition) => {
            if (position != null || !child.isText) return;
            const end = consumed + child.text.length;
            if (offset <= end) position = paragraphPosition + 1 + childPosition + offset - consumed;
            consumed = end;
          });
          if (position == null && offset === node.content.size) return paragraphPosition + 1 + node.content.size;
          if (position == null) throw new Error(`Cannot resolve text offset ${offset} in ${JSON.stringify(node.textContent)}`);
          return position;
        };
        range = {
          from: positionAtOffset(textOffset),
          to: positionAtOffset(textOffset + needle.length),
        };
        return false;
      }
      matches += 1;
      textOffset = node.textContent.indexOf(needle, textOffset + needle.length);
    }
  });
  if (!range) throw new Error(`Text not found: ${needle}`);
  if (editor.state.doc.textBetween(range.from, range.to, "", "") !== needle) {
    throw new Error(`Resolved range does not contain ${JSON.stringify(needle)}`);
  }
  return range;
}

function paragraphRange(editor, needle, occurrence = 0) {
  let matches = 0;
  let range = null;
  editor.state.doc.descendants((node, position) => {
    if (range || node.type.name !== "paragraph" || node.textContent !== needle) return;
    if (matches === occurrence) range = { from: position + 1, to: position + node.content.size + 1 };
    matches += 1;
  });
  if (!range) throw new Error(`Paragraph not found: ${needle}`);
  return range;
}

function listItemRange(editor, needle, occurrence = 0) {
  let matches = 0;
  let range = null;
  editor.state.doc.descendants((node, position) => {
    if (range || node.type.name !== "listItem" || !node.textContent.includes(needle)) return;
    if (matches === occurrence) range = { from: position, to: position + node.nodeSize };
    matches += 1;
  });
  if (!range) throw new Error(`List item not found: ${needle}`);
  return range;
}

function paragraphStates(document) {
  const paragraphs = [];
  const visit = (node, lists = []) => {
    if (node.type.name === "paragraph") {
      const list = lists.at(-1);
      paragraphs.push({
        text: node.textContent,
        listType: list?.type.name === "orderedList" ? "ordered"
          : list?.type.name === "bulletList" ? "bullet" : null,
        nestingLevel: list ? lists.length - 1 : null,
      });
    }
    node.forEach((child) => {
      const nextLists = ["bulletList", "orderedList"].includes(child.type.name) ? [...lists, child] : lists;
      visit(child, nextLists);
    });
  };
  visit(document);
  return paragraphs;
}

function summarizeTransaction(transaction) {
  return transaction.steps.map((step) => {
    const json = step.toJSON();
    const summary = { stepType: json.stepType };
    if (typeof json.from === "number") summary.from = json.from;
    if (typeof json.to === "number") summary.to = json.to;
    if (typeof json.gapFrom === "number") summary.gapFrom = json.gapFrom;
    if (typeof json.gapTo === "number") summary.gapTo = json.gapTo;
    if (typeof json.insert === "number") summary.insert = json.insert;
    if (json.structure) summary.structure = true;
    if (json.slice) {
      summary.slice = {
        types: (json.slice.content || []).map((node) => node.type),
        openStart: json.slice.openStart || 0,
        openEnd: json.slice.openEnd || 0,
      };
    }
    const insertedText = step.slice?.content?.textBetween(0, step.slice.content.size, "\\n");
    if (insertedText) summary.insertedText = insertedText;
    return summary;
  });
}

function summarizeGoogleDocsRequest(request) {
  const [operation, body] = Object.entries(request)[0];
  if (operation === "insertText") return { operation, index: body.location.index, text: body.text };
  if (operation === "deleteContentRange") {
    return { operation, startIndex: body.range.startIndex, endIndex: body.range.endIndex };
  }
  const range = body.range;
  return {
    operation,
    ...(range ? { startIndex: range.startIndex, endIndex: range.endIndex } : {}),
    ...(body.bulletPreset ? { bulletPreset: body.bulletPreset } : {}),
  };
}

function runListOperations(googleDocument, operations) {
  const transactions = [];
  const editor = new Editor({
    extensions: kindredContentExtensions(),
    content: googleDocumentToKindredHtml(googleDocument),
    onTransaction: ({ transaction }) => {
      if (transaction.docChanged) transactions.push(transaction);
    },
  });
  const before = normalizeDocument(editor.state.doc);
  for (const operation of operations) {
    let operationRange = null;
    if (!operation.useCurrentSelection) {
      const start = operation.listItem
        ? listItemRange(editor, operation.needle, operation.occurrence || 0)
        : operation.paragraph
          ? paragraphRange(editor, operation.needle, operation.occurrence || 0)
          : textRange(editor, operation.needle, operation.occurrence || 0);
      const end = operation.lastParagraph
        ? paragraphRange(editor, operation.lastParagraph, operation.lastOccurrence || 0).to
        : start.to;
      operationRange = { from: start.from, to: end };
      const selection = operation.cursor === "start" ? { from: start.from, to: start.from }
        : operation.cursor === "end" ? { from: end, to: end }
          : { from: start.from, to: end };
      editor.commands.setTextSelection(selection);
    }
    if (operation.type === "insert-text") editor.commands.insertContent(operation.text);
    if (operation.type === "delete-selection") editor.commands.deleteSelection();
    if (operation.type === "delete-list-item") editor.commands.deleteRange(operationRange);
    if (operation.type === "bullet") editor.commands.toggleBulletList();
    if (operation.type === "ordered") editor.commands.toggleOrderedList();
    if (operation.type === "split") editor.commands.splitListItem("listItem");
    if (operation.type === "enter") editor.commands.keyboardShortcut("Enter");
    if (operation.type === "backspace") editor.commands.keyboardShortcut("Backspace");
    if (operation.type === "sink") editor.commands.sinkListItem("listItem");
    if (operation.type === "lift") editor.commands.liftListItem("listItem");
    if (operation.type === "paste-paragraphs") editor.commands.insertContent(
      operation.paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    );
  }
  const requests = transactionsToGoogleDocsBatchUpdateRequests(transactions.map((transaction) => ({
    transaction,
    before: transaction.before,
  })));
  const result = {
    before,
    after: normalizeDocument(editor.state.doc),
    afterParagraphs: paragraphStates(editor.state.doc),
    transactions: transactions.map(summarizeTransaction),
    requestSummary: requests.map(summarizeGoogleDocsRequest),
    requests,
  };
  editor.destroy();
  return result;
}

function tableTransaction(command) {
  let transaction;
  const editor = new Editor({
    extensions: kindredContentExtensions(),
    content: "<table><tr><td><p>A</p></td><td><p>B</p></td></tr><tr><td><p>C</p></td><td><p>D</p></td></tr></table>",
    onTransaction: ({ transaction: nextTransaction }) => {
      if (nextTransaction.docChanged) transaction = nextTransaction;
    },
  });
  editor.commands.setTextSelection(4);
  editor.commands[command]();
  editor.destroy();
  return transaction;
}

function alignmentTransaction(content, selection, alignment) {
  let transaction;
  const editor = new Editor({
    extensions: kindredContentExtensions(),
    content,
    onTransaction: ({ transaction: nextTransaction }) => {
      if (nextTransaction.docChanged) transaction = nextTransaction;
    },
  });
  editor.commands.setTextSelection(selection);
  editor.commands.setTextAlign(alignment);
  editor.destroy();
  return transaction;
}

function unitScenario(name) {
  if (name.startsWith("table:")) {
    const transaction = tableTransaction(name.slice("table:".length));
    const analysis = analyzeTableStructureChanges(transaction);
    return {
      stepCount: transaction.steps.length,
      operationTypes: analysis.operations.map((operation) => operation.type),
      suppressedStepCount: analysis.suppressedStepIndexes.size,
      requests: transactionToGoogleDocsBatchUpdateRequests(transaction, transaction.docs[0]),
    };
  }
  if (name === "alignment:center" || name === "alignment:right") {
    const right = name.endsWith("right");
    const transaction = alignmentTransaction(
      right ? "<p>First</p><p>Second</p>" : "<p>Center me</p>",
      right ? { from: 1, to: 14 } : { from: 1, to: 10 },
      right ? "right" : "center",
    );
    return { requests: transactionToGoogleDocsBatchUpdateRequests(transaction, transaction.before) };
  }
  if (name === "queued-transactions") {
    const editor = new Editor({ extensions: kindredContentExtensions(), content: "<p>One</p>" });
    const first = editor.state.tr.insertText("A", 1, 1);
    editor.view.dispatch(first);
    const second = editor.state.tr.insertText("B", 2, 2);
    editor.view.dispatch(second);
    const requests = transactionsToGoogleDocsBatchUpdateRequests([
      { transaction: first, before: first.before },
      { transaction: second, before: second.before },
    ]);
    editor.destroy();
    return { requests };
  }
  throw new Error(`Unsupported unit scenario: ${name}`);
}

const payload = JSON.parse(await new Response(process.stdin).text());

if (payload.action === "unit") {
  process.stdout.write(JSON.stringify(unitScenario(payload.scenario)));
} else if (payload.action === "position-map") {
  const mapping = buildProseMirrorToGoogleDocsPositionMap(payload.document);
  process.stdout.write(JSON.stringify({
    pointCount: mapping.points.size,
    pointValues: [...mapping.points.values()],
    positions: payload.positions.map((position) => mapping.mapPosition(position)),
    nearestPositions: (payload.nearestPositions || []).map((position) =>
      mapProseMirrorPositionToGoogleDocsPosition(payload.document, position)),
  }));
} else if (payload.action === "pull") {
  const html = googleDocumentToKindredHtml(payload.googleDocument);
  const editor = new Editor({
    extensions: kindredContentExtensions(),
    content: html,
  });
  process.stdout.write(JSON.stringify({
    html,
    document: normalizeDocument(editor.state.doc),
    paragraphs: paragraphStates(editor.state.doc),
  }));
  editor.destroy();
} else if (payload.action === "append-text") {
  const editor = new Editor({
    extensions: kindredContentExtensions(),
    content: googleDocumentToKindredHtml(payload.googleDocument),
  });
  const before = editor.state.doc;
  const transaction = appendTextTransaction(editor, payload.needle, payload.text);
  editor.view.dispatch(transaction);
  process.stdout.write(JSON.stringify({
    before: normalizeDocument(before),
    after: normalizeDocument(editor.state.doc),
    requests: transactionToGoogleDocsBatchUpdateRequests(transaction, before),
  }));
  editor.destroy();
} else if (payload.action === "list-operations") {
  process.stdout.write(JSON.stringify(runListOperations(payload.googleDocument, payload.operations)));
} else {
  throw new Error(`Unsupported round-trip action: ${payload.action}`);
}
