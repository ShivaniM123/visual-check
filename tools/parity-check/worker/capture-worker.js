/**
 * Parity Check capture service: a Cloudflare Worker (free plan) that opens the original page in
 * Cloudflare's own headless browser, Browser Run (https://developers.cloudflare.com/browser-run/),
 * through a Browser Run binding named BROWSER. No API key or token is needed.
 *
 *   GET  /          → { ok: true, service: "parity-check-capture", configured: true }
 *   POST /capture   { url, ref, widths, hideSelectors, height, maxHeight, quality }
 *                   → { media, widths: [{ width, page, shot, shotScale, shotHeight }], browserMs }
 *                     `page` is the page's parity data as a JSON string, `shot` a JPEG (base64).
 *
 * It drives the browser over the Chrome DevTools Protocol, the way Cloudflare's Puppeteer library
 * does with the binding, so it can switch off the page's Content Security Policy for the capture
 * (Edge Delivery pages and many others block added scripts) and read every width in one session.
 *
 * The script that runs in the page is never taken from the request: it is read from this site
 * (https://{ref}--{site}--{org}.aem.live/tools/parity-check/lib/extract.js + capture-fn.js).
 * Large answers are passed on as text, without unpacking them: the free plan allows 10 ms of CPU.
 *
 * Paste this whole file into the Worker in the Cloudflare dashboard and add a Browser Run binding
 * named BROWSER (see worker/README.md).
 */

// The site whose capture code the Worker runs. Change these for another site,
// or set SITE_ORG / SITE_REPO as Worker variables.
const ORG = 'shivanim123';
const REPO = 'visual-check';
const CODE_CACHE_SECONDS = 300;
const FAKE_HOST = 'https://fake.host';
const MAX_WIDTHS = 5;

// Never let the Worker be used to reach private or internal addresses.
const BLOCKED_HOSTS = [
  /^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i,
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./,
  /^\[?::1\]?$/, /^\[?f[cd][0-9a-f]{2}:/i, /^\[?fe80:/i,
];

function allowedOrigin(origin, org, repo) {
  if (!origin) return false;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1')) return true;
    if (protocol !== 'https:') return false;
    // the site's previews, live site and the Experience Workspace preview proxy, on any branch
    const site = `--${repo}--${org}.`.toLowerCase();
    return hostname.toLowerCase().includes(site)
      && /\.(aem\.page|aem\.live|hlx\.page|hlx\.live|preview\.da\.live|stage-preview\.da\.live)$/i.test(hostname);
  } catch (e) {
    return false;
  }
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

function publicUrl(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (BLOCKED_HOSTS.some((re) => re.test(u.hostname))) return null;
    return u.href;
  } catch (e) {
    return null;
  }
}

async function readCode(url) {
  const res = await fetch(url, { cf: { cacheTtl: CODE_CACHE_SECONDS, cacheEverything: true } });
  if (!res.ok) return null;
  return res.text();
}

const stripExports = (code) => code.replace(/^export\s+(default\s+)?(?=(async\s+)?function)/gm, '');

/** The parity core added to the page: extract.js + capture-fn.js, read from this site. */
async function captureScript(ref, org, repo) {
  const base = `https://${ref}--${repo}--${org}.aem.live/tools/parity-check/lib/`;
  const [extract, captureSrc] = await Promise.all([readCode(`${base}extract.js`), readCode(`${base}capture-fn.js`)]);
  if (!extract?.includes('export function extractPage')
    || !captureSrc?.includes('export default async function capturePage')
    || !captureSrc.includes('export async function captureMedia')) return null;
  // in its own scope, so its names can't clash with the page's; only window.pcCore is added
  return `(() => {\n${stripExports(extract)}\n${stripExports(captureSrc)}\nwindow.pcCore = { capturePage, captureMedia, pickWidths };\nreturn true;\n})()`;
}

function cleanRequest(body) {
  const url = publicUrl(body?.url);
  if (!url) return { error: 'blocked-url' };
  const num = (v, min, max, d) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : d);
  return {
    url,
    ref: /^[a-z0-9-]{1,60}$/i.test(body.ref || '') ? body.ref.toLowerCase() : 'main',
    widths: (Array.isArray(body.widths) ? body.widths : [])
      .map((w) => Math.round(Number(w)))
      .filter((w) => w >= 280 && w <= 2560)
      .slice(0, MAX_WIDTHS),
    height: Math.round(num(body.height, 400, 1600, 900)),
    maxHeight: Math.round(num(body.maxHeight, 1000, 12000, 8000)),
    quality: Math.round(num(body.quality, 30, 90, 55)),
    scale: num(body.scale, 0.25, 1, 0.75),
    hideSelectors: (Array.isArray(body.hideSelectors) ? body.hideSelectors : [])
      .filter((s) => typeof s === 'string' && s.length <= 200)
      .slice(0, 30),
  };
}

