// Office renderers (xlsx/docx/pptx), split from documents.js to keep each
// module small. All take a JSON spec and return a Buffer.

import { LIMITS, esc, clampRows, clampCells, clampList, formatBytes } from './document-limits.js';

function checkSize(buf) {
  if (buf.length > LIMITS.maxDocBytes) {
    throw new Error(`dokumen melebihi batas ${formatBytes(LIMITS.maxDocBytes)}`);
  }
  return buf;
}

// A leading =/+/-/@ turns a cell into a formula when the file is opened, so
// neutralise it before it reaches a spreadsheet.
function safeCell(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = esc(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// spec: { sheets: [{ name, headers?, rows?, columnWidths? }] }
export async function renderXlsx(spec) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const rawSheets = spec.sheets?.length ? spec.sheets : [{ name: 'Sheet1', headers: spec.headers, rows: spec.rows }];
  for (const s of clampList(rawSheets, 50)) {
    const ws = wb.addWorksheet(esc(s.name || 'Sheet1').slice(0, 31).replace(/[\\/*?:[\]]/g, '_'));
    if (s.headers?.length) {
      const header = ws.addRow(clampCells(s.headers).map(esc));
      header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
      header.alignment = { vertical: 'middle' };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }
    for (const r of clampRows(s.rows)) {
      // Keep numbers numeric so Excel can sum/sort them.
      ws.addRow(r.map(safeCell));
    }
    ws.columns.forEach((col, i) => {
      if (s.columnWidths?.[i]) { col.width = s.columnWidths[i]; return; }
      let max = 10;
      col.eachCell({ includeEmpty: false }, (c) => { max = Math.max(max, String(c.value ?? '').length + 2); });
      col.width = Math.min(max, 60);
    });
  }
  return checkSize(Buffer.from(await wb.xlsx.writeBuffer()));
}

// spec: { title?, blocks: [{ type: 'heading'|'paragraph'|'list'|'table' }] }
export async function renderDocx(spec) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType } = await import('docx');
  const children = [];

  if (spec.title) {
    children.push(new Paragraph({ text: esc(spec.title), heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }));
  }

  for (const b of clampList(spec.blocks, LIMITS.maxBlocksPerDoc)) {
    switch (b?.type) {
      case 'heading':
        children.push(new Paragraph({
          text: esc(b.text),
          heading: b.level === 1 ? HeadingLevel.HEADING_1 : b.level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2,
        }));
        break;
      case 'paragraph':
        children.push(new Paragraph({ children: [new TextRun(esc(b.text))], spacing: { after: 160 } }));
        break;
      case 'list':
        for (const item of clampList(b.items)) {
          children.push(new Paragraph({ text: esc(item), bullet: { level: 0 } }));
        }
        break;
      case 'table': {
        const headers = clampCells(b.headers).map(esc);
        const rows = clampRows(b.rows).map((r) => r.map(esc));
        const mk = (cells, bold) => new TableRow({
          children: cells.map((c) => new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: c, bold })] })],
          })),
        });
        const trs = [];
        if (headers.length) trs.push(mk(headers, true));
        for (const r of rows) trs.push(mk(r, false));
        if (trs.length) children.push(new Table({ rows: trs, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(new Paragraph({ text: '' }));
        break;
      }
      case 'pagebreak':
        children.push(new Paragraph({ pageBreakBefore: true, text: '' }));
        break;
      default:
        break;
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return checkSize(await Packer.toBuffer(doc));
}

// spec: { slides: [{ title?, bullets?, notes?, table? }] }
// Images are deliberately unsupported: pptxgenjs decodes them with image-size,
// which has unpatched infinite-loop DoS advisories (CVE-2025-71329/71330). Text
// and tables never reach that parser. Do not add addImage() until it is fixed.
export async function renderPptx(spec) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';

  for (const s of clampList(spec.slides, LIMITS.maxSlides)) {
    const slide = pptx.addSlide();
    if (s.title) {
      slide.addText(esc(s.title), { x: 0.5, y: 0.35, w: 9, h: 0.9, fontSize: 28, bold: true, color: '1F2937' });
    }
    if (s.bullets?.length) {
      slide.addText(clampList(s.bullets, 200).map((t) => ({ text: esc(t), options: { bullet: true } })), {
        x: 0.7, y: 1.5, w: 8.6, h: 3.6, fontSize: 16, color: '374151',
      });
    }
    if (s.table?.rows?.length) {
      const head = s.table.headers?.length
        ? [clampCells(s.table.headers).map((h) => ({ text: esc(h), options: { bold: true, fill: 'E5E7EB' } }))]
        : [];
      const body = clampRows(s.table.rows).map((r) => r.map((c) => ({ text: esc(c) })));
      slide.addTable([...head, ...body], { x: 0.5, y: 1.5, w: 9, fontSize: 12, border: { pt: 0.5, color: 'CCCCCC' } });
    }
    if (s.notes) slide.addNotes(esc(s.notes));
  }

  return checkSize(Buffer.from(await pptx.write({ outputType: 'nodebuffer' })));
}
