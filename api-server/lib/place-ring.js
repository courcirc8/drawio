/**
 * place-ring.js — engine "ring": the CMOS RING OSCILLATOR drawn as textbooks
 * draw it (Eric's list, 2026-10-12, fifth batch): the inverters left to right
 * on one row, each a PMOS over an NMOS with their gates tied, each output
 * straight on to the next input, the last output fed back under the row to
 * the first input. A current-starved ring has its starving devices over /
 * under each inverter, their gates on one bias line each (one port), the
 * bias generator on the left.
 *
 *      ┤sp   ┤sp   ┤sp        ─ biasP line (over the row)
 *   ┌─┤p ┌──┤p ┌──┤p
 *   │  ├──┘  ├──┘  ├──┬── OUT
 *   └─┤n └──┤n └──┤n  │
 *      ┤sn   ┤sn   ┤sn │      ─ biasN line (under the row)
 *   └──────────────────┘      feedback
 *
 * Reading: lib/ring-reading.js. AUTO_RING=0 disables.
 */
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell, addWire, deleteCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';
import { alignPorts } from './align-ports.js';
import { attachPassives } from './template-attach.js';
import { alignRails, dropAmong, STF, relPin, atPin } from './place-ota.js';
import { ringReading } from './ring-reading.js';

export { ringReading };

/** place-sa's start (units of the median part size). */
export function ringLayout(parsed, R) {
  const pos = new Map();
  R.stages.forEach((s, k) => {
    pos.set(s.p, { x: 2 * k + 2, y: 0 }); pos.set(s.n, { x: 2 * k + 2, y: 1.6 });
    if (s.sp) pos.set(s.sp, { x: 2 * k + 2, y: -1.6 }); if (s.sn) pos.set(s.sn, { x: 2 * k + 2, y: 3.2 });
    if (s.load) pos.set(s.load, { x: 2 * k + 3, y: 2.4 });
  });
  R.biasDevs.forEach((r, j) => pos.set(r, { x: 0, y: j ? 3.2 : -1.6 }));
  let n = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: -2 - 1.5 * n++, y: 0 });
  return pos;
}

export async function importNetlistRing(model, parsed, opts = {}) {
  const R = ringReading(parsed);
  if (!R) throw new Error('ring: no ring oscillator');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: ringLayout(parsed, R), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await impose(model, parsed, R);
  return placed;
}

const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];

