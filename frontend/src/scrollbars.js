import "overlayscrollbars/overlayscrollbars.css";
import { OverlayScrollbars } from "overlayscrollbars";

const SCROLL_SELECTORS = [".editor", ".feedback", ".draft-list", ".git-pane"];

const OPTIONS = { scrollbars: { theme: "os-theme-kindred", autoHide: "leave", autoHideDelay: 100 } };

function wrapScroller(viewport) {
  const host = document.createElement("div");
  host.className = "scroll-host";
  viewport.replaceWith(host);
  host.append(viewport);
  OverlayScrollbars({ target: host, elements: { viewport } }, OPTIONS);
}

export function initScrollbars() {
  const viewports = document.querySelectorAll(SCROLL_SELECTORS.join(","));
  viewports.forEach(wrapScroller);
  console.info(`[scrollbars] OverlayScrollbars applied to ${viewports.length} elements`, OPTIONS);
}
