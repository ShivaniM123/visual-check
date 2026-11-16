/**
 * Local storage for the panel's settings and review statuses (localStorage). Captures aren't
 * kept: both pages are captured fresh for every check.
 */

const PREFIX = 'parity-check:';

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
