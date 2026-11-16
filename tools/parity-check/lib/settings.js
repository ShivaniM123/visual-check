/**
 * Settings (per browser) and "where is the original of this page?".
 * A site's original location can be preset in the library row with ?original=https://www.example.com
 * (plus optional prefix= and suffix=), or is learned from the first page an author checks.
 */
import { load, save } from './store.js';

export const DEFAULT_HIDE = [
  '#onetrust-consent-sdk',
  '#onetrust-banner-sdk',
  '.cookie-banner',
  '[id*="cookie" i][class*="banner" i]',
  '#usercentrics-root',
];

export function getSettings(siteId) {
  const all = load('settings', {});
  const site = load(`site:${siteId}`, {});
  return {
    service: all.service || '',
    hideSelectors: site.hideSelectors || DEFAULT_HIDE,
    widths: site.widths || [], // [] = the original's own breakpoints
    mapping: site.mapping || null, // { origin, prefix, suffix }
  };
}

export function saveSettings(siteId, patch) {
  const { service, ...siteFields } = patch;
  if (service !== undefined) save('settings', { ...load('settings', {}), service });
  if (Object.keys(siteFields).length) save(`site:${siteId}`, { ...load(`site:${siteId}`, {}), ...siteFields });
}

export function presetMapping(params) {
  const origin = params.get('original');
  if (!origin) return null;
  try {
    return { origin: new URL(origin).origin, prefix: params.get('prefix') || '', suffix: params.get('suffix') || '' };
  } catch (e) {
    return null;
  }
}

export function guessOriginal(webPath, mapping) {
  if (!mapping?.origin) return '';
  const tail = webPath === '/' ? '/' : `${webPath}${mapping.suffix || ''}`;
  return `${mapping.origin}${(mapping.prefix || '').replace(/\/$/, '')}${tail}`;
}

/** Learns origin, path prefix ("/en") and suffix (".html") from one pair the author confirmed. */
export function learnMapping(webPath, originalUrl) {
  const o = new URL(originalUrl);
  let oPath = o.pathname;
  let suffix = '';
  const ext = oPath.match(/\.(html?|php|aspx?|jsp)$/i);
  if (ext && webPath !== '/') {
    [suffix] = ext;
    oPath = oPath.slice(0, -suffix.length);
  }
  let prefix = '';
  if (webPath === '/') prefix = oPath.replace(/\/(index)?$/, '');
  else if (oPath.endsWith(webPath)) prefix = oPath.slice(0, oPath.length - webPath.length);
  else return null; // paths don't line up: keep it as a one-off for this page
  return { origin: o.origin, prefix, suffix };
}

export function pageOriginal(siteId, webPath) {
  return load(`page:${siteId}${webPath}`, null);
}

export function rememberOriginal(siteId, webPath, originalUrl) {
  save(`page:${siteId}${webPath}`, originalUrl);
  const site = load(`site:${siteId}`, {});
  if (!site.mapping) {
    const learned = learnMapping(webPath, originalUrl);
    if (learned) save(`site:${siteId}`, { ...site, mapping: learned });
  }
}

/** Approve / Needs fix per issue, kept per page. */
export function getStatuses(siteId, webPath) {
  return load(`status:${siteId}${webPath}`, {});
}

export function saveStatuses(siteId, webPath, statuses) {
  save(`status:${siteId}${webPath}`, statuses);
}
