/* global extractPage, autoScroll, collectMediaFromCssom */
/**
 * The capture that runs in Browserless's cloud Chrome (https://docs.browserless.io/rest-apis/function).
 * The browser can't read another site's pages, so Browserless opens the original on its servers
 * and does what the PR's capture.js does with Playwright, for every width in one session:
 * element data from the parity core (extract.js) plus a screenshot per width.
 *
 * The Worker (../worker/capture-worker.js) sends Browserless this file with extract.js in front of
 * it, both read from this site, so extractPage, autoScroll and collectMediaFromCssom are in scope.
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

const FREEZE_CSS = '*, *::before, *::after { transition: none !important; animation-play-state: paused !important; caret-color: transparent !important; scroll-behavior: auto !important; }';

/**
 * context: { url, widths ([] = the original's breakpoints), hideSelectors, height, maxHeight,
 *            scale, quality }
 * Returns { url, title, status, media, widths: [{ width, data, shot, shotScale, shotHeight }] }.
 */
export default async function capture({ page, context }) {
  const A = {
    widths: [], hideSelectors: [], height: 900, maxHeight: 10000, scale: 0.5, quality: 60, ...context,
  };
  const wait = (ms) => page.evaluate((t) => new Promise((r) => { setTimeout(r, t); }), ms);

  await page.setViewport({ width: 1280, height: A.height, deviceScaleFactor: 1 });
  let response = null;
  try {
    response = await page.goto(A.url, { waitUntil: 'networkidle2', timeout: 45000 });
  } catch (e) {
    // slow third-party requests: carry on with what has loaded
    if (!page.url() || page.url() === 'about:blank') throw e;
  }
  // Edge Delivery loads late widgets about 3 s after load (delayed.js): capture after that
  try {
    await page.waitForFunction(() => document.readyState === 'complete' && performance.now() > 4500, { timeout: 8000 });
  } catch (e) { /* capture what is there */ }

  const out = {
    url: page.url(), title: await page.title(), status: response ? response.status() : 0, widths: [],
  };
  out.media = await page.evaluate(collectMediaFromCssom);
  // cross-origin stylesheets (CDNs) can't be read through the CSSOM: read their text instead
  const more = await page.evaluate(async (hrefs) => {
    const found = [];
    await Promise.all(hrefs.map(async (h) => {
      try {
        const text = await (await fetch(h)).text();
        (text.match(/@media[^{]+/g) || []).forEach((m) => found.push(m.slice(6)));
      } catch (e) { /* not readable */ }
    }));
    return found;
  }, [...new Set(out.media.unreadable || [])].slice(0, 10)).catch(() => []);
  out.media.conditions.push(...more);

  const widths = A.widths.length ? A.widths : pickWidths(out.media.conditions);
  const css = [FREEZE_CSS, ...A.hideSelectors.map((s) => `${s} { display: none !important; }`)].join('\n');
  await page.evaluate((text) => {
    const s = document.createElement('style');
    s.textContent = text;
    document.head.append(s);
  }, css);

  // one width at a time, in the same browser session
  // eslint-disable-next-line no-restricted-syntax
  for (const width of widths.slice(0, 5)) {
    // eslint-disable-next-line no-await-in-loop
    await page.setViewport({ width, height: A.height, deviceScaleFactor: 1 });
    // eslint-disable-next-line no-await-in-loop
    await wait(600);
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(autoScroll, { maxHeight: A.maxHeight });
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(() => document.fonts.ready.then(() => true));
    // eslint-disable-next-line no-await-in-loop
    await wait(300);
    // eslint-disable-next-line no-await-in-loop
    const data = await page.evaluate(extractPage, { hideSelectors: A.hideSelectors });
    const h = Math.max(1, Math.min(data.height, A.maxHeight));
    // eslint-disable-next-line no-await-in-loop
    const shot = await page.screenshot({
      type: 'jpeg',
      quality: A.quality,
      encoding: 'base64',
      captureBeyondViewport: true,
      clip: {
        x: 0, y: 0, width, height: h, scale: A.scale,
      },
    });
    out.widths.push({
      width, data, shot, shotScale: A.scale, shotHeight: h,
    });
  }
  return { data: out, type: 'application/json' };
}
