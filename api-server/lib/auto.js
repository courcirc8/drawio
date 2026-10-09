/**
 * auto.js — engine=auto: place a netlist with every candidate of
 * AUTO_CANDIDATES × AUTO_SPACINGS (lib/place4.js) and keep the drawing with
 * the fewest errors of tools/check.py (since 2026-10-08; AUTO_JUDGE=js: check.js, rule 30 aside), then the best published-convention
 * score (lib/conventions.js), then the earlier candidate.
 * BASICS (default on since 2026-10-05; AUTO_BASICS=0 disables): between the error count and the rest, prefer the
 * fewer basic-rule violations (lib/basics.js: PMOS above NMOS, mirrored pairs,
 * bends, isolated parts). Tune bench: clean drawings 21.7 -> 25.8 % (original
 * bank), errors and aspect unchanged or better.
 * SA (default on since 2026-10-07; AUTO_SA=0 disables): the annealing engine is one more candidate.
 * ASPECT (2026-10-08, off by default, AUTO_ASPECT=1 enables): between equal error counts, a sheet within
 * 3:1 first (AUTO_ASPECT_MAX).
 * AUTO_RULES=1 (measurement only, not adopted): between the error count and the
 * conventions, prefer the higher published-layout-rules score (lib/layout-rules.js).
 * Shared by server.js (POST …/netlist/import?engine=auto) and the bench tools,
 * so what is measured is exactly what is served.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { newDocument, getPage, normalizeOrigin, serialize, parseXml, allCells, cellInfo } from './model.js';
import { importNetlist2 } from './place2.js';
import { importNetlist4, AUTO_CANDIDATES, AUTO_SPACINGS } from './place4.js';
import { routePage, pinAbs } from './route.js';
import { checkDocument } from './check.js';
import { conventionReport } from './conventions.js';
import { layoutRulesScore } from './layout-rules.js';
import { basicsReport } from './basics.js';
import { importNetlistSA } from './place-sa.js';
import { importNetlistStages, stagesConfident } from './place-stages.js';
import { extractNetlist } from './netlist.js';
import { compare } from './lvs.js';

export const candidateLabel = (t) => (t.eng === 'sa' || t.eng === 'stages' ? t.eng : t.eng === 'v4' ? 'v4:' + t.restMode : t.eng) + (t.extra && t.extra.branchExtend ? '+branches' : '') + (t.sp && t.sp.colW ? `@${t.sp.colW}x${t.sp.rowH}` : '');

export async function trial(parsed, eng, restMode, sp = {}, extra = {}) {
  const doc = newDocument(); const m = getPage(doc);
  let placed;
  try {
    if (eng === 'v4') placed = await importNetlist4(m, parsed, { restMode, ...sp, ...extra });
    else if (eng === 'sa') placed = await importNetlistSA(m, parsed, { ...sp, ...extra });
    else if (eng === 'stages') placed = await importNetlistStages(m, parsed, { ...sp, ...extra });
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
  return { eng, restMode, sp, extra, doc, placed, errs, conv, rules, basics, aspect: sheetAspect(m), wire: wirePerPart(m, parsed) };
}

/** Total wire length per part, as the bench measures it (Manhattan length of
 *  each edge through its waypoints, pin to pin). */
function wirePerPart(m, parsed) {
  const cells = allCells(m).map(cellInfo), byId = new Map(cells.map((c) => [c.id, c]));
  let len = 0;
  for (const e of cells.filter((c) => c.kind === 'edge')) {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b) continue;
    const pin = (c, pre) => pinAbs(c, { x: Number(e.style.map.get(pre + 'X') ?? 0.5), y: Number(e.style.map.get(pre + 'Y') ?? 0.5) });
    const pts = [pin(a, 'exit'), ...e.points, pin(b, 'entry')];
    for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
  }
  return len / Math.max(1, parsed.components.length);
}

/** Long side / short side of the box around the placed vertices, as the bench
 *  measures it (tools/bench-families.mjs geometry()). */
