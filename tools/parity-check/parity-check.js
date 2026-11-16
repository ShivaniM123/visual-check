/* eslint no-use-before-define: ["error", { "functions": false }] */
/**
 * Parity Check: an Experience Workspace panel that compares the page you're editing with its
 * original page at the original site's breakpoints, and lists every visible difference.
 * The original is captured by Cloudflare's cloud browser, Browser Run (through the site's capture Worker);
 * this page is rendered in the panel.
 * The parity rules are the ones from tools/parity-check (extract, match, rules, words, prompt).
 */
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import { runCheck } from './lib/compare.js';
import { checkService } from './lib/cloud.js';
import { captureKey, getCapture } from './lib/store.js';
import {
  getSettings, saveSettings,
  getStatuses, saveStatuses, DEFAULT_HIDE,
} from './lib/settings.js';
import { issueKey } from './lib/report.js';
import { pdfReport } from './lib/pdf.js';
import { renderVisual } from './lib/visual.js';
import { groupBySection } from './lib/sections.js';

const SDK_TIMEOUT = 6000;
const MAX_WIDTHS = 5;
const PRESETS = [[390, 'Phone'], [768, 'Tablet'], [1024, 'Small laptop'], [1280, 'Desktop'], [1440, 'Wide']];
const SEV_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
const CATEGORY_LABEL = {
  typography: 'Typography',
  color: 'Colour',
  component: 'Component',
  content: 'Content',
  image: 'Image',
  layout: 'Layout',
  page: 'Page',
  responsive: 'Responsive',
  spacing: 'Spacing',
};

const state = {
  mode: 'demo', // ew | da | demo
  sdk: null,
  ctx: null, // { org, repo, branch, path }
  settings: null,
  original: '',
  originalHint: '',
  report: null,
  statuses: {},
  width: null,
  sev: null,
  hideApproved: false,
  activeId: null,
  busy: false,
  step: '',
  error: null,
  changed: false,
  view: 'main', // main | settings
  cached: null, // capture info for the current original + widths
};

const app = document.getElementById('app');
let visual = null;

/* ---------- helpers ---------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => { setTimeout(() => r(fallback), ms); })]);
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

let toastTimer;
function toast(message) {
  let el = document.querySelector('.pc-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'pc-toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

const siteId = () => `${state.ctx.org}/${state.ctx.repo}`;

/** The page's public address (shown, and given to AEM Coder). */
function migratedUrl() {
  if (state.mode === 'demo') return new URL('./demo/migrated.html', import.meta.url).href;
  const { org, repo, branch, path } = state.ctx;
  return `https://${branch}--${repo}--${org}.aem.page${path}`;
}

/**
 * Where the panel renders the page. In Experience Workspace the panel is served by the DA
 * preview proxy (*.preview.da.live), which composes the page from its DA source: so the check
 * sees the latest edits, even before they're previewed.
 */
function renderUrl() {
  if (state.mode === 'demo') return migratedUrl();
  return `${window.location.origin}${state.ctx.path}`;
}

function sameSitePanel() {
  if (state.mode === 'demo') return true;
  const { hostname } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  const [, repo, org] = hostname.split('.')[0].split('--');
  return repo?.toLowerCase() === state.ctx.repo.toLowerCase() && org?.toLowerCase() === state.ctx.org.toLowerCase();
}

/**
 * This page's public preview, for the cloud capture: both pages are then read in the same browser
 * with the same settings and compared pixel by pixel, as the PR does. Pages Cloudflare can't reach
 * (the local preview) are read in the panel instead.
 */
function migratedCloudUrl() {
  if (!serviceUrl()) return null;
  if (state.mode === 'demo' && !new URLSearchParams(window.location.search).has('cloud')) return null;
  const url = migratedUrl();
  return /^https:\/\//.test(url) && !/(^|\.)(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname) ? url : null;
}

/**
 * The code branch the panel itself is served from (e.g. parity-extension--visual-check--org.*):
 * the capture Worker must run that branch's capture code, whatever branch the content is on.
 */
function codeBranch() {
  const [branch, repo, org] = window.location.hostname.split('.')[0].split('--');
  if (branch && repo?.toLowerCase() === state.ctx.repo.toLowerCase() && org?.toLowerCase() === state.ctx.org.toLowerCase()) return branch;
  return state.ctx.branch;
}

/**
 * The capture Worker that runs Cloudflare Browser Run for this site: from Settings, or set for everyone
 * in the library row (?service=https://parity-check.<account>.workers.dev).
 */
