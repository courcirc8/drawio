/**
 * auto.js — engine=auto: place a netlist with every candidate of
 * AUTO_CANDIDATES × AUTO_SPACINGS (lib/place4.js) and keep the drawing with
 * the fewest check.js errors (rule 30 aside), then the best published-convention
 * score (lib/conventions.js), then the earlier candidate.
 * BASICS (default on since 2026-10-05; AUTO_BASICS=0 disables): between the error count and the rest, prefer the
 * fewer basic-rule violations (lib/basics.js: PMOS above NMOS, mirrored pairs,
 * bends, isolated parts). Tune bench: clean drawings 21.7 -> 25.8 % (original
 * bank), errors and aspect unchanged or better.
 * AUTO_RULES=1 (measurement only, not adopted): between the error count and the
 * conventions, prefer the higher published-layout-rules score (lib/layout-rules.js).
 * Shared by server.js (POST …/netlist/import?engine=auto) and the bench tools,
 * so what is measured is exactly what is served.
 */
import { newDocument, getPage, normalizeOrigin } from './model.js';
import { importNetlist2 } from './place2.js';
import { importNetlist4, AUTO_CANDIDATES, AUTO_SPACINGS } from './place4.js';
import { routePage } from './route.js';
import { checkDocument } from './check.js';
import { conventionReport } from './conventions.js';
import { layoutRulesScore } from './layout-rules.js';
import { basicsReport } from './basics.js';
import { extractNetlist } from './netlist.js';
import { compare } from './lvs.js';

export const candidateLabel = (t) => (t.eng === 'v4' ? 'v4:' + t.restMode : t.eng) + (t.extra && t.extra.branchExtend ? '+branches' : '') + (t.sp && t.sp.colW ? `@${t.sp.colW}x${t.sp.rowH}` : '');

async function trial(parsed, eng, restMode, sp = {}, extra = {}) {
  const doc = newDocument(); const m = getPage(doc);
  let placed;
  try {
    if (eng === 'v4') placed = await importNetlist4(m, parsed, { restMode, ...sp, ...extra });
    else { placed = importNetlist2(m, parsed, { ...sp, ...extra }); await routePage(m, placed.wires, {}); normalizeOrigin(m); }
  } catch (e) { return { eng, restMode, sp, extra, errs: Infinity, error: String(e.message || e) }; }
  // a candidate that does not draw the netlist (LVS) is never chosen: a
  // v4 variant lost a cap on an extracted netlist and auto picked it anyway
  let lvsOk = true;
  try { lvsOk = compare(extractNetlist(m), parsed).match; } catch { lvsOk = false; }
  if (!lvsOk) return { eng, restMode, sp, extra, doc, placed, errs: Infinity, conv: 0, lvsFailed: true };
  const errs = checkDocument(m).violations.filter((v) => v.severity === 'error' && v.rule !== '30').length;
  let conv = 0; try { conv = conventionReport(m, parsed).score ?? 0; } catch { /* no geometry */ }
  let basics = null;
  if (process.env.AUTO_BASICS !== '0') { try { basics = basicsReport(m, parsed).count; } catch { /* no geometry */ } }
  let rules = null;
  if (process.env.AUTO_RULES === '1') { try { rules = layoutRulesScore(m).score; } catch { /* no geometry */ } }
  return { eng, restMode, sp, extra, doc, placed, errs, conv, rules, basics };
}

// rules scores closer than this count as equal (then conventions decide)
const RULES_EPS = 0.02;
const better = (b, a) => {
  if (b.errs !== a.errs) return b.errs < a.errs;
  if (b.basics != null && a.basics != null && b.basics !== a.basics) return b.basics < a.basics;
  if (b.rules != null && a.rules != null && Math.abs(b.rules - a.rules) > RULES_EPS) return b.rules > a.rules;
  return b.conv > a.conv + 1e-9;
};

/** Returns {doc, placed, label, trials:{label:{errors, conventions}}} or throws
 *  when every candidate failed. */
export async function autoPlace(parsed) {
  const trials = await Promise.all(AUTO_SPACINGS.flatMap((sp) => AUTO_CANDIDATES.map(([eng, mode, extra]) => trial(parsed, eng, mode, sp, extra || {}))));
  let win = trials.reduce((a, b) => (better(b, a) ? b : a));
  // STACK-FIRST BAND (experiment, AUTO_BAND=N): among candidates within N
  // check.py-like errors of the best, prefer the branch-column drawings
  // (v2+branches, then v2) — one error decided a scatter of islands over a
  // textbook bandgap. A selection-criterion change: Eric decides.
  const band = Number(process.env.AUTO_BAND ?? 0);
  if (band > 0 && win.errs !== Infinity) {
    const rank = (t) => (t.eng === 'v2' && t.extra && t.extra.branchExtend ? 0 : t.eng === 'v2' ? 1 : 2);
    const near = trials.filter((t) => t.errs <= win.errs + band);
    const best = near.reduce((a, b) => (rank(b) < rank(a) || (rank(b) === rank(a) && b.errs < a.errs) ? b : a));
    if (rank(best) < rank(win)) win = best;
  }
  if (win.doc == null || win.errs === Infinity) {
    // nothing passes LVS: return the first drawn candidate, the caller's LVS gate reports it
    const any = trials.find((t) => t.doc);
    if (!any) { const e = new Error('auto: every engine failed: ' + trials.map((t) => t.error).join(' | ')); e.status = 422; throw e; }
    return { doc: any.doc, placed: any.placed, label: candidateLabel(any), trials: Object.fromEntries(trials.map((t) => [candidateLabel(t), { errors: t.errs, conventions: t.conv, lvs: !t.lvsFailed }])) };
  }
  return { doc: win.doc, placed: win.placed, label: candidateLabel(win), trials: Object.fromEntries(trials.map((t) => [candidateLabel(t), { errors: t.errs, conventions: t.conv, lvs: !t.lvsFailed, rules: t.rules, basics: t.basics }])) };
}