function sheetAspect(m) {
  const verts = allCells(m).map(cellInfo).filter((c) => c.kind === 'vertex' && c.x != null);
  if (!verts.length) return 1;
  const xs = verts.flatMap((c) => [c.x, c.x + c.w]), ys = verts.flatMap((c) => [c.y, c.y + c.h]);
  const W = Math.max(...xs) - Math.min(...xs), H = Math.max(...ys) - Math.min(...ys);
  return Math.max(W, H) / Math.max(1, Math.min(W, H));
}

// rules scores closer than this count as equal (then conventions decide)
const RULES_EPS = 0.02;
// ASPECT (Eric 2026-10-08; OFF by default until Eric's second blind series is read —
// AUTO_ASPECT=1 enables; AUTO_ASPECT_MAX, default 3):
// between equal error counts, a sheet within 3:1 beats a longer one — errors
// stay first, so no error is traded for a squarer sheet.
const wide = (t) => process.env.AUTO_ASPECT === '1' && t.aspect != null && t.aspect > Number(process.env.AUTO_ASPECT_MAX ?? 3);
// CRITERION D (Eric's blind series 1-2, 2026-10-09; AUTO_CRITERION=eric, OFF
// by default): what he prefers is predicted by "sheet within 3:1, then the
// shortest wire" (13 of 16 pairs; the checker-first choice: 4). Unacceptable
// drawings (severe errors: overlaps, bend on another net, wire through a part)
// go last; the checker's error count only breaks remaining ties.
const betterEric = (b, a) => {
  const sb = (b.severe ?? 0) > 0, sa = (a.severe ?? 0) > 0;
  if (sb !== sa) return !sb;
  const wb = b.aspect > 3, wa = a.aspect > 3;
  if (wb !== wa) return !wb;
  if (b.wire != null && a.wire != null && Math.abs(b.wire - a.wire) > 0.02 * Math.max(a.wire, b.wire)) return b.wire < a.wire;
  return b.errs < a.errs;
};
const better = (b, a) => {
  if (b.errs === Infinity || a.errs === Infinity) return b.errs < a.errs;
  if (process.env.AUTO_CRITERION === 'eric') return betterEric(b, a);
  if (b.errs !== a.errs) return b.errs < a.errs;
  if (wide(b) !== wide(a)) return !wide(b);
  if (b.basics != null && a.basics != null && b.basics !== a.basics) return b.basics < a.basics;
  if (b.rules != null && a.rules != null && Math.abs(b.rules - a.rules) > RULES_EPS) return b.rules > a.rules;
  return b.conv > a.conv + 1e-9;
};

// JUDGE (Eric 2026-10-08): the candidates are ranked by the bench's own checker
// (tools/check.py, all error rules) — check.js is a partial port that disagreed
// on 216 tune circuits (auto kept a drawing check.py found worse than sa).
// AUTO_JUDGE=js restores check.js; a failing python run falls back to it.
const CHECK_PY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tools', 'check.py');
let tmpSeq = 0;
// errors that make a drawing UNACCEPTABLE to the eye (criterion D): parts on
// top of each other, a bend lying on another net (reads as a contact), a wire
// through a part
const SEVERE = new Set(['comp-overlap', '22-contact', 'through']);
function checkPyErrors(doc) {
  return new Promise((resolve) => {
    const f = path.join(os.tmpdir(), `auto-judge-${process.pid}-${tmpSeq++}.drawio`);
    try { fs.writeFileSync(f, serialize(doc)); } catch { resolve(null); return; }
    execFile('python3', [CHECK_PY, f, '--json'], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      fs.rm(f, { force: true }, () => {});
      try {   // exit 1 = errors found, stdout still JSON
        const j = JSON.parse(stdout);
        const severe = (j.violations || []).filter((v) => v.severity === 'error' && SEVERE.has(v.rule)).length;
        resolve({ errors: j.errors, severe });
      } catch { resolve(null); }
    });
  });
}

/** Returns {doc, placed, label, trials:{label:{errors, conventions}}} or throws
 *  when every candidate failed. */
