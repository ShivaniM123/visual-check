/*
 * Functions injected into the inspected pages with chrome.scripting.executeScript().
 * Like extract.js, each one must be self-contained: no imports, no module scope.
 */

/** How far the page is: loaded, and past the EDS delayed phase (~3 s after load). */
export function pageState() {
  return {
    readyState: document.readyState,
    uptime: performance.now(),
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollY: window.scrollY,
    url: window.location.href,
  };
}

/** Waits for web fonts, then freezes transitions so styles are read at rest. */
export async function settlePage({ waitMs = 600 }) {
  if (!document.getElementById('__parity-freeze')) {
    const style = document.createElement('style');
    style.id = '__parity-freeze';
    style.textContent = '*, *::before, *::after { transition: none !important; animation-play-state: paused !important; caret-color: transparent !important; scroll-behavior: auto !important; }';
    document.head.append(style);
  }
  try { await document.fonts.ready; } catch (e) { /* ignore */ }
  await new Promise((r) => { setTimeout(r, waitMs); });
  return true;
}

/** Removes the transition freeze from the author's page once it has been read. */
export function unsettlePage() {
  document.getElementById('__parity-freeze')?.remove();
  return true;
}

/** Requests that failed (4xx/5xx) according to the Resource Timing API. */
export function failedRequests() {
  return performance.getEntriesByType('resource')
    .filter((e) => e.responseStatus >= 400)
    .slice(0, 30)
    .map((e) => ({ url: e.name, status: e.responseStatus }));
}

export function scrollToY({ y }) {
  window.scrollTo(0, y);
  return true;
}

/**
 * Draws numbered pins over the issues on the open page, inside a shadow root so the
 * page's CSS can't touch them. Clicking a pin tells the side panel which issue it is.
 */
export function drawPins({ pins, activeId = null, visible = true }) {
  const HOST = '__parity-pins';
  document.getElementById(HOST)?.remove();
  if (!visible || !pins.length) return 0;
  const host = document.createElement('div');
  host.id = HOST;
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  const COLORS = { high: '#d7373f', medium: '#da7b11', low: '#2680eb' };
  root.innerHTML = `<style>
    .box { position: absolute; box-sizing: border-box; border: 2px solid var(--c); border-radius: 3px;
      background: color-mix(in srgb, var(--c) 8%, transparent); pointer-events: none; }
    .box.expected { border-style: dashed; background: repeating-linear-gradient(45deg, transparent 0 6px, color-mix(in srgb, var(--c) 10%, transparent) 6px 12px); }
    .pin { position: absolute; transform: translate(-40%, -60%); min-width: 22px; height: 22px; padding: 0 6px;
      box-sizing: border-box; border-radius: 11px; background: var(--c); color: #fff; border: 2px solid #fff;
      font: 700 11px/18px system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center; cursor: pointer;
      pointer-events: auto; box-shadow: 0 1px 4px rgb(0 0 0 / 35%); }
    .pin:hover { transform: translate(-40%, -60%) scale(1.15); }
    .active .box { border-width: 3px; box-shadow: 0 0 0 4px color-mix(in srgb, var(--c) 30%, transparent); animation: pulse 1.2s ease-out 2; }
    .active .pin { transform: translate(-40%, -60%) scale(1.25); z-index: 2; }
    .dim { opacity: .35; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--c) 60%, transparent); } 100% { box-shadow: 0 0 0 14px transparent; } }
  </style>`;
  // pins on the same spot are moved side by side, so every number stays clickable
  const placed = [];
  const spot = (r) => {
    let { x } = r;
    const taken = (px) => placed.some((q) => Math.abs(q.x - px) < 26 && Math.abs(q.y - r.y) < 22);
    while (taken(x)) x += 26;
    placed.push({ x, y: r.y });
    return x;
  };
  pins.forEach((p) => {
    const g = document.createElement('div');
    g.className = `${p.id === activeId ? 'active' : ''} ${activeId && p.id !== activeId ? 'dim' : ''}`;
    g.dataset.id = p.id;
    g.style.setProperty('--c', COLORS[p.severity] || COLORS.low);
    p.rects.forEach((r, i) => {
      const b = document.createElement('div');
      b.className = `box${p.expected ? ' expected' : ''}`;
      b.style.cssText = `left:${r.x}px;top:${r.y}px;width:${Math.max(6, r.w)}px;height:${Math.max(6, r.h)}px;`;
      g.append(b);
      if (i === 0) {
        const pin = document.createElement('button');
        pin.className = 'pin';
        pin.type = 'button';
        pin.textContent = p.n;
        pin.title = p.title;
        pin.style.left = `${spot(r)}px`;
        pin.style.top = `${r.y}px`;
        pin.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          chrome.runtime.sendMessage({ type: 'parity:pin', id: p.id });
        });
        g.append(pin);
      }
    });
    root.append(g);
  });
  document.documentElement.append(host);
  if (activeId) {
    const a = pins.find((p) => p.id === activeId);
    const r = a?.rects[0];
    if (r) window.scrollTo({ top: Math.max(0, r.y - window.innerHeight / 3), behavior: 'smooth' });
  }
  return pins.length;
}

export function clearPins() {
  document.getElementById('__parity-pins')?.remove();
  document.getElementById('__parity-flash')?.remove();
  return true;
}

/** Outlines the elements behind a Lighthouse finding (by CSS selector) on the open page. */
export function flashSelectors({ selectors }) {
  document.getElementById('__parity-flash')?.remove();
  const els = selectors.flatMap((s) => {
    try { return [...document.querySelectorAll(s)].slice(0, 5); } catch (e) { return []; }
  });
  if (!els.length) return 0;
  const host = document.createElement('div');
  host.id = '__parity-flash';
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>.b{position:absolute;box-sizing:border-box;border:3px solid #7e3bd0;border-radius:3px;background:rgb(126 59 208 / 10%);animation:p 1.2s ease-out 3}@keyframes p{0%{box-shadow:0 0 0 0 rgb(126 59 208 / 60%)}100%{box-shadow:0 0 0 14px transparent}}</style>';
  els.forEach((el) => {
    const r = el.getBoundingClientRect();
    const b = document.createElement('div');
    b.className = 'b';
    b.style.cssText = `left:${r.left + window.scrollX - 3}px;top:${r.top + window.scrollY - 3}px;width:${r.width + 6}px;height:${r.height + 6}px`;
    root.append(b);
  });
  document.documentElement.append(host);
  els[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  return els.length;
}
