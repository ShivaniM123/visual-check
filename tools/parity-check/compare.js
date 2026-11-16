/**
 * Parity Check comparison tab: the original and this page side by side at full size, with every
 * issue pinned and listed. Opened from the panel, which sends it the check's results (the panel
 * runs inside Experience Workspace, so the two can't share browser storage).
 */
import { renderVisual } from './lib/visual.js';
import { issueKey } from './lib/report.js';
import { pdfReport } from './lib/pdf.js';
import { groupBySection } from './lib/sections.js';

const app = document.getElementById('app');
const SEV_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
const STATUS = { ok: 'Approved', fix: 'Needs fix' };
const state = {
  report: null, statuses: {}, migratedUrl: '', note: '', width: null, sev: null, activeId: null,
};
let visual = null;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const scoreClass = (s) => {
  if (s >= 85) return 'good';
  return s >= 65 ? 'fair' : 'poor';
};
const result = () => state.report.results.find((r) => r.width === state.width) || state.report.results[0];
const visibleIssues = () => groupBySection(result().issues.filter((i) => !state.sev || i.severity === state.sev), result().sections).flatMap((g) => g.issues);

function listHtml() {
  const items = visibleIssues();
  if (!result().issues.length) return '<p class="pc-empty">No visual differences at this width.</p>';
  const one = (i) => {
    const st = STATUS[state.statuses[issueKey(i)]];
    const value = i.ov !== undefined || i.mv !== undefined ? `<span class="pc-issue-detail">Original <b>${esc(i.ov ?? '–')}</b> · this page <b>${esc(i.mv ?? '–')}</b></span>` : '';
    return `<li class="pc-issue ${i.severity}${i.id === state.activeId ? ' active' : ''}${st === 'Approved' ? ' approved' : ''}" data-id="${esc(i.id)}">
      <button type="button" class="pc-issue-head"><span class="pc-sev ${i.severity}">${i.n}</span>
      <span><span class="pc-issue-title">${esc(i.title)}</span>${i.detail ? `<span class="pc-issue-detail">${esc(i.detail)}</span>` : ''}${value}
      <span class="pc-meta"><span class="pc-tag">${esc(i.category)}</span>${i.m?.block ? `<span class="pc-tag">Block: ${esc(i.m.block)}</span>` : ''}${st ? `<span class="pc-tag ${st === 'Approved' ? 'ok' : 'fix'}">${st}</span>` : ''}</span></span></button></li>`;
  };
  return `<ol class="pc-issues pc-sections">${groupBySection(items, result().sections).map((g) => `<li class="pc-section">
    <p class="pc-section-head"><span>${esc(g.label)}</span><span class="pc-section-count">${g.issues.length}</span></p>
    <ol class="pc-issues">${g.issues.map(one).join('')}</ol></li>`).join('')}</ol>`;
}

function render() {
  const { report } = state;
  const r = result();
  const counts = { high: 0, medium: 0, low: 0 };
  r.issues.forEach((i) => { counts[i.severity] += 1; });
  document.title = `Parity Check: ${new URL(report.migrated).pathname}`;
  app.innerHTML = `<header class="pcx-head">
      <img src="./icon.svg" alt="" width="26" height="26">
      <div class="pcx-title"><h1>Parity Check</h1><p class="pc-hint">${esc(report.migrated)} · original ${esc(report.original)}</p></div>
      <div class="pc-score ${scoreClass(report.summary.score)} pcx-score" aria-label="Parity score ${report.summary.score} of 100"><span>${report.summary.score}</span><small>/100</small></div>
      <button type="button" class="pc-btn primary" data-act="pdf">Download PDF</button>
    </header>
    <div class="pc-widths" role="tablist" aria-label="Width">${report.results.map((x) => `<button type="button" role="tab" data-width="${x.width}" aria-selected="${x.width === r.width}">${x.width}px <span class="pc-wscore ${scoreClass(x.score)}">${x.score}</span></button>`).join('')}</div>
    ${state.note ? `<p class="pc-notice">${esc(state.note)}</p>` : ''}
    <div class="pcx-grid">
      <div class="pc-visual pcx-visual" id="pc-visual"></div>
      <aside class="pcx-side">
        <div class="pc-chips" role="group" aria-label="Filter by severity">${['high', 'medium', 'low'].map((s) => `<button type="button" class="pc-filter" data-sev="${s}" aria-pressed="${state.sev === s}"><span class="pc-dot ${s}"></span>${SEV_LABEL[s]} ${counts[s]}</button>`).join('')}</div>
        <div class="pcx-list">${listHtml()}</div>
      </aside>
    </div>`;
  drawVisual();
}

