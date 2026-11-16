/**
 * Short texts that were edited in place: a number ("2026" → "2025"), a button label
 * ("Book your stay" → "Book now"), a name in a short line. match.js pairs elements by what they
 * say, so a short text that changed is left over as "missing" on the original and "extra" on
 * the migrated page, and rules.js then only reports it as "content differs in the same spot".
 *
 * Before the rules run, this pairs a missing short text with the extra short text that sits in
 * its place on the migrated page (same kind of element, same position through the matched
 * content), so rules.js reports it with its wording rule. The parity core itself is unchanged.
 */
import { textKey } from './match.js';

const MAX_WORDS = 12;
const TEXTUAL = new Set(['heading', 'text', 'action']);
const words = (t) => textKey(t).split(' ').filter(Boolean);
const short = (e) => {
  const n = words(e.text).length;
  return n > 0 && n <= MAX_WORDS;
};
const candidate = (e) => e.visible && !e.embed && e.rect && TEXTUAL.has(e.kind) && short(e);

/** Pairs edited short texts. Returns the pairs it made (they're also moved into match.matched). */
export function pairShortEdits(match) {
  const missing = match.missing.filter(candidate);
  const extra = match.extra.filter(candidate);
  if (!missing.length || !extra.length) return [];
  // many leftovers of the same markup are a feed or random teasers, not edits: leave those to rules.js
  const crowd = (list, e) => list.filter((x) => x.selector === e.selector).length > 3;
  const used = new Set();
  const pairs = [];
  missing
    .filter((o) => !crowd(missing, o))
    .sort((a, b) => a.rect.y - b.rect.y)
    .forEach((o) => {
      const y = match.ymap ? match.ymap(o.rect.y) : o.rect.y;
      const reach = Math.max(60, o.rect.h * 1.5);
      const best = extra
        .filter((m) => !used.has(m) && !crowd(extra, m) && m.kind === o.kind
          && (m.tag === o.tag || m.kind !== 'heading')
          && Math.abs(m.rect.y - y) <= reach
          && Math.abs((m.rect.x + m.rect.w / 2) - (o.rect.x + o.rect.w / 2)) <= Math.max(120, o.rect.w))
        .sort((a, b) => Math.abs(a.rect.y - y) - Math.abs(b.rect.y - y))[0];
      if (!best) return;
      used.add(best);
      pairs.push({ o, m: best });
    });
  if (!pairs.length) return [];
  const os = new Set(pairs.map((p) => p.o));
  const ms = new Set(pairs.map((p) => p.m));
  match.missing = match.missing.filter((e) => !os.has(e));
  match.extra = match.extra.filter((e) => !ms.has(e));
  pairs.forEach((p) => match.matched.push({
    o: p.o, m: p.m, icon: false, split: false, inOrder: true, edited: true,
  }));
  return pairs;
}

/**
 * rules.js names the changed words when most of a text is kept, and otherwise says
 * "Text differs". For short texts that were edited in place, say what changed plainly:
 * Wording: "2026" → "2025".
 */
export function nameShortEdits(issues, pairs) {
  if (!pairs.length) return;
  const edited = new Set(pairs.map((p) => p.m.selector + p.m.rect.y));
  issues.forEach((i) => {
    if (i.property !== 'text' || !/^Text differs/.test(i.title)) return;
    if (!edited.has((i.m?.selector || '') + (i.m?.rect?.y ?? ''))) return;
    const o = String(i.o?.text || '').trim();
    const m = String(i.m?.text || '').trim();
    i.title = `Wording: “${o}” → “${m}”`;
    i.ov = o;
    i.mv = m;
    i.words = { o: [[o, true]], m: [[m, true]] };
  });
}
