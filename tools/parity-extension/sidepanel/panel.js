import { runCheck } from '../lib/check.js';
import { runPsi, comparePsi, isPublicUrl } from '../lib/psi.js';
import {
  getSettings, guessOriginal, getOverride, rememberOriginal,
} from '../lib/settings.js';
import { issueKey, coderPrompt, markdownReport } from '../lib/report.js';
import {
  drawPins, clearPins, flashSelectors, pageState,
} from '../lib/page.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
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
  windowId: null,
  tab: null,
  settings: null,
  report: null,
  psi: { status: 'idle' },
  statuses: {},
  sevFilter: null,
  activeId: null,
  running: false,
  psiRunning: false,
  view: 'issues',
};

const scriptable = (url) => /^(https?|file):/.test(url || '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/.test(url);
const pageKey = (url) => (url || '').split('#')[0];
const sameTab = () => state.tab && state.report && pageKey(state.tab.url) === pageKey(state.report.migrated);

async function exec(func, arg) {
  if (!state.tab || !scriptable(state.tab.url)) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id }, func, args: arg === undefined ? [] : [arg],
    });
    return res?.result;
  } catch (e) {
    return null;
  }
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

const allIssues = () => state.report?.results[0]?.issues || [];
const statusOf = (i) => state.statuses[issueKey(i)] || null;

function visibleIssues() {
  const hideApproved = $('hide-approved').checked;
  return allIssues().filter((i) => (!state.sevFilter || i.severity === state.sevFilter)
    && (!hideApproved || statusOf(i) !== 'ok'));
}

/* ---------- storage ---------- */

async function saveSession() {
  if (!state.report && state.psi.status === 'idle') return;
  const key = `page:${pageKey(state.report?.migrated || state.tab?.url)}`;
  const psi = state.psi.status === 'running' ? { status: 'idle' } : state.psi;
  await chrome.storage.session.set({ [key]: { report: state.report, psi } }).catch(() => {});
}

async function loadSession(url) {
  const key = `page:${pageKey(url)}`;
  const { [key]: saved } = await chrome.storage.session.get(key).catch(() => ({}));
  return saved || null;
}

async function loadStatuses(url) {
  const key = `statuses:${pageKey(url)}`;
  const { [key]: s = {} } = await chrome.storage.local.get(key);
  return s;
}

async function saveStatuses() {
  if (!state.report) return;
  await chrome.storage.local.set({ [`statuses:${pageKey(state.report.migrated)}`]: state.statuses });
}

/* ---------- the open page ---------- */

async function refreshWidth() {
  const line = $('width-line');
  if (!state.tab || !scriptable(state.tab.url)) { line.textContent = ''; return; }
  const s = await exec(pageState);
  if (!s) { line.textContent = ''; return; }
  const bps = state.report?.breakpoints || [];
  const range = bps.length ? breakpointRange(s.innerWidth, bps) : '';
  line.innerHTML = `Compared at your current view: <strong>${s.innerWidth}px</strong>${range ? ` · ${esc(range)}` : ''}`;
}

function breakpointRange(width, bps) {
  const lower = [...bps].reverse().find((b) => b <= width);
  const upper = bps.find((b) => b > width);
  if (lower && upper) return `original layout ${lower}–${upper - 1}px`;
  if (upper) return `original layout below ${upper}px`;
  if (lower) return `original layout from ${lower}px`;
  return '';
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
  const changed = !state.tab || pageKey(state.tab.url) !== pageKey(tab?.url) || state.tab.id !== tab?.id;
  state.tab = tab || null;
  $('page-title').textContent = tab?.title || 'No page';
  $('page-url').textContent = tab?.url || '';

  const ok = tab && scriptable(tab.url);
  $('blocked').hidden = !!ok;
  $('blocked').textContent = ok ? '' : 'Open a web page (an aem.page preview, aem.live or your local preview) to check it.';
  $('check-form').hidden = !ok;
  if (!ok) {
    showResults(false);
    return;
  }
  if (changed && !state.running) {
    const override = await getOverride(tab.url);
    const guess = override || guessOriginal(tab.url, state.settings);
    const input = $('original-url');
    input.value = guess;
    input.removeAttribute('aria-invalid');
    $('original-hint').textContent = guess
      ? `${override ? 'The original you used last time for this page.' : 'Filled in from your site mapping.'} Change it if it's wrong.`
      : 'Enter the original page once. Other pages on this site are then filled in for you.';

    const saved = await loadSession(tab.url);
    state.report = saved?.report || null;
    state.psi = saved?.psi || { status: 'idle' };
    state.statuses = state.report ? await loadStatuses(tab.url) : {};
    state.activeId = null;
    state.sevFilter = null;
    $('error').hidden = true;
    render();
  }
  await refreshWidth();
}

