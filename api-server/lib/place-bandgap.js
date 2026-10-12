/**
 * place-bandgap.js — engine "bandgap": the BANDGAP REFERENCE core drawn as
 * textbooks draw it (Eric's list, 2026-10-12, fourth batch): one column per
 * branch from the supply to the ground, the feeding devices (a PMOS mirror,
 * gates on one line) or resistors on top, the resistors in their column, the
 * diode-connected bipolars on one row at the bottom; the amplifier (or the
 * rest) beside the columns.
 *
 *     ┤M1 ── M2 ── M3├        mirror row (gates on one line)
 *      │     │     │
 *      X     Y     │          the amplifier's inputs on X and Y
 *      │     R1    R2
 *      │     │     │
 *     Q1    Q2    Q3          diodes on one row, ground below
 *
 * Read: two or more COLUMNS, each a diode-connected bipolar (a substrate PNP:
 * base and collector on the ground; or an NPN with base on collector, emitter
 * on the ground) or diode at the bottom, a series chain of resistors over it
 * (possibly none), and a feeder on top: a device of the supply's polarity with
 * its drain on the column's top node, or a resistor to the supply. With
 * device feeders, they share their gate net (a mirror). Parts hanging from a
 * column node to the ground (Banba's resistors) are drawn beside the column.
 * AUTO_BANDGAP=0 disables.
 */
import { isPmosLike } from './patterns.js';
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell, addWire, deleteCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';
import { alignPorts } from './align-ports.js';
import { attachPassives } from './template-attach.js';
import { alignRails, dropAmong, STF, relPin, atPin } from './place-ota.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
const GNDN = /^(0|gnd\w*|vss\w*|vee\w*|avss|dvss)$/i;
const SUP = (n) => RAIL.test(n) && !GNDN.test(n);
const isAct = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];

/** A diode-connected bipolar / diode: its top node, or null. */
function diodeTop(c) {
  if (c.prefix === 'Q') {
    // substrate PNP: collector and base on the ground, emitter up
    if (isPmosLike(c) && GNDN.test(D(c)) && GNDN.test(G(c)) && !RAIL.test(S(c))) return S(c);
    // NPN in diode: base on collector, emitter on the ground
    if (!isPmosLike(c) && D(c) === G(c) && GNDN.test(S(c)) && !RAIL.test(D(c))) return D(c);
    return null;
  }
  if (c.prefix === 'D') { const [a, k] = c.nodes; return GNDN.test(k) && !RAIL.test(a) ? a : null; }
  return null;
}

