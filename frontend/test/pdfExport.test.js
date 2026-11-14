import { describe, it, expect, vi, beforeEach } from "vitest";

const html2pdfCalls = vi.hoisted(() => ({ container: null }));

vi.mock("html2pdf.js", () => ({
  default: () => ({
    set: () => ({
      from: (container) => {
        html2pdfCalls.container = container;
        return { outputPdf: async () => new Blob(["pdf"]) };
      },
    }),
  }),
}));

import { htmlToPdfBlob } from "../src/pandocConvert.js";

describe("htmlToPdfBlob image sizing", () => {
  beforeEach(() => {
    html2pdfCalls.container = null;
  });

  it("caps images at the page content width so wide images are not clipped", async () => {
    await htmlToPdfBlob('<p><img src="data:image/png;base64,AAAA" width="1600" height="900"></p>');
    const css = html2pdfCalls.container.querySelector("style").textContent;
    expect(css).toMatch(/img\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/img\s*\{[^}]*height:\s*auto/);
  });
});
