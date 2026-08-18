const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];

const XYZ_TO_SRGB = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.9692660, 1.8760108, 0.0415560],
  [0.0556434, -0.2040259, 1.0572252],
];

const D65 = { X: 0.95047, Y: 1.00000, Z: 1.08883 };

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function rgbToXyz(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  return {
    X: lr * SRGB_TO_XYZ[0][0] + lg * SRGB_TO_XYZ[0][1] + lb * SRGB_TO_XYZ[0][2],
    Y: lr * SRGB_TO_XYZ[1][0] + lg * SRGB_TO_XYZ[1][1] + lb * SRGB_TO_XYZ[1][2],
    Z: lr * SRGB_TO_XYZ[2][0] + lg * SRGB_TO_XYZ[2][1] + lb * SRGB_TO_XYZ[2][2],
  };
}

function xyzToRgb(X, Y, Z) {
  const lr = X * XYZ_TO_SRGB[0][0] + Y * XYZ_TO_SRGB[0][1] + Z * XYZ_TO_SRGB[0][2];
  const lg = X * XYZ_TO_SRGB[1][0] + Y * XYZ_TO_SRGB[1][1] + Z * XYZ_TO_SRGB[1][2];
  const lb = X * XYZ_TO_SRGB[2][0] + Y * XYZ_TO_SRGB[2][1] + Z * XYZ_TO_SRGB[2][2];
  return {
    r: Math.round(Math.max(0, Math.min(255, linearToSrgb(lr) * 255))),
    g: Math.round(Math.max(0, Math.min(255, linearToSrgb(lg) * 255))),
    b: Math.round(Math.max(0, Math.min(255, linearToSrgb(lb) * 255))),
  };
}

function xyzToLch(X, Y, Z) {
  const xr = X / D65.X;
  const yr = Y / D65.Y;
  const zr = Z / D65.Z;

  const fx = xr > 0.008856 ? Math.cbrt(xr) : (7.787 * xr) + 16 / 116;
  const fy = yr > 0.008856 ? Math.cbrt(yr) : (7.787 * yr) + 16 / 116;
  const fz = zr > 0.008856 ? Math.cbrt(zr) : (7.787 * zr) + 16 / 116;

  const L = Math.max(0, 116 * fy - 16);
  const a = 500 * (fx - fy);
  const b = 200 * (fy - fz);

  const C = Math.sqrt(a * a + b * b);
  let h = Math.atan2(b, a) * (180 / Math.PI);
  if (h < 0) h += 360;

  return { L, C, h };
}

function lchToXyz(L, C, h) {
  const a = C * Math.cos(h * (Math.PI / 180));
  const b = C * Math.sin(h * (Math.PI / 180));
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;

  const xr = fx > 0.206893 ? fx * fx * fx : (fx - 16 / 116) / 7.787;
  const yr = L > 7.9996 ? fy * fy * fy : (fy - 16 / 116) / 7.787;
  const zr = fz > 0.206893 ? fz * fz * fz : (fz - 16 / 116) / 7.787;

  return {
    X: xr * D65.X,
    Y: yr * D65.Y,
    Z: zr * D65.Z,
  };
}

function rgbToLch(r, g, b) {
  const { X, Y, Z } = rgbToXyz(r, g, b);
  return xyzToLch(X, Y, Z);
}

function lchToRgb(L, C, h) {
  const { X, Y, Z } = lchToXyz(L, C, h);
  return xyzToRgb(X, Y, Z);
}

function invertLchLightness(lch) {
  return { ...lch, L: 100 - lch.L };
}

function parseHsl(hslStr) {
  const m = hslStr.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+))?\s*\)/i);
  if (!m) return null;
  const h = parseFloat(m[1]);
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  const a = m[4] ? parseFloat(m[4]) : 1;
  return { h, s, l, a, original: hslStr };
}

function hslToRgb(h, s, l) {
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
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
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

function parseColor(colorStr) {
  const trimmed = colorStr.trim();
  if (trimmed.startsWith('hsl')) return parseHsl(trimmed);
  if (trimmed.startsWith('rgb')) return parseRgb(trimmed);
  if (trimmed.startsWith('#')) return parseHex(trimmed);
  return parseNamedColor(trimmed);
}

function formatColor(parsed, originalFormat) {
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

function invertColorValue(colorStr) {
  const parsed = parseColor(colorStr);
  if (!parsed) return colorStr;

  if (parsed.a === 0) return colorStr;

  const { r, g, b } = parsed;
  const lch = rgbToLch(r, g, b);
  const inverted = invertLchLightness(lch);
  const { r: r2, g: g2, b: b2 } = lchToRgb(inverted.L, inverted.C, inverted.h);

  return formatColor({ r: r2, g: g2, b: b2, a: parsed.a }, parsed.original || colorStr);
}

function invertStyleDeclaration(styleStr) {
  if (!styleStr) return styleStr;

  return styleStr.replace(
    /(--[\w-]+\s*:\s*)([^;]+)(;?)/g,
    (match, prop, value, semi) => {
      const trimmed = value.trim();
      const inverted = invertColorValue(trimmed);
      return prop + inverted + semi;
    }
  ).replace(
    /(color|background|background-color|border|border-color|outline|outline-color|text-decoration-color|fill|stroke|stop-color|flood-color|lighting-color)\s*:\s*([^;]+)(;?)/gi,
    (match, prop, value, semi) => {
      const trimmed = value.trim();
      if (/^(inherit|initial|unset|revert|currentColor)$/i.test(trimmed)) return match;
      const inverted = invertColorValue(trimmed);
      return `${prop}: ${inverted}${semi}`;
    }
  ).replace(
    /(box-shadow|text-shadow|filter)\s*:\s*([^;]+)(;?)/gi,
    (match, prop, value, semi) => {
      const inverted = value.replace(
        /(rgb|hsl)a?\([^)]+\)|#[a-f\d]{3,8}/gi,
        (colorMatch) => invertColorValue(colorMatch)
      );
      return `${prop}: ${inverted}${semi}`;
    }
  ).replace(
    /(linear-gradient|radial-gradient|conic-gradient)\([^)]+\)/gi,
    (match) => {
      return match.replace(
        /(rgb|hsl)a?\([^)]+\)|#[a-f\d]{3,8}/gi,
        (colorMatch) => invertColorValue(colorMatch)
      );
    }
  );
}

export function invertHtmlColors(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const el of doc.querySelectorAll('*')) {
    const style = el.getAttribute('style');
    if (style) {
      el.setAttribute('style', invertStyleDeclaration(style));
    }
  }

  return doc.documentElement.outerHTML;
}