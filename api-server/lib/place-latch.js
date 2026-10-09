/**
 * place-latch.js — engine "latch": the CML latch / clocked comparator drawn
 * as textbooks draw it (Eric 2026-10-09, CICC 2007 Sheikhaei, "Fig. 2:
 * circuit detail of the comparator": "plein de coudes inutiles, la règle des
 * 45° en cas de cross-coupled g-d pas reconnue").
 *
 *        LA    LB                       loads (R or active), supply on top
 *        |     |
 *   iA  iB      cA ╳ cB                 input pair | cross-coupled pair,
 *     \/          \/                    side by side, same drain nets A / B
 *     tI          tC                    clock switches (or tails) under each pair
 *          tT                           tail source centred under the switches
 *
 * Recognised: a cross-coupled pair C (drains A, B) and a NON-crossed
 * differential pair I of the same polarity on the same two drains (the input
 * pair of a CML latch / comparator). Optional: one load per drain net, the
 * part feeding each pair's source net, and the part feeding the common source
 * of those two (the tail). Every other part sits in a row below.
 * The positions go to lib/place-sa.js as its start (opts.saInit) with almost
 * no annealing: place-sa only snaps rows / columns, flips and wires. The X of
 * the cross-coupled pair is drawn after (lib/crossx.js, auto's polish).
 */
import { detectStructures, isPmosLike } from './patterns.js';
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell, addWire, deleteCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];
const isMos = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';

/** The latch reading, or null when the netlist has no such core. */
export function latchReading(parsed) {
  let st; try { st = detectStructures(parsed); } catch { return null; }
  const byRef = new Map(parsed.components.map((c) => [c.ref, c]));
  for (const cc of st.crossCoupled) {
    const [a, b] = cc.refs.map((r) => byRef.get(r));
    const A = D(a), B = D(b), pol = isPmosLike(a);
    if (S(a) !== S(b) || RAIL.test(S(a))) continue;
    for (const dp of st.diffPairs) {
      if (dp.refs.some((r) => cc.refs.includes(r))) continue;
      const [p, q] = dp.refs.map((r) => byRef.get(r));
      if (isPmosLike(p) !== pol) continue;
      const iA = D(p) === A && D(q) === B ? p : D(q) === A && D(p) === B ? q : null;
      if (!iA) continue;
      const iB = iA === p ? q : p;
      const used = new Set([a.ref, b.ref, p.ref, q.ref]);
      // one load per drain net: a part on that net whose other end is a rail
      const load = (net) => parsed.components.find((c) => !used.has(c.ref) && c.nodes.includes(net)
        && (isMos(c) ? D(c) === net && RAIL.test(S(c)) : c.nodes.some((n) => n !== net && RAIL.test(n))));
      const LA = load(A); if (LA) used.add(LA.ref);
      const LB = load(B); if (LB) used.add(LB.ref);
      // the part feeding a pair's source net (clock switch or tail)
      const feed = (net) => parsed.components.find((c) => !used.has(c.ref) && (isMos(c) ? D(c) === net : c.nodes.includes(net)));
      const tI = feed(S(iA)); if (tI) used.add(tI.ref);
      const tC = feed(S(a)); if (tC) used.add(tC.ref);
      let tT = null;
      if (tI && tC && isMos(tI) && isMos(tC) && S(tI) === S(tC) && !RAIL.test(S(tI))) { tT = feed(S(tI)); if (tT) used.add(tT.ref); }
      return { iA: iA.ref, iB: iB.ref, cA: a.ref, cB: b.ref, LA: LA?.ref, LB: LB?.ref, tI: tI?.ref, tC: tC?.ref, tT: tT?.ref, used, nets: { A, B } };
    }
  }
  return null;
}

/** Template centres, in units of the median part size. */
export function latchLayout(parsed, L) {
  const COL = 2, ROW = 1.8, GAP = Number(process.env.LATCH_GAP ?? 1.6);
  const pos = new Map(), put = (r, x, y) => { if (r) pos.set(r, { x, y }); };
  // the cross-coupled pair one unit wider: room for an X at 45° between the gates
  const CC = COL + 1;
  const xI = COL / 2, xC = COL + GAP + CC / 2;          // centres of the two pairs
  put(L.LA, 0, -ROW); put(L.LB, COL, -ROW);
  put(L.iA, 0, 0); put(L.iB, COL, 0);
  put(L.cA, COL + GAP, 0); put(L.cB, COL + GAP + CC, 0);
  put(L.tI, xI, ROW); put(L.tC, xC, ROW);
  put(L.tT, (xI + xC) / 2, 2 * ROW);
  let k = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: COL * k++, y: 3 * ROW + (L.tT ? 0 : -ROW) });
  return pos;
}

