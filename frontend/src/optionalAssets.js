function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`link[href="${href}"]`);
    if (existing) {
      resolve();
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load ${href}`));
    document.head.appendChild(link);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

let colorisPromise = null;
let htmlDiffPromise = null;

export function loadColoris() {
  if (!colorisPromise) {
    colorisPromise = Promise.all([
      loadStylesheet("/static/coloris.min.css"),
      loadScript("/static/coloris.min.js"),
    ]).then(() => {
      // 1. Set global defaults once
      window.Coloris({
        el: "[data-highlight-input], [data-color-input], [data-coloris]",
        wrap: false,
        theme: "default",
        themeMode: "dark",
        focusInput: false,
        closeButton: true,
        closeLabel: "Done",
      });
    
      // 2. Custom settings for Font Color
      window.Coloris.setInstance("[data-color-input]", {
        alpha: false,
        format: "hex",
        swatches: [
          "#d4d4d4",
          "#ff9687",
          "#e9cd64",
          "#87e29e",
          "#98e0ff",
          "#e1aaff"
        ],
      });
    
      // 3. Custom settings for Highlight Color (with alpha enabled)
      window.Coloris.setInstance("[data-highlight-input]", {
        alpha: false,
        format: "mixed",
        swatches: [
          "#75720c",
          "#b23434",
          "#006f00",
          "#005d5d",
          "#af00af",
          "#545454",
        ],
      });
    }).catch((error) => {
      colorisPromise = null;
      throw error;
    });
  }
  return colorisPromise;
}

export function loadHtmlDiff() {
  if (!htmlDiffPromise) {
    htmlDiffPromise = loadScript("/static/htmldiff.js").catch((error) => {
      htmlDiffPromise = null;
      throw error;
    });
  }
  return htmlDiffPromise;
}
