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
      window.Coloris({
        el: "[data-color-input]",
        wrap: false,
        theme: "default",
        themeMode: "dark",
        alpha: false,
        format: "hex",
        focusInput: false,
        closeButton: true,
        closeLabel: "Done",
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