/* ---------- running ---------- */

function setRunning(on, step = '') {
  state.running = on;
  $('progress').hidden = !on;
  $('progress-step').textContent = step;
  $('run-btn').disabled = on;
  $('original-url').disabled = on;
}

function showError(msg) {
  const e = $('error');
  e.textContent = msg;
  e.hidden = !msg;
}

async function onSubmit(ev) {
  ev.preventDefault();
  if (state.running) return;
  const input = $('original-url');
  let original;
  try {
    original = new URL(input.value.trim()).href;
    if (!/^https?:$/.test(new URL(original).protocol)) throw new Error();
  } catch (e) {
    input.setAttribute('aria-invalid', 'true');
    showError('Enter the full address of the original page, starting with https://');
    input.focus();
    return;
  }
  if (pageKey(original) === pageKey(state.tab.url)) {
    input.setAttribute('aria-invalid', 'true');
    showError('The original page is the page you have open. Enter the page on the original site.');
    return;
  }
  input.removeAttribute('aria-invalid');
  showError('');
  state.settings = await getSettings();
  state.settings.mappings = await rememberOriginal(state.tab.url, original, state.settings);

  const { tab } = state;
  setRunning(true, 'Reading this page');
  await exec(clearPins);
  state.report = null;
  state.activeId = null;
  state.sevFilter = null;
  state.psi = { status: 'idle' };
  render();

  const psiRun = state.settings.autoPsi ? startPsi(original, tab.url) : null;
  try {
    const report = await runCheck({
      tab,
      original,
      hideSelectors: state.settings.hideSelectors,
      log: (step) => { $('progress-step').textContent = step; },
    });
    if (state.tab?.id !== tab.id || pageKey(state.tab.url) !== pageKey(tab.url)) {
      // the author moved on: keep the result for that page, don't show it here
      await chrome.storage.session.set({ [`page:${pageKey(tab.url)}`]: { report, psi: { status: 'idle' } } });
      return;
    }
    state.report = report;
    state.statuses = await loadStatuses(tab.url);
    await saveSession();
    render();
    await refreshWidth();
    const s = report.summary;
    toast(s.issues ? `${s.issues} difference${s.issues === 1 ? '' : 's'} found` : 'No differences found');
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    setRunning(false);
  }
  if (psiRun) psiRun.then(() => saveSession());
}

/* ---------- Google PageSpeed Insights ---------- */

async function startPsi(original = $('original-url').value.trim(), migrated = state.tab?.url) {
  if (state.psiRunning) return;
  const settings = state.settings || await getSettings();
  const width = state.report?.results[0]?.width || (await exec(pageState))?.innerWidth || 1280;
  let strategy = settings.psiStrategy;
  if (strategy === 'auto') strategy = width >= 1024 ? 'desktop' : 'mobile';
  const chosen = document.getElementById('lh-strategy')?.value;
  if (chosen) strategy = chosen;

  const blocked = [[original, 'original'], [migrated, 'this']].find(([u]) => !isPublicUrl(u));
  if (blocked) {
    state.psi = {
      status: 'skipped',
      strategy,
      reason: `Lighthouse runs on Google's servers, so it needs public pages. The ${blocked[1]} page (${new URL(blocked[0]).host}) isn't reachable from the internet. Open the page's aem.page preview to include Lighthouse.`,
    };
    renderLh();
    showResults(true);
    return;
  }
  state.psiRunning = true;
  state.psi = { status: 'running', strategy, started: Date.now() };
  showResults(true);
  renderLh();
  const tick = setInterval(() => {
    const el = $('lh-elapsed');
    if (el) el.textContent = `${Math.round((Date.now() - state.psi.started) / 1000)} s`;
  }, 1000);
  try {
    const [o, m] = await Promise.all([
      runPsi(original, { strategy, key: settings.psiKey }),
      runPsi(migrated, { strategy, key: settings.psiKey }),
    ]);
    const data = { ...comparePsi(o, m), strategy, original, migrated };
    if (pageKey(state.tab?.url) === pageKey(migrated)) state.psi = { status: 'done', strategy, data };
  } catch (e) {
    if (pageKey(state.tab?.url) === pageKey(migrated)) state.psi = { status: 'error', strategy, error: e.message };
  } finally {
    clearInterval(tick);
    state.psiRunning = false;
  }
  renderLh();
  renderCounts();
  saveSession();
}

