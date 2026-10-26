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
import { classify } from './components.js';
import { newDocument, getPage, normalizeOrigin, serialize, parseXml, allCells, cellInfo } from './model.js';
import { importNetlist2 } from './place2.js';
import { importNetlist4, AUTO_CANDIDATES, AUTO_SPACINGS } from './place4.js';
import { routePage, pinAbs, netGroups, polylineOf } from './route.js';
import { checkDocument } from './check.js';
import { conventionReport } from './conventions.js';
import { layoutRulesScore } from './layout-rules.js';
import { basicsReport } from './basics.js';
import { importNetlistSA } from './place-sa.js';
import { importNetlistStages, stagesConfident } from './place-stages.js';
import { importNetlistLatch, latchReading } from './place-latch.js';
import { alignPorts } from './align-ports.js';
import { drawRails } from './rails.js';
import { qualityGate } from './quality.js';
import { importNetlistOta, otaReading, importNetlistMiller, millerReading } from './place-ota.js';
import { importNetlistLna, lnaReading } from './place-lna.js';
import { importNetlistPair, pairReading, importNetlistVco, vcoReading } from './place-pair.js';
import { importNetlistStrongarm, strongarmReading } from './place-strongarm.js';
import { importNetlistCs, csReading } from './place-cs.js';
import { importNetlistIndirect, indirectReading } from './place-indirect.js';
import { importNetlistCascode, cascodeReading } from './place-cascode.js';
import { importNetlistClassab, classabReading } from './place-classab.js';
import { importNetlistBandgap, bandgapReading } from './place-bandgap.js';
import { importNetlistRing, ringReading } from './place-ring.js';
import { importNetlistLdo, ldoReading } from './place-ldo.js';
import { crossCoupledX } from './crossx.js';
import { wireNamedNets } from './wirenames.js';
import { straighten, checkerErrors, fixDots } from './straighten.js';
import { extractNetlist } from './netlist.js';
import { compare } from './lvs.js';
import { withGroundAlias, groundAlias } from './ground-alias.js';
import { crossingCount } from './crossings.js';
import { importNetlistManuel, ladderReading } from './place-manuel.js';
import { manuelReading } from './manuel-reading.js';
import { brokawReading } from './place-brokaw.js';

export const candidateLabel = (t) => (t.eng === 'sa' || t.eng === 'stages' || t.eng === 'latch' || t.eng === 'ota' || t.eng === 'miller' || t.eng === 'lna' || t.eng === 'pair' || t.eng === 'vco' || t.eng === 'strongarm' || t.eng === 'cs' || t.eng === 'indirect' || t.eng === 'cascode' || t.eng === 'classab' || t.eng === 'bandgap' || t.eng === 'ring' || t.eng === 'ldo' ? t.eng : t.eng === 'v4' ? 'v4:' + t.restMode : t.eng) + (t.extra && t.extra.branchExtend ? '+branches' : '') + (t.sp && t.sp.colW ? `@${t.sp.colW}x${t.sp.rowH}` : '');