export function bandgapReading(parsed) {
  const comps = parsed.components;
  const ends = (c) => (isAct(c) ? [D(c), S(c)] : ['R', 'L'].includes(c.prefix) ? c.nodes.slice(0, 2) : null);
  const toGnd = (c, n) => c.prefix === 'R' && c.nodes.slice(0, 2).includes(n) && c.nodes.slice(0, 2).some((y) => GNDN.test(y));
  const cols = [], used = new Set(), side = [];
  for (const q of comps) {
    const bottom = diodeTop(q); if (!bottom || used.has(q.ref)) continue;
    // up the column through resistors and devices (drain / source) until the
    // supply; a resistor from a column node to the ground is a side part
    const chain = []; let n = bottom; const sides = [];
    let feed = null;
    for (let k = 0; k < 5 && !feed; k++) {
      const cur = comps.filter((c) => c !== q && !used.has(c.ref) && !chain.includes(c) && ends(c) && ends(c).includes(n) && ends(c)[0] !== ends(c)[1]);
      const g = cur.filter((c) => toGnd(c, n)); sides.push(...g.map((c) => ({ r: c.ref, node: n })));
      const up = cur.filter((c) => !toGnd(c, n) && !(isAct(c) && GNDN.test(ends(c).find((x) => x !== n))));
      if (up.length !== 1) break;
      const c = up[0], next = ends(c).find((x) => x !== n);
      if (SUP(next)) { feed = c; break; }
      if (RAIL.test(next)) break;
      chain.push(c); n = next;
    }
    if (!feed) continue;
    cols.push({ q: q.ref, chain: chain.map((c) => c.ref).reverse(), feed: feed.ref, top: n, bottom });
    used.add(q.ref); chain.forEach((c) => used.add(c.ref)); used.add(feed.ref);
    for (const sd of sides) if (!used.has(sd.r)) { used.add(sd.r); side.push({ col: q.ref, ...sd }); }
  }
  if (cols.length < 2) return null;
  // device feeders: one mirror (same gate net); resistor feeders: all resistors
  const fd = cols.map((c) => comps.find((x) => x.ref === c.feed));
  const devs = fd.filter(isAct);
  if (devs.length && (devs.length !== cols.length || new Set(devs.map(G)).size !== 1)) return null;
  // ΔVbe: a resistor in series in one column (or a side resistor)
  const res = (c) => c.chain.some((r) => r.startsWith('R') || comps.find((x) => x.ref === r)?.prefix === 'R');
  if (!cols.some(res)) return null;
  // a self-biased reference (several diode-connected devices stacked in the
  // columns, no amplifier: analoggenie/859) is not a bandgap core — its links
  // crowded the middle and the generic drawing was cleaner (orchestrator
  // 2026-10-13)
  const diodes = cols.flatMap((c) => [c.feed, ...c.chain]).map((r) => comps.find((x) => x.ref === r)).filter((x) => x.prefix === 'M' && D(x) === G(x));
  if (diodes.length > 2) return null;
  // the plain diode first, then by resistors
  cols.sort((a, b) => a.chain.length - b.chain.length);
  return { cols, side, mirror: devs.length ? G(devs[0]) : null, used };
}

/** place-sa's start (units of the median part size). */
export function bandgapLayout(parsed, R) {
  const pos = new Map();
  R.cols.forEach((c, i) => {
    const x = 2 * i;
    pos.set(c.feed, { x, y: 0 });
    c.chain.forEach((r, k) => pos.set(r, { x, y: 1.5 * (k + 1) }));
    pos.set(c.q, { x, y: 1.5 * (c.chain.length + 2) });
  });
  let n = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: -3 - 1.5 * n++, y: 1.5 });
  return pos;
}

export async function importNetlistBandgap(model, parsed, opts = {}) {
  const R = bandgapReading(parsed);
  if (!R) throw new Error('bandgap: no bandgap core');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: bandgapLayout(parsed, R), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await impose(model, parsed, R);
  return placed;
}

