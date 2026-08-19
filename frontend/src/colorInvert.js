function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  return lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
}

export function invertWordLuminanceWindow(r, g, b) {
  if (r === 0 && g === 0 && b === 0) return { r: 255, g: 255, b: 255 };
  if (r === 255 && g === 255 && b === 255) return { r: 0, g: 0, b: 0 };

  const y = relativeLuminance(r, g, b);

  if (y > 0.28) {
    const targetY = 0.095;
    let low = 0;
    let high = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (low + high) / 2;
      const curY = relativeLuminance(r * mid, g * mid, b * mid);
      if (curY > targetY) high = mid;
      else low = mid;
    }
    return {
      r: Math.round(r * low),
      g: Math.round(g * low),
      b: Math.round(b * low),
    };
  }

  if (y < 0.25) {
    const targetY = 0.264;
    let low = 0;
    let high = 255;
    for (let i = 0; i < 16; i++) {
      const lift = (low + high) / 2;
      const curY = relativeLuminance(
        Math.min(255, r + lift),
        Math.min(255, g + lift),
        Math.min(255, b + lift)
      );
      if (curY < targetY) low = lift;
      else high = lift;
    }
    return {
      r: Math.round(Math.min(255, r + low)),
      g: Math.round(Math.min(255, g + low)),
      b: Math.round(Math.min(255, b + low)),
    };
  }

  return {
    r: Math.min(252, r),
    g: Math.min(252, g),
    b: Math.min(252, b),
  };
}

function hslToRgbFloat(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return {
    r: (r + m) * 255,
    g: (g + m) * 255,
    b: (b + m) * 255,
  };
}

function hslToRgb(h, s, l) {
  const { r, g, b } = hslToRgbFloat(h, s, l);
  return {
    r: Math.round(Math.max(0, Math.min(255, r))),
    g: Math.round(Math.max(0, Math.min(255, g))),
    b: Math.round(Math.max(0, Math.min(255, b))),
  };
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = 60 * (((g - b) / d) % 6); break;
      case g: h = 60 * ((b - r) / d + 2); break;
      case b: h = 60 * ((r - g) / d + 4); break;
    }
  }
  return { h: h < 0 ? h + 360 : h, s, l };
}

function parseHsl(hslStr) {
  const m = hslStr.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+))?\s*\)/i);
  if (!m) return null;
  const h = parseFloat(m[1]);
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  const a = m[4] ? parseFloat(m[4]) : 1;
  return { ...hslToRgb(h, s, l), a, original: hslStr };
}

function parseRgb(rgbStr) {
  const m = rgbStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i);
  if (!m) return null;
  return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]), a: m[4] ? parseFloat(m[4]) : 1 };
}

function parseHex(hexStr) {
  const m = hexStr.match(/^#?([a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length === 6) hex += 'ff';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = parseInt(hex.slice(6, 8), 16) / 255;
  return { r, g, b, a };
}

const NAMED_COLORS = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
};

function parseNamedColor(name) {
  return NAMED_COLORS[name.toLowerCase()] || null;
}

export function parseColor(colorStr) {
  const trimmed = colorStr.trim();
  if (trimmed.startsWith('hsl')) return parseHsl(trimmed);
  if (trimmed.startsWith('rgb')) return parseRgb(trimmed);
  if (trimmed.startsWith('#')) return parseHex(trimmed);
  return parseNamedColor(trimmed);
}

export function formatColor(parsed, originalFormat) {
  const { r, g, b, a } = parsed;
  if (originalFormat.startsWith('hsl')) {
    const { h, s, l } = rgbToHsl(r, g, b);
    const hasAlpha = originalFormat.includes('a') || a < 1;
    if (hasAlpha) return `hsla(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`;
    return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
  }
  if (originalFormat.startsWith('rgb')) {
    const hasAlpha = originalFormat.includes('a') || a < 1;
    if (hasAlpha) return `rgba(${r}, ${g}, ${b}, ${a})`;
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (originalFormat.startsWith('#')) {
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    if (a < 1) {
      const alphaHex = Math.round(a * 255).toString(16).padStart(2, '0');
      return hex + alphaHex;
    }
    return hex;
  }
  return `rgb(${r}, ${g}, ${b})`;
}

export function invertColor(colorStr) {
  const parsed = parseColor(colorStr);
  if (!parsed) return colorStr;
  if (parsed.a === 0) return colorStr;

  const { r, g, b } = parsed;
  const inverted = invertWordLuminanceWindow(r, g, b);
  return formatColor({ ...inverted, a: parsed.a }, parsed.original || colorStr);
}

export function invertColorValue(colorStr) {
  return invertColor(colorStr);
}

export function invertStyleDeclaration(styleStr, invertFn = invertColor) {
  if (!styleStr) return styleStr;

  return styleStr.replace(
    /(--[\w-]+\s*:\s*)([^;]+)(;?)/g,
    (match, prop, value, semi) => {
      const trimmed = value.trim();
      const inverted = invertFn(trimmed);
      return prop + inverted + semi;
    }
  ).replace(
    /(color|background|background-color|border|border-color|outline|outline-color|text-decoration-color|fill|stroke|stop-color|flood-color|lighting-color)\s*:\s*([^;]+)(;?)/gi,
    (match, prop, value, semi) => {
      const trimmed = value.trim();
      if (/^(inherit|initial|unset|revert|currentColor)$/i.test(trimmed)) return match;
      const inverted = invertFn(trimmed);
      return `${prop}: ${inverted}${semi}`;
    }
  ).replace(
    /(box-shadow|text-shadow|filter)\s*:\s*([^;]+)(;?)/gi,
    (match, prop, value, semi) => {
      const inverted = value.replace(
        /(rgb|hsl)a?\([^)]+\)|#[a-f\d]{3,8}/gi,
        (colorMatch) => invertFn(colorMatch)
      );
      return `${prop}: ${inverted}${semi}`;
    }
  ).replace(
    /(linear-gradient|radial-gradient|conic-gradient)\([^)]+\)/gi,
    (match) => {
      return match.replace(
        /(rgb|hsl)a?\([^)]+\)|#[a-f\d]{3,8}/gi,
        (colorMatch) => invertFn(colorMatch)
      );
    }
  );
}

export function invertHtmlColors(html, invertFn = invertColor) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('*')) {
    const style = el.getAttribute('style');
    if (style) {
      el.setAttribute('style', invertStyleDeclaration(style, invertFn));
    }
  }
  return doc.documentElement.outerHTML;
}

export function invertHtmlColorsImport(html, invertFn = invertColor) {
  return invertHtmlColors(html, invertFn);
}