export async function autoPlace(parsed) {
  // every candidate is started at once, judged as soon as it is drawn; TIME
  // BUDGET (Eric 2026-10-08, AUTO_BUDGET_MS, default 60 s): past it, auto keeps
  // the best drawing finished so far (candidates still running are ignored;
  // if none has finished yet, the first one to finish is taken)
  const BUDGET = Number(process.env.AUTO_BUDGET_MS ?? 60000);
  const judge = async (t) => {
    if (process.env.AUTO_JUDGE !== 'js' && t.doc && t.errs !== Infinity) { const e = await checkPyErrors(t.doc); if (e != null) { t.errsJs = t.errs; t.errs = e.errors; t.severe = e.severe; } }
    return t;
  };
  const specs = AUTO_SPACINGS.flatMap((sp) => AUTO_CANDIDATES.map(([eng, mode, extra]) => [eng, mode, sp, extra || {}]));
  // the annealing engine (lib/place-sa.js) as one more candidate (Eric
  // 2026-10-07; AUTO_SA=0 disables, AUTO_SA_MAX=N limits it to N parts)
  if (process.env.AUTO_SA !== '0' && parsed.components.length <= Number(process.env.AUTO_SA_MAX ?? Infinity)) specs.push(['sa', null, {}, {}]);
  // the stage-driven engine (lib/place-stages.js) as one more candidate, only
  // when the topological reading is sure (AUTO_STAGES=1, OFF by default)
  if (process.env.AUTO_STAGES === '1' && stagesConfident(parsed)) specs.push(['stages', null, {}, {}]);
  // THREADS (2026-10-08, AUTO_THREADS=0 disables; from AUTO_THREADS_MIN parts,
  // default 30): each candidate in its own worker thread (lib/auto-trial-worker.js);
  // on one thread the budget only ever saw v2 finish on the big converters.
  // Past the budget the unfinished threads are terminated (their CPU is freed).
  const threads = process.env.AUTO_THREADS !== '0' && parsed.components.length >= Number(process.env.AUTO_THREADS_MIN ?? 30);
  const workers = new Set();
  const run1 = ([eng, mode, sp, extra]) => {
    if (!threads) return trial(parsed, eng, mode, sp, extra);
    return new Promise((resolve) => {
      const w = new Worker(new URL('./auto-trial-worker.js', import.meta.url), { workerData: { parsed, eng, restMode: mode, sp, extra } });
      workers.add(w);
      const fail = (e) => { workers.delete(w); resolve({ eng, restMode: mode, sp, extra, errs: Infinity, error: String(e && e.message || e) }); };
      w.once('message', (t) => { workers.delete(w); const { xml, ...rest } = t; resolve({ ...rest, doc: xml ? parseXml(xml) : undefined }); w.terminate().catch(() => {}); });
      w.once('error', fail);
      w.once('exit', (code) => { if (workers.has(w)) fail(new Error('trial thread exit ' + code)); });
    });
  };
  const done = [];
  const running = specs.map((spec) => run1(spec).then(judge).then((t) => { done.push(t); return t; }));
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(r, BUDGET); });
  await Promise.race([Promise.all(running), deadline]);
  clearTimeout(timer);
  if (!done.length) await Promise.race(running);
  for (const w of workers) { workers.delete(w); w.terminate().catch(() => {}); }
  const timedOut = done.length < running.length;
  const trials = [...done];
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
    return { doc: any.doc, placed: any.placed, label: candidateLabel(any), timedOut, trials: Object.fromEntries(trials.map((t) => [candidateLabel(t), { errors: t.errs, conventions: t.conv, lvs: !t.lvsFailed }])) };
  }
  return { doc: win.doc, placed: win.placed, label: candidateLabel(win), timedOut, trials: Object.fromEntries(trials.map((t) => [candidateLabel(t), { errors: t.errs, conventions: t.conv, lvs: !t.lvsFailed, rules: t.rules, basics: t.basics }])) };
}
