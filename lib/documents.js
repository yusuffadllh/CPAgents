import fs from 'fs/promises';
import path from 'path';
import { LIMITS, esc, clampRows, clampCells, clampList, formatBytes } from './document-limits.js';

// Chat mode has no terminal, so the model can't run a generator script. Instead
// it emits a JSON spec and the server renders the real binary here. Keeping the
// rendering server-side means chat never executes model-supplied code.
const BLOCK_RE = /<<<DOC:\s*(pdf|xlsx|docx|pptx|csv)\s*:\s*(.+?)\s*>>>\r?\n([\s\S]*?)\r?\n?<<<END>>>/gi;

export const DOC_MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
};

export function parseDocBlocks(text) {
  const blocks = [];
  let m;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    if (blocks.length >= LIMITS.maxBlocksPerReply) break;
    const [, type, name, body] = m;
    const raw = body.trim();
    if (Buffer.byteLength(raw, 'utf8') > LIMITS.maxSpecBytes) continue;
    let spec;
    try {
      spec = JSON.parse(raw);
    } catch {
      continue; // malformed spec: skip rather than crash the whole reply
    }
    if (!spec || typeof spec !== 'object') continue;
    blocks.push({ type: type.toLowerCase(), name: name.trim(), spec });
  }
  return blocks;
}

// spec: { title?, blocks: [{ type: 'heading'|'paragraph'|'list'|'table'|'pagebreak', ... }] }
async function renderPdf(spec) {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  doc.on('data', (c) => {
    bytes += c.length;
    if (bytes > LIMITS.maxDocBytes) overflow = true;
    chunks.push(c);
  });
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  if (spec.title) {
    doc.fontSize(20).font('Helvetica-Bold').text(esc(spec.title), { align: 'center' });
    doc.moveDown(1.2);
  }

  for (const b of clampList(spec.blocks, LIMITS.maxBlocksPerDoc)) {
    // pdfkit streams as it renders, so stop as soon as we cross the ceiling
    // instead of buffering an unbounded document first.
    if (overflow) break;
    switch (b?.type) {
      case 'heading': {
        const size = b.level === 1 ? 16 : b.level === 3 ? 12 : 14;
        doc.fontSize(size).font('Helvetica-Bold').text(esc(b.text));
        doc.moveDown(0.5);
        break;
      }
      case 'paragraph':
        doc.fontSize(11).font('Helvetica').text(esc(b.text), { align: b.align || 'left' });
        doc.moveDown(0.6);
        break;
      case 'list':
        doc.fontSize(11).font('Helvetica').list(clampList(b.items).map(esc), { bulletRadius: 2 });
        doc.moveDown(0.6);
        break;
      case 'table':
        renderPdfTable(doc, b, () => overflow);
        break;
      case 'pagebreak':
        doc.addPage();
        break;
      default:
        break;
    }
  }

  doc.end();
  const buf = await done;
  if (overflow) {
    throw new Error(`dokumen melebihi batas ${formatBytes(LIMITS.maxDocBytes)}`);
  }
  return buf;
}

// Minimal fixed-width table: pdfkit has no table primitive.
function renderPdfTable(doc, b, isOverflowing) {
  const headers = clampCells(b.headers).map(esc);
  const rows = clampRows(b.rows).map((r) => r.map(esc));
  const cols = Math.min(Math.max(headers.length, ...rows.map((r) => r.length), 1), LIMITS.maxCols);
  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const colW = usable / cols;
  const lineH = 18;

  const drawRow = (cells, bold) => {
    // Start a new page before the row rather than letting it overflow.
    if (doc.y + lineH > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    for (let i = 0; i < cols; i++) {
      doc.text(cells[i] ?? '', left + i * colW + 4, y + 5, { width: colW - 8, ellipsis: true, lineBreak: false });
    }
    doc.rect(left, y, usable, lineH).strokeColor('#cccccc').lineWidth(0.5).stroke();
    doc.y = y + lineH;
  };

  if (headers.length) drawRow(headers, true);
  for (const r of rows) {
    if (isOverflowing?.()) break;
    drawRow(r, false);
  }
  doc.moveDown(0.8);
}

// spec: { headers?: [], rows: [[]] }
function renderCsv(spec) {
  const cell = (v) => {
    const s = esc(v);
    // A leading =/+/-/@ makes Excel treat the cell as a formula; prefix with a
    // quote so spreadsheet apps can't be turned into an injection vector.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [];
  if (spec.headers?.length) lines.push(clampCells(spec.headers).map(cell).join(','));
  for (const r of clampRows(spec.rows)) lines.push(r.map(cell).join(','));
  const buf = Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
  if (buf.length > LIMITS.maxDocBytes) {
    throw new Error(`dokumen melebihi batas ${formatBytes(LIMITS.maxDocBytes)}`);
  }
  return buf;
}

async function renderDoc({ type, spec }) {
  if (type === 'pdf') return renderPdf(spec);
  if (type === 'csv') return renderCsv(spec);
  const office = await import('./documents-office.js');
  if (type === 'xlsx') return office.renderXlsx(spec);
  if (type === 'docx') return office.renderDocx(spec);
  if (type === 'pptx') return office.renderPptx(spec);
  throw new Error(`Unsupported document type: ${type}`);
}

/**
 * Render every <<<DOC:...>>> block in an assistant reply into a real file under
 * chat-workspaces/<sessionId>/files, returning attachment descriptors.
 */
export async function writeDocuments(sessionId, blocks) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId || '')) return [];

  const base = path.join(process.cwd(), 'chat-workspaces', sessionId, 'files');
  const saved = [];
  let totalBytes = 0;

  for (const block of blocks) {
    const name = safeName(block.name, block.type);
    const target = path.join(base, name);

    try {
      const buf = await renderDoc(block);
      if (buf.length > LIMITS.maxDocBytes) {
        throw new Error(`dokumen melebihi batas ${formatBytes(LIMITS.maxDocBytes)}`);
      }
      if (totalBytes + buf.length > LIMITS.maxTotalBytes) {
        throw new Error(`total dokumen melebihi batas ${formatBytes(LIMITS.maxTotalBytes)}`);
      }
      await fs.mkdir(base, { recursive: true });
      await fs.writeFile(target, buf);
      totalBytes += buf.length;
      saved.push({
        type: 'file',
        name,
        path: `files/${name}`,
        mime: DOC_MIME[block.type] || 'application/octet-stream',
        size: buf.length,
        created: true,
      });
    } catch (e) {
      console.error(`Failed to render ${block.type} "${block.name}":`, e.message);
      saved.push({ type: 'error', name, error: e.message });
    }
  }

  return saved;
}

// Model-supplied filenames are untrusted: flatten to a basename, drop anything
// outside a safe charset, and force the extension to match the block type.
function safeName(raw, type) {
  const stem = path
    .basename(String(raw || '').replace(/\\/g, '/'))
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9 ._-]/g, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 100)
    .trim();
  return `${stem || 'dokumen'}.${type}`;
}
