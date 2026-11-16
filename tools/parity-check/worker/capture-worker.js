/**
 * Parity Check capture service: a Cloudflare Worker (free plan) using Cloudflare's own headless
 * browser, Browser Run (https://developers.cloudflare.com/browser-run/), through a Worker binding.
 * No API key or token is needed: the binding is enough.
 *
 *   GET  /           → { ok: true, service: "parity-check-capture", configured: true }
 *   POST /snapshot   { url, ref, width, height, hideSelectors, maxHeight, quality }
 *                    → Browser Run's snapshot of the original page at that width:
 *                      { success, result: { content, screenshot }, meta: { status, title } }
 *                      The page's parity data is in the content, as JSON in #__pc-data.
 *
 * The script that runs in the page is never taken from the request: it is read from this site
 * (https://{ref}--{site}--{org}.aem.live/tools/parity-check/lib/extract.js + capture-fn.js),
 * so the Worker can only capture pages, with this site's capture. The answer is passed straight
 * through to the panel, which reads it (the free plan allows 10 ms of CPU per request).
 *
 * Paste this whole file into the Worker in the Cloudflare dashboard and add a Browser Run binding
 * named BROWSER (see worker/README.md).
 */

// The site whose capture code the Worker runs. Change these for another site,
// or set SITE_ORG / SITE_REPO as Worker variables.
const ORG = 'shivanim123';
const REPO = 'visual-check';
const CODE_CACHE_SECONDS = 300;

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
    'Access-Control-Expose-Headers': 'X-Browser-Ms-Used',
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

/** The script added to the original page: extract.js + capture-fn.js, then the call. */
async function captureScript(ref, org, repo, opts) {
  const base = `https://${ref}--${repo}--${org}.aem.live/tools/parity-check/lib/`;
  const [extract, capture] = await Promise.all([readCode(`${base}extract.js`), readCode(`${base}capture-fn.js`)]);
  if (!extract?.includes('export function extractPage') || !capture?.includes('export default async function capturePage')) return null;
  return `${stripExports(extract)}\n${stripExports(capture)}\ncapturePage(${JSON.stringify(opts)});\n`;
}

function cleanRequest(body) {
  const url = publicUrl(body?.url);
  if (!url) return { error: 'blocked-url' };
  const num = (v, min, max, d) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : d);
  return {
    url,
    ref: /^[a-z0-9-]{1,60}$/i.test(body.ref || '') ? body.ref.toLowerCase() : 'main',
    width: num(body.width, 280, 2560, 1280),
    height: num(body.height, 400, 1600, 900),
    quality: num(body.quality, 30, 90, 60),
    opts: {
      maxHeight: num(body.maxHeight, 1000, 15000, 10000),
      hideSelectors: (Array.isArray(body.hideSelectors) ? body.hideSelectors : [])
        .filter((s) => typeof s === 'string' && s.length <= 200)
        .slice(0, 30),
    },
  };
}

async function snapshot(request, env, origin) {
  if (!env.BROWSER?.quickAction) return json({ error: 'not-configured' }, 503, origin);
  const req = cleanRequest(await request.json().catch(() => null));
  if (req.error) return json({ error: req.error }, 400, origin);

  const script = await captureScript(req.ref, env.SITE_ORG || ORG, env.SITE_REPO || REPO, req.opts);
  if (!script) return json({ error: 'core-unavailable' }, 502, origin);

  let res;
  try {
    res = await env.BROWSER.quickAction('snapshot', {
      url: req.url,
      viewport: { width: req.width, height: req.height },
      gotoOptions: { waitUntil: 'networkidle2', timeout: 45000 },
      addScriptTag: [{ content: script }],
      waitForSelector: { selector: '#__pc-done', timeout: 40000 },
      screenshotOptions: { fullPage: true, type: 'jpeg', quality: req.quality },
      actionTimeout: 60000,
      bestAttempt: true,
      cacheTTL: 0,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/429|rate|limit|quota/i.test(msg)) return json({ error: 'browser-quota', message: msg }, 429, origin);
    return json({ error: 'capture-failed', message: msg.slice(0, 300) }, 502, origin);
  }
  // passed straight through: the panel reads the snapshot
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) };
  const used = res.headers.get('X-Browser-Ms-Used');
  if (used) headers['X-Browser-Ms-Used'] = used;
  return new Response(res.body, { status: res.status, headers });
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
        site: `${org}/${repo}`,
        configured: !!env.BROWSER?.quickAction,
      }, 200, ok ? origin : '*');
    }
    if (request.method === 'POST' && pathname === '/snapshot') {
      if (!ok) return json({ error: 'forbidden-origin' }, 403, null);
      return snapshot(request, env, origin);
    }
    return json({ error: 'not-found' }, 404, ok ? origin : '*');
  },
};