function serviceUrl() {
  return state.settings.service || new URLSearchParams(window.location.search).get('service') || '';
}

function toWebPath(p) {
  let path = (p || '/').replace(/\.(plain\.)?html$/, '');
  if (!path.startsWith('/')) path = `/${path}`;
  return path.replace(/\/index$/, '/') || '/';
}

const result = () => state.report?.results.find((r) => r.width === state.width) || state.report?.results[0];
const statusOf = (i) => state.statuses[issueKey(i)] || null;

function visibleIssues() {
  const r = result();
  if (!r) return [];
  const items = r.issues.filter((i) => (!state.sev || i.severity === state.sev)
    && (!state.hideApproved || statusOf(i) !== 'ok'));
  // in the order they're shown: section by section, down the page
  return groupBySection(items, r.sections).flatMap((g) => g.issues);
}

/* ---------- running ---------- */

async function refreshCached() {
  if (!state.original) { state.cached = null; return; }
  const cap = await getCapture(captureKey(state.original, state.settings.widths));
  state.cached = cap ? { at: cap.capturedAt, widths: cap.widths.map((w) => w.width), local: !!cap.local } : null;
}

async function check({ refreshOriginal = false } = {}) {
  if (state.busy) return;
  let original;
  try {
    original = new URL(state.original.trim()).href;
    if (!/^https?:$/.test(new URL(original).protocol)) throw new Error();
  } catch (e) {
    state.error = { title: 'Enter the original page', text: 'Enter its full address, starting with https://' };
    render();
    app.querySelector('#pc-original')?.focus();
    return;
  }
  if (!sameSitePanel()) {
    state.error = {
      title: 'This page can\'t be read from here',
      text: `The panel is installed from another site. Add it to this site's library with a relative path (/tools/parity-check/parity-check.html), so it runs on ${state.ctx.repo}.`,
    };
    render();
    return;
  }
  state.original = original;
  state.busy = true;
  state.error = null;
  state.step = 'Starting';
  render();
  try {
    const report = await runCheck({
      original,
      migrated: migratedUrl(),
      renderUrl: renderUrl(),
      migratedCloudUrl: migratedCloudUrl(),
      widths: state.settings.widths,
      hideSelectors: state.settings.hideSelectors,
      service: serviceUrl(),
      // the Worker reads the capture code from this branch of the site
      ref: codeBranch(),
      // the demo original is on this site, so it's read in the panel; ?demo&cloud uses Cloudflare Browser Run
      cloud: new URLSearchParams(window.location.search).has('cloud'),
      refreshOriginal,
      log: (step) => {
        state.step = step;
        const el = app.querySelector('.pc-progress-step');
        if (el) el.textContent = step;
      },
    });
    state.report = report;
    state.statuses = getStatuses(siteId(), state.ctx.path);
    if (!report.results.some((r) => r.width === state.width)) state.width = report.results[0]?.width;
    state.activeId = null;
    state.changed = false;
    await refreshCached();
    const s = report.summary;
    toast(s.issues ? `${plural(s.issues, 'difference')} found` : 'No differences found');
  } catch (e) {
    state.error = { title: 'The check didn\'t finish', text: e.message || String(e) };
  } finally {
    state.busy = false;
    render();
  }
}

/* ---------- rendering ---------- */

function scoreClass(s) {
  if (s >= 85) return 'good';
  if (s >= 65) return 'fair';
  return 'poor';
}

function quotaLine() {
  if (state.cached) {
    return `<p class="pc-hint">Original captured ${esc(ago(state.cached.at))} at ${esc(state.cached.widths.join(', '))}px${state.cached.local ? ' (same site, read in the panel)' : ' by Cloudflare Browser Run'}. Re-checks reuse it. <button type="button" class="pc-link" data-act="recapture">Capture again</button></p>`;
  }
  const BL = '<a href="https://developers.cloudflare.com/browser-run/" target="_blank" rel="noopener">Cloudflare Browser Run</a>';
  const cloud = new URLSearchParams(window.location.search).has('cloud');
  if (state.mode === 'demo' && !cloud) {
    return `<p class="pc-hint">Both demo pages are on this site, so they're read in the panel. Pages on other sites are opened by ${BL} (add <code>&amp;cloud</code> to the address to use it here too).</p>`;
  }
  if (!serviceUrl()) {
    return `<p class="pc-hint">The original is opened by ${BL} through this site's capture Worker. <button type="button" class="pc-link" data-act="settings">Add its address</button> to start.</p>`;
  }
  return `<p class="pc-hint">The original is opened by ${BL} (free plan: 10 minutes of browser time a day, about 10 s per width). The capture is reused for every re-check.</p>`;
}

