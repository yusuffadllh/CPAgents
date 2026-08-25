// Guardrails shared by the PDF/CSV and Office renderers. The spec comes from a
// model, so every unbounded loop it can drive needs a ceiling: without these a
// single reply could exhaust server memory before any size check runs.
export const LIMITS = {
  maxDocBytes: 100 * 1024 * 1024, // per rendered file
  maxTotalBytes: 100 * 1024 * 1024, // per assistant reply
  maxSpecBytes: 4 * 1024 * 1024, // raw JSON accepted per block
  maxBlocksPerReply: 10,
  maxBlocksPerDoc: 5000,
  maxRows: 20000,
  maxCols: 64,
  maxCellChars: 5000,
  maxListItems: 5000,
  maxSlides: 500,
};

export function esc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.length > LIMITS.maxCellChars ? `${s.slice(0, LIMITS.maxCellChars)}…` : s;
}

export function clampRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (out.length >= LIMITS.maxRows) break;
    out.push((Array.isArray(r) ? r : [r]).slice(0, LIMITS.maxCols));
  }
  return out;
}

export function clampCells(cells) {
  return Array.isArray(cells) ? cells.slice(0, LIMITS.maxCols) : [];
}

export function clampList(items, max = LIMITS.maxListItems) {
  return Array.isArray(items) ? items.slice(0, max) : [];
}

export function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
