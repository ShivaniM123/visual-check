/**
 * Visual parity: the original (Cloudflare Browser Run screenshot) and this page (rendered live in an iframe)
 * side by side at one width, scaled to the panel, scrolling together, with every issue pinned.
 */
import { openFrame } from './frame.js';

const COLORS = { high: '#d7373f', medium: '#da7b11', low: '#2680eb' };
const VIEW_H = 900; // the viewport height both pages were measured at
const MAX_PANE_H = 560;

/** Maps a y position from one page to the other through the matched-content anchors. */
export function mapY(anchors, y, from = 'o') {
  if (!anchors?.length) return y;
  const a = from === 'o' ? 0 : 1;
  const b = 1 - a;
  if (y <= anchors[0][a]) return Math.max(0, y - anchors[0][a] + anchors[0][b]);
  for (let i = 1; i < anchors.length; i += 1) {
    const p = anchors[i - 1];
    const q = anchors[i];
    if (y <= q[a]) {
      const t = (y - p[a]) / Math.max(1, q[a] - p[a]);
      return p[b] + t * (q[b] - p[b]);
    }
  }
  const last = anchors[anchors.length - 1];
  return Math.max(0, y - last[a] + last[b]);
}

function pinNodes(doc, pins, scale, activeId, onPin, inner = 1) {
  const frag = doc.createDocumentFragment();
  const placed = [];
  const spot = (r) => {
    // keep the whole pin inside the pane (it sits above-left of its box)
    let x = Math.max(r.x * scale, 10 / inner);
    const y = Math.max(r.y * scale, 14 / inner);
    const gap = 24 / inner;
    const taken = (px) => placed.some((q) => Math.abs(q.x - px) < gap && Math.abs(q.y - y) < 20 / inner);
    while (taken(x)) x += gap;
    placed.push({ x, y });
    return { x, y };
  };
  pins.forEach((p) => {
    const color = COLORS[p.severity] || COLORS.low;
    const dim = activeId && p.id !== activeId;
    p.rects.forEach((r, i) => {
      const box = doc.createElement('div');
      box.className = `pcv-box${p.expected ? ' expected' : ''}${p.id === activeId ? ' active' : ''}${dim ? ' dim' : ''}`;
      box.style.cssText = `left:${r.x * scale}px;top:${r.y * scale}px;width:${Math.max(4, r.w * scale)}px;height:${Math.max(4, r.h * scale)}px;--c:${color}`;
      frag.append(box);
      if (i === 0) {
        const pin = doc.createElement('button');
        pin.type = 'button';
        pin.className = `pcv-pin${p.id === activeId ? ' active' : ''}${dim ? ' dim' : ''}`;
        pin.textContent = p.n;
        pin.title = p.title;
        const at = spot(r);
        pin.style.cssText = `left:${at.x}px;top:${at.y}px;--c:${color}`;
        pin.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onPin(p.id); });
        frag.append(pin);
      }
    });
  });
  return frag;
}

// --inv undoes the pane's scale, so pins drawn inside a scaled page stay readable
const PIN_CSS = `
  .pcv-box { position: absolute; box-sizing: border-box; border: calc(2px * var(--inv, 1)) solid var(--c);
    border-radius: 3px; background: color-mix(in srgb, var(--c) 8%, transparent); pointer-events: none; }
  .pcv-box.expected { border-style: dashed; }
  .pcv-box.active { border-width: calc(3px * var(--inv, 1));
    box-shadow: 0 0 0 calc(3px * var(--inv, 1)) color-mix(in srgb, var(--c) 35%, transparent); }
  .pcv-pin { position: absolute; transform-origin: 0 0; transform: scale(var(--inv, 1)) translate(-40%, -60%);
    min-width: 20px; height: 20px; padding: 0 5px; box-sizing: border-box; border-radius: 10px; background: var(--c);
    color: #fff; border: 2px solid #fff; font: 700 10px/16px system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: center; cursor: pointer; pointer-events: auto; box-shadow: 0 1px 3px rgb(0 0 0 / 40%); z-index: 1; }
  .pcv-pin.active { transform: scale(calc(var(--inv, 1) * 1.25)) translate(-40%, -60%); z-index: 2; }
  .dim { opacity: .35; }
`;

/** The original as a screenshot from Cloudflare Browser Run. */
function imagePane(el, { shot, width, scale }) {
  el.innerHTML = `<div class="pcv-scroll" style="height:${Math.round(VIEW_H * scale)}px">
    <div class="pcv-canvas" style="width:${Math.round(width * scale)}px;height:${Math.round(shot.height * scale)}px">
      <img alt="The original page at ${width}px" src="${shot.src}" style="width:${Math.round(width * scale)}px">
      <div class="pcv-pins"></div></div></div>`;
  const scroller = el.querySelector('.pcv-scroll');
  const layer = el.querySelector('.pcv-pins');
  return {
    setPins(pins, activeId, onPin) {
      layer.replaceChildren(pinNodes(document, pins, scale, activeId, onPin));
    },
    scrollTo(y, smooth) { scroller.scrollTo({ top: Math.max(0, y * scale - 40), behavior: smooth ? 'smooth' : 'auto' }); },
    onScroll(cb) { scroller.addEventListener('scroll', () => cb(scroller.scrollTop / scale)); },
    destroy() {},
  };
}