function breakpointsHtml() {
  const w = state.settings.widths;
  const auto = !w.length;
  const dis = state.busy ? 'disabled' : '';
  const presets = PRESETS.map(([px, name]) => `<button type="button" class="pc-preset" data-preset="${px}" aria-pressed="${w.includes(px)}" ${dis} title="${name}">${px}<small>${name}</small></button>`).join('');
  const custom = w.filter((x) => !PRESETS.some(([px]) => px === x))
    .map((x) => `<span class="pc-chip">${x}px<button type="button" data-rmw="${x}" aria-label="Remove ${x}px" ${dis}>×</button></span>`).join('');
  const found = auto && state.report?.widths?.length ? ` Last check used ${state.report.widths.join(', ')}px.` : '';
  return `<div class="pc-bp" role="group" aria-labelledby="pc-bp-label">
      <div class="pc-bp-head"><span class="pc-label" id="pc-bp-label">Breakpoints</span>
        <label class="pc-toggle"><input type="checkbox" data-act="auto-toggle" ${auto ? 'checked' : ''} ${dis}> Auto</label></div>
      <p class="pc-hint">${auto
    ? `The original's own breakpoints, read from its CSS, plus a phone width.${esc(found)} Pick widths below to choose them yourself.`
    : `${w.length} of ${MAX_WIDTHS} widths: ${w.join(', ')}px. Each width is checked on both pages.`}</p>
      <div class="pc-presets">${presets}</div>
      <div class="pc-chips">${custom}
        <input id="pc-width" class="pc-width-input" type="text" inputmode="numeric" placeholder="e.g. 600, 1920" aria-label="Add widths in pixels, separated by commas" ${dis}>
        <button type="button" class="pc-btn small" data-act="add-width" ${dis}>Add</button>
      </div>
    </div>`;
}

function setupHtml() {
  return `<section class="pc-card pc-setup" aria-label="Compare with">
    <label class="pc-label" for="pc-original">Original page</label>
    <input id="pc-original" type="url" spellcheck="false" autocomplete="off" placeholder="https://www.example.com/the-same-page" value="${esc(state.original)}" ${state.busy ? 'disabled' : ''}>
    <p class="pc-hint">${esc(state.originalHint)}</p>
    ${breakpointsHtml()}
    <button type="button" class="pc-btn primary pc-run" data-act="check" ${state.busy ? 'disabled' : ''}>${state.report ? 'Check again' : 'Check this page'}</button>
    ${quotaLine()}
  </section>`;
}

function progressHtml() {
  if (!state.busy) return '';
  return `<section class="pc-card pc-progress" aria-live="polite"><div class="pc-spinner" aria-hidden="true"></div>
    <div><p class="pc-progress-step">${esc(state.step)}</p>
    <p class="pc-hint">The original is read at every breakpoint in Cloudflare's cloud browser (about 10 s per width), then this page is rendered here at the same widths.</p></div></section>`;
}

function errorHtml() {
  if (!state.error) return '';
  return `<section class="pc-card pc-error" role="alert"><p class="pc-error-title">${esc(state.error.title)}</p><p>${esc(state.error.text)}</p></section>`;
}

function noticesHtml() {
  const { report } = state;
  const out = [];
  const cloud = report.migratedSource === 'cloud';
  if (state.changed) out.push(`<p class="pc-notice">The page changed since the last check.${cloud ? ' Preview it, then' : ''} <button type="button" class="pc-link" data-act="check">Check again</button></p>`);
  if (cloud) out.push('<p class="pc-notice pc-notice-info">Both pages were opened in the same cloud browser and compared pixel by pixel. This page is checked as last previewed.</p>');
  else if (state.mode !== 'demo') out.push('<p class="pc-notice">This page was read in the panel, without a pixel comparison, so results are less exact. Add the capture Worker in Settings to compare both pages in the cloud.</p>');
  if (report.breakpoints.length) {
    const mm = report.breakpointMismatch;
    const miss = mm.missingInMigrated.length ? ` The migrated CSS has no media query at ${mm.missingInMigrated.join(', ')}px.` : '';
    out.push(`<p class="pc-notice">The original changes layout at ${report.breakpoints.join(', ')}px.${esc(miss)}</p>`);
  }
  const r = result();
  if (r && !r.page.m.isEds) out.push('<p class="pc-notice">This page doesn\'t look like an Edge Delivery page.</p>');
  return out.join('');
}