/* ---------- rendering ---------- */

function showResults(on) {
  $('results').hidden = !on;
  $('actions').hidden = !(on && state.report);
}

function scoreClass(s) {
  if (s >= 85) return 'good';
  if (s >= 65) return 'fair';
  return 'poor';
}

function render() {
  const has = !!state.report || state.psi.status !== 'idle';
  showResults(has);
  if (!has) {
    exec(clearPins);
    return;
  }
  const { report } = state;
  document.querySelector('.summary').hidden = !report;
  if (report) {
    const r = report.results[0];
    $('score-num').textContent = report.summary.score;
    $('score').className = `score ${scoreClass(report.summary.score)}`;
    $('summary-stats').textContent = `${r.stats.matched} elements matched · ${r.stats.missing} missing · ${r.stats.extra} extra · at ${r.width}px`;
    $('sev-chips').innerHTML = ['high', 'medium', 'low'].map((s) => `
      <button type="button" class="chip" data-sev="${s}" aria-pressed="${state.sevFilter === s}">
        <span class="dot ${s}"></span>${SEV_LABEL[s]} ${report.summary[s]}
      </button>`).join('');
  }
  renderNotices();
  renderIssues();
  renderLh();
  renderCounts();
  selectView(state.view);
  updatePins();
}

function renderCounts() {
  const open = allIssues().filter((i) => statusOf(i) !== 'ok').length;
  $('count-issues').textContent = state.report ? open : '';
  const lh = $('count-lh');
  if (state.psi.status === 'done') {
    const n = state.psi.data.regressions.length;
    lh.textContent = n;
    lh.className = `count${n ? ' bad' : ''}`;
  } else {
    lh.textContent = state.psi.status === 'running' ? '…' : '';
    lh.className = 'count';
  }
}

function renderNotices() {
  const out = [];
  const { report } = state;
  if (report) {
    const r = report.results[0];
    if (report.widthMismatch) {
      out.push(`The original page could only be opened at ${report.widthMismatch}px, while this page is ${r.width}px wide. Widths and positions may differ for that reason.`);
    }
    if (!r.page.m.isEds) {
      out.push('This page doesn\'t look like an Edge Delivery page. Open the migrated page and enter the original page above.');
    }
    const bps = report.breakpoints;
    if (bps.length) {
      const mm = report.breakpointMismatch;
      const miss = mm.missingInMigrated.length ? ` The migrated CSS has no media query at ${mm.missingInMigrated.join(', ')}px.` : '';
      out.push(`The original changes layout at ${bps.join(', ')}px. To check another layout, resize the browser window and check again.${miss}`);
    }
  }
  $('notices').innerHTML = out.map((t) => `<p class="notice">${esc(t)}</p>`).join('');
}

const isColor = (v) => /^#|^rgb/.test(v || '');
const val = (v) => (v === undefined || v === null || v === '' ? '–' : `${isColor(v) ? `<span class="swatch" style="background:${esc(v)}"></span>` : ''}${esc(v)}`);

function compareTable(i) {
  const o = i.o?.st;
  const m = i.m?.st;
  if (o && m) {
    const rows = Object.keys({ ...o, ...m }).filter((k) => o[k] !== undefined || m[k] !== undefined);
    const diff = rows.filter((k) => o[k] !== m[k]);
    const same = rows.filter((k) => o[k] === m[k] && ['font-family', 'font-size', 'color', 'size'].includes(k));
    const show = [...diff, ...same];
    if (!show.length) return '';
    return `<table class="cmp"><thead><tr><th></th><th>Original</th><th>This page</th></tr></thead><tbody>
      ${show.map((k) => `<tr class="${o[k] !== m[k] ? 'diff' : ''}"><th>${esc(k)}</th><td>${val(o[k])}</td><td>${val(m[k])}</td></tr>`).join('')}
    </tbody></table>`;
  }
  if (i.ov !== undefined || i.mv !== undefined) {
    return `<table class="cmp"><thead><tr><th></th><th>Original</th><th>This page</th></tr></thead><tbody>
      <tr class="diff"><th>${esc(i.property || 'value')}</th><td>${val(i.ov)}</td><td>${val(i.mv)}</td></tr></tbody></table>`;
  }
  return '';
}