async function impose(model, parsed, R) {
  const comp = new Map(parsed.components.map((c) => [c.ref, c]));
  const cells = () => allCells(model).map(cellInfo);
  const find = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const pinsOf = (r) => { const c = find(r); return activePins(classify(c)).map((p) => pinAbs(c, p)); };
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
    if (!ref || !isAct(comp.get(ref)) || comp.get(ref).prefix === 'Q' && diodeTop(comp.get(ref))) return;
    const c = find(ref), g = pinsOf(ref)[1], mid = c.x + c.w / 2;
    if ((side === 'left') !== (g.x < mid)) updateCell(model, c.id, { style: { flipH: String(c.style.map.get('flipH') || '0') === '1' ? null : 1 } });
  };
  // the pin index of a part on a net (a device: drain 0 / source 2; a diode
  // bipolar: its top node)
  const kOn = (ref, net) => { const c = comp.get(ref); if (isAct(c)) return c.nodes.slice(0, 3).indexOf(net) === 1 ? (D(c) === net ? 0 : 2) : c.nodes.slice(0, 3).indexOf(net); return c.nodes.slice(0, 2).indexOf(net); };
  // a 2-terminal part upright with its pin on `net` on top
  const stand = (ref, net) => {
    const c0 = find(ref), k = comp.get(ref).nodes.indexOf(net);
    for (const rot of [0, 90, 180, 270]) {
      updateCell(model, c0.id, { style: { rotation: rot || null, flipV: null, flipH: null } });
      const ps = pinsOf(ref);
      if (ps.length >= 2 && Math.abs(ps[0].x - ps[1].x) < 1 && ps[k].y < ps[1 - k].y) break;
    }
  };
  // each column top to bottom: feeder, chain, diode; the nets between them
  const colParts = R.cols.map((c) => [c.feed, ...c.chain, c.q]);
  const nets = R.cols.map((c, i) => {
    const out = []; const ps = colParts[i];
    for (let k = 0; k + 1 < ps.length; k++) {
      const a = comp.get(ps[k]), b = comp.get(ps[k + 1]);
      const ea = isAct(a) ? [D(a), S(a)] : a.nodes.slice(0, 2), eb = b.prefix === 'Q' && diodeTop(b) ? [diodeTop(b)] : isAct(b) ? [D(b), S(b)] : b.nodes.slice(0, 2);
      out.push(ea.find((x) => eb.includes(x)));
    }
    return out;
  });
  const n = R.cols.length;
  R.cols.forEach((c, i) => colParts[i].forEach((r) => { if (!isAct(comp.get(r))) stand(r, (nets[i][colParts[i].indexOf(r) - 1]) ?? comp.get(r).nodes.find(SUP)); face(r, n === 2 ? (i === 0 ? 'right' : 'left') : (i === 0 ? 'right' : 'left')); }));
  // the diodes: base (and collector) leads to the left, away from the side
  // resistors on the right of the columns
  for (const c of R.cols) {
    const q = comp.get(c.q); if (q.prefix !== 'Q') continue;
    const cell = find(c.q), g = pinsOf(c.q)[1];
    if (g.x > cell.x + cell.w / 2) updateCell(model, cell.id, { style: { flipH: String(cell.style.map.get('flipH') || '0') === '1' ? null : 1 } });
  }
  const all = colParts.flat();
  const H = Math.max(...all.map((r) => find(r).h)), W = Math.max(...all.map((r) => find(r).w));
  const ROW = Math.round(1.6 * H), SP = Math.max(3 * W + 60, 230);
  const f0 = find(R.cols[0].feed), x0 = Math.round(f0.x + f0.w / 2), y0 = Math.round(f0.y + f0.h / 2);
  // rows from the top; the diodes on the last row
  const rows = Math.max(...colParts.map((p) => p.length));
  const yRow = (k) => y0 + k * ROW;
  colParts.forEach((ps, i) => {
    const x = x0 + i * SP;
    ps.forEach((r, k) => {
      const row = k === ps.length - 1 ? rows - 1 : k;
      // the column line: through the pin on the net above (or the top pin)
      const up = k ? nets[i][k - 1] : null, ref = r;
      const pk = up != null ? kOn(ref, up) : (isAct(comp.get(ref)) ? kOn(ref, comp.get(ref).nodes.find(SUP)) : comp.get(ref).nodes.slice(0, 2).findIndex(SUP));
      const q = pinsOf(ref)[pk], c = find(ref);
      move(ref, x - q.x, yRow(row) - (c.y + c.h / 2));
    });
  });
  // side resistors (Banba): beside their node, standing to the ground
  R.side.forEach((sd, j) => {
    const i = R.cols.findIndex((c) => c.q === sd.col), ps = colParts[i];
    stand(sd.r, sd.node);
    const k = nets[i].indexOf(sd.node), yN = k >= 0 ? (pinsOf(ps[k])[kOn(ps[k], sd.node)].y + pinsOf(ps[k + 1])[kOn(ps[k + 1], sd.node)].y) / 2 : pinsOf(R.cols[i].q)[kOn(R.cols[i].q, sd.node)]?.y;
    const q = pinsOf(sd.r)[comp.get(sd.r).nodes.indexOf(sd.node)];
    move(sd.r, x0 + i * SP + (i === n - 1 ? 1 : -1) * (i === 0 && n === 2 ? -1 : 1) * Math.max(70, W * 0.8) - q.x, yN + 24 - q.y);
    void j;
  });
  const tpl = [...R.used];
  const att = new Set(attachPassives(model, parsed, tpl).attached);
  // parts outside the core overlapping it: to its left (the amplifier)
  {
    const T2 = tpl.map(find).filter(Boolean);
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
  // the columns: each node straight between its two parts
  colParts.forEach((ps, i) => {
    for (let k = 0; k + 1 < ps.length; k++) {
      const net = nets[i][k], a = P(ps[k], kOn(ps[k], net)), b = P(ps[k + 1], kOn(ps[k + 1], net));
      if (Math.abs(pinAbs(...a).x - pinAbs(...b).x) > 0.5) continue;
      reroute.push(...moveWires(model, b[0], b[1], a[0], a[1]));
      dropAmong(model, [a, b]);
      wire(model, b, a);
    }
  });
  // gate lines between the first two columns (devices of one row on one gate
  // net; a third column's gate joins that line over the row)
  for (let i = 0; i + 1 < Math.min(n, 2); i++) {
    for (let k = 0; k < rows; k++) {
      const ra = colParts[i][k], rb = colParts[i + 1][k];
      if (!ra || !rb || !isAct(comp.get(ra)) || !isAct(comp.get(rb)) || G(comp.get(ra)) !== G(comp.get(rb))) continue;
      const pa = P(ra, 1), pb = P(rb, 1);
      if (Math.abs(pinAbs(...pa).y - pinAbs(...pb).y) > 0.5 || pinAbs(...pa).x > pinAbs(...pb).x) continue;
      // the net's ports wired to these gates alone (one label per pin): one
      // kept, on a stem under the line (Eric 2026-10-12: no duplicated labels)
      const net = G(comp.get(ra)), ports = netPorts(model, net, [pa, pb]);
      for (const o of ports) for (const e of cells().filter((e) => e.kind === 'edge' && (e.source === o.id || e.target === o.id))) deleteCell(model, e.id);
      for (const o of ports.slice(1)) deleteCell(model, o.id);
      reroute.push(...moveWires(model, pb[0], pb[1], pa[0], pa[1]));
      dropAmong(model, [pa, pb]);
      wire(model, pb, pa);
      const span = pinAbs(...pb).x - pinAbs(...pa).x;
      if (ports[0]) stemPort(model, ports[0], [pa, pb], Math.round(pinAbs(...pa).x + 0.7 * span - ports[0].w / 2), pinAbs(...pa).y, 1);
      // a mirror whose gate line is a column node (not a diode of its own
      // row): the link from that node into the middle, up (down) to the line
      for (const [j, side] of [[i, 1], [i + 1, -1]]) {
        const kk = nets[j].indexOf(net); if (kk < 0 || kk === k || kk === k - 1) continue;
        const up = P(colParts[j][kk], kOn(colParts[j][kk], net)), lo = P(colParts[j][kk + 1], kOn(colParts[j][kk + 1], net));
        const yn = Math.round((pinAbs(...up).y + pinAbs(...lo).y) / 2), xm = Math.round(pinAbs(...pa).x + (side > 0 ? 0.25 : 0.4) * span);   // left of the stem ports
        dropAmong(model, [pa, pb, up, lo]);
        wire(model, pb, pa); wire(model, lo, up);
        wire(model, up, pa, [{ x: pinAbs(...up).x, y: yn }, { x: xm, y: yn }, { x: xm, y: pinAbs(...pa).y }]);
        break;
      }
    }
  }
  for (let j = 2; j < n; j++) {
    for (let k = 0; k < rows; k++) {
      const r0 = colParts[0][k], r1 = colParts[1][k], rj = colParts[j][k];
      if (!r0 || !r1 || !rj || ![r0, r1, rj].every((r) => isAct(comp.get(r))) || new Set([r0, r1, rj].map((r) => G(comp.get(r)))).size !== 1) continue;
      const pj = P(rj, 1), p0 = pinAbs(...P(r0, 1)), p1 = pinAbs(...P(r1, 1)), gj = pinAbs(...pj);
      if (Math.abs(gj.y - p0.y) > 0.5) continue;
      const yA = Math.round(Math.min(F(r1).y, F(rj).y) - 12), xk = Math.round(gj.x - 20), x01 = Math.round(p0.x + 0.6 * (p1.x - p0.x));
      reroute.push(...moveWires(model, pj[0], pj[1], ...P(r0, 1)));
      wire(model, pj, P(r0, 1), [{ x: xk, y: gj.y }, { x: xk, y: yA }, { x: x01, y: yA }, { x: x01, y: p0.y }]);
    }
  }
  // a diode-connected device in a column: its gate tied to its drain beside it
  for (const r of colParts.flat()) {
    const pc = comp.get(r); if (!isAct(pc) || pc.prefix === 'Q' || G(pc) !== D(pc)) continue;
    const g = P(r, 1), d = P(r, 0), pg = pinAbs(...g), pd = pinAbs(...d), dir = pd.y < pg.y ? -1 : 1;
    const xo = Math.round(pg.x + (pg.x < pd.x ? -15 : 15)), yo = Math.round(pd.y + dir * 15);
    dropAmong(model, [g, d]);   // the direct gate-drain wire only: the gate keeps its line
    wire(model, g, d, [{ x: xo, y: pg.y }, { x: xo, y: yo }, { x: pd.x, y: yo }]);
  }
  // side resistors: across from the column node, standing to the ground
  for (const sd of R.side) {
    const i = R.cols.findIndex((c) => c.q === sd.col), ps = colParts[i], k = nets[i].indexOf(sd.node);
    const tgt = k >= 0 ? P(ps[k], kOn(ps[k], sd.node)) : P(R.cols[i].q, kOn(R.cols[i].q, sd.node));
    const sr = P(sd.r, comp.get(sd.r).nodes.indexOf(sd.node)), at = pinAbs(...sr), tp = pinAbs(...tgt);
    reroute.push(...moveWires(model, sr[0], sr[1], tgt[0], tgt[1]));
    wire(model, sr, tgt, [{ x: at.x, y: Math.round(at.y - 24) }, { x: tp.x, y: Math.round(at.y - 24) }]);
  }
  if (reroute.length) await routePage(model, reroute, {});
  await alignPorts(model);
  alignRails(model);
  for (const r of R.used) { const c = find(r); if (c) updateCell(model, c.id, { style: { drawioApiPinned: 1 } }); }
  rebuildLocalDots(model);
}