const isColor = (v) => /^#|^rgb/.test(v || '');
const val = (v) => (v === undefined || v === null || v === '' ? '–' : `${isColor(v) ? `<span class="pc-swatch" style="background:${esc(v)}"></span>` : ''}${esc(v)}`);
const marked = (segs) => segs.map(([t, changed]) => (changed ? `<mark>${esc(t)}</mark>` : esc(t))).join('');

function compareTable(i) {
  const o = i.o?.st;
  const m = i.m?.st;
  if (o && m) {
    const rows = Object.keys({ ...o, ...m }).filter((k) => o[k] !== undefined || m[k] !== undefined);
    const diff = rows.filter((k) => o[k] !== m[k]);
    const same = rows.filter((k) => o[k] === m[k] && ['font-family', 'font-size', 'color'].includes(k));
    const show = [...diff, ...same];
    if (!show.length) return '';
    return `<table class="pc-cmp"><thead><tr><th></th><th>Original</th><th>This page</th></tr></thead><tbody>
      ${show.map((k) => `<tr class="${o[k] !== m[k] ? 'diff' : ''}"><th>${esc(k)}</th><td>${val(o[k])}</td><td>${val(m[k])}</td></tr>`).join('')}
    </tbody></table>`;
  }
  if (i.ov !== undefined || i.mv !== undefined) {
    return `<table class="pc-cmp"><thead><tr><th></th><th>Original</th><th>This page</th></tr></thead><tbody>
      <tr class="diff"><th>${esc(i.property || 'value')}</th><td>${val(i.ov)}</td><td>${val(i.mv)}</td></tr></tbody></table>`;
  }
  return '';
}

function issueHtml(i) {
  const st = statusOf(i);
  const active = i.id === state.activeId;
  const hasM = (i.m?.rects?.length || i.m?.rect) && !i.m?.expected;
  const tags = [
    CATEGORY_LABEL[i.category] || i.category,
    i.m?.block ? `Block: ${i.m.block}` : null,
    i.count > 1 ? `${i.count} elements` : null,
    !hasM && (i.o?.rect || i.oRects?.length) ? 'Only on original' : null,
  ].filter(Boolean).map((t) => `<span class="pc-tag">${esc(t)}</span>`);
  if (st === 'ok') tags.push('<span class="pc-tag ok">Approved</span>');
  if (st === 'fix') tags.push('<span class="pc-tag fix">Needs fix</span>');
  let body = '';
  if (active) {
    const words = i.words ? `<div class="pc-words"><div><b>Original</b>${marked(i.words.o)}</div><div><b>This page</b>${marked(i.words.m)}</div></div>` : '';
    const sel = i.m?.selector || i.o?.selector;
    body = `<div class="pc-issue-body">${words}${compareTable(i)}
      ${sel ? `<p class="pc-sel">${esc(sel)}</p>` : ''}
      <div class="pc-issue-actions">
        <button type="button" class="pc-btn small fix" data-act="fix" aria-pressed="${st === 'fix'}">Needs fix <kbd>F</kbd></button>
        <button type="button" class="pc-btn small ok" data-act="ok" aria-pressed="${st === 'ok'}">Approve <kbd>A</kbd></button>
      </div></div>`;
  }
  return `<li class="pc-issue ${i.severity}${active ? ' active' : ''}${st === 'ok' ? ' approved' : ''}" data-id="${esc(i.id)}">
    <button type="button" class="pc-issue-head" aria-expanded="${active}">
      <span class="pc-sev ${i.severity}" title="${SEV_LABEL[i.severity]}">${i.n}</span>
      <span><span class="pc-issue-title">${esc(i.title)}</span>
      ${i.detail ? `<span class="pc-issue-detail">${esc(i.detail)}</span>` : ''}
      <span class="pc-meta">${tags.join('')}</span></span>
    </button>${body}</li>`;
}

function summaryHtml() {
  const { report } = state;
  const open = report.results.flatMap((x) => x.issues).filter((i) => statusOf(i) !== 'ok').length;
  return `<section class="pc-card pc-summary">
      <div class="pc-score ${scoreClass(report.summary.score)}" aria-label="Parity score ${report.summary.score} of 100"><span>${report.summary.score}</span><small>/100</small></div>
      <div><p class="pc-summary-title">${report.summary.issues ? `${plural(open, 'open issue')} across ${plural(report.results.length, 'width')}` : 'Matches the original'}</p>
      <p class="pc-hint">${report.summary.high} high · ${report.summary.medium} medium · ${report.summary.low} low · checked ${esc(ago(new Date(report.created).getTime()))}</p></div>
    </section>`;
}

