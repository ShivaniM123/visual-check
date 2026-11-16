/**
 * Parity Check capture service: a Cloudflare Worker (free plan) in front of Browserless.
 *
 * Browserless (https://www.browserless.io, free plan: 1,000 units a month, no credit card) runs a
 * real Chrome in the cloud. Its key must stay on a server, so the panel calls this Worker, which
 * adds the key and runs the site's own capture code in Browserless:
 *
 *   GET  /          → { ok: true, service: "parity-check-capture", configured: true }
 *   POST /capture   { url, ref, widths, hideSelectors, height, maxHeight, scale, quality }
 *                   → { url, title, status, media, widths: [{ width, data, shot, ... }] }
 *
 * The code it runs is never taken from the request: it is read from this site
 * (https://{ref}--{site}--{org}.aem.live/tools/parity-check/lib/extract.js + capture-fn.js),
 * so the Worker can only capture pages, with this site's capture.
 *
 * Paste this whole file into the Worker in the Cloudflare dashboard and add the secret
 * BROWSERLESS_TOKEN (see worker/README.md).
 */

// The site whose capture code the Worker runs. Change these for another site,
// or set SITE_ORG / SITE_REPO as Worker variables.
const ORG = 'shivanim123';
const REPO = 'visual-check';
const BROWSERLESS = 'https://production-sfo.browserless.io';
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

/** The capture module Browserless runs: extract.js (exports removed) + capture-fn.js. */
async function captureModule(ref, org, repo) {
  const base = `https://${ref}--${repo}--${org}.aem.live/tools/parity-check/lib/`;
  const [extract, captureFn] = await Promise.all([readCode(`${base}extract.js`), readCode(`${base}capture-fn.js`)]);
  if (!extract?.includes('export function extractPage') || !captureFn?.includes('export default async function capture')) return null;
  return `${extract.replace(/^export\s+(?=(async\s+)?function)/gm, '')}\n${captureFn}`;
}

function cleanRequest(body) {
  const url = publicUrl(body?.url);
  if (!url) return { error: 'blocked-url' };
  const ref = /^[a-z0-9-]{1,60}$/i.test(body.ref || '') ? body.ref.toLowerCase() : 'main';
  const widths = (Array.isArray(body.widths) ? body.widths : [])
    .map((w) => Math.round(Number(w)))
    .filter((w) => w >= 280 && w <= 2560)
    .slice(0, 5);
  const hideSelectors = (Array.isArray(body.hideSelectors) ? body.hideSelectors : [])
    .filter((s) => typeof s === 'string' && s.length <= 200)
    .slice(0, 30);
  const num = (v, min, max, d) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : d);
  return {
    ref,
    context: {
      url,
      widths,
      hideSelectors,
      height: num(body.height, 400, 1600, 900),
      maxHeight: num(body.maxHeight, 1000, 15000, 10000),
      scale: num(body.scale, 0.25, 1, 0.5),
      quality: num(body.quality, 30, 90, 60),
    },
  };
}

async function capture(request, env, origin) {
  const token = env.BROWSERLESS_TOKEN;
  if (!token) return json({ error: 'not-configured' }, 503, origin);
  const body = await request.json().catch(() => null);
  const req = cleanRequest(body);
  if (req.error) return json({ error: req.error }, 400, origin);

  const code = await captureModule(req.ref, env.SITE_ORG || ORG, env.SITE_REPO || REPO);
  if (!code) return json({ error: 'core-unavailable' }, 502, origin);

  const endpoint = `${env.BROWSERLESS_URL || BROWSERLESS}/function?token=${encodeURIComponent(token)}&timeout=110000`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, context: req.context }),
    });
  } catch (e) {
    return json({ error: 'capture-failed', message: 'Browserless could not be reached.' }, 502, origin);
  }
  if (res.status === 401 || res.status === 403) return json({ error: 'browserless-auth' }, 502, origin);
  if (res.status === 429 || res.status === 402) return json({ error: 'browserless-quota' }, 429, origin);
  if (res.status === 408) return json({ error: 'timeout' }, 504, origin);
  const text = await res.text();
  if (!res.ok) {
    return json({ error: 'capture-failed', message: text.replace(/\s+/g, ' ').slice(0, 300) || `Browserless answered ${res.status}.` }, 502, origin);
  }
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
  });
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
        ok: true, service: 'parity-check-capture', site: `${org}/${repo}`, configured: !!env.BROWSERLESS_TOKEN,
      }, 200, ok ? origin : '*');
    }
    if (request.method === 'POST' && pathname === '/capture') {
      if (!ok) return json({ error: 'forbidden-origin' }, 403, null);
      return capture(request, env, origin);
    }
    return json({ error: 'not-found' }, 404, ok ? origin : '*');
  },
};