const marked = (segs) => segs.map(([t, changed]) => (changed ? `<mark>${esc(t)}</mark>` : esc(t))).join('');

function pinRects(i) {
  const rects = (i.m?.rects?.length ? i.m.rects : [i.m?.rect]).filter((r) => r && r.w >= 0 && r.h >= 0);
  return rects;
}

function issueHtml(i) {
  const st = statusOf(i);
  const active = i.id === state.activeId;
  const where = i.m?.block ? `Block: ${i.m.block}` : null;
  const onlyOrig = i.m?.expected || (!pinRects(i).length && i.o?.rect);
  const tags = [
    CATEGORY_LABEL[i.category] || i.category,
    where,
    i.count > 1 ? `${i.count} elements` : null,
    onlyOrig ? 'Only on original' : null,
  ].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`);
  if (st === 'ok') tags.push('<span class="tag state-ok">Approved</span>');
  if (st === 'fix') tags.push('<span class="tag state-fix">Needs fix</span>');

  let body = '';
  if (active) {
    const words = i.words ? `<div class="words"><div><b>Original</b>${marked(i.words.o)}</div><div><b>This page</b>${marked(i.words.m)}</div></div>` : '';
    const sel = i.m?.selector || i.o?.selector;
    body = `<div class="issue-body">
      ${words}${compareTable(i)}
      ${sel ? `<p class="sel">${esc(sel)}</p>` : ''}
      <div class="issue-actions">
        ${pinRects(i).length ? '<button type="button" class="btn small" data-act="locate">Show on page</button>' : ''}
        <button type="button" class="btn small fix" data-act="fix" aria-pressed="${st === 'fix'}">Needs fix</button>
        <button type="button" class="btn small ok" data-act="ok" aria-pressed="${st === 'ok'}">Approve</button>
      </div>
    </div>`;
  }
  return `<li class="issue ${i.severity}${active ? ' active' : ''}${st === 'ok' ? ' approved' : ''}" data-id="${esc(i.id)}">
    <button type="button" class="issue-head" aria-expanded="${active}">
      <span class="sev ${i.severity}" title="${SEV_LABEL[i.severity]}">${i.n}</span>
      <span><span class="issue-title">${esc(i.title)}</span>
      ${i.detail ? `<span class="issue-detail">${esc(i.detail)}</span>` : ''}
      <span class="meta">${tags.join('')}</span></span>
    </button>${body}</li>`;
}

function renderIssues() {
  const list = $('issues');
  if (!state.report) { list.innerHTML = '<li class="empty">Run a check to see the differences.</li>'; return; }
  const items = visibleIssues();
  if (!allIssues().length) {
    list.innerHTML = '<li class="empty">No visual differences found at this width. 🎉</li>';
  } else if (!items.length) {
    list.innerHTML = '<li class="empty">No issues match the filter.</li>';
  } else {
    list.innerHTML = items.map(issueHtml).join('');
  }
}

function updatePins() {
  if (!sameTab()) return;
  const pins = visibleIssues().map((i) => ({
    id: i.id, n: i.n, severity: i.severity, title: i.title, rects: pinRects(i), expected: !!i.m?.expected,
  })).filter((p) => p.rects.length);
  exec(drawPins, { pins, activeId: state.activeId, visible: $('show-pins').checked });
}

function setActive(id, { fromPage = false } = {}) {
  state.activeId = state.activeId === id && !fromPage ? null : id;
  renderIssues();
  updatePins();
  const li = document.querySelector(`.issue[data-id="${CSS.escape(id)}"]`);
  li?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function setStatus(id, value) {
  const issue = allIssues().find((i) => i.id === id);
  if (!issue) return;
  const key = issueKey(issue);
  if (state.statuses[key] === value) delete state.statuses[key];
  else state.statuses[key] = value;
  await saveStatuses();
  renderIssues();
  renderCounts();
  if ($('hide-approved').checked) updatePins();
}

function renderLh() {
  const box = $('lh');
  const { psi } = state;
  const strategyPicker = (sel) => `<label class="hint">Device <select id="lh-strategy">
      <option value="mobile"${sel === 'mobile' ? ' selected' : ''}>Mobile</option>
      <option value="desktop"${sel === 'desktop' ? ' selected' : ''}>Desktop</option></select></label>`;
  const intro = (msg, cls = 'hint') => `<div class="card lh-intro">
      <p class="${cls}">${esc(msg)}</p>
      ${/API key|Settings/.test(msg) ? '<button type="button" class="btn" id="lh-settings">Open Settings</button>' : ''}
      ${strategyPicker(psi.strategy || 'mobile')}
      <button type="button" class="btn primary" id="lh-run">Run Lighthouse comparison</button>
    </div>`;

  if (psi.status === 'idle') {
    box.innerHTML = intro('Compare the Lighthouse scores of the original and this page with Google PageSpeed Insights, and see which accessibility, SEO and best-practice checks the migration broke. Both pages must be public.');
    return;
  }
  if (psi.status === 'skipped') { box.innerHTML = intro(psi.reason); return; }
  if (psi.status === 'error') { box.innerHTML = intro(psi.error, 'error-text'); return; }
  if (psi.status === 'running') {
    box.innerHTML = `<div class="card progress"><div class="spinner" aria-hidden="true"></div><div>
      <p class="progress-step">Google PageSpeed Insights is testing both pages <span id="lh-elapsed" class="hint"></span></p>
      <p class="hint">Lighthouse runs on Google's servers (${esc(psi.strategy)}). This usually takes 20–60 seconds.</p></div></div>`;
    return;
  }

  const d = psi.data;
  const cats = d.categories.map((c) => {
    let cls = 'same';
    let txt = '±0';
    if (c.delta === null) { cls = 'same'; txt = '–'; } else if (c.delta < 0) { cls = 'down'; txt = `▼ ${-c.delta}`; } else if (c.delta > 0) { cls = 'up'; txt = `▲ ${c.delta}`; }
    return `<div class="cat"><span class="cat-title">${esc(c.title)}</span>
      <span class="cat-vals">${c.o ?? '–'}<span class="arrow">→</span>${c.m ?? '–'}</span>
      <span class="delta ${cls}">${txt}</span></div>`;
  }).join('');

  const item = (r, withNodes = true) => `<div class="lh-item">
    <span class="tag">${esc(r.categoryTitle)}</span>
    <p><strong>${esc(r.title)}</strong>${r.display ? ` <span class="hint">· ${esc(r.display)}</span>` : ''}</p>
    ${r.description ? `<p class="hint">${esc(r.description)}${r.link ? ` <a href="${esc(r.link)}" target="_blank" rel="noopener">Learn more</a>` : ''}</p>` : ''}
    ${withNodes && r.nodes.length ? `<ul class="nodes">${r.nodes.map((n) => `<li><span><span class="sel">${esc(n.label || n.selector)}</span><br><span class="sel hint">${esc(n.snippet.slice(0, 140))}</span></span>
      <button type="button" class="btn small" data-flash="${esc(n.selector)}">Show</button></li>`).join('')}</ul>` : ''}
  </div>`;

  const metrics = `<table class="cmp metrics"><thead><tr><th>Metric</th><th>Original</th><th>This page</th></tr></thead><tbody>
    ${d.metrics.map((m) => `<tr><th>${esc(m.title)}</th><td>${esc(m.o)}</td><td class="${m.worse ? 'worse' : ''}">${esc(m.m)}</td></tr>`).join('')}</tbody></table>`;

  box.innerHTML = `
    <div class="cats">${cats}</div>
    <p class="lh-h">Got worse after migration (${d.regressions.length})</p>
    ${d.regressions.length ? d.regressions.map((r) => item(r)).join('') : '<p class="card hint">No check that passes on the original fails on this page. 🎉</p>'}
    <p class="lh-h">Lab metrics</p>
    ${metrics}
    ${d.improvements.length ? `<details class="better"><summary>Better than the original (${d.improvements.length})</summary>${d.improvements.map((r) => item(r, false)).join('')}</details>` : ''}
    <div class="lh-intro" style="margin-top:10px">${strategyPicker(psi.strategy)}<button type="button" class="btn" id="lh-run">Run Lighthouse again</button></div>
    <p class="lh-foot">Powered by Google PageSpeed Insights · Lighthouse ${esc(d.lighthouseVersion)} · ${esc(psi.strategy)} · tested ${new Date(d.fetched.m).toLocaleTimeString()}. Scores vary a little between runs; the checks that fail are what matter.</p>`;
}