/** The ports of a net whose wires all end on these pins or on each other. */
function netPorts(model, net, pins) {
  const cs = allCells(model).map(cellInfo), edges = cs.filter((e) => e.kind === 'edge');
  const mine = cs.filter((v) => v.kind === 'vertex' && classify(v).role === 'port' && String(classify(v).net || v.value || '').trim().toLowerCase() === String(net).toLowerCase());
  const ids = new Set(mine.map((v) => v.id));
  const on = (e) => pins.some(([c, r]) => atPin(e, 'exit', c, r) || atPin(e, 'entry', c, r)) || (ids.has(e.source) && ids.has(e.target));
  return mine.every((v) => edges.filter((e) => e.source === v.id || e.target === v.id).every(on)) ? mine : [];
}

/** A port on a stem off a horizontal line at height y (dir +1: under it). */
function stemPort(model, port, pins, x, y, dir) {
  const ys = Math.round(y + dir * 40);
  updateCell(model, port.id, { x: Math.round(x), y: Math.round(ys - port.h / 2), style: { flipH: null, rotation: null, drawioApiPinned: 1 } });
  const Pc = allCells(model).map(cellInfo).find((c) => c.id === port.id);
  const end = { x: 0.5, y: dir > 0 ? 0 : 1 }, tip = pinAbs(Pc, end);
  for (const [c, r] of pins) addWire(model, { source: port.id, target: c.id, sourcePin: end, targetPin: r, style: STF, points: [{ x: tip.x, y }] });
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
    // (a wire to another pin of the same part — a diode's gate to its drain —
    // is kept, moved too; only the wire to the target itself goes)
    if ((oid === T.id && Math.abs(orel.x - trel.x) < 0.02 && Math.abs(orel.y - trel.y) < 0.02) || (oid === C.id && Math.abs(orel.x - rel.x) < 0.02 && Math.abs(orel.y - rel.y) < 0.02)) continue;
    out.push(addWire(model, { source: oid, target: T.id, sourcePin: orel, targetPin: trel, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }).getAttribute('id'));
  }
  return out;
}