/* ---------- a minimal DevTools client (the binding's session + WebSocket) ---------- */

async function openBrowser(binding) {
  const res = await binding.fetch(`${FAKE_HOST}/v1/devtools/browser?keep_alive=60000`, { method: 'POST' });
  const text = await res.text();
  if (res.status === 429) throw Object.assign(new Error(text), { code: 'browser-quota' });
  if (res.status !== 200) throw new Error(`Cloudflare couldn't start a browser (${res.status}): ${text.slice(0, 200)}`);
  const { sessionId } = JSON.parse(text);
  const up = await binding.fetch(`${FAKE_HOST}/v1/devtools/browser/${sessionId}`, { headers: { Upgrade: 'websocket' } });
  if (!up.webSocket) throw new Error(`Cloudflare's browser didn't connect (${up.status})`);
  up.webSocket.accept();
  return up.webSocket;
}

function cdpClient(ws) {
  let next = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
    // answers start with {"id":N — events (no id) are ignored, and big answers aren't parsed here
    const m = msg.match(/^\{"id":(\d+)/) || (msg.length < 20000 && msg.match(/"id":(\d+)/));
    const p = m && pending.get(Number(m[1]));
    if (!p) return;
    pending.delete(Number(m[1]));
    clearTimeout(p.timer);
    p.resolve(msg);
  });
  ws.addEventListener('close', () => {
    pending.forEach((p) => p.reject(new Error('Cloudflare closed the browser connection')));
    pending.clear();
  });
  const raw = (method, params = {}, sessionId = undefined, timeout = 45000) => new Promise((resolve, reject) => {
    next += 1;
    const id = next;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`${method} took too long`), { code: 'timeout' }));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({
      id, method, params, ...(sessionId ? { sessionId } : {}),
    }));
  });
  /** For small answers: parsed, with protocol errors thrown. */
  const call = async (method, params, sessionId, timeout) => {
    const msg = await raw(method, params, sessionId, timeout);
    const data = JSON.parse(msg);
    if (data.error) throw new Error(`${method}: ${data.error.message}`);
    return data.result;
  };
  return { raw, call };
}

/** The string returned by Runtime.evaluate, still JSON-escaped (it's passed on as-is). */
function escapedString(msg) {
  const start = msg.indexOf('"value":"');
  const end = msg.lastIndexOf('"}}');
  if (msg.includes('"exceptionDetails"') || start < 0 || end < start || !msg.includes('"type":"string"')) {
    const data = JSON.parse(msg);
    const ex = data.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description?.split('\n')[0] || ex.text || 'the page script failed');
    if (typeof data.result?.result?.value !== 'string') throw new Error(data.error?.message || 'unexpected answer from the page');
    return JSON.stringify(data.result.result.value).slice(1, -1);
  }
  return msg.slice(start + 9, end);
}

