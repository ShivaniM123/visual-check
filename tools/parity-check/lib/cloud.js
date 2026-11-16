/**
 * Captures the original page with Cloudflare Browser Run (Cloudflare's headless browser in the
 * cloud), through the site's capture Worker (../worker/capture-worker.js, free plan).
 * One snapshot per width: the parity data read in the page by capture-fn.js, plus a
 * full-page screenshot. The Worker passes Cloudflare's answer through and the panel reads it.
 */

const CONCURRENCY = 2; // the free plan allows 3 browsers at a time

/**
 * The original's breakpoints from its media queries (the same reading as breakpoints.js),
 * used when the author leaves widths on "Auto".
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

function friendly(status, body) {
  const code = body?.error || '';
  const cfMsg = body?.errors?.[0]?.message || '';
  if (code === 'browser-quota' || status === 429) {
    return 'Cloudflare\'s free browser time for today is used up (10 minutes a day). Re-checks of originals you already captured still work; new captures work again tomorrow.';
  }
  if (code === 'not-configured') return 'The capture Worker has no Browser Run binding yet. Add one named BROWSER to it (see worker/README.md).';
  if (code === 'blocked-url') return 'That address can\'t be captured: it must be a public http(s) page.';
  if (code === 'core-unavailable') return 'The capture Worker couldn\'t read the parity code from the site. Make sure this branch is pushed, then try again.';
  if (code === 'forbidden-origin') return 'The capture Worker only answers this site\'s pages.';
  if (status === 408 || status === 504 || /timeout/i.test(cfMsg)) return 'The original page took too long to open in the cloud browser. Try again, or with fewer breakpoints.';
  const msg = body?.message || cfMsg;
  return msg ? `Capture service: ${msg}` : `The capture service answered ${status}.`;
}

/** Is the capture Worker reachable? Resolves to its info, or throws. */
export async function checkService(service) {
  const res = await fetch(service.replace(/\/$/, ''), { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.service !== 'parity-check-capture') throw new Error('That address isn\'t a Parity Check capture Worker.');
  return body;
}

/** The parity data capture-fn.js wrote into the page, from the snapshot's HTML. */
function readData(content) {
  const m = (content || '').match(/<script[^>]*id="__pc-data"[^>]*>([\s\S]*?)<\/script>/);
  if (m) return JSON.parse(m[1]);
  const err = (content || '').match(/id="__pc-done"[^>]*data-error="([^"]*)"/) || (content || '').match(/data-error="([^"]*)"[^>]*id="__pc-done"/);
  if (err) throw new Error(`The original page couldn't be read in the cloud browser: ${err[1]}.`);
  throw new Error('The original page didn\'t let the capture run (it may block added scripts with a strict security policy). It can\'t be compared automatically.');
}

async function snapshot(service, request, signal) {
  let res;
  try {
    res = await fetch(`${service.replace(/\/$/, '')}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (e) {
    throw new Error('The capture Worker couldn\'t be reached. Check its address in Settings, or your network.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(friendly(res.status, body));
  const page = readData(body.result?.content);
  const shot = body.result?.screenshot;
  return {
    width: request.width,
    data: page.data,
    media: page.media,
    title: page.title || body.meta?.title,
    status: page.status || body.meta?.status || 0,
    url: page.url,
    shot: shot || null,
    shotScale: 1,
    shotHeight: page.data.height,
    browserMs: Number(res.headers.get('X-Browser-Ms-Used')) || 0,
  };
}

/**
 * Captures the original at the given widths ([] = its own breakpoints, read from a first
 * snapshot at 1280px). Resolves to { url, title, status, media, widths: [{ width, data, shot, ... }] }.
 */
export async function captureOriginal(url, {
  service, ref = 'main', widths = [], hideSelectors = [], height = 900, maxHeight = 10000, quality = 60,
  log = () => {}, signal,
} = {}) {
  if (!service) {
    throw new Error('The cloud capture isn\'t set up yet. Add the capture Worker\'s address in Settings, or to the library row as ?service=… (see worker/README.md).');
  }
  const ask = (width) => snapshot(service, {
    url, ref, width, height, hideSelectors, maxHeight, quality,
  }, signal);

  const got = [];
  let list = widths;
  let media = null;
  if (!list.length) {
    log('Reading the original\'s breakpoints in Cloudflare\'s cloud browser');
    const probe = await ask(1280);
    ({ media } = probe);
    list = pickWidths(media?.conditions);
    if (list.includes(1280)) got.push(probe);
  }
  const todo = list.filter((w) => !got.some((g) => g.width === w));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const width = todo[next];
      next += 1;
      log(`Capturing the original at ${width}px in Cloudflare's cloud browser`);
      // eslint-disable-next-line no-await-in-loop
      got.push(await ask(width));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  got.sort((a, b) => a.width - b.width);
  const first = got[0];
  return {
    url: first?.url || url,
    title: first?.title,
    status: first?.status,
    media: media || first?.media,
    widths: got.filter((g) => list.includes(g.width)),
    browserMs: got.reduce((s, g) => s + g.browserMs, 0),
    capturedAt: Date.now(),
  };
}