async function drawVisual() {
  visual?.destroy();
  visual = null;
  const box = document.getElementById('pc-visual');
  const r = result();
  try {
    const v = await renderVisual(box, {
      result: r,
      original: r.shot ? { shot: r.shot } : { url: state.report.original },
      migrated: r.mshot ? { shot: r.mshot } : { url: state.migratedUrl },
      onPin: (id) => setActive(id, true),
      maxPaneHeight: Math.max(600, window.innerHeight - 150),
    });
    if (document.getElementById('pc-visual') !== box) { v.destroy(); return; }
    visual = v;
    visual.setIssues(visibleIssues(), state.activeId);
  } catch (e) {
    box.innerHTML = `<p class="pc-hint">The side-by-side view couldn't be shown: ${esc(e.message)}</p>`;
  }
}

function renderList() {
  app.querySelector('.pcx-list').innerHTML = listHtml();
  app.querySelectorAll('.pc-filter').forEach((b) => b.setAttribute('aria-pressed', String(state.sev === b.dataset.sev)));
  visual?.setIssues(visibleIssues(), state.activeId);
}

function setActive(id, fromPin = false) {
  state.activeId = state.activeId === id && !fromPin ? null : id;
  renderList();
  const issue = result().issues.find((i) => i.id === state.activeId);
  if (issue) visual?.focus(issue);
  app.querySelector(`.pc-issue[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function downloadPdf(btn) {
  btn.disabled = true;
  btn.textContent = 'Making PDF…';
  try {
    const blob = await pdfReport(state.report, state.statuses);
    const a = document.createElement('a');
    const path = new URL(state.report.migrated).pathname.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'index';
    a.href = URL.createObjectURL(blob);
    a.download = `parity-${path}-${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download PDF';
  }
}

app.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-act="pdf"]')) { downloadPdf(t.closest('[data-act="pdf"]')); return; }
  const w = t.closest('[data-width]');
  if (w) { state.width = Number(w.dataset.width); state.activeId = null; render(); return; }
  const s = t.closest('[data-sev]');
  if (s) { state.sev = state.sev === s.dataset.sev ? null : s.dataset.sev; renderList(); return; }
  const li = t.closest('.pc-issue');
  if (li && t.closest('.pc-issue-head')) setActive(li.dataset.id);
});

document.addEventListener('keydown', (e) => {
  if (!state.report || e.metaKey || e.ctrlKey || e.altKey) return;
  const items = visibleIssues();
  const idx = items.findIndex((i) => i.id === state.activeId);
  if (['ArrowRight', 'ArrowDown'].includes(e.key) && items.length) {
    e.preventDefault();
    setActive(items[Math.min(items.length - 1, idx + 1)].id, true);
  } else if (['ArrowLeft', 'ArrowUp'].includes(e.key) && items.length) {
    e.preventDefault();
    setActive(items[Math.max(0, idx - 1)].id, true);
  }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.report) drawVisual(); }, 300);
});

// the panel sends the results once this tab says it's ready
const allowed = (origin) => /^https:\/\/[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.(aem\.page|aem\.live|preview\.da\.live|stage-preview\.da\.live)$/i.test(origin)
  || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
window.addEventListener('message', (e) => {
  if (e.source !== window.opener || !allowed(e.origin) || e.data?.type !== 'pc:report') return;
  state.report = e.data.report;
  state.statuses = e.data.statuses || {};
  state.migratedUrl = e.data.migratedUrl;
  state.note = e.data.note || '';
  state.width = e.data.width || state.report.results[0]?.width;
  render();
});
let tries = 0;
const ping = setInterval(() => {
  tries += 1;
  if (state.report || tries > 40) {
    clearInterval(ping);
    if (!state.report) {
      app.innerHTML = '<section class="pc-card pc-error"><p class="pc-error-title">No results to show</p><p>Open this view from the Parity Check panel with <b>Open comparison in new tab</b>.</p></section>';
    }
    return;
  }
  window.opener?.postMessage({ type: 'pc:ready' }, '*');
}, 250);