function listToolsHtml() {
  const counts = { high: 0, medium: 0, low: 0 };
  result().issues.forEach((i) => { counts[i.severity] += 1; });
  return `<div class="pc-list-tools">
      <div class="pc-chips" role="group" aria-label="Filter by severity">${['high', 'medium', 'low'].map((s) => `<button type="button" class="pc-filter" data-sev="${s}" aria-pressed="${state.sev === s}"><span class="pc-dot ${s}"></span>${SEV_LABEL[s]} ${counts[s]}</button>`).join('')}</div>
      <label class="pc-toggle"><input type="checkbox" data-act="hide-approved" ${state.hideApproved ? 'checked' : ''}> Hide approved</label>
    </div>`;
}

function issuesHtml() {
  const r = result();
  const items = visibleIssues();
  let list;
  if (!r.issues.length) list = '<li class="pc-empty">No visual differences at this width.</li>';
  else if (!items.length) list = '<li class="pc-empty">No issues match the filter.</li>';
  else {
    list = groupBySection(items, r.sections).map((g) => `<li class="pc-section" aria-label="${esc(g.label)}">
      <p class="pc-section-head"><span>${esc(g.label)}</span><span class="pc-section-count">${g.issues.length}</span></p>
      <ol class="pc-issues">${g.issues.map(issueHtml).join('')}</ol></li>`).join('');
  }
  return `<ol class="pc-issues pc-sections">${list}</ol>`;
}

function resultsHtml() {
  const { report } = state;
  if (!report) return '';
  const r = result();
  return `${summaryHtml()}
    <div class="pc-notices">${noticesHtml()}</div>
    <div class="pc-widths" role="tablist" aria-label="Width">${report.results.map((x) => `<button type="button" role="tab" data-width="${x.width}" aria-selected="${x.width === r.width}">
      ${x.width}px <span class="pc-wscore ${scoreClass(x.score)}">${x.score}</span></button>`).join('')}</div>
    <div class="pc-visual" id="pc-visual"></div>
    ${listToolsHtml()}
    ${issuesHtml()}
    <p class="pc-hint pc-keys"><kbd>←</kbd> <kbd>→</kbd> move · <kbd>A</kbd> approve · <kbd>F</kbd> needs fix · click a pin to open its issue</p>
    <div class="pc-actions">
      <button type="button" class="pc-btn primary" data-act="compare">Open comparison in new tab</button>
      <button type="button" class="pc-btn" data-act="pdf">Download PDF</button>
    </div>`;
}

function settingsHtml() {
  const s = state.settings;
  return `<section class="pc-card pc-settings" aria-label="Settings">
    <h2>Settings</h2>
    <label class="pc-label" for="pc-service">Capture Worker address</label>
    <div class="pc-row-inline"><input id="pc-service" type="url" autocomplete="off" spellcheck="false" value="${esc(s.service)}" placeholder="${esc(new URLSearchParams(window.location.search).get('service') || 'https://parity-check.<account>.workers.dev')}">
    <button type="button" class="pc-btn small" data-act="test-service">Test</button></div>
    <p class="pc-hint" id="pc-service-status">The free Cloudflare Worker that opens originals in Cloudflare's cloud browser for this site. Leave empty to use the one in the library row.</p>
    <label class="pc-label" for="pc-hide">Ignore elements</label>
    <textarea id="pc-hide" rows="5" spellcheck="false">${esc(s.hideSelectors.join('\n'))}</textarea>
    <p class="pc-hint">CSS selectors hidden on both pages before comparing: cookie banners, chat widgets, ads.</p>
    <div class="pc-row-actions"><button type="button" class="pc-btn primary" data-act="save-settings">Save</button>
    <button type="button" class="pc-btn" data-act="close-settings">Cancel</button></div>
  </section>`;
}