/** Engine "latch": the template, wired by place-sa (positions kept). */
export async function importNetlistLatch(model, parsed, opts = {}) {
  const L = latchReading(parsed);
  if (!L) throw new Error('latch: no CML latch core');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: latchLayout(parsed, L), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await alignLatch(model, L);
  return placed;
}

/** Exact alignment place-sa's grid cannot give: each load straight above its
 *  drain, each switch's drain under the middle of its pair's source line, the
 *  tail's drain under the middle of the switches' sources. A part moves with
 *  its satellites (rail symbols, ports wired to it alone) and its label; every
 *  wire is then routed again. */
async function alignLatch(model, L) {
  const cells = () => allCells(model).map(cellInfo);
  const find = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const pins = (c) => activePins(classify(c)).map((p) => pinAbs(c, p));
  const drain = (r) => pins(find(r))[0], source = (r) => pins(find(r))[2];
  const lower = (r) => pins(find(r)).reduce((a, b) => (b.y > a.y ? b : a));
  const move = (ref, dx) => {
    dx = Math.round(dx); if (!dx) return;
    const cs = cells(), me = cs.find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
    const edges = cs.filter((c) => c.kind === 'edge');
    const group = [me.id];
    for (const v of cs.filter((c) => c.kind === 'vertex' && ['power', 'ground', 'port'].includes(classify(c).role))) {
      const peers = new Set(edges.filter((e) => e.source === v.id || e.target === v.id).map((e) => (e.source === v.id ? e.target : e.source)));
      if (peers.size === 1 && peers.has(me.id)) group.push(v.id);
    }
    for (const c of cs) if (c.kind === 'vertex' && (String(c.id) === 'LBL_' + ref || String(c.id) === 'LBL_' + me.id)) group.push(c.id);
    for (const id of group) updateCell(model, id, { dx });
  };
  const mid = (a, b) => (a.x + b.x) / 2;
  if (L.LA) move(L.LA, drain(L.iA).x - lower(L.LA).x);
  if (L.LB) move(L.LB, drain(L.iB).x - lower(L.LB).x);
  if (L.tI) move(L.tI, mid(source(L.iA), source(L.iB)) - drain(L.tI).x);
  if (L.tC) move(L.tC, mid(source(L.cA), source(L.cB)) - drain(L.tC).x);
  if (L.tT && L.tI && L.tC) move(L.tT, mid(source(L.tI), source(L.tC)) - drain(L.tT).x);
  const ids = cells().filter((c) => c.kind === 'edge').map((e) => e.id);
  for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
  await routePage(model, ids, {});
  // each pair's source net (two sources + the switch's drain) as ONE line
  // under the pair, the switch's wire teeing into it — the router drew two
  // parallel lines a few pixels apart
  for (const [a, b, f] of [[L.iA, L.iB, L.tI], [L.cA, L.cB, L.tC], [L.tI, L.tC, L.tT]]) if (a && b && f) teeNet(model, find(a), find(b), find(f));
  rebuildLocalDots(model);
}

function teeNet(model, A, B, F) {
  const rel = (c, k) => activePins(classify(c))[k];
  const sA = rel(A, 2), sB = rel(B, 2), dF = rel(F, 0);
  const at = (e, end, c, r) => (end === 'exit' ? e.source : e.target) === c.id && Math.abs(Number(e.style.map.get(end + 'X') ?? -1) - r.x) < 0.02 && Math.abs(Number(e.style.map.get(end + 'Y') ?? -1) - r.y) < 0.02;
  const onNet = (e, end) => at(e, end, A, sA) || at(e, end, B, sB) || at(e, end, F, dF);
  const old = allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && onNet(e, 'exit') && onNet(e, 'entry'));
  if (old.length !== 2) return;   // not the simple 3-pin net drawn as two wires
  const pa = pinAbs(A, sA), pb = pinAbs(B, sB), pf = pinAbs(F, dF);
  if (Math.abs(pa.y - pb.y) > 0.5 || pf.y <= pa.y + 20) return;
  const y = Math.round(pa.y + Math.min(26, (pf.y - pa.y) / 2));
  const st = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;';
  for (const e of old) deleteCell(model, e.id);
  addWire(model, { source: A.id, target: B.id, sourcePin: sA, targetPin: sB, style: st, points: [{ x: pa.x, y }, { x: pb.x, y }] });
  const near = Math.abs(pf.x - pa.x) < Math.abs(pf.x - pb.x) ? [A, sA, pa] : [B, sB, pb];
  addWire(model, { source: F.id, target: near[0].id, sourcePin: dF, targetPin: near[1], style: st, points: [{ x: pf.x, y }, { x: near[2].x, y }] });
}
