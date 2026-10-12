/**
 * place-ldo.js — engine "ldo": the LOW-DROPOUT REGULATOR drawn as textbooks
 * draw it (Eric's list, 2026-10-12, last batch; the regulator family is no
 * longer held out): the error amplifier (a 5T OTA, lib/place-ota.js) on the
 * left, the pass device on the right on the mirror's row (its gate taken from
 * the amplifier's output as the two-stage Miller's second stage), the
 * feedback divider standing in a column under the output, the loads beside
 * it; the divider's tap back to its amplifier input by the router.
 *
 *      ┤mA ┤├ mB├           ┤pass├──VDD
 *        │      ├───────────┘   │
 *   ┤iA      iB├─VREF          ├── VOUT
 *         tail                  R1
 *                         fb ── ┤
 *                               R2
 * Read: a 5T OTA (lib/place-ota.js otaReading); a pass device whose gate is
 * the OTA output, source on the supply, drain on the output (not a rail); a
 * series divider from the output to the ground (resistors, 0 V sources standing
 * for ammeters) whose tap is an OTA input gate; loads (R, C, I) from the
 * output to the ground. AUTO_LDO=0 disables.
 */
import { otaReading, otaLayout, imposeOta, millerGate } from './place-ota.js';
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
const GNDN = /^(0|gnd\w*|vss\w*|vee\w*|avss|dvss)$/i;
const isAct = (c) => c.prefix === 'M' || c.prefix === 'Q';
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];

export function ldoReading(parsed) {
  const O = otaReading(parsed);
  if (!O) return null;
  const comps = parsed.components;
  const pass = comps.find((c) => !O.used.has(c.ref) && isAct(c) && G(c) === O.out && RAIL.test(S(c)) && !GNDN.test(S(c)) && !RAIL.test(D(c)));
  if (!pass) return null;
  const vout = D(pass);
  const byRef = new Map(comps.map((c) => [c.ref, c]));
  const inputs = [G(byRef.get(O.iA)), G(byRef.get(O.iB))];
  // the divider: a series chain from the output to the ground through
  // resistors and 0 V sources (ammeters), its tap on an amplifier input
  const used = new Set([...O.used, pass.ref]);
  const isLink = (c) => c.prefix === 'R' || (c.prefix === 'V' && /^(dc\s*)?0(\.0*)?$/i.test(String(c.value ?? '').trim()));
  const chain = []; let n = vout, tap = null;
  for (let k = 0; k < 6; k++) {
    const nx = comps.filter((c) => !used.has(c.ref) && !chain.includes(c) && isLink(c) && c.nodes.slice(0, 2).includes(n));
    // at the tap the chain goes on to the ground: take the part that is not a load
    const step = nx.find((c) => !GNDN.test(c.nodes.slice(0, 2).find((x) => x !== n)) || tap) || nx[0];
    if (!step) break;
    chain.push(step);
    n = step.nodes.slice(0, 2).find((x) => x !== n);
    if (inputs.includes(n)) tap = n;
    if (GNDN.test(n)) break;
  }
  if (!tap || !GNDN.test(n)) return null;
  chain.forEach((c) => used.add(c.ref));
  const loads = comps.filter((c) => !used.has(c.ref) && ['R', 'C', 'I'].includes(c.prefix) && c.nodes.slice(0, 2).includes(vout) && c.nodes.slice(0, 2).some((x) => GNDN.test(x)));
  loads.forEach((c) => used.add(c.ref));
  return { O, pass: pass.ref, vout, tap, chain: chain.map((c) => c.ref), loads: loads.map((c) => c.ref), used };
}

export async function importNetlistLdo(model, parsed, opts = {}) {
  const L = ldoReading(parsed);
  if (!L) throw new Error('ldo: no LDO');
  const pos = otaLayout(parsed, L.O), x = 6;
  pos.set(L.pass, { x, y: L.O.pmosIn ? 1.8 : -1.8 });
  L.chain.forEach((r, k) => pos.set(r, { x, y: 1 + 1.4 * k }));
  L.loads.forEach((r, k) => pos.set(r, { x: x + 1.5 + 1.2 * k, y: 1 }));
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: pos, saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await imposeOta(model, L.O, parsed);
  await impose(model, parsed, L);
  return placed;
}

