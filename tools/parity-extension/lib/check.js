/*
 * One parity check of the page open in the current tab against its original,
 * at the width the author is looking at.
 */
import { autoScroll, extractPage, collectMediaFromCssom } from './extract.js';
import { matchElements } from './match.js';
import { analyzeWidth } from './rules.js';
import { boundariesFromCondition, clusterBoundaries, suggestBreakpoints } from './breakpoints.js';
import {
  pageState, settlePage, unsettlePage, failedRequests, scrollToY, clearPins,
} from './page.js';

const MAX_HEIGHT = 12000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function exec(tabId, func, arg) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: arg === undefined ? [] : [arg],
  });
  return res?.result;
}

function waitForComplete(tabId, timeout = 45000) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      // eslint-disable-next-line no-use-before-define
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      fn(v);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(resolve);
    };
    timer = setTimeout(() => finish(reject, new Error('The original page took longer than 45 s to load.')), timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(resolve); }).catch((e) => finish(reject, e));
  });
}

/** Waits until EDS's delayed phase (~3 s after load) has run, so late widgets are in. */
async function waitForUptime(tabId, ms = 5000) {
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const s = await exec(tabId, pageState).catch(() => null);
    if (s && s.readyState === 'complete' && s.uptime > ms) return s;
    // eslint-disable-next-line no-await-in-loop
    await sleep(300);
  }
  return exec(tabId, pageState);
}

/** Media-query boundaries from the page's stylesheets, cross-origin ones fetched here. */
async function breakpointsOf(tabId) {
  const css = await exec(tabId, collectMediaFromCssom).catch(() => null);
  if (!css) return { clusters: [], suggested: [] };
  const conditions = [...css.conditions];
  await Promise.all([...new Set(css.unreadable)].slice(0, 12).map(async (href) => {
    try {
      const text = await (await fetch(href)).text();
      [...text.matchAll(/@media([^{]+)\{/g)].forEach((m) => conditions.push(m[1]));
    } catch (e) { /* unreachable stylesheet */ }
  }));
  const clusters = clusterBoundaries(conditions.flatMap(boundariesFromCondition));
  return { clusters, suggested: suggestBreakpoints(clusters) };
}

/** Scrolls (so lazy content renders), settles and reads the page's elements and styles. */
async function readPage(tabId, { hideSelectors, restore }) {
  const before = await exec(tabId, pageState);
  await exec(tabId, clearPins);
  await exec(tabId, autoScroll, { maxHeight: MAX_HEIGHT });
  await exec(tabId, settlePage, { waitMs: 600 });
  const data = await exec(tabId, extractPage, { hideSelectors });
  if (!data) throw new Error('Could not read the page.');
  data.failedRequests = await exec(tabId, failedRequests).catch(() => []) || [];
  data.consoleErrors = [];
  data.truncated = data.height > MAX_HEIGHT;
  data.innerWidth = before.innerWidth;
  data.breakpoints = await breakpointsOf(tabId);
  if (restore) {
    await exec(tabId, unsettlePage);
    await exec(tabId, scrollToY, { y: before.scrollY });
  }
  return data;
}

/** Opens the original in a popup window over the current one, sized to the same viewport width. */
async function readOriginal(url, { windowId, width, hideSelectors, log }) {
  const host = await chrome.windows.get(windowId);
  const popup = await chrome.windows.create({
    url,
    type: 'popup',
    focused: true,
    left: host.left,
    top: host.top,
    width: width + 16,
    height: host.height,
  });
  const tabId = popup.tabs[0].id;
  try {
    log('Loading the original page');
    await waitForComplete(tabId);
    // match the viewport width exactly: window chrome differs per OS
    let state = await exec(tabId, pageState);
    for (let i = 0; i < 3 && state && state.innerWidth !== width; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const w = await chrome.windows.get(popup.id);
      // eslint-disable-next-line no-await-in-loop
      await chrome.windows.update(popup.id, { width: w.width + (width - state.innerWidth) });
      // eslint-disable-next-line no-await-in-loop
      await sleep(350);
      // eslint-disable-next-line no-await-in-loop
      state = await exec(tabId, pageState);
    }
    log('Waiting for late content on the original');
    await waitForUptime(tabId);
    log('Reading the original page');
    const data = await readPage(tabId, { hideSelectors, restore: false });
    return data;
  } catch (e) {
    if (/Cannot access|cannot be scripted|error page/i.test(e.message)) {
      throw new Error('The original page could not be opened. Check the URL, and that you can reach it in this browser.');
    }
    throw e;
  } finally {
    await chrome.windows.remove(popup.id).catch(() => {});
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  }
}

/**
 * Pixel screenshots aren't taken in the extension, so the visual share of the score
 * is the layout similarity of the matched elements (position and width at this width).
 */
function layoutSimilarity(match, width) {
  const pairs = match.matched.filter(({ o, m }) => o.visible && m.visible && o.rect && m.rect);
  if (!pairs.length) return 0;
  const half = Math.max(1, width / 2);
  const s = pairs.reduce((sum, { o, m }) => {
    const d = (Math.abs(o.rect.x - m.rect.x) + Math.abs(o.rect.w - m.rect.w)) / half;
    return sum + (1 - Math.min(1, d));
  }, 0) / pairs.length;
  return Math.round(s * 1000) / 10;
}

const near = (list, v) => list.some((x) => Math.abs(x - v) <= 2);

export async function runCheck({
  tab, original, hideSelectors = [], log = () => {},
}) {
  log('Reading this page');
  const mig = await readPage(tab.id, { hideSelectors, restore: true });
  const width = mig.innerWidth;
  const orig = await readOriginal(original, {
    windowId: tab.windowId, width, hideSelectors, log,
  });

  log('Comparing');
  const match = matchElements(orig.elements, mig.elements, { origHeight: orig.height, migHeight: mig.height });
  const diff = { similarity: layoutSimilarity(match, width), shots: null, regions: [] };
  const analysis = analyzeWidth({
    width, orig, mig, match, diff,
  });

  const origBps = orig.breakpoints.suggested;
  const migBps = mig.breakpoints.clusters.map((c) => c.px);
  const all = analysis.issues;
  return {
    id: `${Date.now()}`,
    created: new Date().toISOString(),
    original,
    migrated: tab.url,
    title: mig.title,
    widths: [width],
    breakpoints: origBps,
    migratedBreakpoints: mig.breakpoints.suggested,
    breakpointMismatch: {
      missingInMigrated: origBps.filter((b) => !near(migBps, b)),
      extraInMigrated: mig.breakpoints.suggested.filter((b) => !near(origBps, b)),
    },
    widthMismatch: orig.innerWidth !== width ? orig.innerWidth : null,
    results: [{
      width,
      score: analysis.score,
      stats: analysis.stats,
      issues: analysis.issues,
      page: {
        o: { title: orig.title, url: orig.url, height: orig.height, isEds: orig.isEds, elements: orig.elements.length },
        m: { title: mig.title, url: mig.url, height: mig.height, isEds: mig.isEds, elements: mig.elements.length },
      },
    }],
    summary: {
      score: analysis.score,
      issues: all.length,
      high: all.filter((i) => i.severity === 'high').length,
      medium: all.filter((i) => i.severity === 'medium').length,
      low: all.filter((i) => i.severity === 'low').length,
    },
  };
}
