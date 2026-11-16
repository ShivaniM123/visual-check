/**
 * Captures the original page with Cloudflare Browser Run (Cloudflare's headless browser in the
 * cloud), through the site's capture Worker (../worker/capture-worker.js, free plan).
 * One browser session per capture: every width, with the parity data read in the page by
 * capture-fn.js and a screenshot per width. The Worker passes the results on as text and the
 * panel unpacks them.
 */
export { pickWidths } from './capture-fn.js';

function friendly(status, body) {
  const code = body?.error || '';
  if (code === 'browser-rate') {
    return 'Cloudflare is still busy with the previous capture (the free plan opens one new browser every 20 seconds). Wait a few seconds and check again.';
  }
  if (code === 'browser-quota' || status === 429) {
    return 'Cloudflare\'s free browser time for today is used up (10 minutes a day). Re-checks of originals you already captured still work; new captures work again tomorrow.';
  }
  if (code === 'not-configured') return 'The capture Worker has no Browser Run binding yet. Add one named BROWSER to it (see worker/README.md).';
  if (code === 'blocked-url') return 'That address can\'t be captured: it must be a public http(s) page.';
  if (code === 'core-unavailable') return 'The capture Worker couldn\'t read the parity code from the site. Make sure this branch is pushed, then try again.';
  if (code === 'forbidden-origin') return 'The capture Worker only answers this site\'s pages.';
  if (code === 'timeout' || status === 504) return 'The original page took too long in the cloud browser. Try again, or with fewer breakpoints.';
  return body?.message ? `Capture service: ${body.message}` : `The capture service answered ${status}.`;
}

/** Is the capture Worker reachable? Resolves to its info, or throws. */
export async function checkService(service) {
  const res = await fetch(service.replace(/\/$/, ''), { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.service !== 'parity-check-capture') throw new Error('That address isn\'t a Parity Check capture Worker.');
  return body;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const unpack = (body) => {
  const pages = body.widths.map((w) => ({ ...w, page: JSON.parse(w.page) }));
  const first = pages[0]?.page || {};
  return {
    url: first.url,
    title: first.title,
    status: first.status,
    media: body.media ? JSON.parse(body.media).media : null,
    widths: pages.map((w) => ({
      width: w.width, data: w.page.data, shot: w.shot, shotScale: w.shotScale, shotHeight: w.shotHeight,
    })),
    browserMs: body.browserMs,
    capturedAt: Date.now(),
  };
};

/**
 * Captures a page at the given widths ([] = its own breakpoints), and optionally a second page
 * (`also`) in the same browser session at the same widths. Resolves to
 * { url, title, status, media, widths: [{ width, data, shot, ... }], also: <same, or null> }.
 * The free plan opens one new browser every 20 seconds: when Cloudflare says so, it waits and retries.
 */
export async function captureOriginal(url, {
  service, ref = 'main', widths = [], hideSelectors = [], height = 900, maxHeight = 8000, quality = 60, scale = 0.75,
  also = null, log = () => {}, signal,
} = {}) {
  if (!service) {
    throw new Error('The cloud capture isn\'t set up yet. Add the capture Worker\'s address in Settings, or to the library row as ?service=… (see worker/README.md).');
  }
  log(`Capturing ${also ? 'both pages' : 'the page'} ${widths.length ? `at ${widths.join(', ')}px` : 'at the original\'s breakpoints'} in Cloudflare's cloud browser (about 10 s per width${also ? ' and page' : ''})`);
  let res;
  let body;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(`${service.replace(/\/$/, '')}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url, also, ref, widths, hideSelectors, height, maxHeight, quality, scale,
        }),
        signal,
      });
    } catch (e) {
      throw new Error('The capture Worker couldn\'t be reached. Check its address in Settings, or your network.');
    }
    // eslint-disable-next-line no-await-in-loop
    body = await res.json().catch(() => null);
    // older Workers say "quota" for every 429: only the daily limit mentions the time used
    const rate = body?.error === 'browser-rate' || (res.status === 429 && !/time limit|browser hours|daily|per day/i.test(body?.message || ''));
    if (res.status !== 429 || !rate || attempt === 2) break;
    const wait = Math.min(30, Number(body?.retryAfter) || 20) + 1;
    log(`Cloudflare opens one new browser every 20 seconds on the free plan: waiting ${wait} s`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(wait * 1000);
    log(`Capturing ${also ? 'both pages' : 'the page'} in Cloudflare's cloud browser`);
  }
  if (!res.ok || !Array.isArray(body?.widths)) {
    const rate = res.status === 429 && !/time limit|browser hours|daily|per day/i.test(body?.message || '');
    throw new Error(friendly(res.status, rate ? { ...body, error: 'browser-rate' } : body));
  }
  const out = unpack(body);
  out.url = out.url || url;
  out.also = body.also ? { ...unpack(body.also), url: also } : null;
  return out;
}
