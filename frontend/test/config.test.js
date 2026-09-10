import { describe, expect, it } from "vitest";
import { assertGoogleDocsCompatibilityConfig } from "../src/config.js";

const enabledConfig = {
  googleDocs: {
    compatibility: {
      mergeAdjacentLists: true,
      requireTableSeparatorParagraphs: true,
      disableTrailingNode: true,
      preserveInitialTableParagraph: true,
    },
  },
};

describe("Google Docs compatibility config", () => {
  it("does not require compatibility features without an active sync", () => {
    expect(() => assertGoogleDocsCompatibilityConfig(null, {})).not.toThrow();
  });

  it("accepts an active sync when all required features are enabled", () => {
    expect(() => assertGoogleDocsCompatibilityConfig(
      { documentId: "document-1" },
      enabledConfig,
    )).not.toThrow();
  });

  it("reports every disabled required feature when sync is active", () => {
    expect(() => assertGoogleDocsCompatibilityConfig(
      { documentId: "document-1" },
      { googleDocs: { compatibility: {} } },
    )).toThrow(
      "Google Docs sync requires these compatibility features: "
      + "merge adjacent lists, require table-separator paragraphs, "
      + "disable automatic trailing paragraphs, preserve the initial paragraph before tables.",
    );
  });
});
