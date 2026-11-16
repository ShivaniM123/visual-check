/**
 * Local storage for the panel: settings in localStorage, original-page captures in IndexedDB
 * (they hold screenshots). The original site doesn't change while a page is migrated, so a
 * capture is reused for every re-check until the author asks for a fresh one.
 */

const DB = 'parity-check';
const STORE = 'captures';
const PREFIX = 'parity-check:';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const captureKey = (url, widths) => `${url.split('#')[0]}|${widths.length ? widths.join(',') : 'auto'}`;

export async function getCapture(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch (e) { return null; }
}

export async function putCapture(key, capture) {
  try { await tx('readwrite', (s) => s.put(capture, key)); } catch (e) { /* storage full or blocked */ }
}

export function load(name, fallback) {
  try {
    const v = localStorage.getItem(PREFIX + name);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

export function save(name, value) {
  try { localStorage.setItem(PREFIX + name, JSON.stringify(value)); } catch (e) { /* ignore */ }
}
