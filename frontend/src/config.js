export const CONFIG = {
  chat: {
    model: "openrouter/google/gemini-3.7-flash",
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
