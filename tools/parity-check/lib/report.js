/**
 * Issue keys and review statuses (Approve / Needs fix), shared by the panel, the comparison tab
 * and the PDF report.
 */

/** Stable key for an issue across re-runs (ids are renumbered every run). */
export const issueKey = (i) => [i.width, i.category, i.property || '', i.m?.selector || i.o?.selector || '', i.title.replace(/\d+(\.\d+)?/g, '#')].join('|');

export function statusesById(report, statuses) {
  const out = {};
  report.results.flatMap((r) => r.issues).forEach((i) => {
    if (statuses[issueKey(i)]) out[i.id] = statuses[issueKey(i)];
  });
  return out;
}