async function impose(model, parsed, L) {
  const comp = new Map(parsed.components.map((c) => [c.ref, c]));
  const cells = () => allCells(model).map(cellInfo);
  const find = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const pinsOf = (r) => { const c = find(r); return activePins(classify(c)).map((p) => pinAbs(c, p)); };
  const move = (ref, dx, dy = 0) => {
    dx = Math.round(dx); dy = Math.round(dy); if (!dx && !dy) return;
    const cs = cells(), me = cs.find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref); if (!me) return;
    const edges = cs.filter((c) => c.kind === 'edge'), group = [me.id];
    for (const v of cs.filter((c) => c.kind === 'vertex' && ['power', 'ground', 'port'].includes(classify(c).role))) {
      const peers = new Set(edges.filter((e) => e.source === v.id || e.target === v.id).map((e) => (e.source === v.id ? e.target : e.source)));
      if (peers.size === 1 && peers.has(me.id)) group.push(v.id);
    }
    for (const c of cs) if (c.kind === 'vertex' && (String(c.id) === 'LBL_' + ref || String(c.id) === 'LBL_' + me.id)) group.push(c.id);
    for (const id of group) updateCell(model, id, { dx, dy });
  };
  const stand = (ref, net) => {   // upright, its pin on `net` on top
    const c0 = find(ref), k = comp.get(ref).nodes.indexOf(net);
    for (const rot of [0, 90, 180, 270]) {
      updateCell(model, c0.id, { style: { rotation: rot || null, flipV: null, flipH: null } });
      const ps = pinsOf(ref);
      if (ps.length >= 2 && Math.abs(ps[0].x - ps[1].x) < 1 && ps[k].y < ps[1 - k].y) break;
    }
  };
  const O = L.O, mB = find(O.mB), iB = find(O.iB), P = find(L.pass);
  // the pass device: right of the amplifier on the mirror's row, gate facing it
  const g0 = pinsOf(L.pass)[1];
  if (g0.x > P.x + P.w / 2) updateCell(model, P.id, { style: { flipH: String(P.style.map.get('flipH') || '0') === '1' ? null : 1 } });
  const right = Math.max(...cells().filter((c) => c.kind === 'vertex' && c.x != null && classify(c).role !== 'junction').filter((c) => [O.iA, O.iB, O.mA, O.mB, O.tail, O.bias, O.ref].includes(String(c.refdes || ''))).map((c) => c.x + c.w));
  { const p = find(L.pass); move(L.pass, right + 170 - p.x, (mB.y + mB.h / 2) - (p.y + p.h / 2)); }
  // the divider in a column under the output, the loads beside it
  const pd = pinsOf(L.pass)[0];
  let y = pd.y + 40, n = L.vout;
  for (const r of L.chain) {
    stand(r, n);
    const k = comp.get(r).nodes.indexOf(n), q = pinsOf(r)[k];
    move(r, pd.x - q.x, y - q.y);
    n = comp.get(r).nodes.slice(0, 2).find((x) => x !== n);
    y = pinsOf(r)[1 - k].y + 30;
  }
  L.loads.forEach((r, j) => {
    stand(r, L.vout);
    const q = pinsOf(r)[comp.get(r).nodes.indexOf(L.vout)];
    move(r, pd.x + 70 + 60 * j - q.x, pd.y + 40 - q.y);
  });
  // every wire of the moved parts routed again; the pass gate from the
  // amplifier's output like a second stage's
  const moved = new Set([L.pass, ...L.chain, ...L.loads].map((r) => find(r).id));
  const ids = cells().filter((e) => e.kind === 'edge' && (moved.has(e.source) || moved.has(e.target))).map((e) => e.id);
  for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
  const rr = millerGate(model, find(L.pass), iB, find(O.mB), Math.round((pinsOf(O.iB)[0].y + pinsOf(O.mB)[0].y) / 2));
  const after = cells().filter((e) => e.kind === 'edge' && (moved.has(e.source) || moved.has(e.target)) && !String(e.style.map.get('drawioApiFixedRoute') || '')).map((e) => e.id);
  await routePage(model, [...new Set([...after, ...rr])], {});
  for (const r of L.used) { const c = find(r); if (c) updateCell(model, c.id, { style: { drawioApiPinned: 1 } }); }
  rebuildLocalDots(model);
  void D;
}
