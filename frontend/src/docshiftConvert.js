// DOCX import/export using docshift (pure client-side, no WASM)
import { toHtml, toDocx } from 'docshift';

/**
 * Convert a DOCX file to HTML string using docshift
 * @param {File|Blob} file - DOCX file object
 * @returns {Promise<string>} HTML string representation
 */
export async function importDocxToHtml(file) {
  const blob = file instanceof Blob ? file : new Blob([file], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const html = await toHtml(blob);
  return html || '<p></p>';
}

/**
 * Convert HTML content to DOCX Blob using docshift
 * @param {string} html - HTML string to convert
 * @returns {Promise<Blob>} DOCX file as Blob
 */
export async function htmlToDocxBlob(html) {
  const docxBlob = await toDocx(html);
  return docxBlob;
}

/**
 * Preload docshift (no-op for docshift as it's pure JS)
 */
export function preloadDocshift() {
  // docshift loads synchronously, no preload needed
}

/**
 * Check if docshift is available
 * @returns {Promise<boolean>}
 */
export async function ensureDocshift() {
  return true;
}