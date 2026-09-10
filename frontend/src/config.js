export const CONFIG = {
  chat: {
    model: "openrouter/free",
  },
  googleDocs: {
    compatibility: {
      mergeAdjacentLists: true,
      requireTableSeparatorParagraphs: true,
      disableTrailingNode: true,
      preserveInitialTableParagraph: true,
    },
  },
  debug: {
    enabled: false,
    verbose: false,
    scopes: {
      input: true,
      editor: true,
      app: true,
      diff: true,
      align: true,
      merge: true,
      review: true,
    },
  },
  export: {
    invertColorsForDarkMode: true, // whether or not to invert colors during import/export to account for the fact that Kindred is a dark mode editor
    diffModeExport: "styledDiff", // "text" | "styledDiff"
    defaultFormat: "docx", // "docx" | "md" | "html" | "txt" | "pdf"
  },
};

const REQUIRED_GOOGLE_DOCS_COMPATIBILITY_FEATURES = {
  mergeAdjacentLists: "merge adjacent lists",
  requireTableSeparatorParagraphs: "require table-separator paragraphs",
  disableTrailingNode: "disable automatic trailing paragraphs",
  preserveInitialTableParagraph: "preserve the initial paragraph before tables",
};

export function assertGoogleDocsCompatibilityConfig(googleDocsSync, config = CONFIG) {
  if (!googleDocsSync) return;
  const compatibility = config.googleDocs?.compatibility;
  const disabledFeatures = Object.entries(REQUIRED_GOOGLE_DOCS_COMPATIBILITY_FEATURES)
    .filter(([key]) => compatibility?.[key] !== true)
    .map(([, label]) => label);
  if (disabledFeatures.length) {
    throw new Error(
      `Google Docs sync requires these compatibility features: ${disabledFeatures.join(", ")}. `
      + "Enable them in CONFIG.googleDocs.compatibility.",
    );
  }
}