function screenshotData(msg) {
  const start = msg.indexOf('"data":"');
  if (start < 0) throw new Error(JSON.parse(msg).error?.message || 'no screenshot');
  return msg.slice(start + 8, msg.indexOf('"', start + 8));
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function capture(request, env, origin) {
  if (!env.BROWSER?.fetch) return json({ error: 'not-configured' }, 503, origin);
  const req = cleanRequest(await request.json().catch(() => null));
  if (req.error) return json({ error: req.error }, 400, origin);
  const script = await captureScript(req.ref, env.SITE_ORG || ORG, env.SITE_REPO || REPO);
  if (!script) return json({ error: 'core-unavailable' }, 502, origin);

  const started = Date.now();
  let ws;
  try {
    ws = await openBrowser(env.BROWSER);
    const cdp = cdpClient(ws);
    const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId: s } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
    const evalString = async (expression, timeout = 60000) => escapedString(await cdp.raw('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, s, timeout));
    const metrics = (width) => cdp.call('Emulation.setDeviceMetricsOverride', {
      width, height: req.height, deviceScaleFactor: 1, mobile: false,
    }, s);

    // the page's own security policy would block the capture script: switch it off for this tab
    await cdp.call('Page.setBypassCSP', { enabled: true }, s);
    await metrics(req.widths[0] || 1280);
    const nav = await cdp.call('Page.navigate', { url: req.url }, s, 45000);
    if (nav.errorText) return json({ error: 'capture-failed', message: `The original page couldn't be opened (${nav.errorText}).` }, 502, origin);
    // wait for the new document, then add the parity core to it
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await cdp.call('Runtime.evaluate', { expression: 'location.href !== "about:blank" && document.readyState !== "loading"', returnByValue: true }, s).catch(() => null);
      if (r?.result?.value === true) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
    }
    const added = await cdp.call('Runtime.evaluate', { expression: script, returnByValue: true }, s);
    if (added.exceptionDetails) throw new Error(added.exceptionDetails.exception?.description?.split('\n')[0] || 'the parity core could not run in the page');

    const mediaJson = await evalString('pcCore.captureMedia().then((m) => JSON.stringify({ media: m, widths: pcCore.pickWidths(m.conditions) }))');
    let { widths } = req;
    if (!widths.length) widths = (JSON.parse(JSON.parse(`"${mediaJson}"`)).widths || [1280]).slice(0, MAX_WIDTHS);

    const parts = [];
    const opts = JSON.stringify({ hideSelectors: req.hideSelectors, maxHeight: req.maxHeight });
    // eslint-disable-next-line no-restricted-syntax
    for (const width of widths) {
      // eslint-disable-next-line no-await-in-loop
      await metrics(width);
      // eslint-disable-next-line no-await-in-loop
      await sleep(600);
      // eslint-disable-next-line no-await-in-loop
      const page = await evalString(`pcCore.capturePage(${opts}).then((o) => { window.pcHeight = o.data.height; return JSON.stringify(o); })`);
      // eslint-disable-next-line no-await-in-loop
      const h = (await cdp.call('Runtime.evaluate', { expression: `Math.max(1, Math.min(window.pcHeight || 1, ${req.maxHeight}))`, returnByValue: true }, s)).result.value;
      // eslint-disable-next-line no-await-in-loop
      const shotMsg = await cdp.raw('Page.captureScreenshot', {
        format: 'jpeg',
        quality: req.quality,
        captureBeyondViewport: true,
        clip: {
          x: 0, y: 0, width, height: h, scale: req.scale,
        },
      }, s, 60000);
      parts.push(`{"width":${width},"shotScale":${req.scale},"shotHeight":${h},"shot":"${screenshotData(shotMsg)}","page":"${page}"}`);
    }
    cdp.raw('Browser.close', {}, undefined, 3000).catch(() => {});
    const body = `{"media":"${mediaJson}","browserMs":${Date.now() - started},"widths":[${parts.join(',')}]}`;
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (e?.code === 'browser-quota' || /429|rate limit|quota|limit exceeded/i.test(msg)) return json({ error: 'browser-quota', message: msg.slice(0, 300) }, 429, origin);
    if (e?.code === 'timeout') return json({ error: 'timeout', message: msg }, 504, origin);
    return json({ error: 'capture-failed', message: msg.slice(0, 300) }, 502, origin);
  } finally {
    try { ws?.close(); } catch (e) { /* already closed */ }
  }
}

export default {
  async fetch(request, env) {
    const org = env.SITE_ORG || ORG;
    const repo = env.SITE_REPO || REPO;
    const origin = request.headers.get('Origin');
    const ok = allowedOrigin(origin, org, repo);
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
    }
    if (request.method === 'GET' && pathname === '/') {
      return json({
        ok: true,
        service: 'parity-check-capture',
        browser: 'cloudflare-browser-run',
        version: 3,
        site: `${org}/${repo}`,
        configured: !!env.BROWSER?.fetch,
      }, 200, ok ? origin : '*');
    }
    if (request.method === 'POST' && pathname === '/capture') {
      if (!ok) return json({ error: 'forbidden-origin' }, 403, null);
      return capture(request, env, origin);
    }
    return json({ error: 'not-found' }, 404, ok ? origin : '*');
  },
};
