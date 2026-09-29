import { describe, expect, it } from "vitest";
import DOMPurify from "dompurify";
import { createChatMarkdownStream, refreshChatAnchors, renderChatAnchor, UnsupportedAnchorContext } from "../src/chatStreamMarkdown.js";

const suggestion = '<suggestion start="0" end="4"><original>text</original><prefix></prefix><suffix></suffix><replacement>**clear**</replacement></suggestion>';
const mention = '<mention start="0" end="4"><original>text</original><prefix></prefix><suffix></suffix></mention>';

function anchorStream(container) {
  return createChatMarkdownStream(container, {
    parseAnchor(token, kind) {
      const xml = new DOMParser().parseFromString(token, "application/xml");
      if (xml.querySelector("parsererror")) return null;
      return { kind, replacement: xml.querySelector("replacement")?.textContent };
    },
    renderAnchor({ anchor }) {
      const button = document.createElement("button");
      button.textContent = anchor.replacement || "mention";
      return button;
    },
  });
}

describe("streaming chat Markdown", () => {
  it("shows a short reply and flushes the pending character at the end", () => {
    const container = document.createElement("div");
    const stream = createChatMarkdownStream(container);
    stream.write("hello");

    expect(container.textContent).toBe("hell");
    stream.end();
    expect(container.textContent).toBe("hello");
  });

  it("appends text without replacing earlier DOM nodes", () => {
    const container = document.createElement("div");
    const stream = createChatMarkdownStream(container);
    stream.write("First paragraph.\n\nSecond **bo");
    const firstParagraph = container.querySelector("p");
    stream.write("ld** paragraph.");
    stream.end();

    expect(container.querySelector("p")).toBe(firstParagraph);
    expect(container.textContent).toContain("First paragraph.");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("does not attach unsafe link or image URLs from model output", () => {
    const container = document.createElement("div");
    const stream = createChatMarkdownStream(container);
    stream.write("[unsafe](javascript:alert%281%29) ![image](javascript:alert%281%29) [safe](https://example.com)");
    stream.end();

    expect(container.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(container.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(container.querySelectorAll('a[href="https://example.com"]')).toHaveLength(1);
  });

  it("turns a split XML suggestion into an atomic button in the surrounding paragraph", () => {
    for (let split = 1; split < suggestion.length; split++) {
      const container = document.createElement("div");
      const stream = anchorStream(container);
      stream.write(`Change ${suggestion.slice(0, split)}`);
      stream.write(`${suggestion.slice(split)} today.`);
      stream.end();

      expect(container.querySelector("button")?.textContent).toBe("**clear**");
      expect(container.querySelector("p")?.textContent).toBe("Change **clear** today.");
      expect(container.querySelector("strong")).toBeNull();
    }
  });

  it("keeps incomplete XML inert and flushes it when the stream ends", () => {
    const container = document.createElement("div");
    const stream = anchorStream(container);
    stream.write("Before <suggestion start=\"0\"><original>text");
    expect(container.textContent).toBe("Before");
    stream.end();
    expect(container.textContent).toContain("<suggestion");
    expect(container.querySelector("button")).toBeNull();
  });

  it("does not mistake a partial tag or a similarly named element for an anchor", () => {
    const container = document.createElement("div");
    const stream = anchorStream(container);
    stream.write("Before <sug");
    stream.write("gestionary>ordinary</suggestionary> after ");
    stream.end();

    expect(container.textContent).toContain("<suggestionary>ordinary</suggestionary>");
    expect(container.querySelector("button")).toBeNull();
  });

  it("rejects buttons inside Markdown code or links", () => {
    for (const text of [`\`${suggestion}\``, `[label ${suggestion}](https://example.com)`]) {
      const container = document.createElement("div");
      const stream = anchorStream(container);
      expect(() => {
        stream.write(text);
        stream.end();
      }).toThrow(UnsupportedAnchorContext);
    }
  });

  it("creates the existing delegated actions for resolved XML anchors", () => {
    const container = document.createElement("div");
    const stream = createChatMarkdownStream(container, {
      parseAnchor(token, kind) {
        const xml = new DOMParser().parseFromString(token, "application/xml");
        return {
          original: xml.querySelector("original")?.textContent,
          replacement: xml.querySelector("replacement")?.textContent,
        };
      },
      renderAnchor(info) {
        return renderChatAnchor(info, 3, () => ({ start: 0, end: 4, original: "text" }));
      },
    });
    stream.write(`${mention} and ${suggestion} today.`);
    stream.end();

    const mentionButton = container.querySelector('[data-chat-action="mention"]');
    const suggestionButton = container.querySelector('[data-chat-action="suggest"]');
    expect(mentionButton?.dataset.start).toBe("0");
    expect(suggestionButton?.dataset.end).toBe("4");
    expect(suggestionButton?.dataset.msgIndex).toBe("3");
    expect(suggestionButton?.dataset.replacement).toBe("**clear**");
    expect(decodeURIComponent(suggestionButton?.dataset.suggestionToken)).toBe(suggestion);
  });

  it("renders unmatched XML anchors as inert text rather than actionable buttons", () => {
    const node = renderChatAnchor({
      anchor: { original: "text", replacement: "clearer" },
      kind: "suggestion",
      token: suggestion,
    }, 0, () => null);

    expect(node.querySelector("button")).toBeNull();
    expect(node.textContent).toBe("textclearer");
  });

  it("refreshes saved-message anchors without reparsing Markdown or replacing the paragraph", () => {
    const info = {
      anchor: { original: "text", prefix: "", suffix: "", replacement: "clearer" },
      kind: "suggestion",
      token: suggestion,
    };
    const container = document.createElement("div");
    container.innerHTML = DOMPurify.sanitize(
      `<p>Try ${renderChatAnchor(info, 3, () => null).outerHTML} now.</p>`,
    );
    const paragraph = container.querySelector("p");

    expect(container.querySelectorAll("[data-chat-anchor-info]")).toHaveLength(1);
    expect(refreshChatAnchors(container, () => ({ start: 7, end: 11, original: "text" })))
      .toEqual({ scanned: 1, changed: 1 });
    expect(container.querySelector('[data-chat-action="suggest"]')?.dataset.start).toBe("7");
    expect(container.querySelector('[data-chat-action="suggest"]')?.dataset.msgIndex).toBe("3");
    const unchanged = container.querySelector(".chat-suggestion");
    expect(refreshChatAnchors(container, () => ({ start: 7, end: 11, original: "text" })))
      .toEqual({ scanned: 1, changed: 0 });
    expect(container.querySelector(".chat-suggestion")).toBe(unchanged);
    expect(refreshChatAnchors(container, () => ({ start: 9, end: 13, original: "text" })))
      .toEqual({ scanned: 1, changed: 1 });
    expect(container.querySelector('[data-chat-action="suggest"]')?.dataset.start).toBe("9");
    expect(refreshChatAnchors(container, () => null)).toEqual({ scanned: 1, changed: 1 });
    expect(container.querySelector('[data-chat-action="suggest"]')).toBeNull();
    expect(container.querySelector(".chat-suggestion-replaced")?.textContent).toBe("textclearer");
    const unmatched = container.querySelector(".chat-suggestion");
    expect(refreshChatAnchors(container, () => null)).toEqual({ scanned: 1, changed: 0 });
    expect(container.querySelector(".chat-suggestion")).toBe(unmatched);
    expect(container.querySelector("p")).toBe(paragraph);
  });

  it("streams many mixed Markdown and XML anchors without replacing earlier nodes", () => {
    const container = document.createElement("div");
    const stream = createChatMarkdownStream(container, {
      parseAnchor(token, kind) {
        const xml = new DOMParser().parseFromString(token, "application/xml");
        return { original: xml.querySelector("original")?.textContent, replacement: xml.querySelector("replacement")?.textContent };
      },
      renderAnchor(info) {
        return renderChatAnchor(info, 0, () => ({ start: 0, end: 4, original: "text" }));
      },
    });
    stream.write("First **bold** sentence. ");
    const firstParagraph = container.querySelector("p");
    for (let index = 0; index < 300; index++) {
      stream.write(` ${mention.slice(0, 25)}`);
      stream.write(`${mention.slice(25)} and ${suggestion} text. `);
    }
    stream.end();

    expect(container.querySelector("p")).toBe(firstParagraph);
    expect(container.querySelectorAll('[data-chat-action="mention"]')).toHaveLength(300);
    expect(container.querySelectorAll('[data-chat-action="suggest"]')).toHaveLength(300);
  });
});
