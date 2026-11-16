/**
 * One parity check of the open page: the original (Browserless, cached) against the migrated
 * page (rendered in the panel), at every breakpoint. Mirrors the PR's run.js.
 */
import { matchElements } from './match.js';
import { analyzeWidth } from './rules.js';
import { boundariesFromCondition, clusterBoundaries, suggestBreakpoints } from './breakpoints.js';
import { capturePage } from './frame.js';
import { captureOriginal, pickWidths } from './cloud.js';
import { captureKey, getCapture, putCapture } from './store.js';

const MAX_HEIGHT = 10000;

const pageMeta = (d) => ({
  title: d.title,
  url: d.url,
  status: d.status,
  height: d.height,
  overflow: d.overflow,
  truncated: d.truncated,
  isEds: d.isEds,
  elements: d.elements.length,
});

// one anchor per 40px of the original is plenty for scrolling
const thin = (anchors = []) => anchors.reduce((out, a, i) => {
  const last = out[out.length - 1];
  if (!last || a[0] - last[0] >= 40 || (i === anchors.length - 1 && a[0] > last[0])) out.push(a);
  return out;
}, []);

function breakpointsOf(conditions = []) {
  const clusters = clusterBoundaries(conditions.flatMap(boundariesFromCondition));
  return { clusters, suggested: suggestBreakpoints(clusters) };
}

/**
 * No pixel screenshot of the migrated page is taken in the panel, so the visual share of the
 * score is the layout similarity of the matched elements (position and width).
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

/** The original on this same site (demo pages, local tests): read it in the panel too. */
async function captureLocally(url, { widths, hideSelectors, log }) {
  let list = widths;
  if (!list.length) {
    const probe = await capturePage(url, { width: 1280, hideSelectors, maxHeight: MAX_HEIGHT });
    list = pickWidths(probe.media.conditions);
  }
  const out = { url, widths: [], capturedAt: Date.now(), local: true };
  // eslint-disable-next-line no-restricted-syntax
  for (const width of list) {
    log(`Reading the original at ${width}px`);
    // eslint-disable-next-line no-await-in-loop
    const data = await capturePage(url, { width, hideSelectors, maxHeight: MAX_HEIGHT });
    out.widths.push({ width, data, shot: null });
    out.title = data.title;
    out.status = data.status;
    out.media = data.media;
  }
  return out;
}

export async function getOriginal(url, {
  widths, hideSelectors, service, ref, refresh, log, cloud = false,
}) {
  const key = captureKey(url, widths);
  if (!refresh) {
    const cached = await getCapture(key);
    if (cached) return { ...cached, fromCache: true };
  }
  let capture;
  if (!cloud && new URL(url).origin === window.location.origin) {
    capture = await captureLocally(url, { widths, hideSelectors, log });
  } else {
    log(`Capturing the original in Browserless's cloud browser${widths.length ? ` at ${widths.join(', ')}px` : ' at its breakpoints'}`);
    capture = await captureOriginal(url, {
      service, ref, widths, hideSelectors, maxHeight: MAX_HEIGHT,
    });
  }
  await putCapture(key, capture);
  return { ...capture, fromCache: false };
}

export async function runCheck({
  original, migrated, renderUrl, service, ref, cloud = false, widths = [], hideSelectors = [],
  refreshOriginal = false, log = () => {},
}) {
  log('Getting the original page');
  const orig = await getOriginal(original, {
    widths, hideSelectors, service, ref, refresh: refreshOriginal, log, cloud,
  });
  if (orig.status >= 400) throw new Error(`The original page answered ${orig.status}. Check its address.`);

  const report = {
    id: `${Date.now()}`,
    created: new Date().toISOString(),
    original,
    migrated,
    widths: orig.widths.map((w) => w.width),
    originalCapturedAt: orig.capturedAt,
    originalFromCache: orig.fromCache,
    originalLocal: !!orig.local,
    results: [],
  };
  const origBps = breakpointsOf(orig.media?.conditions);
  report.breakpoints = origBps.suggested;

  let migMedia = null;
  // eslint-disable-next-line no-restricted-syntax
  for (const ow of orig.widths) {
    const { width } = ow;
    log(`Rendering this page at ${width}px`);
    // eslint-disable-next-line no-await-in-loop
    const mig = await capturePage(renderUrl, { width, hideSelectors, maxHeight: MAX_HEIGHT });
    if (mig.status >= 400) throw new Error(`This page answered ${mig.status}. Preview it once, then check again.`);
    migMedia = migMedia || mig.media;
    log(`Comparing at ${width}px`);
    const o = ow.data;
    const match = matchElements(o.elements, mig.elements, { origHeight: o.height, migHeight: mig.height });
    const diff = { similarity: layoutSimilarity(match, width), shots: null, regions: [] };
    const analysis = analyzeWidth({
      width, orig: o, mig, match, diff,
    });
    report.results.push({
      width,
      score: analysis.score,
      stats: analysis.stats,
      issues: analysis.issues,
      anchors: thin(match.anchors),
      shot: ow.shot ? { src: `data:image/jpeg;base64,${ow.shot}`, scale: ow.shotScale, height: ow.shotHeight } : null,
      page: { o: pageMeta(o), m: pageMeta(mig) },
    });
  }

  const migBps = breakpointsOf(migMedia?.conditions);
  const near = (list, v) => list.some((x) => Math.abs(x - v) <= 2);
  const migAll = migBps.clusters.map((c) => c.px);
  report.migratedBreakpoints = migBps.suggested;
  report.breakpointMismatch = {
    missingInMigrated: report.breakpoints.filter((b) => !near(migAll, b)),
    extraInMigrated: migBps.suggested.filter((b) => !near(report.breakpoints, b)),
  };
  const all = report.results.flatMap((r) => r.issues);
  report.summary = {
    score: Math.round(report.results.reduce((s, r) => s + r.score, 0) / Math.max(1, report.results.length)),
    issues: all.length,
    high: all.filter((i) => i.severity === 'high').length,
    medium: all.filter((i) => i.severity === 'medium').length,
    low: all.filter((i) => i.severity === 'low').length,
  };
  log('Done');
  return report;
}
