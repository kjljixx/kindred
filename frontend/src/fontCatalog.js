import googleFontsLatin from "./googleFontsLatin.json";

export const DEFAULT_FONT_NAME = "Noto Sans";
export const DEFAULT_FONT_FAMILY = `'${DEFAULT_FONT_NAME}', sans-serif`;

/** Fixed popular slots (order preserved). System faces are not Google Fonts. */
const PINNED_TOP = [
  "Noto Sans",
  "Times New Roman",
  "Arial",
  "Verdana",
  "Helvetica Neue",
];

const SYSTEM_FONT_CSS = {
  "Times New Roman": "'Times New Roman', Times, serif",
  Arial: "Arial, Helvetica, sans-serif",
  Verdana: "Verdana, Geneva, sans-serif",
  "Helvetica Neue": "'Helvetica Neue', Helvetica, Arial, sans-serif",
};

const SYSTEM_FONTS = new Set(Object.keys(SYSTEM_FONT_CSS));

/** How many popularity-ranked Google Fonts follow the pinned rows. */
const TOP_GOOGLE_COUNT = 15;

const loadedFonts = new Set(["Noto Sans", "Geist"]);

export function fontFamilyCssValue(name) {
  const family = String(name || "").trim();
  if (!family) return "";
  if (SYSTEM_FONT_CSS[family]) return SYSTEM_FONT_CSS[family];
  return `'${family.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', sans-serif`;
}

