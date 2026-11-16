/**
 * Settings (per browser): the capture Worker, ignored elements and widths per site, and the
 * Approve / Needs fix statuses per page.
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
    env: site.env === 'live' ? 'live' : 'page', // check the preview or the live page
  };
}

export function saveSettings(siteId, patch) {
  const { service, ...siteFields } = patch;
  if (service !== undefined) save('settings', { ...load('settings', {}), service });
  if (Object.keys(siteFields).length) save(`site:${siteId}`, { ...load(`site:${siteId}`, {}), ...siteFields });
}

/** Approve / Needs fix per issue, kept per page. */
export function getStatuses(siteId, webPath) {
  return load(`status:${siteId}${webPath}`, {});
}

export function saveStatuses(siteId, webPath, statuses) {
  save(`status:${siteId}${webPath}`, statuses);
}