function render() {
  if (!state.ctx) {
    app.innerHTML = state.error ? errorHtml() : '<section class="pc-card pc-progress"><div class="pc-spinner"></div><p>Connecting to the editor…</p></section>';
    return;
  }
  const label = state.mode === 'demo' ? 'Demo page' : state.ctx.path;
  app.innerHTML = `<header class="pc-header">
      <img src="./icon.svg" alt="" width="22" height="22">
      <div class="pc-title"><h1>Parity Check</h1><p class="pc-path" title="${esc(migratedUrl())}">${esc(label)}</p></div>
      <button type="button" class="pc-icon-btn" data-act="settings" title="Settings" aria-label="Settings">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.3 1.5l.4 2.2c.6.2 1.1.5 1.6.9l2.1-.8 1.3 2.3-1.7 1.4c.1.6.1 1.2 0 1.8l1.7 1.4-1.3 2.3-2.1-.8c-.5.4-1 .7-1.6.9l-.4 2.2H8.7l-.4-2.2c-.6-.2-1.1-.5-1.6-.9l-2.1.8-1.3-2.3L5 10.3c-.1-.6-.1-1.2 0-1.8L3.3 7.1l1.3-2.3 2.1.8c.5-.4 1-.7 1.6-.9l.4-2.2h2.6zM10 7a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"/></svg>
      </button></header>
    ${state.view === 'settings' ? settingsHtml() : `${setupHtml()}${progressHtml()}${errorHtml()}${state.busy ? '' : resultsHtml()}`}`;
  if (state.view === 'main' && state.report && !state.busy) drawVisual();
  else { visual?.destroy(); visual = null; }
}

async function drawVisual() {
  const box = document.getElementById('pc-visual');
  const r = result();
  visual?.destroy();
  visual = null;
  if (!box || !r) return;
  const original = r.shot ? { shot: r.shot } : { url: state.report.original };
  try {
    const v = await renderVisual(box, {
      result: r,
      original,
      migrated: r.mshot ? { shot: r.mshot } : { url: renderUrl() },
      onPin: (id) => setActive(id, { fromPin: true }),
    });
    if (document.getElementById('pc-visual') !== box) { v.destroy(); return; }
    visual = v;
    visual.setIssues(visibleIssues(), state.activeId);
  } catch (e) {
    box.innerHTML = `<p class="pc-hint">The side-by-side view couldn't be shown: ${esc(e.message)}</p>`;
  }
}

/** Updates the summary, notices and list only, so the live side-by-side panes stay loaded. */
function renderList() {
  if (!state.report || state.busy || state.view !== 'main' || !app.querySelector('.pc-issues')) { render(); return; }
  const swap = (sel, html) => {
    const el = app.querySelector(sel);
    if (el) el.outerHTML = html;
  };
  swap('.pc-summary', summaryHtml());
  swap('.pc-notices', `<div class="pc-notices">${noticesHtml()}</div>`);
  swap('.pc-list-tools', listToolsHtml());
  swap('.pc-issues', issuesHtml());
  visual?.setIssues(visibleIssues(), state.activeId);
}