export function fontNameFromCssValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .split(",")[0]
    .trim()
    .replace(/^['"]+|['"]+$/g, "");
}

export function loadGoogleFont(familyName) {
  const name = String(familyName || "").trim();
  if (!name || SYSTEM_FONTS.has(name) || loadedFonts.has(name)) return;
  loadedFonts.add(name);
  const id = `gf-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  const familyParam = encodeURIComponent(name).replace(/%20/g, "+");
  link.href = `https://fonts.googleapis.com/css2?family=${familyParam}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
  document.head.appendChild(link);
}

/** googleFontsLatin.json is sorted by Google Fonts popularity (ascending rank). */
function latinCatalog() {
  const all = Array.isArray(googleFontsLatin) ? googleFontsLatin : [];
  const pinnedSet = new Set(PINNED_TOP);
  const popularGoogle = all
    .filter((name) => !pinnedSet.has(name))
    .slice(0, TOP_GOOGLE_COUNT);
  const top = [...PINNED_TOP, ...popularGoogle];
  const topSet = new Set(top);
  const rest = all.filter((name) => !topSet.has(name));
  return { top, rest };
}

export const TOP_FONTS = PINNED_TOP;


function makeOptionButton(name, { selected = false } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "font-family-option";
  btn.role = "option";
  btn.dataset.fontName = name;
  btn.textContent = name;
  btn.style.fontFamily = fontFamilyCssValue(name);
  btn.setAttribute("aria-selected", selected ? "true" : "false");
  if (selected) btn.classList.add("is-selected");
  return btn;
}

/**
 * Replaces a bare <select data-font-family> with a custom picker:
 * popular fonts stay pinned; full Latin Google Fonts catalog scrolls below.
 */
export function mountFontFamilyPicker(selectEl) {
  if (!selectEl || selectEl.dataset.fontPickerMounted === "1") return null;
  selectEl.dataset.fontPickerMounted = "1";

  const { top, rest } = latinCatalog();
  const defaultValue = fontFamilyCssValue(DEFAULT_FONT_NAME);

  selectEl.innerHTML = "";
  const allNames = [...top, ...rest];
  for (const name of allNames) {
    const opt = document.createElement("option");
    opt.value = fontFamilyCssValue(name);
    opt.textContent = name;
    selectEl.appendChild(opt);
  }
  selectEl.value = defaultValue;

  const picker = document.createElement("div");
  picker.className = "font-family-picker";
  picker.dataset.fontFamilyPicker = "";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "toolbar-select font-family-trigger";
  trigger.dataset.fontFamilyTrigger = "";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.title = selectEl.title || "Font family";
  trigger.setAttribute("aria-label", selectEl.getAttribute("aria-label") || "Font family");

  const label = document.createElement("span");
  label.dataset.fontFamilyLabel = "";
  label.textContent = DEFAULT_FONT_NAME;
  label.style.fontFamily = defaultValue;
  trigger.appendChild(label);

  const panel = document.createElement("div");
  panel.className = "font-family-panel";
  panel.dataset.fontFamilyPanel = "";
  panel.hidden = true;
  panel.setAttribute("role", "listbox");
  panel.setAttribute("aria-label", "Font family");

  const topEl = document.createElement("div");
  topEl.className = "font-family-top";
  topEl.setAttribute("role", "group");
  topEl.setAttribute("aria-label", "Popular fonts");
  for (const name of top) {
    topEl.appendChild(makeOptionButton(name, { selected: name === DEFAULT_FONT_NAME }));
  }

  const scrollEl = document.createElement("div");
  scrollEl.className = "font-family-scroll";
  scrollEl.setAttribute("role", "group");
  scrollEl.setAttribute("aria-label", "All Google Fonts");

  panel.appendChild(topEl);
  panel.appendChild(scrollEl);

  selectEl.classList.add("font-family-select-hidden");
  selectEl.tabIndex = -1;
  selectEl.setAttribute("aria-hidden", "true");

  const parent = selectEl.parentNode;
  parent.insertBefore(picker, selectEl);
  picker.appendChild(trigger);
  picker.appendChild(panel);
  picker.appendChild(selectEl);

  const syncLabel = (name) => {
    label.textContent = name || DEFAULT_FONT_NAME;
    label.style.fontFamily = fontFamilyCssValue(name || DEFAULT_FONT_NAME);
    panel.querySelectorAll(".font-family-option").forEach((btn) => {
      const on = btn.dataset.fontName === (name || DEFAULT_FONT_NAME);
      btn.classList.toggle("is-selected", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  };

  let restMounted = false;
  const ensureRestMounted = () => {
    if (restMounted) return;
    restMounted = true;
    const frag = document.createDocumentFragment();
    for (const name of rest) {
      frag.appendChild(makeOptionButton(name));
    }
    scrollEl.appendChild(frag);
    const current = fontNameFromCssValue(selectEl.value) || DEFAULT_FONT_NAME;
    syncLabel(current);
  };

  const setOpen = (open) => {
    if (open) ensureRestMounted();
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    picker.classList.toggle("is-open", open);
    if (open) {
      const selected = panel.querySelector(".font-family-option.is-selected");
      selected?.scrollIntoView({ block: "nearest" });
    }
  };

  const applyFont = (name) => {
    const value = fontFamilyCssValue(name);
    if (!value) return;
    loadGoogleFont(name);
    if (selectEl.value !== value) selectEl.value = value;
    syncLabel(name);
    setOpen(false);
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const onTriggerClick = (e) => {
    e.preventDefault();
    setOpen(panel.hidden);
  };

  const onPanelClick = (e) => {
    const btn = e.target.closest(".font-family-option");
    if (!btn || !panel.contains(btn)) return;
    e.preventDefault();
    applyFont(btn.dataset.fontName);
  };

  const onDocPointerDown = (e) => {
    if (!picker.classList.contains("is-open")) return;
    if (picker.contains(e.target)) return;
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape" && picker.classList.contains("is-open")) {
      e.preventDefault();
      setOpen(false);
      trigger.focus();
    }
  };

  // Prefetch faces for popular fonts so the top list previews correctly.
  for (const name of top) loadGoogleFont(name);

  trigger.addEventListener("click", onTriggerClick);
  panel.addEventListener("click", onPanelClick);
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onKeyDown);

  // Keep label in sync when syncSelectValue assigns select.value
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  if (valueDesc?.set) {
    Object.defineProperty(selectEl, "value", {
      configurable: true,
      enumerable: true,
      get() {
        return valueDesc.get.call(this);
      },
      set(v) {
        valueDesc.set.call(this, v);
        const name = fontNameFromCssValue(v) || DEFAULT_FONT_NAME;
        loadGoogleFont(name);
        syncLabel(name);
      },
    });
  }

  return {
    picker,
    trigger,
    panel,
    destroy() {
      trigger.removeEventListener("click", onTriggerClick);
      panel.removeEventListener("click", onPanelClick);
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    },
  };
}