async function impose(model, parsed, R) {
  const comp = new Map(parsed.components.map((c) => [c.ref, c]));
  const cells = () => allCells(model).map(cellInfo);
  const find = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const pinsOf = (r) => { const c = find(r); return activePins(classify(c)).map((p) => pinAbs(c, p)); };
  const pin = (r, k) => pinsOf(r)[k];
  const ctr = (r) => { const c = find(r); return { x: c.x + c.w / 2, y: c.y + c.h / 2 }; };
  const move = (ref, dx, dy = 0) => {
    dx = Math.round(dx); dy = Math.round(dy); if (!ref || (!dx && !dy)) return;
    const cs = cells(), me = cs.find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref); if (!me) return;
    const edges = cs.filter((c) => c.kind === 'edge'), group = [me.id];
    for (const v of cs.filter((c) => c.kind === 'vertex' && ['power', 'ground', 'port'].includes(classify(c).role))) {
      const peers = new Set(edges.filter((e) => e.source === v.id || e.target === v.id).map((e) => (e.source === v.id ? e.target : e.source)));
      if (peers.size === 1 && peers.has(me.id)) group.push(v.id);
    }
    for (const c of cs) if (c.kind === 'vertex' && (String(c.id) === 'LBL_' + ref || String(c.id) === 'LBL_' + me.id)) group.push(c.id);
    for (const id of group) updateCell(model, id, { dx, dy });
  };
  const face = (ref, side) => {
    if (!ref) return;
    const c = find(ref), g = pin(ref, 1), mid = c.x + c.w / 2;
    if ((side === 'left') !== (g.x < mid)) updateCell(model, c.id, { style: { flipH: String(c.style.map.get('flipH') || '0') === '1' ? null : 1 } });
  };
  const all = R.stages.flatMap((s) => [s.p, s.n, s.sp, s.sn]).filter(Boolean);
  for (const r of [...all, ...R.biasDevs]) face(r, 'left');
  const H = Math.max(...all.map((r) => find(r).h)), W = Math.max(...all.map((r) => find(r).w));
  const ROW = Math.round(1.6 * H), SP = Math.max(2 * W + 110, 230);
  const p0 = R.stages[0].p, x0 = Math.round(pin(p0, 0).x), y0 = Math.round(ctr(p0).y);
  // each inverter: PMOS over NMOS, drains on one vertical; the starving
  // devices over / under, drains on the inverter's sources
  R.stages.forEach((s, k) => {
    const x = x0 + k * SP;
    const put = (r, kPin, yC) => { const q = pin(r, kPin); move(r, x - q.x, 0); const c = ctr(r); move(r, 0, yC - c.y); };
    put(s.p, 0, y0); put(s.n, 0, y0 + ROW);
    if (s.sp) put(s.sp, 0, y0 - ROW);
    if (s.sn) put(s.sn, 0, y0 + 2 * ROW);
  });
  // the bias generator: one column left of the first stage (a PMOS on the
  // starving PMOS row, an NMOS on the starving NMOS row)
  const xb = x0 - SP;
  for (const r of R.biasDevs) {
    const c = comp.get(r), isP = /pmos|pfet|pch/i.test(c.model || '');
    const q = pin(r, 0); move(r, xb - q.x, 0); const cc = ctr(r); move(r, 0, (isP ? y0 - ROW : y0 + 2 * ROW) - cc.y);
  }
  // load capacitors: standing under each output node, right of its inverter
  const yMid = (s) => Math.round((pin(s.p, 0).y + pin(s.n, 0).y) / 2);
  for (const s of R.stages) {
    if (!s.load) continue;
    const L = find(s.load), pc = comp.get(s.load), k = pc.nodes.indexOf(s.out);
    for (const rot of [0, 90, 180, 270]) {
      updateCell(model, L.id, { style: { rotation: rot || null, flipV: null, flipH: null } });
      const ps = pinsOf(s.load);
      if (Math.abs(ps[0].x - ps[1].x) < 1 && ps[k].y < ps[1 - k].y) break;
    }
    const q = pinsOf(s.load)[k]; move(s.load, pin(s.p, 0).x + 45 - q.x, yMid(s) + 30 - q.y);
  }
  const att = new Set(attachPassives(model, parsed, [...R.used]).attached);
  // parts outside the ring overlapping it: to its left
  {
    const T2 = [...R.used].map(find).filter(Boolean);
    const box = { x0: Math.min(...T2.map((c) => c.x)) - 60, x1: Math.max(...T2.map((c) => c.x + c.w)) + 60, y0: Math.min(...T2.map((c) => c.y)) - 30, y1: Math.max(...T2.map((c) => c.y + c.h)) + 30 };
    let x = box.x0 - 60;
    const others = cells().filter((c) => c.kind === 'vertex' && classify(c).role === 'component' && !R.used.has(String(c.refdes || '')) && !att.has(String(c.refdes || ''))).sort((p, q) => q.x - p.x);
    for (const c0 of others) {
      const c = find(String(c0.refdes));
      if (!(c.x < box.x1 && c.x + c.w > box.x0 && c.y < box.y1 && c.y + c.h > box.y0)) continue;
      const free = (xx) => !cells().some((o) => o.kind === 'vertex' && o.id !== c.id && classify(o).role === 'component' && o.x < xx + c.w + 30 && o.x + o.w + 30 > xx && o.y < c.y + c.h && o.y + o.h > c.y);
      while (!free(x - c.w)) x -= 40;
      move(String(c.refdes), x - c.w - c.x, 0);
      x -= c.w + 60;
    }
  }
  const ids = cells().filter((c) => c.kind === 'edge').map((e) => e.id);
  for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
  await routePage(model, ids, {});
  const F = (r) => find(r), P = (r, k) => [F(r), relPin(F(r), k)];
  const reroute = [];
  const n = R.stages.length;
  // one net at a time: every wire on its template pins goes, the other parts
  // it reached are joined to `rep` (routed), the template wires are drawn
  const rewire = (pins, rep) => {
    const on = (e, end) => pins.some(([c, r]) => atPin(e, end, c, r));
    const seen = new Set();
    for (const e of cells().filter((e) => e.kind === 'edge' && (on(e, 'exit') || on(e, 'entry')))) {
      deleteCell(model, e.id);
      for (const end of ['exit', 'entry']) {
        if (on(e, end)) continue;
        const oid = end === 'exit' ? e.source : e.target, orel = { x: Number(e.style.map.get(end + 'X') ?? 0.5), y: Number(e.style.map.get(end + 'Y') ?? 0.5) };
        const key = oid + ':' + orel.x + ':' + orel.y; if (seen.has(key)) continue; seen.add(key);
        reroute.push({ oid, orel, rep });
      }
    }
  };
  R.stages.forEach((s, k) => {
    const nx = R.stages[(k + 1) % n];
    const dp = P(s.p, 0), dn = P(s.n, 0), gp = P(nx.p, 1), gn = P(nx.n, 1);
    // (this inverter's load capacitor hangs from its output line)
    const cap = s.load ? P(s.load, comp.get(s.load).nodes.indexOf(s.out)) : null;
    rewire([dp, dn, gp, gn, ...(cap ? [cap] : [])], dp);
    wire(model, dn, dp);
    if (cap) { const c = pinAbs(...cap); wire(model, cap, dp, [{ x: c.x, y: yMid(s) }, { x: pinAbs(...dp).x, y: yMid(s) }]); }
    // the next inverter's gates tied by a short bus left of them
    const xg = Math.round(pinAbs(...gp).x - 20), ym = yMid(s), xd = pinAbs(...dp).x;
    wire(model, gn, gp, [{ x: xg, y: pinAbs(...gn).y }, { x: xg, y: pinAbs(...gp).y }]);
    if (k + 1 < n) wire(model, gp, dp, [{ x: xg, y: pinAbs(...gp).y }, { x: xg, y: ym }, { x: xd, y: ym }]);
    else {
      // the feedback: onto the first gate bus, left of it, under the row, up
      // right of the last output
      const yLow = Math.max(...cells().filter((c) => c.kind === 'vertex' && classify(c).role === 'component' && R.used.has(String(c.refdes || ''))).map((c) => c.y + c.h)) + 40;
      const xr = Math.round(xd + 70), yg = yMid(R.stages[0]);
      // the output port (if any) on the feedback's corner: the output comes
      // in from the left, the feedback from below (a port on the line was
      // crossed by the wires)
      const port = cells().find((v) => v.kind === 'vertex' && classify(v).role === 'port' && String(classify(v).net || v.value || '').trim().toLowerCase() === String(s.out).toLowerCase());
      if (port) {
        for (const e of cells().filter((e) => e.kind === 'edge' && (e.source === port.id || e.target === port.id))) {
          const [oid, oend] = e.source === port.id ? [e.target, 'entry'] : [e.source, 'exit'];
          deleteCell(model, e.id);
          if (oid !== dp[0].id && oid !== dn[0].id) reroute.push({ oid, orel: { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) }, rep: dp });
        }
        updateCell(model, port.id, { x: Math.round(xr - 10), y: Math.round(ym - port.h / 2), style: { flipH: 1, rotation: null, drawioApiPinned: 1 } });
        const Pc = cells().find((c) => c.id === port.id);
        const tip = pinAbs(Pc, { x: 1, y: 0.5 }).x < pinAbs(Pc, { x: 0, y: 0.5 }).x ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 };
        wire(model, [Pc, tip], dp, [{ x: xd, y: ym }]);
        const bot = { x: 0.5, y: 1 }, pb = pinAbs(Pc, bot);
        wire(model, gp, [Pc, bot], [{ x: xg, y: pinAbs(...gp).y }, { x: xg, y: yg }, { x: xg - 30, y: yg }, { x: xg - 30, y: yLow }, { x: pb.x, y: yLow }]);
      } else wire(model, gp, dp, [{ x: xg, y: pinAbs(...gp).y }, { x: xg, y: yg }, { x: xg - 30, y: yg }, { x: xg - 30, y: yLow }, { x: xr, y: yLow }, { x: xr, y: ym }, { x: xd, y: ym }]);
    }
    // the starving devices: drain straight onto the inverter's source
    for (const [st, dev] of [[s.sp, s.p], [s.sn, s.n]]) {
      if (!st) continue;
      const a = P(st, 0), b = P(dev, 2);
      rewire([a, b], b); wire(model, a, b);
    }
  });
  // the bias lines: over the starving PMOS row, under the starving NMOS row;
  // each gate taps it on a short stem
  for (const [net, side] of [[R.biasP, -1], [R.biasN, 1]]) {
    if (!net) continue;
    const taps = [...R.stages.map((s) => (side < 0 ? s.sp : s.sn)), ...R.biasDevs.filter((r) => G(comp.get(r)) === net)].filter(Boolean);
    if (taps.length < 2) continue;
    const ys = taps.map((r) => (side < 0 ? F(r).y : F(r).y + F(r).h));
    const yBus = Math.round(side < 0 ? Math.min(...ys) - 14 : Math.max(...ys) + 14);
    const ref = taps.slice().sort((a, b) => pin(a, 1).x - pin(b, 1).x)[0], rp = P(ref, 1);
    rewire(taps.map((r) => P(r, 1)), rp);
    const rpa = pinAbs(...rp), xr = Math.round(rpa.x - 12);
    for (const r of taps) {
      if (r === ref) continue;
      const g = P(r, 1), gp = pinAbs(...g), xs = Math.round(gp.x - 12);
      wire(model, g, rp, [{ x: xs, y: gp.y }, { x: xs, y: yBus }, { x: xr, y: yBus }, { x: xr, y: rpa.y }]);
    }
  }
  // the other parts of each net, joined to its representative pin, routed
  const ids2 = reroute.map(({ oid, orel, rep }) => addWire(model, { source: oid, target: rep[0].id, sourcePin: orel, targetPin: rep[1], style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }).getAttribute('id'));
  reroute.length = 0; reroute.push(...ids2);
  if (reroute.length) await routePage(model, reroute, {});
  await alignPorts(model);
  alignRails(model);
  for (const r of R.used) { const c = find(r); if (c) updateCell(model, c.id, { style: { drawioApiPinned: 1 } }); }
  rebuildLocalDots(model);
  void D; void S; void deleteCell; void addWire;
}

