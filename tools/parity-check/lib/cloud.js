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
  if (code === 'browser-quota' || status === 429) {
    return 'Cloudflare\'s free browser time is used up for now (10 minutes a day, 3 browsers at a time). Re-checks of originals you already captured still work; try a new capture later.';
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

/**
 * Captures the original at the given widths ([] = its own breakpoints).
 * Resolves to { url, title, status, media, widths: [{ width, data, shot, shotScale, shotHeight }] }.
 */
export async function captureOriginal(url, {
  service, ref = 'main', widths = [], hideSelectors = [], height = 900, maxHeight = 8000, quality = 55,
  log = () => {}, signal,
} = {}) {
  if (!service) {
    throw new Error('The cloud capture isn\'t set up yet. Add the capture Worker\'s address in Settings, or to the library row as ?service=… (see worker/README.md).');
  }
  log(`Capturing the original ${widths.length ? `at ${widths.join(', ')}px` : 'at its breakpoints'} in Cloudflare's cloud browser (about 10 s per width)`);
  let res;
  try {
    res = await fetch(`${service.replace(/\/$/, '')}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url, ref, widths, hideSelectors, height, maxHeight, quality,
      }),
      signal,
    });
  } catch (e) {
    throw new Error('The capture Worker couldn\'t be reached. Check its address in Settings, or your network.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body?.widths)) throw new Error(friendly(res.status, body));
  const pages = body.widths.map((w) => ({ ...w, page: JSON.parse(w.page) }));
  const first = pages[0]?.page || {};
  return {
    url: first.url || url,
    title: first.title,
    status: first.status,
    media: body.media ? JSON.parse(body.media).media : null,
    widths: pages.map((w) => ({
      width: w.width, data: w.page.data, shot: w.shot, shotScale: w.shotScale, shotHeight: w.shotHeight,
    })),
    browserMs: body.browserMs,
    capturedAt: Date.now(),
  };
}