function setActive(id, { fromPin = false } = {}) {
  state.activeId = state.activeId === id && !fromPin ? null : id;
  renderList();
  const issue = result()?.issues.find((i) => i.id === state.activeId);
  if (issue) visual?.focus(issue);
  app.querySelector(`.pc-issue[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function setStatus(id, value) {
  const issue = result()?.issues.find((i) => i.id === id);
  if (!issue) return;
  const key = issueKey(issue);
  if (state.statuses[key] === value) delete state.statuses[key];
  else state.statuses[key] = value;
  saveStatuses(siteId(), state.ctx.path, state.statuses);
  renderList();
}

/* ---------- hand-off ---------- */

async function downloadPdf(btn) {
  btn.disabled = true;
  btn.textContent = 'Making PDF…';
  try {
    const blob = await pdfReport(state.report, state.statuses);
    const a = document.createElement('a');
    const path = state.ctx.path.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'index';
    a.href = URL.createObjectURL(blob);
    a.download = `parity-${path}-${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('PDF report downloaded.');
  } catch (e) {
    toast(`The PDF couldn't be made: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download PDF';
  }
}

/**
 * Where the comparison tab opens, and the page it renders next to the original. In Experience
 * Workspace the panel runs on DA's preview proxy, which a separate tab can't use, so the tab runs
 * on this branch's aem.page preview and shows the page as last previewed.
 */
function compareTarget() {
  const here = new URL(window.location.href);
  if (state.mode === 'demo' || !/\.preview\.da\.live$/.test(here.hostname)) {
    return { url: new URL('./compare.html', import.meta.url).href, migrated: renderUrl(), note: '' };
  }
  const origin = `https://${codeBranch()}--${state.ctx.repo}--${state.ctx.org}.aem.page`;
  return {
    url: `${origin}/tools/parity-check/compare.html`,
    migrated: `${origin}${state.ctx.path}`,
    note: 'This tab shows the page as last previewed. Edits that aren\'t previewed yet show in the panel only.',
  };
}

let compareWin = null;
let compareData = null;

function openCompare() {
  const target = compareTarget();
  compareData = {
    type: 'pc:report',
    report: state.report,
    statuses: state.statuses,
    migratedUrl: target.migrated,
    note: target.note,
    width: state.width,
  };
  compareWin = window.open(target.url, '_blank');
  if (!compareWin) toast('The browser blocked the new tab. Allow pop-ups for this site and try again.');
}

// the comparison tab asks for the results once it has loaded
window.addEventListener('message', (e) => {
  if (!compareWin || e.source !== compareWin || e.data?.type !== 'pc:ready' || !compareData) return;
  compareWin.postMessage(compareData, e.origin);
});

function addWidths(text) {
  const values = String(text || '').split(/[\s,;]+/).map((v) => Math.round(Number(v.replace(/px$/i, '')))).filter((v) => v >= 280 && v <= 2560);
  if (!values.length) { toast('Enter widths between 280 and 2560 px, e.g. 600, 1920'); return; }
  const current = state.settings.widths;
  const fresh = [...new Set(values)].filter((v) => !current.includes(v));
  const room = MAX_WIDTHS - current.length;
  if (!fresh.length) { toast('Those widths are already in the list.'); return; }
  if (room <= 0) { toast(`Up to ${MAX_WIDTHS} widths per check. Remove one first.`); return; }
  const added = fresh.slice(0, room);
  if (added.length < fresh.length) toast(`Up to ${MAX_WIDTHS} widths per check: added ${added.join(', ')}px.`);
  saveWidths([...current, ...added].sort((a, b) => a - b));
}

function togglePreset(px) {
  const w = state.settings.widths;
  if (w.includes(px)) { saveWidths(w.filter((x) => x !== px)); return; }
  if (w.length >= MAX_WIDTHS) { toast(`Up to ${MAX_WIDTHS} widths per check. Remove one first.`); return; }
  saveWidths([...w, px].sort((a, b) => a - b));
}

/* ---------- events ---------- */

app.addEventListener('click', async (e) => {
  const t = e.target;
  const act = t.closest('[data-act]')?.dataset.act;
  const issueEl = t.closest('.pc-issue');
  if (act === 'check') { readSetup(); check(); return; }
  if (act === 'recapture') { readSetup(); check({ refreshOriginal: true }); return; }
  if (act === 'settings') { state.view = state.view === 'settings' ? 'main' : 'settings'; render(); return; }
  if (act === 'close-settings') { state.view = 'main'; render(); return; }
  if (act === 'save-settings') { saveSettingsForm(); return; }
  if (act === 'test-service') { testService(); return; }
  if (act === 'pdf') { downloadPdf(t.closest('[data-act]')); return; }
  if (act === 'compare') { openCompare(); return; }
  if (act === 'add-width') { addWidths(app.querySelector('#pc-width')?.value); return; }
  const preset = t.closest('[data-preset]');
  if (preset) { togglePreset(Number(preset.dataset.preset)); return; }
  if ((act === 'ok' || act === 'fix') && issueEl) { setStatus(issueEl.dataset.id, act); return; }
  const rm = t.closest('[data-rmw]');
  if (rm) { saveWidths(state.settings.widths.filter((w) => w !== Number(rm.dataset.rmw))); return; }
  const wtab = t.closest('[data-width]');
  if (wtab) {
    state.width = Number(wtab.dataset.width);
    state.activeId = null;
    render();
    return;
  }
  const sev = t.closest('[data-sev]');
  if (sev) { state.sev = state.sev === sev.dataset.sev ? null : sev.dataset.sev; renderList(); return; }
  if (issueEl && t.closest('.pc-issue-head')) setActive(issueEl.dataset.id);
});

app.addEventListener('change', (e) => {
  if (e.target.dataset.act === 'hide-approved') { state.hideApproved = e.target.checked; renderList(); }
  if (e.target.dataset.act === 'auto-toggle') saveWidths(e.target.checked ? [] : [390, 1280]);
});

app.addEventListener('keydown', (e) => {
  if (e.target.id === 'pc-width' && e.key === 'Enter') {
    addWidths(e.target.value);
    return;
  }
  if (e.target.id === 'pc-original' && e.key === 'Enter') { readSetup(); check(); }
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey || !state.report || state.view !== 'main') return;
  const items = visibleIssues();
  const idx = items.findIndex((i) => i.id === state.activeId);
  if (['ArrowRight', 'ArrowDown'].includes(e.key) && items.length) {
    e.preventDefault();
    setActive(items[Math.min(items.length - 1, idx + 1)].id, { fromPin: true });
  } else if (['ArrowLeft', 'ArrowUp'].includes(e.key) && items.length) {
    e.preventDefault();
    setActive(items[Math.max(0, idx - 1)].id, { fromPin: true });
  } else if ((e.key === 'a' || e.key === 'A') && state.activeId) {
    setStatus(state.activeId, 'ok');
  } else if ((e.key === 'f' || e.key === 'F') && state.activeId) {
    setStatus(state.activeId, 'fix');
  } else if (e.key === 'Escape' && state.activeId) {
    state.activeId = null;
    renderList();
  }
});

function readSetup() {
  const input = app.querySelector('#pc-original');
  if (input) state.original = input.value.trim();
}

function saveWidths(widths) {
  readSetup();
  state.settings.widths = widths;
  if (state.mode !== 'demo') saveSettings(siteId(), { widths });
  refreshCached().then(render);
}

function saveSettingsForm() {
  const v = (id) => app.querySelector(id)?.value.trim() || '';
  const service = v('#pc-service').replace(/\/+$/, '');
  if (service && !/^https:\/\//.test(service) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(service)) {
    toast('The capture Worker address must start with https://');
    return;
  }
  const hideSelectors = v('#pc-hide').split('\n').map((l) => l.trim()).filter(Boolean);
  readSetup();
  saveSettings(siteId(), { service, hideSelectors });
  state.settings = { ...state.settings, service, hideSelectors };
  state.view = 'main';
  toast('Settings saved.');
  refreshCached().then(render);
}

async function testService() {
  const status = app.querySelector('#pc-service-status');
  const url = (app.querySelector('#pc-service')?.value.trim() || serviceUrl()).replace(/\/+$/, '');
  if (!url) { status.textContent = 'Enter the Worker\'s address first.'; return; }
  status.textContent = 'Testing…';
  try {
    const info = await checkService(url);
    status.textContent = info.configured
      ? '✓ Connected. The Worker is ready to capture originals in Cloudflare\'s cloud browser.'
      : 'The Worker answers, but has no Browser Run binding yet: add one named BROWSER to it.';
  } catch (e) {
    status.textContent = `✗ ${e.message === 'Failed to fetch' ? 'The Worker couldn\'t be reached.' : e.message}`;
  }
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.report && !state.busy && state.view === 'main') render();
  }, 300);
});

