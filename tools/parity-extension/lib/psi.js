/*
 * Google PageSpeed Insights (Lighthouse) for the original and the migrated page,
 * reduced to what an author needs: did the migration make any check worse?
 * API: https://developers.google.com/speed/docs/insights/v5/get-started
 */

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
export const CATEGORIES = [
  ['performance', 'Performance'],
  ['accessibility', 'Accessibility'],
  ['best-practices', 'Best Practices'],
  ['seo', 'SEO'],
];
const METRICS = [
  ['largest-contentful-paint', 'Largest Contentful Paint', 'ms'],
  ['cumulative-layout-shift', 'Cumulative Layout Shift', ''],
  ['total-blocking-time', 'Total Blocking Time', 'ms'],
  ['first-contentful-paint', 'First Contentful Paint', 'ms'],
  ['speed-index', 'Speed Index', 'ms'],
];
const PASS = 0.9;

/** PageSpeed Insights runs on Google's servers, so it can only reach public pages. */
export function isPublicUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (!/^https?:$/.test(protocol)) return false;
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.localhost')) return false;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/.test(hostname)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function friendlyError(status, body) {
  const msg = body?.error?.message || '';
  if (status === 429) {
    return /per day/i.test(msg)
      ? 'The shared PageSpeed Insights quota is used up for today. Add your own free API key in Settings to run the Lighthouse comparison.'
      : 'PageSpeed Insights is getting too many requests. Add your own free API key in Settings, or try again in a minute.';
  }
  if (status === 400 && /API key/i.test(msg)) return 'The PageSpeed Insights API key in the extension options is not valid.';
  if (status === 403) return 'The PageSpeed Insights API key is not allowed to call the API (enable "PageSpeed Insights API" for it in Google Cloud).';
  if (/FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|NO_FCP|DNS_FAILURE/.test(msg)) return 'Lighthouse could not load this page from Google\'s servers. It must be publicly reachable.';
  return msg ? msg.replace(/^Lighthouse returned error: /, '') : `PageSpeed Insights answered ${status}.`;
}

export async function runPsi(url, { strategy = 'mobile', key = '', signal } = {}) {
  const q = new URLSearchParams({ url, strategy });
  CATEGORIES.forEach(([id]) => q.append('category', id.toUpperCase().replace('-', '_')));
  if (key) q.set('key', key);
  const res = await fetch(`${ENDPOINT}?${q}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.lighthouseResult) throw new Error(friendlyError(res.status, body));
  return body.lighthouseResult;
}

const scored = (a) => a && ['binary', 'numeric', 'metricSavings'].includes(a.scoreDisplayMode) && typeof a.score === 'number';

/** Elements Lighthouse names for a failing audit (selector + snippet). */
function nodesOf(audit) {
  const out = [];
  const visit = (items) => (items || []).forEach((it) => {
    if (out.length >= 6) return;
    const node = it.node || (it.type === 'node' ? it : null);
    if (node?.selector) out.push({ selector: node.selector, snippet: node.snippet || '', label: node.nodeLabel || '' });
    if (it.subItems?.items) visit(it.subItems.items);
  });
  visit(audit?.details?.items);
  return out;
}

const plain = (md = '') => md.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`/g, '').trim();
const learnMore = (md = '') => (md.match(/\[Learn[^\]]*\]\(([^)]+)\)/i) || [])[1] || null;

/**
 * Compares two Lighthouse results. A regression is a check that passes on the
 * original (or isn't applicable there) and fails on the migrated page.
 */
export function comparePsi(orig, mig) {
  const categories = CATEGORIES.map(([id, title]) => {
    const o = orig.categories[id]?.score;
    const m = mig.categories[id]?.score;
    const pct = (s) => (typeof s === 'number' ? Math.round(s * 100) : null);
    return {
      id, title, o: pct(o), m: pct(m), delta: pct(m) !== null && pct(o) !== null ? pct(m) - pct(o) : null,
    };
  });

  const regressions = [];
  const improvements = [];
  const seen = new Set();
  CATEGORIES.forEach(([cat, catTitle]) => {
    (mig.categories[cat]?.auditRefs || []).forEach((ref) => {
      if (ref.group === 'metrics' || seen.has(ref.id)) return; // metrics are listed separately
      seen.add(ref.id);
      const ma = mig.audits[ref.id];
      const oa = orig.audits[ref.id];
      if (!scored(ma)) return;
      const oPass = !scored(oa) || oa.score >= PASS;
      const mPass = ma.score >= PASS;
      const entry = {
        id: ref.id,
        category: cat,
        categoryTitle: catTitle,
        title: plain(ma.title),
        description: plain(ma.description).replace(/Learn (more|how)[^.]*\.?$/i, '').trim(),
        link: learnMore(ma.description),
        display: ma.displayValue || '',
        weight: ref.weight || 0,
        oScore: scored(oa) ? oa.score : null,
        mScore: ma.score,
        nodes: nodesOf(ma),
      };
      if (oPass && !mPass) regressions.push(entry);
      if (!oPass && mPass) improvements.push(entry);
    });
  });
  const order = { accessibility: 0, seo: 1, 'best-practices': 2, performance: 3 };
  regressions.sort((a, b) => order[a.category] - order[b.category] || b.weight - a.weight);

  const metrics = METRICS.map(([id, title, unit]) => {
    const o = orig.audits[id];
    const m = mig.audits[id];
    if (!o || !m) return null;
    return {
      id,
      title,
      unit,
      o: o.displayValue,
      m: m.displayValue,
      oValue: o.numericValue,
      mValue: m.numericValue,
      oScore: o.score,
      mScore: m.score,
      worse: typeof m.numericValue === 'number' && typeof o.numericValue === 'number'
        && m.numericValue > o.numericValue * 1.1 && (m.score ?? 1) < (o.score ?? 1),
    };
  }).filter(Boolean);

  return {
    categories,
    regressions,
    improvements,
    metrics,
    fetched: { o: orig.fetchTime, m: mig.fetchTime },
    lighthouseVersion: mig.lighthouseVersion,
  };
}
