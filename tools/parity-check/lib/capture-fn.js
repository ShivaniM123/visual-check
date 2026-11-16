/* global extractPage, autoScroll, collectMediaFromCssom */
/**
 * Runs inside the original page, in Cloudflare's cloud browser (Browser Run,
 * https://developers.cloudflare.com/browser-run/). The browser can't read another site's pages,
 * so Cloudflare opens the original at one width and the capture Worker
 * (../worker/capture-worker.js) adds this script to it, after extract.js, both read from this site.
 *
 * It does what the PR's capture.js does with Playwright: waits for late content, scrolls so lazy
 * content loads, freezes animations, then reads the page with the parity core. The result is
 * written into the page as JSON (#__pc-data), and #__pc-done tells Cloudflare it can take the
 * snapshot (rendered HTML + full-page screenshot).
 */
export default async function capturePage(opts) {
  const A = {
    hideSelectors: [], maxHeight: 10000, ...opts,
  };
  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const done = (attrs) => {
    const el = document.createElement('div');
    el.id = '__pc-done';
    el.hidden = true;
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(`data-${k}`, String(v)));
    (document.body || document.documentElement).append(el);
  };
  try {
    // Edge Delivery loads late widgets about 3 s after load (delayed.js): read the page after that
    for (let i = 0; i < 45 && (document.readyState !== 'complete' || performance.now() < 4500); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await wait(200);
    }
    const style = document.createElement('style');
    style.textContent = [
      '*, *::before, *::after { transition: none !important; animation-play-state: paused !important; caret-color: transparent !important; scroll-behavior: auto !important; }',
      ...A.hideSelectors.map((s) => `${s} { display: none !important; }`),
    ].join('\n');
    document.head.append(style);
    await autoScroll({ maxHeight: A.maxHeight });
    try { await document.fonts.ready; } catch (e) { /* ignore */ }
    await wait(300);

    const data = extractPage({ hideSelectors: A.hideSelectors });
    const media = collectMediaFromCssom();
    // cross-origin stylesheets (CDNs) can't be read through the CSSOM: read their text instead
    await Promise.all([...new Set(media.unreadable || [])].slice(0, 10).map(async (href) => {
      try {
        const text = await (await fetch(href)).text();
        (text.match(/@media[^{]+/g) || []).forEach((m) => media.conditions.push(m.slice(6)));
      } catch (e) { /* not readable */ }
    }));
    const nav = performance.getEntriesByType('navigation')[0];
    const out = {
      url: window.location.href,
      title: document.title,
      status: nav?.responseStatus || 0,
      media,
      data,
    };
    const holder = document.createElement('script');
    holder.type = 'application/json';
    holder.id = '__pc-data';
    holder.textContent = JSON.stringify(out).replace(/</g, '\\u003c');
    document.body.append(holder);
    done({ ok: 1 });
  } catch (e) {
    done({ error: e.message || String(e) });
  }
}