function selectView(view) {
  state.view = view;
  $('tab-issues').setAttribute('aria-selected', view === 'issues');
  $('tab-lh').setAttribute('aria-selected', view === 'lh');
  $('view-issues').hidden = view !== 'issues';
  $('view-lh').hidden = view !== 'lh';
}

/* ---------- hand-off ---------- */

const psiForExport = () => (state.psi.status === 'done' ? { ...state.psi.data, strategy: state.psi.strategy } : null);

async function copyPrompt() {
  if (!state.report) return;
  const text = coderPrompt(state.report, state.statuses, psiForExport());
  await navigator.clipboard.writeText(text);
  toast('Copied. Paste it into AEM Coder.');
}

function download() {
  if (!state.report) return;
  const md = markdownReport(state.report, state.statuses, psiForExport());
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  const path = new URL(state.report.migrated).pathname.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'index';
  a.href = URL.createObjectURL(blob);
  a.download = `parity-${path}-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- events ---------- */

function bind() {
  $('check-form').addEventListener('submit', onSubmit);
  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('copy-prompt').addEventListener('click', () => copyPrompt().catch((e) => showError(e.message)));
  $('download').addEventListener('click', download);
  $('tab-issues').addEventListener('click', () => selectView('issues'));
  $('tab-lh').addEventListener('click', () => selectView('lh'));
  $('show-pins').addEventListener('change', updatePins);
  $('hide-approved').addEventListener('change', () => { renderIssues(); updatePins(); });
  $('original-url').addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

  $('sev-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-sev]');
    if (!chip) return;
    state.sevFilter = state.sevFilter === chip.dataset.sev ? null : chip.dataset.sev;
    render();
  });

  $('issues').addEventListener('click', (e) => {
    const li = e.target.closest('.issue');
    if (!li) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'ok' || act === 'fix') setStatus(li.dataset.id, act);
    else if (act === 'locate') { state.activeId = li.dataset.id; updatePins(); } else if (e.target.closest('.issue-head')) setActive(li.dataset.id);
  });

  $('lh').addEventListener('click', (e) => {
    if (e.target.closest('#lh-run')) startPsi();
    if (e.target.closest('#lh-settings')) chrome.runtime.openOptionsPage();
    const flash = e.target.closest('[data-flash]');
    if (flash) {
      exec(flashSelectors, { selectors: [flash.dataset.flash] }).then((n) => {
        if (!n) toast('That element isn\'t on the page you have open.');
      });
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || !state.report) return;
    const items = visibleIssues();
    const idx = items.findIndex((i) => i.id === state.activeId);
    if (['ArrowRight', 'ArrowDown'].includes(e.key) && items.length) {
      e.preventDefault();
      setActive(items[Math.min(items.length - 1, idx + 1)].id, { fromPage: true });
    } else if (['ArrowLeft', 'ArrowUp'].includes(e.key) && items.length) {
      e.preventDefault();
      setActive(items[Math.max(0, idx - 1)].id, { fromPage: true });
    } else if ((e.key === 'a' || e.key === 'A') && state.activeId) {
      setStatus(state.activeId, 'ok');
    } else if ((e.key === 'f' || e.key === 'F') && state.activeId) {
      setStatus(state.activeId, 'fix');
    } else if (e.key === 'Escape') {
      state.activeId = null;
      renderIssues();
      updatePins();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === 'parity:pin' && sender.tab?.id === state.tab?.id) {
      selectView('issues');
      setActive(msg.id, { fromPage: true });
    }
  });

  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (windowId === state.windowId) loadTab();
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== state.tab?.id) return;
    if (info.url) loadTab();
    if (info.status === 'complete') {
      loadTab().then(() => { if (!state.running) updatePins(); });
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') getSettings().then((s) => { state.settings = s; });
  });
  window.addEventListener('focus', refreshWidth);
}

async function init() {
  const win = await chrome.windows.getCurrent();
  state.windowId = win.id;
  state.settings = await getSettings();
  bind();
  await loadTab();
}

init();
