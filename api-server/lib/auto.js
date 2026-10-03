/**
 * auto.js — engine=auto: place a netlist with every candidate of
 * AUTO_CANDIDATES × AUTO_SPACINGS (lib/place4.js) and keep the drawing with
 * the fewest check.js errors (rule 30 aside), then the best published-convention
 * score (lib/conventions.js), then the earlier candidate.
 * Shared by server.js (POST …/netlist/import?engine=auto) and the bench tools,
 * so what is measured is exactly what is served.
 */
import { newDocument, getPage, normalizeOrigin } from './model.js';
import { importNetlist2 } from './place2.js';
import { importNetlist4, AUTO_CANDIDATES, AUTO_SPACINGS } from './place4.js';
import { routePage } from './route.js';
import { checkDocument } from './check.js';
import { conventionReport } from './conventions.js';

export const candidateLabel = (t) => (t.eng === 'v4' ? 'v4:' + t.restMode : t.eng) + (t.extra && t.extra.branchExtend ? '+branches' : '') + (t.sp && t.sp.colW ? `@${t.sp.colW}x${t.sp.rowH}` : '');

async function trial(parsed, eng, restMode, sp = {}, extra = {}) {
  const doc = newDocument(); const m = getPage(doc);
  let placed;
  try {
    if (eng === 'v4') placed = await importNetlist4(m, parsed, { restMode, ...sp, ...extra });
    else { placed = importNetlist2(m, parsed, { ...sp, ...extra }); await routePage(m, placed.wires, {}); normalizeOrigin(m); }
  } catch (e) { return { eng, restMode, sp, extra, errs: Infinity, error: String(e.message || e) }; }
  const errs = checkDocument(m).violations.filter((v) => v.severity === 'error' && v.rule !== '30').length;
  let conv = 0; try { conv = conventionReport(m, parsed).score ?? 0; } catch { /* no geometry */ }
  return { eng, restMode, sp, extra, doc, placed, errs, conv };
}

/** Returns {doc, placed, label, trials:{label:{errors, conventions}}} or throws
 *  when every candidate failed. */
export async function autoPlace(parsed) {
  const trials = await Promise.all(AUTO_SPACINGS.flatMap((sp) => AUTO_CANDIDATES.map(([eng, mode, extra]) => trial(parsed, eng, mode, sp, extra || {}))));
  const win = trials.reduce((a, b) => (b.errs < a.errs || (b.errs === a.errs && b.conv > a.conv + 1e-9) ? b : a));
  if (win.doc == null) { const e = new Error('auto: every engine failed: ' + trials.map((t) => t.error).join(' | ')); e.status = 422; throw e; }
  return { doc: win.doc, placed: win.placed, label: candidateLabel(win), trials: Object.fromEntries(trials.map((t) => [candidateLabel(t), { errors: t.errs, conventions: t.conv }])) };
}
