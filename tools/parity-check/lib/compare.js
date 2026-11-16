/**
 * One parity check of the open page, the way the PR's run.js does it: both pages are opened in
 * the same browser with the same settings (Cloudflare Browser Run, through the capture Worker),
 * at every breakpoint, then compared with the PR's rules and pixel diff. Both pages are captured
 * fresh for every check, at the same moment, so the result never depends on an older copy.
 */
import { matchElements } from './match.js';
import { analyzeWidth } from './rules.js';
import { boundariesFromCondition, clusterBoundaries, suggestBreakpoints } from './breakpoints.js';
import { capturePage } from './frame.js';
import { captureOriginal, pickWidths } from './cloud.js';
import { diffScreenshots } from './diff.js';
import { sectionsOf, sectionFor } from './sections.js';
import { pairShortEdits, nameShortEdits } from './edits.js';

const MAX_HEIGHT = 10000;
// full-size screenshots, so the pixel diff compares the same pixels the PR does
const SHOT = { scale: 1, quality: 90 };

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
 * Without screenshots of both pages (a page read in the panel), the visual share of the score
 * is the layout similarity of the matched elements (position and width).
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

const shotOf = (w) => (w.shot ? {
  src: `data:image/jpeg;base64,${w.shot}`, scale: w.shotScale || 1, height: w.shotHeight,
} : null);

/** A page on this same site (demo pages, local tests): read it in the panel. */
async function captureLocally(url, { widths, hideSelectors, log, label }) {
  let list = widths;
  if (!list.length) {
    const probe = await capturePage(url, { width: 1280, hideSelectors, maxHeight: MAX_HEIGHT });
    list = pickWidths(probe.media.conditions);
  }
  const out = { url, widths: [], capturedAt: Date.now(), local: true };
  // eslint-disable-next-line no-restricted-syntax
  for (const width of list) {
    log(`Reading ${label} at ${width}px`);
    // eslint-disable-next-line no-await-in-loop
    const data = await capturePage(url, { width, hideSelectors, maxHeight: MAX_HEIGHT });
    out.widths.push({ width, data, shot: null });
    out.title = data.title;
    out.status = data.status;
    out.media = data.media;
  }
  return out;
}

const local = (url, cloud) => !cloud && new URL(url).origin === window.location.origin;

export function getOriginal(url, {
  widths, hideSelectors, service, ref, log, cloud = false,
}) {
  return local(url, cloud)
    ? captureLocally(url, {
      widths, hideSelectors, log, label: 'the original',
    })
    : captureOriginal(url, {
      service, ref, widths, hideSelectors, maxHeight: MAX_HEIGHT, log, ...SHOT,
    });
}

/** This page: in the cloud like the original when it's public, otherwise read in the panel. */
function getMigrated({
  cloudUrl, renderUrl, widths, hideSelectors, service, ref, log,
}) {
  if (cloudUrl && service) {
    return captureOriginal(cloudUrl, {
      service,
      ref,
      widths,
      hideSelectors,
      maxHeight: MAX_HEIGHT,
      ...SHOT,
      log: () => log(`Capturing this page at ${widths.join(', ')}px in Cloudflare's cloud browser`),
    });
  }
  return captureLocally(renderUrl, {
    widths, hideSelectors, log, label: 'this page',
  });
}

