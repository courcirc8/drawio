/**
 * crossx.js — the symmetric X of a cross-coupled pair (Eric 2026-10-09: "on
 * doit autoriser les fils en diagonale pour les croisements symétriques de 2
 * lignes horizontales, genre VCO drain / grille"), as textbooks draw a VCO or a
 * latch core: each gate goes inwards on a horizontal line, crosses the
 * partner's line on a DIAGONAL in the middle of the pair, and reaches the
 * partner's drain on a horizontal line just beyond the drains.
 *
 *   gate L ── ╲ ╱ ── drain R          (and its mirror image)
 *              ╳
 *   gate R ── ╱ ╲ ── drain L
 *
 * For every cross-coupled pair (lib/patterns.js) drawn on ONE row: the two
 * devices are turned so their gates face each other, the wire that leaves each
 * gate is redrawn as that polyline and ends on the partner's drain (same net),
 * marked `drawioApiCrossX=1` with `edgeStyle=none` (tools/check.py exempts
 * deliberate diagonals of edgeStyle=none from its orthogonality rule). The pair
 * is left as it was when the result does not draw the netlist (LVS) or adds a
 * checker error. Geometry only otherwise.
 */
import { allCells, cellInfo, updateCell, addWire, deleteCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { detectStructures } from './patterns.js';
import { extractNetlist } from './netlist.js';
import { compare } from './lvs.js';

export async function crossCoupledX(model, parsed, { errorCount, fixDots } = {}) {
  let pairs = [];
  try { pairs = detectStructures(parsed).crossCoupled.map((p) => p.refs); } catch { return { drawn: 0 }; }
  if (!pairs.length) return { drawn: 0, why: {} };
  const byRef = new Map(parsed.components.map((c) => [c.ref, c]));
  let drawn = 0; const why = {}; const no = (k) => { why[k] = (why[k] || 0) + 1; };
  let errs = errorCount ? await errorCount(model) : null;
  for (const [ra, rb] of pairs) {
    const cells = allCells(model).map(cellInfo);
    const cell = (r) => cells.find((c) => c.kind === 'vertex' && String(c.refdes || c.id) === r);
    let A = cell(ra), B = cell(rb);
    if (!A || !B) { no('cellule'); continue; }
    if (Math.abs((A.y + A.h / 2) - (B.y + B.h / 2)) > 1) { no('pas sur une rangée'); continue; }   // one row only
    const snap = Array.from(model.childNodes).map((n) => n.cloneNode(true));
    const undo = () => { while (model.firstChild) model.removeChild(model.firstChild); for (const n of snap) model.appendChild(n); };
    // L on the left, R on the right; gates must face each other
    let [L, R] = A.x + A.w / 2 <= B.x + B.w / 2 ? [A, B] : [B, A];
    const pins = (c) => { const ps = activePins(classify(c)); return { rel: ps, abs: ps.map((p) => pinAbs(c, p)) }; };
    const turned = [];
    const face = (c, inwardSign) => {
      const p = pins(c).abs, leadX = (p[0].x + p[2].x) / 2;
      if (Math.sign(p[1].x - leadX) !== inwardSign) {
        updateCell(model, c.id, { style: { flipH: String(c.style.map.get('flipH') || '0') === '1' ? null : 1 } });
        turned.push(c.id);
      }
    };
    face(L, 1); face(R, -1);
    const fresh = () => { const cs = allCells(model).map(cellInfo); L = cs.find((c) => c.id === L.id); R = cs.find((c) => c.id === R.id); return cs; };
    let cs = fresh();
    const pl = pins(L), pr = pins(R);
    const [dL, gL] = [pl.abs[0], pl.abs[1]], [dR, gR] = [pr.abs[0], pr.abs[1]];
    if (gR.x - gL.x < 24) { no('trop serrés'); undo(); continue; }   // no room for an X between the gates
    // the drain line: just beyond the drains, away from the gates
    const off = (d, g) => (d.y < g.y ? -12 : 12);
    const yN = (dL.y + dR.y) / 2 + off(dL, gL);
    // the diagonals at 45° (Eric: "la règle des 45°") when the gates leave
    // room: half-width = half the drop, else as wide as the gap allows
    const xC = (gL.x + gR.x) / 2, s = Math.max(8, Math.min(Math.abs(gL.y - yN) / 2, (gR.x - gL.x) / 2 - 12));
    const gateEdge = (c, gRel) => cs.find((e) => e.kind === 'edge' && ((e.source === c.id && near(e, 'exit', gRel)) || (e.target === c.id && near(e, 'entry', gRel))));
    const near = (e, end, rel) => Math.abs(Number(e.style.map.get(end + 'X') ?? -1) - rel.x) < 0.02 && Math.abs(Number(e.style.map.get(end + 'Y') ?? -1) - rel.y) < 0.02;
    const eL = gateEdge(L, pl.rel[1]), eR = gateEdge(R, pr.rel[1]);
    if (!eL || !eR || eL.id === eR.id) { no('fil de grille introuvable'); undo(); continue; }
    // the two wires of the X are ADDED; each old gate wire is then removed only
    // if the netlist is still drawn without it (it may be the only link of
    // another pin of the net: rebranching it cut that pin off)
    const X = 'edgeStyle=none;rounded=0;curved=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiCrossX=1;';
    addWire(model, { source: L.id, target: R.id, sourcePin: pl.rel[1], targetPin: pr.rel[0], style: X,
      points: [{ x: xC - s, y: gL.y }, { x: xC + s, y: yN }, { x: dR.x, y: yN }] });
    addWire(model, { source: R.id, target: L.id, sourcePin: pr.rel[1], targetPin: pl.rel[0], style: X,
      points: [{ x: xC + s, y: gR.y }, { x: xC - s, y: yN }, { x: dL.x, y: yN }] });
    // an old gate wire that must stay (it links another pin of the net) is
    // moved from the gate to the partner's drain — same net, now joined to the
    // gate by the X — and rerouted
    const reroute = [];
    for (const [e, dev, gRel, partner, dRel] of [[eL, L, pl.rel[1], R, pr.rel[0]], [eR, R, pr.rel[1], L, pl.rel[0]]]) {
      // already on the partner's drain at its other end: the X replaces it
      const other = e.source === dev.id ? { id: e.target, end: 'entry' } : { id: e.source, end: 'exit' };
      if (other.id === partner.id && near(e, other.end, dRel)) { deleteCell(model, e.id); continue; }
      const keep = Array.from(model.childNodes).map((n) => n.cloneNode(true));
      deleteCell(model, e.id);
      let still = false; try { still = compare(extractNetlist(model), parsed).match; } catch { still = false; }
      if (still) continue;
      while (model.firstChild) model.removeChild(model.firstChild); for (const n of keep) model.appendChild(n);
      const atSource = e.source === dev.id && Math.abs(Number(e.style.map.get('exitX') ?? -1) - gRel.x) < 0.02;
      updateCell(model, e.id, atSource
        ? { source: partner.id, style: { exitX: dRel.x, exitY: dRel.y, edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] }
        : { target: partner.id, style: { entryX: dRel.x, entryY: dRel.y, edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
      reroute.push(e.id);
    }
    // any OTHER wire still on a gate (the net's link to a load or to the rest
    // of the circuit, CICC 2007 Sheikhaei comparator) would cross the X: it is
    // moved to the partner's drain too, the X joins it to the gate
    for (const e of allCells(model).map(cellInfo)) {
      if (e.kind !== 'edge' || e.style.map.get('drawioApiCrossX') === '1' || reroute.includes(e.id)) continue;
      for (const [dev, gRel, partner, dRel] of [[L, pl.rel[1], R, pr.rel[0]], [R, pr.rel[1], L, pl.rel[0]]]) {
        const atSource = e.source === dev.id && near(e, 'exit', gRel), atTarget = e.target === dev.id && near(e, 'entry', gRel);
        if (!atSource && !atTarget) continue;
        // already on the partner's drain at its other end: it would become a loop
        const other = atSource ? { id: e.target, end: 'entry' } : { id: e.source, end: 'exit' };
        if (other.id === partner.id && near(e, other.end, dRel)) { deleteCell(model, e.id); break; }
        updateCell(model, e.id, atSource
          ? { source: partner.id, style: { exitX: dRel.x, exitY: dRel.y, edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] }
          : { target: partner.id, style: { entryX: dRel.x, entryY: dRel.y, edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
        reroute.push(e.id);
      }
    }
    if (reroute.length) await routePage(model, reroute, {});
    // the turned devices' other wires follow
    if (turned.length) {
      cs = allCells(model).map(cellInfo);
      const ids = cs.filter((e) => e.kind === 'edge' && e.style.map.get('drawioApiCrossX') !== '1' && (turned.includes(e.source) || turned.includes(e.target))).map((e) => e.id);
      for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
      if (ids.length) await routePage(model, ids, {});
    }
    if (fixDots) await fixDots(model);
    let ok = false;
    try { ok = compare(extractNetlist(model), parsed).match; } catch { ok = false; }
    if (!ok) { no('LVS'); undo(); continue; }
    if (errorCount) { const e2 = await errorCount(model); ok = errs != null && e2 != null && e2 <= errs; if (ok) errs = e2; }
    if (!ok) { no('erreurs check.py'); undo(); continue; }
    drawn++;
  }
  return { drawn, why };
}