/** A template wire, straight (edgeStyle=none) when all its segments are
 *  horizontal / vertical (an orthogonal wire leaves a bottom pin downwards). */
function wire(model, [A, ra], [B, rb], points = []) {
  const pa = pinAbs(A, ra), pb = pinAbs(B, rb), pts = points.filter((q) => !((Math.abs(q.x - pa.x) < 0.5 && Math.abs(q.y - pa.y) < 0.5) || (Math.abs(q.x - pb.x) < 0.5 && Math.abs(q.y - pb.y) < 0.5)));
  const all = [pa, ...pts, pb];
  const straight = all.every((q, i) => !i || Math.abs(q.x - all[i - 1].x) < 0.5 || Math.abs(q.y - all[i - 1].y) < 0.5);
  return addWire(model, { source: A.id, target: B.id, sourcePin: ra, targetPin: rb, style: straight ? STF.replace('orthogonalEdgeStyle', 'none') : STF, points: pts });
}

/** Delete the wires on one pin; whatever else they reached is joined to
 *  another pin of the same net by a new routable wire (ids returned). */
function moveWires(model, C, rel, T, trel) {
  const out = [];
  for (const e of allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && (atPin(e, 'exit', C, rel) || atPin(e, 'entry', C, rel)))) {
    const [oid, oend] = atPin(e, 'exit', C, rel) ? [e.target, 'entry'] : [e.source, 'exit'];
    const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
    deleteCell(model, e.id);
    if ((oid === T.id && Math.abs(orel.x - trel.x) < 0.02 && Math.abs(orel.y - trel.y) < 0.02) || (oid === C.id && Math.abs(orel.x - rel.x) < 0.02 && Math.abs(orel.y - rel.y) < 0.02)) continue;
    out.push(addWire(model, { source: oid, target: T.id, sourcePin: orel, targetPin: trel, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }).getAttribute('id'));
  }
  return out;
}
