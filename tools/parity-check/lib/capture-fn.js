/* global extractPage, autoScroll, collectMediaFromCssom */
/**
 * Runs inside the original page, in Cloudflare's cloud browser (Browser Run,
 * https://developers.cloudflare.com/browser-run/). The browser can't read another site's pages,
 * so the capture Worker (../worker/capture-worker.js) opens the original in Cloudflare's browser
 * and adds this file, after extract.js, both read from this site. It does what the PR's
 * capture.js does with Playwright: waits for late content, scrolls so lazy content loads,
 * freezes animations, then reads the page with the parity core.
 */

/**
 * The original's breakpoints from its media queries (the same reading as breakpoints.js),
 * used when the author leaves widths on "Auto". Also used by the panel for same-site originals.
 */
export function pickWidths(conditions) {
  const UNIT = { px: 1, em: 16, rem: 16 };
  const values = [];
  (conditions || []).forEach((cond) => {
    const c = String(cond).toLowerCase();
    let m;
    const minRe = /min-width\s*:\s*([\d.]+)(px|em|rem)/g;
    const maxRe = /max-width\s*:\s*([\d.]+)(px|em|rem)/g;
    const rangeRe = /(?:^|[(\s])width\s*(>=|<=|>|<)\s*([\d.]+)(px|em|rem)/g;
    // eslint-disable-next-line no-cond-assign
    while ((m = minRe.exec(c))) values.push(Math.round(parseFloat(m[1]) * UNIT[m[2]]));
    // eslint-disable-next-line no-cond-assign
    while ((m = maxRe.exec(c))) values.push(Math.floor(parseFloat(m[1]) * UNIT[m[2]]) + 1);
    // eslint-disable-next-line no-cond-assign
    while ((m = rangeRe.exec(c))) {
      const v = parseFloat(m[2]) * UNIT[m[3]];
      values.push(m[1] === '>=' || m[1] === '<' ? Math.round(v) : Math.floor(v) + 1);
    }
  });
  const clusters = [];
  values.filter((v) => v >= 320 && v <= 1920).forEach((px) => {
    const near = clusters.find((cl) => Math.abs(cl.px - px) <= 2);
    if (near) near.count += 1;
    else clusters.push({ px, count: 1 });
  });
  const picked = clusters
    .filter((cl) => cl.count >= 2 || clusters.length <= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((cl) => cl.px)
    .sort((a, b) => a - b);
  if (!picked.length) return [390, 768, 1280];
  // a breakpoint is where a layout starts: add a phone width so the smallest layout is tested too
  return picked[0] > 480 ? [390, ...picked] : picked;
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * No scrollbar, as in the PR's browser (--hide-scrollbars): the page is laid out at the full
 * viewport width, so a 900px check really is 900px wide for the page's media queries.
 */
function hideScrollbars() {
  if (document.getElementById('__pc-noscroll')) return;
  const style = document.createElement('style');
  style.id = '__pc-noscroll';
  style.textContent = 'html { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }';
  (document.head || document.documentElement).append(style);
}

/** Waits for the page to load and for Edge Delivery's delayed phase (~3 s after load). */
async function settled() {
  for (let i = 0; i < 60 && (document.readyState !== 'complete' || performance.now() < 4500); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await wait(200);
  }
}

/** The page's media queries, including cross-origin stylesheets (read as text). */
export async function captureMedia() {
  hideScrollbars();
  await settled();
  const media = collectMediaFromCssom();
  await Promise.all([...new Set(media.unreadable || [])].slice(0, 10).map(async (href) => {
    try {
      const text = await (await fetch(href)).text();
      (text.match(/@media[^{]+/g) || []).forEach((m) => media.conditions.push(m.slice(6)));
    } catch (e) { /* not readable */ }
  }));
  return media;
}

/** Reads the page at the current viewport width. */
export default async function capturePage(opts) {
  const A = { hideSelectors: [], maxHeight: 10000, ...opts };
  hideScrollbars();
  await settled();
  if (!document.getElementById('__pc-freeze')) {
    const style = document.createElement('style');
    style.id = '__pc-freeze';
    style.textContent = [
      '*, *::before, *::after { transition: none !important; animation-play-state: paused !important; caret-color: transparent !important; scroll-behavior: auto !important; }',
      ...A.hideSelectors.map((s) => `${s} { display: none !important; }`),
    ].join('\n');
    document.head.append(style);
  }
  await autoScroll({ maxHeight: A.maxHeight });
  try { await document.fonts.ready; } catch (e) { /* ignore */ }
  await wait(300);
  const data = extractPage({ hideSelectors: A.hideSelectors });
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    url: window.location.href,
    title: document.title,
    status: nav?.responseStatus || 0,
    data,
  };
}
