/**
 * Captures the original page with Browserless (https://www.browserless.io), a hosted Chrome.
 * The panel calls the site's capture Worker (../worker/capture-worker.js, free on Cloudflare),
 * which keeps the Browserless key secret and runs this site's capture (capture-fn.js) in
 * Browserless: element data and a screenshot of the original at every width, in one session.
 */
export { pickWidths } from './capture-fn.js';

function friendly(status, body) {
  const code = body?.error || '';
  if (code === 'browserless-quota' || status === 429) {
    return 'The free Browserless units for this month are used up. Re-checks of originals you already captured still work.';
  }
  if (code === 'browserless-auth') return 'Browserless didn\'t accept the key saved in the capture Worker. Check its BROWSERLESS_TOKEN secret.';
  if (code === 'not-configured') return 'The capture Worker has no Browserless key yet. Add the BROWSERLESS_TOKEN secret to it (see worker/README.md).';
  if (code === 'timeout' || status === 408 || status === 504) return 'The original page took too long to open in the cloud browser. Try fewer breakpoints, or try again.';
  if (code === 'blocked-url') return 'That address can\'t be captured: it must be a public http(s) page.';
  if (code === 'core-unavailable') return 'The capture Worker couldn\'t read the parity code from the site. Make sure this branch is pushed, then try again.';
  if (code === 'capture-failed') return `The original page couldn't be read in the cloud browser: ${body.message || 'unknown error'}.`;
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
  service, ref = 'main', widths = [], hideSelectors = [],
  height = 900, maxHeight = 10000, scale = 0.5, quality = 60, signal,
} = {}) {
  if (!service) {
    throw new Error('The cloud capture isn\'t set up yet. Add the capture Worker\'s address in Settings, or to the library row as ?service=… (see worker/README.md).');
  }
  let res;
  try {
    res = await fetch(`${service.replace(/\/$/, '')}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url, ref, widths, hideSelectors, height, maxHeight, scale, quality,
      }),
      signal,
    });
  } catch (e) {
    throw new Error('The capture Worker couldn\'t be reached. Check its address in Settings, or your network.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body?.widths)) throw new Error(friendly(res.status, body));
  body.capturedAt = Date.now();
  return body;
}
