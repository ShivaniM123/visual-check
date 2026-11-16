/**
 * The parity report as a PDF file, made in the browser: a small PDF writer (text in Helvetica,
 * JPEG images) and the report layout. No library and no service: the file is built from the
 * check's results and the original's screenshots, then downloaded.
 */
import { issueKey } from './report.js';

/* ---------- a minimal PDF writer ---------- */

// Helvetica widths (1/1000 em) for characters 32–126, from the standard font metrics
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667,
  722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556,
  222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584];
const SWAP = {
  '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', '—': '-', '…': '...', '→': '->', '×': 'x', '·': '-', '•': '-', '←': '<-', '≈': '~', ' ': ' ',
};

/** Text the standard fonts can draw (WinAnsi): quotes and arrows replaced, the rest kept or "?". */
function winAnsi(text) {
  return String(text ?? '').replace(/[^\x20-\x7e\xa1-\xff]/g, (c) => SWAP[c] ?? (c === '\n' || c === '\t' ? ' ' : '?'));
}

export function textWidth(text, size, bold = false) {
  const w = [...winAnsi(text)].reduce((sum, ch) => {
    const c = ch.charCodeAt(0);
    return sum + (c >= 32 && c <= 126 ? HELV[c - 32] : 556);
  }, 0);
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

export function wrap(text, size, maxWidth, bold = false) {
  const words = winAnsi(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    let w = word;
    // break very long words (selectors, URLs)
    while (textWidth(w, size, bold) > maxWidth) {
      let cut = w.length - 1;
      while (cut > 1 && textWidth(w.slice(0, cut), size, bold) > maxWidth) cut -= 1;
      if (line) { lines.push(line); line = ''; }
      lines.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, size, bold) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const pdfString = (s) => `(${winAnsi(s).replace(/[\\()]/g, (c) => `\\${c}`).replace(/[\xa1-\xff]/g, (c) => `\\${c.charCodeAt(0).toString(8)}`)})`;
const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => num(parseInt(h.slice(i, i + 2), 16) / 255)).join(' ');
};

export class PdfDoc {
  constructor({ width = 595.28, height = 841.89 } = {}) {
    this.W = width;
    this.H = height;
    this.pages = [];
    this.images = [];
    this.addPage();
  }

  addPage() {
    this.ops = [];
    this.pages.push(this.ops);
  }

  /** y is measured from the top of the page. */
  text(str, x, y, { size = 10, bold = false, color = '#1d1d1d' } = {}) {
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg ${num(x)} ${num(this.H - y)} Td ${pdfString(str)} Tj ET`);
  }

  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 1 } = {}) {
    const ops = [];
    if (fill) ops.push(`${rgb(fill)} rg`);
    if (stroke) ops.push(`${rgb(stroke)} RG ${num(lineWidth)} w`);
    let paint = 'S';
    if (fill) paint = stroke ? 'B' : 'f';
    ops.push(`${num(x)} ${num(this.H - y - h)} ${num(w)} ${num(h)} re ${paint}`);
    this.ops.push(`q ${ops.join(' ')} Q`);
  }

  line(x1, y1, x2, y2, { color = '#e1e1e1', lineWidth = 0.5 } = {}) {
    this.ops.push(`q ${rgb(color)} RG ${num(lineWidth)} w ${num(x1)} ${num(this.H - y1)} m ${num(x2)} ${num(this.H - y2)} l S Q`);
  }

  /** A JPEG: { bytes: Uint8Array, width, height } (pixels). */
  image(img, x, y, w, h) {
    let index = this.images.indexOf(img);
    if (index < 0) { this.images.push(img); index = this.images.length - 1; }
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.H - y - h)} cm /Im${index} Do Q`);
  }

  toBlob() {
    const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff); // eslint-disable-line no-bitwise
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (part) => {
      const bytes = typeof part === 'string' ? enc(part) : part;
      chunks.push(bytes);
      length += bytes.length;
    };
    // object numbers: 1 catalog, 2 pages, 3 F1, 4 F2, then images, then page + content pairs
    const imgBase = 5;
    const pageBase = imgBase + this.images.length;
    const total = pageBase + this.pages.length * 2;
    const obj = (n, body) => {
      offsets[n] = length;
      push(`${n} 0 obj\n`);
      (Array.isArray(body) ? body : [body]).forEach(push);
      push('\nendobj\n');
    };
    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    const kids = this.pages.map((_, i) => `${pageBase + i * 2} 0 R`).join(' ');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    this.images.forEach((im, i) => {
      obj(imgBase + i, [
        `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`,
        im.bytes,
        '\nendstream',
      ]);
    });
    const xobjects = this.images.map((_, i) => `/Im${i} ${imgBase + i} 0 R`).join(' ');
    this.pages.forEach((ops, i) => {
      const content = ops.join('\n');
      obj(pageBase + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.W)} ${num(this.H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xobjects} >> >> /Contents ${pageBase + i * 2 + 1} 0 R >>`);
      obj(pageBase + i * 2 + 1, [`<< /Length ${enc(content).length} >>\nstream\n`, content, '\nendstream']);
    });
    const xref = length;
    let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let n = 1; n < total; n += 1) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }
}

/* ---------- images: crops of the original's screenshot ---------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('screenshot'));
    img.src = src;
  });
}

function jpeg(canvas, quality = 0.82) {
  const b64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
  return { bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), width: canvas.width, height: canvas.height };
}

/** The issue's area on the original screenshot, with a little context and its outline. */
function crop(img, shot, rect, color) {
  const s = img.naturalWidth / (shot.width || img.naturalWidth);
  const pad = 24;
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  const w = Math.min((img.naturalWidth / s) - x, rect.w + pad * 2);
  const h = Math.min((img.naturalHeight / s) - y, Math.min(rect.h, 600) + pad * 2);
  if (w < 8 || h < 8) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * s));
  canvas.height = Math.max(1, Math.round(h * s));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, x * s, y * s, w * s, h * s, 0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, 2 * s);
  ctx.strokeRect((rect.x - x) * s, (rect.y - y) * s, Math.min(rect.w, w) * s, Math.min(rect.h, h) * s);
  return jpeg(canvas);
}

/* ---------- the report ---------- */

const SEV = { high: ['High', '#d7373f'], medium: ['Medium', '#da7b11'], low: ['Low', '#2680eb'] };
const STATUS = { ok: 'Approved', fix: 'Needs fix' };

export async function pdfReport(report, statuses = {}) {
  const doc = new PdfDoc();
  const M = 40;
  const W = doc.W - M * 2;
  let y = M;
  const ensure = (h) => {
    if (y + h > doc.H - M) { doc.addPage(); y = M; }
  };
  const para = (str, { size = 9.5, bold = false, color = '#1d1d1d', x = M, width = W, gap = 3 } = {}) => {
    wrap(str, size, width, bold).forEach((l) => {
      ensure(size + gap);
      doc.text(l, x, y + size, { size, bold, color });
      y += size + gap;
    });
  };

  // cover
  doc.rect(0, 0, doc.W, 6, { fill: '#3b63fb' });
  para('Parity report', { size: 22, bold: true, gap: 8 });
  para(report.migrated, { size: 10, color: '#6d6d6d', gap: 12 });
  const facts = [
    ['Original page', report.original],
    ['Migrated page', report.migrated],
    ['Checked', `${new Date(report.created).toLocaleString()} at ${report.widths.join(', ')}px`],
    ['Original breakpoints', report.breakpoints.length ? `${report.breakpoints.join(', ')}px` : 'none detected'],
    ['Original captured', `${new Date(report.originalCapturedAt).toLocaleString()}${report.originalLocal ? ' (same site)' : ' by Cloudflare Browser Run'}`],
  ];
  facts.forEach(([k, v]) => {
    ensure(14);
    doc.text(k, M, y + 9.5, { size: 9.5, bold: true, color: '#6d6d6d' });
    const lines = wrap(v, 9.5, W - 130);
    lines.forEach((l, i) => doc.text(l, M + 130, y + 9.5 + i * 12.5, { size: 9.5 }));
    y += Math.max(1, lines.length) * 12.5 + 2;
  });
  y += 10;
  ensure(70);
  const s = report.summary;
  let scoreColor = '#d7373f';
  if (s.score >= 85) scoreColor = '#2d9d78';
  else if (s.score >= 65) scoreColor = '#da7b11';
  doc.rect(M, y, W, 62, { fill: '#f8f8f8', stroke: '#e1e1e1' });
  doc.text(`${s.score}`, M + 16, y + 42, { size: 30, bold: true, color: scoreColor });
  doc.text('/100 parity score', M + 16 + textWidth(`${s.score}`, 30, true) + 6, y + 42, { size: 10, color: '#6d6d6d' });
  doc.text(`${s.issues} issues: ${s.high} high, ${s.medium} medium, ${s.low} low`, M + 230, y + 26, { size: 10, bold: true });
  doc.text(report.results.map((r) => `${r.width}px: ${r.score}`).join('   '), M + 230, y + 42, { size: 10, color: '#464646' });
  y += 80;
  // per width: score and issue counts
  para('By width', { size: 12, bold: true, gap: 6 });
  report.results.forEach((r) => {
    const c = { high: 0, medium: 0, low: 0 };
    r.issues.forEach((i) => { c[i.severity] += 1; });
    ensure(18);
    doc.text(`${r.width}px`, M, y + 10, { size: 10, bold: true });
    doc.text(`score ${r.score}`, M + 70, y + 10, { size: 10 });
    doc.text(`${c.high} high`, M + 150, y + 10, { size: 10, color: SEV.high[1] });
    doc.text(`${c.medium} medium`, M + 210, y + 10, { size: 10, color: SEV.medium[1] });
    doc.text(`${c.low} low`, M + 290, y + 10, { size: 10, color: SEV.low[1] });
    doc.text(`${r.stats.matched} matched, ${r.stats.missing} missing, ${r.stats.extra} extra`, M + 340, y + 10, { size: 9, color: '#6d6d6d' });
    y += 16;
  });
  y += 8;
  const mm = report.breakpointMismatch;
  if (mm?.missingInMigrated?.length) para(`The migrated CSS has no media query at ${mm.missingInMigrated.join(', ')}px.`, { color: '#8a5300' });

  // one section per width
  // eslint-disable-next-line no-restricted-syntax
  for (const r of report.results) {
    doc.addPage();
    y = M;
    para(`${r.width}px  -  score ${r.score}`, { size: 16, bold: true, gap: 6 });
    para(`${r.stats.matched} elements matched, ${r.stats.missing} missing and ${r.stats.extra} extra on the migrated page.`, { color: '#6d6d6d', gap: 10 });
    let img = null;
    if (r.shot?.src) {
      // eslint-disable-next-line no-await-in-loop
      img = await loadImage(r.shot.src).catch(() => null);
    }
    if (!r.issues.length) para('No visual differences at this width.', { size: 11 });
    // eslint-disable-next-line no-loop-func
    r.issues.forEach((i) => {
      const [label, color] = SEV[i.severity] || SEV.low;
      const st = STATUS[statuses[issueKey(i)]] || 'Open';
      const rect = i.oRects?.[0] || i.o?.rect;
      const pic = img && rect ? crop(img, { width: r.width }, rect, color) : null;
      const textW = pic ? W - 190 : W;
      const sel = i.m?.selector || i.o?.selector;
      const value = i.ov !== undefined || i.mv !== undefined ? `Original: ${i.ov ?? '-'}   Migrated: ${i.mv ?? '-'}` : '';
      const lines = [
        ...wrap(`${i.n}. ${i.title}`, 10.5, textW - 20, true).map((t) => [t, 10.5, true, '#1d1d1d']),
        ...(i.detail ? wrap(i.detail, 9, textW - 20).map((t) => [t, 9, false, '#464646']) : []),
        ...(value ? wrap(value, 9, textW - 20).map((t) => [t, 9, false, '#1d1d1d']) : []),
        ...(sel ? wrap(sel, 8, textW - 20).map((t) => [t, 8, false, '#6d6d6d']) : []),
        [`${label} - ${i.category}${i.m?.block ? ` - block ${i.m.block}` : ''} - ${st}`, 8.5, true, color],
      ];
      const textH = lines.reduce((h, l) => h + l[1] + 3, 0);
      const picW = pic ? Math.min(180, pic.width) : 0;
      const picH = pic ? Math.min(140, (pic.height / pic.width) * picW) : 0;
      const picW2 = pic ? (pic.width / pic.height) * picH : 0;
      const boxH = Math.max(textH, picH) + 16;
      ensure(boxH + 8);
      doc.rect(M, y, 3, boxH, { fill: color });
      let ty = y + 8;
      lines.forEach(([t, size, bold, c]) => {
        doc.text(t, M + 12, ty + size, { size, bold, color: c });
        ty += size + 3;
      });
      if (pic) doc.image(pic, M + W - picW2, y + 8, picW2, picH);
      y += boxH;
      doc.line(M, y + 4, M + W, y + 4);
      y += 10;
    });
  }
  return doc.toBlob();
}