export async function trial(parsed, eng, restMode, sp = {}, extra = {}) {
  const doc = newDocument(); const m = getPage(doc);
  let placed;
  try {
    if (eng === 'v4') placed = await importNetlist4(m, parsed, { restMode, ...sp, ...extra });
    else if (eng === 'sa') placed = await importNetlistSA(m, parsed, { ...sp, ...extra });
    else if (eng === 'stages') placed = await importNetlistStages(m, parsed, { ...sp, ...extra });
    else if (eng === 'latch') placed = await importNetlistLatch(m, parsed, { ...sp, ...extra });
    else if (eng === 'ota') placed = await importNetlistOta(m, parsed, { ...sp, ...extra });
    else if (eng === 'miller') placed = await importNetlistMiller(m, parsed, { ...sp, ...extra });
    else if (eng === 'lna') placed = await importNetlistLna(m, parsed, { ...sp, ...extra });
    else if (eng === 'pair') placed = await importNetlistPair(m, parsed, { ...sp, ...extra });
    else if (eng === 'vco') placed = await importNetlistVco(m, parsed, { ...sp, ...extra });
    else if (eng === 'strongarm') placed = await importNetlistStrongarm(m, parsed, { ...sp, ...extra });
    else if (eng === 'cs') placed = await importNetlistCs(m, parsed, { ...sp, ...extra });
    else if (eng === 'indirect') placed = await importNetlistIndirect(m, parsed, { ...sp, ...extra });
    else if (eng === 'cascode') placed = await importNetlistCascode(m, parsed, { ...sp, ...extra });
    else if (eng === 'classab') placed = await importNetlistClassab(m, parsed, { ...sp, ...extra });
    else if (eng === 'bandgap') placed = await importNetlistBandgap(m, parsed, { ...sp, ...extra });
    else if (eng === 'ring') placed = await importNetlistRing(m, parsed, { ...sp, ...extra });
    else if (eng === 'ldo') placed = await importNetlistLdo(m, parsed, { ...sp, ...extra });
    else { placed = importNetlist2(m, parsed, { ...sp, ...extra }); await routePage(m, placed.wires, {}); normalizeOrigin(m); }
  } catch (e) { return { eng, restMode, sp, extra, errs: Infinity, error: String(e.message || e) }; }
  // a candidate that does not draw the netlist (LVS) is never chosen: a
  // v4 variant lost a cap on an extracted netlist and auto picked it anyway
  // no connection by name (Eric): labels joining an internal net are replaced
  // by wires before the drawing is judged (AUTO_WIRE_NAMES=0 keeps the labels)
  if (process.env.AUTO_WIRE_NAMES !== '0') { try { await wireNamedNets(m); } catch { /* judged as drawn */ } }
  // a template is judged FINISHED (straightened, ports aligned): its quality
  // gate decides whether it takes priority
  if ((eng === 'ota' || eng === 'miller' || eng === 'lna' || eng === 'pair' || eng === 'vco' || eng === 'strongarm' || eng === 'cs' || eng === 'indirect' || eng === 'cascode' || eng === 'classab' || eng === 'bandgap' || eng === 'ring' || eng === 'ldo') && process.env.AUTO_JUDGE !== 'js') { try { if (eng === 'vco' || eng === 'strongarm') await crossCoupledX(m, parsed, { errorCount: checkerErrors, fixDots }); await straighten(m); await alignPorts(m, { errorCount: checkerErrors }); await drawRails(m, { errorCount: checkerErrors, fixDots }); } catch { /* judged as drawn */ } }
  let lvsOk = true;
  try { lvsOk = compare(extractNetlist(m), parsed).match; } catch { lvsOk = false; }
  if (!lvsOk) return { eng, restMode, sp, extra, doc, placed, errs: Infinity, conv: 0, lvsFailed: true };
  const errs = checkDocument(m).violations.filter((v) => v.severity === 'error' && v.rule !== '30').length;
  let conv = 0; try { conv = conventionReport(m, parsed).score ?? 0; } catch { /* no geometry */ }
  let basics = null;
  if (process.env.AUTO_BASICS !== '0') { try { basics = basicsReport(m, parsed).count; } catch { /* no geometry */ } }
  let rules = null;
  if (process.env.AUTO_RULES === '1') { try { rules = layoutRulesScore(m).score; } catch { /* no geometry */ } }
  // quality gate: number of checks failed (lib/quality.js), every candidate
  let gateFails = null;
  try { const q = qualityGate(m, parsed); gateFails = Object.values(q.checks).filter((c) => !c.ok).length; } catch { gateFails = 99; }
  return { eng, restMode, sp, extra, doc, placed, errs, conv, rules, basics, gateFails, aspect: sheetAspect(m), wire: wirePerPart(m, parsed), bends: bendsPerWire(m), cross: crossingCount(m), byName: namedLinks(m) };
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

/** CONNECTIONS BY NAME (Eric 2026-10-09: "on ne veut pas de connexions par
 *  nom"): nets drawn as two or more port labels of the same name instead of
 *  wires (v4 joins its blocks that way), supply and ground excepted. */
const RAILNAME = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss|v\+|v-|power(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?|ground(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?)$/i;
export function namedLinks(m) {
  const count = new Map();
  for (const c of allCells(m).map(cellInfo)) {
    if (c.kind !== 'vertex' || classify(c).role !== 'port') continue;
    const n = String(c.value || '').trim().toUpperCase();
    if (!n || RAILNAME.test(n)) continue;
    count.set(n, (count.get(n) || 0) + 1);
  }
  return [...count.values()].filter((k) => k > 1).length;
}

/** Bends per wire (waypoints of the drawn wires), as the bench measures it. */
function bendsPerWire(m) {
  const cs = allCells(m).map(cellInfo), es = cs.filter((c) => c.kind === 'edge');
  if (!es.length) return 0;
  // a waypoint lying INSIDE a straight run of another wire of the same net is
  // a tee hidden in the copper, not a bend the eye sees (lib/place-latch.js
  // draws a pair's source net that way)
  let net = new Map(), byId = new Map(cs.map((c) => [c.id, c])), runs = [];
  try {
    net = netGroups(cs);
    for (const e of es) { const p = polylineOf(e, byId); if (p) for (let i = 1; i < p.length; i++) runs.push([e.id, net.get(e.id), p[i - 1], p[i]]); }
  } catch { runs = []; }
  const inside = (q, e) => runs.some(([id, n, a, b]) => id !== e.id && n === net.get(e.id)
    && ((Math.abs(a.x - b.x) < 0.5 && Math.abs(q.x - a.x) < 0.5 && q.y > Math.min(a.y, b.y) + 0.5 && q.y < Math.max(a.y, b.y) - 0.5)
      || (Math.abs(a.y - b.y) < 0.5 && Math.abs(q.y - a.y) < 0.5 && q.x > Math.min(a.x, b.x) + 0.5 && q.x < Math.max(a.x, b.x) - 0.5)));
  return es.reduce((n, e) => n + e.points.filter((q) => !inside(q, e)).length, 0) / es.length;
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
// CRITERION D, DEFAULT since 2026-10-09 (Eric, after three blind series;
// AUTO_CRITERION=checker restores the checker-first choice): what he prefers
// is predicted by "sheet within 3:1, then fewer bends per wire, then the
// shortest wire" (series 1-3: 17 of 23 pairs; checker-first: 6). Unacceptable
// drawings (severe errors: parts on top of each other, a bend on another net,
// a wire through a part, two nets on one line, a double line) go last, then
// drawings joining an internal net by name (port labels) instead of a wire; the
// checker's error count only breaks remaining ties (a guard, not a goal).
// CROSSINGS (drawio-placement benchmark, 2026-10-20; AUTO_CROSS=polish (default)|off|safe|first|mid|last):
// fewer wire crossings between candidates, placed before the bends rule (first),
// between bends and wire length (mid) or after wire length (last). Measured on 300
// circuits vs the old order: first = median 6 -> 4 crossings, 84 better / 7 worse;
// safe = 6 -> 5, 65 / 6; wire length, pairs, rails unchanged; mid and last gain
// much less. first and safe, applied BEFORE finishing, cost a few quality-gate passes in
// `npm run bench:templates` (ota 23->22, vco 7->6, cs 68->67), a hard gate: see 'polish' below. Layered graph
// drawing minimises crossings first; criterion D (Eric) never looked at them.
// 'safe' = 'first' but the candidate with fewer crossings must not fail more quality-gate checks
// (plain 'first' made bench:templates regress: latch/ota/miller/vco/strongarm/cs lost gate checks)
// 'polish' (default): the old criterion picks the winner; the 'safe' winner is a CHALLENGER; both are
// finished (polish) and the challenger wins only if, once finished, it has fewer crossings and fails no
// more quality-gate checks (the checks bench:templates counts are those of the finished drawing).
let crossOverride = null;
const crossBefore = (where, b, a) => {
  const mode = crossOverride || process.env.AUTO_CROSS || 'polish';
  if (b.cross == null || a.cross == null || b.cross === a.cross) return false;
  if (mode === 'safe' && where === 'first') { const lo = b.cross < a.cross ? b : a, hi = lo === b ? a : b; return (lo.gateFails ?? 99) <= (hi.gateFails ?? 99); }
  return mode === where;
};
const betterEric = (b, a) => {
  const sb = (b.severe ?? 0) > 0, sa = (a.severe ?? 0) > 0;
  if (sb !== sa) return !sb;
  // then wires rather than connections by name (Eric)
  if ((b.byName ?? 0) !== (a.byName ?? 0)) return (b.byName ?? 0) < (a.byName ?? 0);
  // then a recognised MOTIF drawn by its template (the textbook drawing,
  // Eric 2026-10-09 on the CML comparator) over a generic placement
  // — the OTA template only when its drawing fails no more quality-gate
  // checks than the other one (a template forced on a circuit it does not fit
  // is worse than a generic placement); the latch keeps its approved priority
  const isT = (t) => t.eng === 'latch' || t.eng === 'ota' || t.eng === 'miller' || t.eng === 'lna' || t.eng === 'pair' || t.eng === 'vco' || t.eng === 'strongarm' || t.eng === 'cs' || t.eng === 'indirect' || t.eng === 'cascode' || t.eng === 'classab' || t.eng === 'bandgap' || t.eng === 'ring' || t.eng === 'ldo';
  // two templates: fewer quality-gate checks failed, then the more specific
  // one (the two-stage Miller OTA contains the 5T OTA)
  if (isT(b) && isT(a) && b.eng !== a.eng) {
    if ((b.gateFails ?? 99) !== (a.gateFails ?? 99)) return (b.gateFails ?? 99) < (a.gateFails ?? 99);
    const rank = { latch: 3, strongarm: 3, lna: 2, indirect: 1.5, cascode: 1.2, miller: 1, classab: 0.5, bandgap: 0.4, ring: 0.3, ldo: 1.1, ota: 0, vco: 0, pair: -1, cs: -2 };
    return rank[b.eng] > rank[a.eng];
  }
  if (isT(b) !== isT(a)) {
    const t = isT(b) ? b : a, o = isT(b) ? a : b;
    if (t.eng === 'latch' || (t.gateFails ?? 99) <= (o.gateFails ?? 99)) return isT(b);
  }
  const wb = b.aspect > 3, wa = a.aspect > 3;
  if (wb !== wa) return !wb;
  if (crossBefore('first', b, a)) return b.cross < a.cross;
  if (b.bends != null && a.bends != null && Math.abs(b.bends - a.bends) > 0.05) return b.bends < a.bends;
  if (crossBefore('mid', b, a)) return b.cross < a.cross;
  if (b.wire != null && a.wire != null && Math.abs(b.wire - a.wire) > 0.02 * Math.max(a.wire, b.wire)) return b.wire < a.wire;
  if (crossBefore('last', b, a)) return b.cross < a.cross;
  return b.errs < a.errs;
};
const better = (b, a) => {
  if (b.errs === Infinity || a.errs === Infinity) return b.errs < a.errs;
  if (process.env.AUTO_CRITERION !== 'checker') return betterEric(b, a);
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
// through a part, two nets drawn on top of each other; and (Eric 2026-10-09)
// a differential pair not drawn on one row (rule 14)
const SEVERE = new Set(['comp-overlap', '22-contact', 'through', '22', 'double-line', '14']);
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
/** engine manuel, or null when its reading is not sure or a check fails */
export function tryManuel(parsed) {
  if (!manuelReading(parsed) && !manuelReading(parsed, { textbook: false }) && !brokawReading(parsed) && !ladderReading(parsed)) return null;
  try {
    const doc = newDocument(), m = getPage(doc);
    const placed = importNetlistManuel(m, parsed);      // throws on a geometric LVS failure
    if (!compare(extractNetlist(m), parsed).match) return null;
    return { doc, placed, label: 'manuel', trials: { manuel: { lvs: true, geo: placed.geo.ok, frames: placed.frames } } };
  } catch { return null; }
}

export async function autoPlace(parsed) {
  const r = await autoPlaceAliased(parsed);
  // a ground_<dom> drawn as the ground keeps its domain name next to the symbol
  // (analog-design convention, Orchestrator 2026-10-26): a text value only, the
  // extracted net stays `0`
  const a = r?.ground?.alias ?? groundAlias(parsed.components.flatMap((c) => c.fullNodes || c.nodes || []));
  if (process.env.AUTO_GND !== '0' && r?.doc) labelGroundDomain(getPage(r.doc), a);
  return r;
}

/** a ground_<dom> drawn as the ground symbol keeps its domain name under it (a text value: the
 *  extracted net stays `0`); other aliases (vss, gnd) are drawn as the plain ground */
export function labelGroundDomain(model, alias) {
  if (!alias || !/^ground_/i.test(alias)) return;
  for (const n of allCells(model)) {
    const info = cellInfo(n);
    if (!/signal_ground/.test(info.styleRaw || '') || info.value) continue;
    const cell = n.nodeName === 'mxCell' ? n : n.getElementsByTagName('mxCell')[0];
    if (n.nodeName === 'object' || n.nodeName === 'UserObject') n.setAttribute('label', alias); else n.setAttribute('value', alias);
    if (cell) cell.setAttribute('style', `${cell.getAttribute('style') || ''}verticalLabelPosition=bottom;verticalAlign=top;fontSize=10;`);
  }
}

async function autoPlaceAliased(parsed) {
  // a ground spelled vss / gnd (alone, no `0`) drawn as ground: one GND rail
  // (lib/ground-alias.js); AUTO_GND=0 draws it as written (before / after renders)
  const aliased = process.env.AUTO_GND !== '0' ? withGroundAlias(parsed) : parsed;
  // ENGINE MANUEL FIRST (orchestrator GO 2026-10-24): when its reading is sure
  // (lib/manuel-reading.js) and its drawing passes both the topological and
  // the geometric LVS, the textbook drawing is returned when no template reads
  // the circuit; else the candidates below, unchanged. AUTO_MANUEL=0 disables.
  const man = process.env.AUTO_MANUEL !== '0' ? tryManuel(aliased) : null;
  if (man && !templateReads(parsed)) return man;
  if (man) {
    // a template (approved by Eric) reads this circuit too: manuel only when it
    // fails FEWER quality-gate checks than the drawing auto elects (tie: auto)
    const won = await autoPlaceMain(parsed, aliased);
    const f = (r) => { try { return Object.values(qualityGate(getPage(r.doc), parsed).checks).filter((c) => !c.ok).length; } catch { return 99; } };
    const [fm, fw] = [f(man), f(won)];
    const trials = { ...(won.trials || {}), manuel: { ...man.trials.manuel, gateFails: fm } };
    // the ldo template stays even when manuel fails fewer checks: Eric approved it (Orchestrator, 2026-10-26)
    return fm < fw && won.label !== 'ldo' ? { ...man, trials, manuelVs: { manuel: fm, [won.label]: fw } } : { ...won, trials, manuelVs: { manuel: fm, [won.label]: fw } };
  }
  return autoPlaceMain(parsed, aliased);
}

/** a template reader recognises the circuit (the bench of lib/template-bench) */
function templateReads(p) {
  const readers = [latchReading, otaReading, millerReading, lnaReading, pairReading, vcoReading, strongarmReading, csReading, indirectReading, cascodeReading, classabReading, bandgapReading, ringReading, ldoReading];
  return readers.some((r) => { try { return !!r(p); } catch { return false; } });
}

async function autoPlaceMain(parsed, aliased) {
  if (aliased === parsed) return autoPlaceOnce(parsed);
  // SAME RULE AS THE TEMPLATES (orchestrator 2026-10-10): the alias changes the
  // candidates' drawings, so auto may elect another engine and draw worse. The
  // deck is drawn as written too; when the aliased drawing fails more
  // quality-gate checks, (1) the engine elected as written is redrawn WITH the
  // alias and kept if it does at least as well as the drawing as written, else
  // (2) the drawing as written is kept when its LVS still matches (its ground
  // named by a port or a label). The connectivity gain stays in every case:
  // a drawing as written that loses the ground's name is never returned.
  const lvsOk = (r) => { try { return compare(extractNetlist(getPage(r.doc)), parsed).match; } catch { return false; } };
  const fails = (r) => { try { return Object.values(qualityGate(getPage(r.doc), parsed).checks).filter((c) => !c.ok).length; } catch { return 99; } };
  // one after the other: two passes at once share the CPU and the time budget
  const now = await autoPlaceOnce(aliased), old = await autoPlaceOnce(parsed).catch(() => null);
  const ground = { alias: aliased.groundAlias, fails: fails(now), asWritten: old ? fails(old) : null, asWrittenLabel: old ? old.label : null };
  if (!old || ground.fails <= ground.asWritten) return { ...now, ground };
  if (old.label !== now.label) try {
    const same = await autoPlaceOnce(aliased, old.label), f = fails(same);
    ground.sameEngine = f;
    if (f < ground.fails) {
      if (f <= ground.asWritten || !lvsOk(old)) return { ...same, ground: { ...ground, fails: f, fellBack: 'engine' } };
      return { ...old, ground: { ...ground, fails: ground.asWritten, fellBack: 'as-written' } };
    }
  } catch { /* the aliased drawing stays */ }
  // the drawing as written, when it is still right (its ground named, by a
  // port or a label: LVS matches) and fails fewer checks
  if (lvsOk(old)) return { ...old, ground: { ...ground, fails: ground.asWritten, fellBack: 'as-written' } };
  return { ...now, ground };
}

/** One auto pass on `parsed` as given; `only` restricts the candidates to the
 *  one with that label (the ground fallback above). */
async function autoPlaceOnce(parsed, only = null) {
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
  // when the topological reading is sure; DEFAULT since 2026-10-09 for circuits
  // of at most 12 parts (Eric: liked on small circuits, bad on a 15-part PA;
  // AUTO_STAGES=0 disables, AUTO_STAGES_MAX changes the size)
  if (process.env.AUTO_STAGES !== '0' && parsed.components.length <= Number(process.env.AUTO_STAGES_MAX ?? 12) && stagesConfident(parsed)) specs.push(['stages', null, {}, {}]);
  // the CML latch / clocked comparator template (lib/place-latch.js), when the
  // netlist has that core (Eric 2026-10-09; AUTO_LATCH=0 disables)
  if (process.env.AUTO_LATCH !== '0' && latchReading(parsed)) specs.push(['latch', null, {}, {}]);
  // the 5-transistor OTA template (lib/place-ota.js): DEFAULT since Eric's
  // "oui, gabarit OTA" (2026-10-10), taking priority only when its finished
  // drawing passes the quality gate (AUTO_OTA=0 disables)
  if (process.env.AUTO_OTA !== '0' && otaReading(parsed)) specs.push(['ota', null, {}, {}]);
  // the two-stage Miller OTA template: DEFAULT since Eric's yes (2026-10-10),
  // taking priority only when it does at least as well (AUTO_MILLER=0 disables)
  if (process.env.AUTO_MILLER !== '0' && millerReading(parsed)) specs.push(['miller', null, {}, {}]);
  // the cascode LNA with inductive degeneration (lib/place-lna.js): DEFAULT since
  // Eric's yes (2026-10-10), same rule (AUTO_LNA=0 disables)
  if (process.env.AUTO_LNA !== '0' && lnaReading(parsed)) specs.push(['lna', null, {}, {}]);
  // the differential pair with passive loads (lib/place-pair.js): DEFAULT since
  // Eric's yes (2026-10-10), same rule (AUTO_PAIR=0 disables)
  if (process.env.AUTO_PAIR !== '0' && pairReading(parsed)) specs.push(['pair', null, {}, {}]);
  // the cross-coupled pair / LC VCO (lib/place-pair.js, cross mode): DEFAULT since
  // Eric's yes (2026-10-10), same rule (AUTO_VCO=0 disables)
  if (process.env.AUTO_VCO !== '0' && vcoReading(parsed)) specs.push(['vco', null, {}, {}]);
  // the StrongARM latch comparator (lib/place-strongarm.js): Eric's yes
  // (2026-10-11), same rule (AUTO_STRONGARM=0 disables)
  if (process.env.AUTO_STRONGARM !== '0' && strongarmReading(parsed)) specs.push(['strongarm', null, {}, {}]);
  // single-transistor stages (common source, follower, their cascade): Eric's
  // yes (2026-10-11), same rule (AUTO_CS=0 disables)
  if (process.env.AUTO_CS !== '0' && csReading(parsed)) specs.push(['cs', null, {}, {}]);
  // two-stage OTA with indirect compensation (lib/place-indirect.js): Eric's
  // list (2026-10-12), same rule (AUTO_INDIRECT=0 disables)
  if (process.env.AUTO_INDIRECT !== '0' && indirectReading(parsed)) specs.push(['indirect', null, {}, {}]);
  // telescopic / folded-cascode OTA (lib/place-cascode.js): Eric's list
  // (2026-10-12), same rule (AUTO_CASCODE=0 disables)
  if (process.env.AUTO_CASCODE !== '0' && cascodeReading(parsed)) specs.push(['cascode', null, {}, {}]);
  // class-AB output stage (lib/place-classab.js): Eric's list (2026-10-12),
  // same rule (AUTO_CLASSAB=0 disables)
  if (process.env.AUTO_CLASSAB !== '0' && classabReading(parsed)) specs.push(['classab', null, {}, {}]);
  // bandgap reference core (lib/place-bandgap.js): Eric's list (2026-10-12),
  // same rule (AUTO_BANDGAP=0 disables)
  if (process.env.AUTO_BANDGAP !== '0' && bandgapReading(parsed)) specs.push(['bandgap', null, {}, {}]);
  // CMOS ring oscillator (lib/place-ring.js): Eric's list (2026-10-12), same
  // rule (AUTO_RING=0 disables)
  if (process.env.AUTO_RING !== '0' && ringReading(parsed)) specs.push(['ring', null, {}, {}]);
  // low-dropout regulator (lib/place-ldo.js): Eric's list (2026-10-12), same
  // rule (AUTO_LDO=0 disables)
  if (process.env.AUTO_LDO !== '0' && ldoReading(parsed)) specs.push(['ldo', null, {}, {}]);
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
  if (only) {
    const keep = specs.filter(([eng, restMode, sp, extra]) => candidateLabel({ eng, restMode, sp, extra }) === only);
    if (!keep.length) throw new Error('auto: no candidate ' + only);
    specs.splice(0, specs.length, ...keep);
  }
  const done = [];
  const running = specs.map((spec, k) => run1(spec).then(judge).then((t) => { t.order = k; done.push(t); return t; }));
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(r, BUDGET); });
  await Promise.race([Promise.all(running), deadline]);
  clearTimeout(timer);
  if (!done.length) await Promise.race(running);
  for (const w of workers) { workers.delete(w); w.terminate().catch(() => {}); }
  const timedOut = done.length < running.length;
  // in the candidates' fixed order, not their finishing order: ties went to
  // whichever finished first, so the same netlist could be drawn differently
  const trials = [...done].sort((a, b) => a.order - b.order);
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
  // FINISHING of the chosen drawing (Eric 2026-10-09, default; AUTO_POLISH=0
  // disables): the symmetric X of cross-coupled pairs, then the straightening
  // pass (avoidable bends, labels glued) — each step guarded by tools/check.py
  const finish = async (doc) => {
    const polish = {};
    if (process.env.AUTO_POLISH !== '0' && process.env.AUTO_JUDGE !== 'js') {
      try {
        const page = getPage(doc);
        polish.crossX = await crossCoupledX(page, parsed, { errorCount: checkerErrors, fixDots });   // {drawn, why}
        polish.straighten = await straighten(page);
        // ports at the height of the pin they drive, straight wire (Eric)
        polish.ports = await alignPorts(page, { errorCount: checkerErrors });
        // supply and ground: one rail line with one label (Eric's default) or a
        // symbol per branch (AUTO_RAILS=branch)
        polish.rails = await drawRails(page, { errorCount: checkerErrors, fixDots });
      } catch (e) { polish.error = String(e.message || e); /* the unfinished drawing stays as chosen */ }
    }
    return polish;
  };
  const measure = (doc) => {
    try {
      const m = getPage(doc), q = qualityGate(m, parsed);
      return { gate: Object.values(q.checks).filter((c) => !c.ok).length, cross: crossingCount(m) };
    } catch { return null; }
  };
  let polish = null;
  if ((process.env.AUTO_CROSS || 'polish') === 'polish' && process.env.AUTO_POLISH !== '0' && process.env.AUTO_JUDGE !== 'js' && !only) {
    crossOverride = 'safe';
    const alt = trials.reduce((a, b) => (better(b, a) ? b : a));
    crossOverride = null;
    if (alt !== win && alt.doc && alt.errs !== Infinity && alt.cross != null && win.cross != null && alt.cross < win.cross) {
      const altDoc = parseXml(serialize(alt.doc));
      const [pw, pa] = [await finish(win.doc), await finish(altDoc)];
      const [mw, ma] = [measure(win.doc), measure(altDoc)];
      if (mw && ma && ma.gate <= mw.gate && ma.cross < mw.cross) { win = { ...alt, doc: altDoc }; polish = { ...pa, crossChallenger: 'taken', cross: [mw.cross, ma.cross] }; }
      else polish = { ...pw, crossChallenger: 'kept', cross: mw && ma ? [mw.cross, ma.cross] : null };
    }
  }
  if (polish == null) polish = await finish(win.doc);
  return { doc: win.doc, placed: win.placed, label: candidateLabel(win), timedOut, polish, trials: Object.fromEntries(trials.map((t) => [candidateLabel(t), { errors: t.errs, conventions: t.conv, lvs: !t.lvsFailed, rules: t.rules, basics: t.basics, severe: t.severe, byName: t.byName, aspect: t.aspect, bends: t.bends, wire: t.wire, cross: t.cross, gateFails: t.gateFails }])) };
}
