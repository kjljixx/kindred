import * as markdown from "streaming-markdown";

const SAFE_URL = /^(https?:|mailto:|\/(?!\/)|#)/i;
const OPEN_TAGS = ["<mention", "<suggestion"];
const MAX_ANCHOR_LENGTH = 65536;
const MARKER_END = "\uE001";

export class UnsupportedAnchorContext extends Error {}

export function renderChatAnchor({ anchor, kind, token }, msgIndex, resolveAnchor) {
  const location = resolveAnchor(anchor);
  const suggestion = kind === "suggestion";
  const wrapper = document.createElement("span");
  wrapper.className = suggestion ? "chat-suggestion" : "chat-mention";
  if (!location) {
    wrapper.classList.add("suggestion-static");
    if (suggestion) wrapper.classList.add("chat-suggestion-replaced");
    const original = document.createElement("span");
    original.className = suggestion ? "suggestion-static suggestion-current" : "";
    original.textContent = anchor.original || "";
    wrapper.append(original);
    if (suggestion) {
      const replacement = document.createElement("span");
      replacement.className = "suggestion-static suggestion-replacement";
      replacement.textContent = anchor.replacement || "";
      wrapper.append(replacement);
    }
    return wrapper;
  }
  const button = (action, label, extraClass = "") => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `btn btn-tertiary ${extraClass}`.trim();
    element.dataset.chatAction = action;
    element.dataset.preview = action === "suggest" ? "replacement" : "current";
    element.dataset.start = String(location.start);
    element.dataset.end = String(location.end);
    element.dataset.anchor = encodeURIComponent(JSON.stringify(anchor));
    element.dataset.suggestionToken = encodeURIComponent(token);
    element.textContent = label;
    return element;
  };
  if (!suggestion) {
    wrapper.append(button("mention", location.original));
  } else {
    wrapper.append(button("current", location.original, "suggestion-current"));
    const replacement = button("suggest", anchor.replacement);
    replacement.dataset.msgIndex = String(msgIndex);
    replacement.dataset.replacement = anchor.replacement;
    wrapper.append(replacement);
  }
  return wrapper;
}

export function createChatMarkdownStream(container, { parseAnchor, renderAnchor } = {}) {
  const renderer = markdown.default_renderer(container);
  const setAttribute = renderer.set_attr;
  const addToken = renderer.add_token;
  const endToken = renderer.end_token;
  const anchors = [];
  const markerStart = `\uE000kindred${crypto.randomUUID().replaceAll("-", "")}`;
  const marker = new RegExp(`${markerStart}(\\d+)${MARKER_END}`, "g");
  let pending = "";
  let pendingMarker = "";

  const emitText = (text) => {
    if (text) markdown.parser_write(parser, text);
  };
  const flushMarkerBoundary = () => {
    if (pendingMarker) throw new UnsupportedAnchorContext("Anchor marker crossed a Markdown boundary");
  };
  renderer.add_token = (data, type) => {
    flushMarkerBoundary();
    addToken(data, type);
  };
  renderer.end_token = (data) => {
    flushMarkerBoundary();
    endToken(data);
  };
  renderer.add_text = (data, text) => {
    const parent = data.nodes[data.index];
    const combined = pendingMarker + text;
    pendingMarker = "";
    let cursor = 0;
    for (const match of combined.matchAll(marker)) {
      parent.append(document.createTextNode(combined.slice(cursor, match.index)));
      if (parent.closest("a, code, pre")) {
        throw new UnsupportedAnchorContext("Anchor inside a link or code span");
      }
      const anchor = anchors[Number(match[1])];
      if (!anchor) throw new UnsupportedAnchorContext("Unknown anchor marker");
      parent.append(renderAnchor(anchor));
      cursor = match.index + match[0].length;
    }
    const remaining = combined.slice(cursor);
    const unfinishedMarker = remaining.lastIndexOf(markerStart);
    let keepFrom = unfinishedMarker;
    if (keepFrom === -1) {
      for (let length = Math.min(markerStart.length - 1, remaining.length); length > 0; length--) {
        if (remaining.endsWith(markerStart.slice(0, length))) {
          keepFrom = remaining.length - length;
          break;
        }
      }
    }
    parent.append(document.createTextNode(keepFrom === -1 ? remaining : remaining.slice(0, keepFrom)));
    if (keepFrom !== -1) pendingMarker = remaining.slice(keepFrom);
  };
  renderer.set_attr = (data, type, value) => {
    if ((type === markdown.HREF || type === markdown.SRC) && !SAFE_URL.test(value.trim())) {
      return;
    }
    setAttribute(data, type, value);
  };
  const parser = markdown.parser(renderer);

  const scan = () => {
    while (pending) {
      const start = pending.indexOf("<");
      if (start < 0) {
        emitText(pending);
        pending = "";
        return;
      }
      if (start > 0) {
        emitText(pending.slice(0, start));
        pending = pending.slice(start);
      }
      const lower = pending.toLowerCase();
      const tag = OPEN_TAGS.find((name) => lower.startsWith(name));
      if (!tag) {
        if (OPEN_TAGS.some((name) => name.startsWith(lower))) return;
        emitText("<");
        pending = pending.slice(1);
        continue;
      }
      const next = lower[tag.length];
      if (next === undefined) return;
      if (!/[\s>]/.test(next)) {
        emitText("<");
        pending = pending.slice(1);
        continue;
      }
      const openEnd = lower.indexOf(">");
      const close = `</${tag.slice(1)}>`;
      const closeStart = lower.indexOf(close, openEnd + 1);
      if (openEnd < 0 || closeStart < 0) {
        if (pending.length <= MAX_ANCHOR_LENGTH) return;
        emitText(pending);
        pending = "";
        return;
      }
      const tokenEnd = closeStart + close.length;
      const token = pending.slice(0, tokenEnd);
      if (token.length > MAX_ANCHOR_LENGTH) {
        emitText(token);
        pending = pending.slice(tokenEnd);
        continue;
      }
      const kind = tag.slice(1);
      const anchor = parseAnchor?.(token, kind);
      if (anchor) {
        const id = anchors.push({ anchor, kind, token }) - 1;
        emitText(`${markerStart}${id}${MARKER_END}`);
      } else {
        emitText(token);
      }
      pending = pending.slice(tokenEnd);
    }
  };
  return {
    write(text) {
      pending += text;
      scan();
    },
    end() {
      emitText(pending);
      pending = "";
      markdown.parser_end(parser);
      flushMarkerBoundary();
    },
  };
}
