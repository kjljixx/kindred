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
    invertColorsForDarkMode: true,
    diffModeExport: "styledDiff", // "text" | "styledDiff"
  },
};