/** A page of this site (the migrated page, or a same-site original) rendered live. */
async function framePane(el, { url, width, scale }) {
  el.innerHTML = `<div class="pcv-frame" style="width:${Math.round(width * scale)}px;height:${Math.round(VIEW_H * scale)}px">
    <p class="pcv-loading">Loading…</p></div>`;
  const wrap = el.querySelector('.pcv-frame');
  const iframe = await openFrame(url, { width, height: VIEW_H, parent: wrap, className: 'pcv-iframe' });
  iframe.style.transform = `scale(${scale})`;
  wrap.querySelector('.pcv-loading')?.remove();
  const win = iframe.contentWindow;
  const doc = win.document;
  doc.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
  const host = doc.createElement('div');
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = `:host { --inv: ${1 / scale}; }\n${PIN_CSS}`;
  root.append(style);
  const layer = doc.createElement('div');
  root.append(layer);
  doc.documentElement.append(host);
  return {
    iframe,
    setPins(pins, activeId, onPin) {
      layer.replaceChildren(pinNodes(doc, pins, 1, activeId, onPin, scale));
    },
    scrollTo(y, smooth) { win.scrollTo({ top: Math.max(0, y - 40 / scale), behavior: smooth ? 'smooth' : 'auto' }); },
    onScroll(cb) { win.addEventListener('scroll', () => cb(win.scrollY)); },
    destroy() { iframe.remove(); },
  };
}

function layout(container, width) {
  const avail = Math.max(240, container.clientWidth);
  const side = (avail - 10) / 2 / width;
  const sideBySide = side >= 0.3;
  let scale = sideBySide ? side : avail / width;
  scale = Math.min(scale, MAX_PANE_H / VIEW_H, 1);
  return { sideBySide, scale };
}

/**
 * Draws both panes for one width result. Returns a controller to update pins and focus issues.
 * `original` is { shot } (Cloudflare Browser Run) or { url } (same-site original, e.g. the demo).
 */
export async function renderVisual(container, {
  result, original, migratedUrl, onPin,
}) {
  const { width, anchors } = result;
  const { sideBySide, scale } = layout(container, width);
  container.innerHTML = `<div class="pcv ${sideBySide ? 'side' : 'stack'}">
    <figure class="pcv-side"><figcaption>Original</figcaption><div class="pcv-pane" data-side="o"></div></figure>
    <figure class="pcv-side"><figcaption>This page</figcaption><div class="pcv-pane" data-side="m"></div></figure>
  </div>`;
  const oEl = container.querySelector('[data-side="o"]');
  const mEl = container.querySelector('[data-side="m"]');
  const [o, m] = await Promise.all([
    original.shot
      ? imagePane(oEl, { shot: original.shot, width, scale })
      : framePane(oEl, { url: original.url, width, scale }),
    framePane(mEl, { url: migratedUrl, width, scale }),
  ]);

  // scroll together, through the matched content
  let lock = null;
  const follow = (from, to, dir) => from.onScroll((y) => {
    if (lock === to) return;
    lock = from;
    to.scrollTo(mapY(anchors, y, dir), false);
    clearTimeout(follow.t);
    follow.t = setTimeout(() => { lock = null; }, 120);
  });
  follow(o, m, 'o');
  follow(m, o, 'm');

  return {
    setIssues(issues, activeId) {
      const pin = (side) => issues.map((i) => {
        let rects;
        if (side === 'o') rects = (i.oRects?.length ? i.oRects : [i.o?.rect]);
        else rects = (i.m?.rects?.length ? i.m.rects : [i.m?.rect]);
        return {
          id: i.id, n: i.n, severity: i.severity, title: i.title, rects: rects.filter(Boolean), expected: side === 'm' && !!i.m?.expected,
        };
      }).filter((p) => p.rects.length);
      o.setPins(pin('o'), activeId, onPin);
      m.setPins(pin('m'), activeId, onPin);
    },
    focus(issue) {
      const or = issue.oRects?.[0] || issue.o?.rect;
      const mr = issue.m?.rects?.[0] || issue.m?.rect;
      lock = 'both';
      if (or) o.scrollTo(or.y, true);
      else if (mr) o.scrollTo(mapY(anchors, mr.y, 'm'), true);
      if (mr) m.scrollTo(mr.y, true);
      else if (or) m.scrollTo(mapY(anchors, or.y, 'o'), true);
      setTimeout(() => { lock = null; }, 700);
    },
    destroy() { o.destroy(); m.destroy(); },
  };
}