export async function runCheck({
  original, migrated, renderUrl, migratedCloudUrl = null, service, ref, cloud = false, widths = [],
  hideSelectors = [], log = () => {},
}) {
  log('Opening both pages');
  const migOpts = {
    cloudUrl: migratedCloudUrl, renderUrl, hideSelectors, service, ref, log,
  };
  let orig;
  let mig;
  const bothInCloud = migratedCloudUrl && service && !local(original, cloud);
  if (bothInCloud) {
    // one browser session for both pages (the free plan opens one new browser every 20 s)
    const both = await captureOriginal(original, {
      service, ref, widths, hideSelectors, maxHeight: MAX_HEIGHT, also: migratedCloudUrl, log, ...SHOT,
    });
    const { also, ...first } = both;
    orig = first;
    // an older Worker reads one page per call: then this page is captured on its own
    mig = also || await getMigrated({ ...migOpts, widths: orig.widths.map((w) => w.width) });
  } else if (widths.length) {
    // both at once: the widths are known
    [orig, mig] = await Promise.all([
      getOriginal(original, {
        widths, hideSelectors, service, ref, log, cloud,
      }),
      getMigrated({ ...migOpts, widths }),
    ]);
  } else {
    orig = await getOriginal(original, {
      widths, hideSelectors, service, ref, log, cloud,
    });
    mig = await getMigrated({ ...migOpts, widths: orig.widths.map((w) => w.width) });
  }
  if (orig.status >= 400) throw new Error(`The original page answered ${orig.status}. Check its address.`);
  if (mig.status >= 400) throw new Error(`This page answered ${mig.status}. Preview it once, then check again.`);

  const report = {
    id: `${Date.now()}`,
    created: new Date().toISOString(),
    original,
    migrated,
    widths: orig.widths.map((w) => w.width),
    originalCapturedAt: orig.capturedAt,
    originalLocal: !!orig.local,
    migratedSource: mig.local ? 'panel' : 'cloud',
    migratedCaptured: migratedCloudUrl && !mig.local ? migratedCloudUrl : renderUrl,
    results: [],
  };
  report.breakpoints = breakpointsOf(orig.media?.conditions).suggested;
  // a page that loads without its styles (its CSS and scripts missing at that address) makes
  // every element look different: say so, rather than only listing the differences
  const unstyled = (cap, url) => {
    const d = cap.widths[0]?.data;
    if (!d) return false;
    const sheets = cap.media?.sheetCount ?? 99;
    const eds = /--[a-z0-9-]+--[a-z0-9-]+\.(aem|hlx)\.(page|live)$/i.test(new URL(url).hostname);
    return (sheets <= 1 && !(cap.media?.conditions || []).length && !(d.fonts || []).length) || (eds && !d.isEds);
  };
  report.warnings = [];
  if (unstyled(orig, original)) report.warnings.push({ page: 'original', url: original });
  if (unstyled(mig, migratedCloudUrl || renderUrl)) report.warnings.push({ page: 'migrated', url: migratedCloudUrl || renderUrl });

  // eslint-disable-next-line no-restricted-syntax
  for (const ow of orig.widths) {
    const { width } = ow;
    const mw = mig.widths.find((w) => w.width === width);
    if (!mw) continue; // eslint-disable-line no-continue
    log(`Comparing at ${width}px`);
    const o = ow.data;
    const m = mw.data;
    const match = matchElements(o.elements, m.elements, { origHeight: o.height, migHeight: m.height });
    // short texts edited in place (a number, a button label) are compared as one element
    const edits = pairShortEdits(match);
    const oShot = shotOf(ow);
    const mShot = shotOf(mw);
    const diff = oShot && mShot
      // eslint-disable-next-line no-await-in-loop
      ? await diffScreenshots(oShot.src, mShot.src, { threshold: 0.1 })
      : { similarity: layoutSimilarity(match, width), shots: null, regions: [] };
    const analysis = analyzeWidth({
      width, orig: o, mig: m, match, diff,
    });
    nameShortEdits(analysis.issues, edits);
    const sections = sectionsOf(m);
    analysis.issues.forEach((i) => { i.section = sectionFor(i, sections); });
    report.results.push({
      width,
      score: analysis.score,
      stats: analysis.stats,
      issues: analysis.issues,
      sections: sections.map(({
        key, label, top, bottom,
      }) => ({
        key, label, top, bottom,
      })),
      anchors: thin(match.anchors),
      regions: diff.regions,
      pixelDiff: !!diff.shots,
      shot: oShot,
      mshot: mShot,
      page: { o: pageMeta(o), m: pageMeta(m) },
    });
  }

  const migBps = breakpointsOf(mig.media?.conditions);
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
