/**
 * Renders a page of this site in an iframe inside the panel, at an exact viewport width,
 * and reads it with the parity core (extract.js). The panel and the page share an origin
 * (the Experience Workspace preview proxy, aem.page or the local preview), so the page can
 * be read directly: no third party, no limit, and it shows the author's latest edits.
 */
import { autoScroll, extractPage, collectMediaFromCssom } from './extract.js';

const GLOBALS = [
  'window', 'document', 'getComputedStyle', 'CSS', 'CSSRule', 'NodeFilter',
  'DOMMatrixReadOnly', 'setTimeout', 'clearTimeout', 'performance',
];

const FREEZE_CSS = '*, *::before, *::after { transition: none !important; animation-play-state: paused !important; caret-color: transparent !important; scroll-behavior: auto !important; }';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitUntil(test, timeout, step = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (test()) return true; } catch (e) { /* not ready */ }
    // eslint-disable-next-line no-await-in-loop
    await sleep(step);
  }
  return false;
}

/**
 * Runs one of the self-contained core functions against the iframe's window, as if it had
 * been injected into that page (the same way Playwright's page.evaluate() runs it).
 */
export function runIn(win, fn, arg) {
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(...GLOBALS, `return (${fn.toString()});`);
    const bound = factory(
      win,
      win.document,
      win.getComputedStyle.bind(win),
      win.CSS,
      win.CSSRule,
      win.NodeFilter,
      win.DOMMatrixReadOnly,
      win.setTimeout.bind(win),
      win.clearTimeout.bind(win),
      win.performance,
    );
    return bound(arg);
  } catch (e) {
    if (!(e instanceof EvalError) && !/unsafe-eval|Content Security/i.test(e.message)) throw e;
    // The panel's CSP doesn't allow new Function(): run the function inside the page instead.
    // EDS pages allow scripts with the "aem" nonce.
    const doc = win.document;
    const s = doc.createElement('script');
    s.setAttribute('nonce', 'aem');
    s.textContent = `window.pcRun = ${fn.toString()};`;
    doc.head.append(s);
    s.remove();
    if (typeof win.pcRun !== 'function') throw new Error('This page can\'t be read from the panel (blocked by its security policy).');
    return win.pcRun(arg);
  }
}

function host() {
  return document.getElementById('pc-frames') || document.body;
}

/** Loads a same-origin page in an iframe of the given viewport size. */
export async function openFrame(url, {
  width, height = 900, timeout = 45000, parent = host(), className = '',
}) {
  const iframe = document.createElement('iframe');
  iframe.className = className;
  iframe.width = String(width);
  iframe.height = String(height);
  iframe.title = `This page at ${width}px`;
  iframe.style.width = `${width}px`;
  iframe.style.height = `${height}px`;
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`This page took longer than ${Math.round(timeout / 1000)} s to load.`)), timeout);
    iframe.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  iframe.src = url;
  parent.append(iframe);
  await loaded;
  try {
    if (!iframe.contentWindow.document.body) throw new Error('empty');
  } catch (e) {
    iframe.remove();
    throw new Error('This page can\'t be read from the panel: it isn\'t on the same site as the panel.');
  }
  return iframe;
}

/**
 * Waits for an Edge Delivery page to finish loading (sections, delayed phase, fonts, images),
 * then reads its elements and styles. Same steps as the PR's capture.js, inside the browser.
 */
export async function readFrame(iframe, { hideSelectors = [], maxHeight = 12000 } = {}) {
  const win = iframe.contentWindow;
  const doc = win.document;
  await waitUntil(() => doc.readyState === 'complete' && win.performance.now() > 4500, 9000);
  await waitUntil(() => ![...doc.querySelectorAll('main .section')]
    .some((s) => s.dataset.sectionStatus && s.dataset.sectionStatus !== 'loaded'), 6000);
  doc.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
  await runIn(win, autoScroll, { maxHeight });
  await waitUntil(() => [...doc.images].every((img) => img.complete), 4000);
  if (!doc.getElementById('__pc-freeze')) {
    const style = doc.createElement('style');
    style.id = '__pc-freeze';
    style.textContent = FREEZE_CSS;
    doc.head.append(style);
  }
  try { await doc.fonts.ready; } catch (e) { /* ignore */ }
  await sleep(400);
  const data = runIn(win, extractPage, { hideSelectors });
  const nav = win.performance.getEntriesByType('navigation')[0];
  data.status = nav?.responseStatus || 200;
  data.failedRequests = win.performance.getEntriesByType('resource')
    .filter((e) => e.responseStatus >= 400)
    .slice(0, 30)
    .map((e) => ({ url: e.name, status: e.responseStatus }));
  data.consoleErrors = [];
  data.truncated = data.height > maxHeight;
  data.media = runIn(win, collectMediaFromCssom);
  return data;
}

/** Opens, reads and closes: one width of the migrated page. */
export async function capturePage(url, { width, height, hideSelectors, maxHeight }) {
  const iframe = await openFrame(url, { width, height });
  try {
    return await readFrame(iframe, { hideSelectors, maxHeight });
  } finally {
    iframe.remove();
  }
}
