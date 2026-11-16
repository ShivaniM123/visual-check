/*
 * Settings (chrome.storage.sync) and the "where is the original of this page?" logic.
 */

export const DEFAULT_HIDE = [
  '#onetrust-consent-sdk',
  '#onetrust-banner-sdk',
  '.cookie-banner',
  '[id*="cookie" i][class*="banner" i]',
  '#usercentrics-root',
];

export const DEFAULTS = {
  psiKey: '',
  autoPsi: true,
  psiStrategy: 'auto', // auto | mobile | desktop
  showPins: true,
  hideSelectors: DEFAULT_HIDE,
  mappings: [], // [{ key, label, origin, prefix, suffix }]
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}

/**
 * Every branch of an EDS site (main--site--org.aem.page, feature--site--org.aem.live, …)
 * shares one mapping; any other site is keyed by its origin.
 */
export function siteKey(u) {
  const url = new URL(u);
  const eds = url.hostname.match(/^[a-z0-9-]+?--([a-z0-9-]+--[a-z0-9-]+)\.(aem|hlx)\.(page|live)$/i);
  if (eds) return { key: `eds:${eds[1].toLowerCase()}`, label: `${eds[1]} (all branches, .page and .live)` };
  return { key: url.origin, label: url.host };
}

const pathOf = (u) => {
  const p = new URL(u).pathname.replace(/\.(plain\.)?html$/, '').replace(/\/index$/, '/');
  return p || '/';
};

export function guessOriginal(migratedUrl, settings) {
  try {
    const { key } = siteKey(migratedUrl);
    const map = (settings.mappings || []).find((m) => m.key === key);
    if (!map) return '';
    const path = pathOf(migratedUrl);
    const tail = path === '/' ? '/' : `${path}${map.suffix || ''}`;
    const prefix = (map.prefix || '').replace(/\/$/, '');
    return `${map.origin}${prefix}${tail}`;
  } catch (e) {
    return '';
  }
}

/** Learns origin, path prefix and suffix (".html") from one pair the author confirmed. */
export function learnMapping(migratedUrl, originalUrl) {
  const { key, label } = siteKey(migratedUrl);
  const o = new URL(originalUrl);
  const mPath = pathOf(migratedUrl);
  let oPath = o.pathname;
  let suffix = '';
  const ext = oPath.match(/\.(html?|php|aspx?|jsp)$/i);
  if (ext && mPath !== '/') {
    [suffix] = ext;
    oPath = oPath.slice(0, -suffix.length);
  }
  let prefix = '';
  if (mPath === '/') {
    prefix = oPath.replace(/\/(index)?$/, '');
  } else if (oPath.endsWith(mPath)) {
    prefix = oPath.slice(0, oPath.length - mPath.length);
  } else {
    return null; // paths don't line up: keep this pair as a one-off override only
  }
  return {
    key, label, origin: o.origin, prefix, suffix,
  };
}

export async function getOverride(migratedUrl) {
  const { overrides = {} } = await chrome.storage.local.get('overrides');
  return overrides[migratedUrl.split('#')[0]] || '';
}

export async function rememberOriginal(migratedUrl, originalUrl, settings) {
  const { overrides = {} } = await chrome.storage.local.get('overrides');
  overrides[migratedUrl.split('#')[0]] = originalUrl;
  await chrome.storage.local.set({ overrides });
  const learned = learnMapping(migratedUrl, originalUrl);
  if (learned && !(settings.mappings || []).some((m) => m.key === learned.key)) {
    const mappings = [...(settings.mappings || []), learned];
    await saveSettings({ mappings });
    return mappings;
  }
  return settings.mappings;
}