/* ---------- start-up ---------- */

async function start(ctx) {
  state.ctx = ctx;
  state.settings = state.mode === 'demo'
    ? {
      service: getSettings('demo').service, hideSelectors: DEFAULT_HIDE, widths: [640, 1024],
    }
    : getSettings(siteId());
  if (state.mode === 'demo') {
    state.original = new URL('./demo/original.html', import.meta.url).href;
    state.originalHint = 'Demo: two sample pages with deliberate differences. Open the panel from Experience Workspace to check your own pages.';
  } else {
    // empty: the author enters the original each time
    state.original = '';
    state.originalHint = 'Enter the address of the original page this page was migrated from.';
  }
  await refreshCached();
  // nothing runs until the author clicks "Check this page"
  render();
}

async function startEditor(sdk) {
  state.sdk = sdk;
  const { context } = sdk;
  state.mode = sdk.capabilities?.liveDocument === 1 ? 'ew' : 'da';
  await start({
    org: context.org,
    repo: context.repo || context.site,
    branch: context.branch || (context.ref && context.ref !== 'local' ? context.ref : 'main'),
    path: toWebPath(context.path),
  });
  if (state.mode === 'ew' && sdk.actions.subscribeLiveDocument) {
    let first = true;
    sdk.actions.subscribeLiveDocument(() => {
      if (first) { first = false; return; }
      if (state.report && !state.busy && !state.changed) {
        state.changed = true;
        renderList();
      }
    });
  }
}

function demoContext() {
  const host = window.location.hostname.match(/^([a-z0-9-]+)--([a-z0-9-]+)--([a-z0-9-]+)\./i);
  return {
    org: host?.[3] || 'shivanim123', repo: host?.[2] || 'visual-check', branch: host?.[1] || 'main', path: '/demo',
  };
}

(async () => {
  const params = new URLSearchParams(window.location.search);
  const embedded = window.parent !== window && !params.has('demo');
  render();
  const sdk = embedded ? await withTimeout(DA_SDK, SDK_TIMEOUT, null) : null;
  if (sdk?.context?.org) {
    await startEditor(sdk);
  } else if (embedded) {
    state.error = { title: 'Couldn\'t connect to the editor', text: 'Reload Experience Workspace and open Parity Check again.' };
    render();
  } else {
    state.mode = 'demo';
    await start(demoContext());
  }
})();
