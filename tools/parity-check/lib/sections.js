/**
 * The migrated page's sections (header, each `main > div` section, footer), so issues can be
 * read section by section. Built from the element data extract.js returns: each element's
 * structural path (body:1/main:1/div:3/…), region and position.
 */

const SECTION = /(?:^|\/)main:1\/div:(\d+)(?:\/|$)/;
const short = (t, n = 48) => (t && t.length > n ? `${t.slice(0, n - 1)}…` : t || '');

export function sectionsOf(data) {
  const map = new Map();
  (data?.elements || []).forEach((e) => {
    if (!e.visible || !e.rect || e.rect.h <= 0) return;
    let key = null;
    if (e.region === 'header') key = 'header';
    else if (e.region === 'footer') key = 'footer';
    else {
      const m = (e.path || '').match(SECTION);
      key = m ? `s${m[1]}` : null;
    }
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, {
        key, region: e.region, index: key.startsWith('s') ? Number(key.slice(1)) : 0, top: e.rect.y, bottom: e.rect.y + e.rect.h, heading: null, block: null,
      });
    }
    const s = map.get(key);
    s.top = Math.min(s.top, e.rect.y);
    s.bottom = Math.max(s.bottom, e.rect.y + e.rect.h);
    if (!s.heading && e.kind === 'heading' && e.text) s.heading = e.text;
    if (!s.block && e.block) s.block = e.block;
  });
  const list = [...map.values()].sort((a, b) => a.top - b.top);
  let n = 0;
  list.forEach((s) => {
    if (s.key === 'header') s.label = 'Header';
    else if (s.key === 'footer') s.label = 'Footer';
    else {
      n += 1;
      const name = s.heading ? `“${short(s.heading)}”` : (s.block && `${s.block} block`);
      s.label = `Section ${n}${name ? `: ${name}` : ''}`;
    }
  });
  return list;
}

/** The section an issue belongs to: where its element is (or should be) on the migrated page. */
export function sectionFor(issue, sections) {
  const r = issue.m?.rects?.[0] || issue.m?.rect;
  if (!r || !sections.length) return { key: 'page', label: 'Whole page' };
  const mid = r.y + Math.min(r.h, 200) / 2;
  const hit = sections.find((s) => mid >= s.top - 4 && mid <= s.bottom + 4)
    || sections.reduce((best, s) => {
      const d = Math.min(Math.abs(mid - s.top), Math.abs(mid - s.bottom));
      return !best || d < best.d ? { s, d } : best;
    }, null)?.s;
  return hit ? { key: hit.key, label: hit.label } : { key: 'page', label: 'Whole page' };
}

/** Issues grouped by section, in page order; whole-page issues last. */
export function groupBySection(issues, sections = []) {
  const order = new Map(sections.map((s, i) => [s.key, i]));
  const groups = new Map();
  issues.forEach((i) => {
    const sec = i.section || { key: 'page', label: 'Whole page' };
    if (!groups.has(sec.key)) groups.set(sec.key, { ...sec, issues: [] });
    groups.get(sec.key).issues.push(i);
  });
  return [...groups.values()].sort((a, b) => (order.get(a.key) ?? 1e6) - (order.get(b.key) ?? 1e6));
}
