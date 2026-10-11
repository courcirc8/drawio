/**
 * neutral.js — the NEUTRAL SCHEMATIC `schema-neutre/1` (orchestrator / Eric,
 * 2026-10-11: drawio becomes a schematic-creation skill for several tools —
 * draw.io, xschem, KiCad, Qucs-S, LTspice, Cadence; docs/export-multi-outils.md).
 *
 * The placement engine draws in the TARGET's geometry; this file turns the
 * drawn page into data a translator only has to write:
 *   components  ref, symbol, centre, size, rotation, mirror, every drawn pin
 *               (absolute position + net), the SPICE line it stands for
 *   wires       polylines, each on one net
 *   junctions, ports, rails (supply / ground symbols)
 * and checks itself: `neutralNetlist` rebuilds the netlist from the geometry
 * ALONE (pins, wire ends, wire segments, junctions, ports, rails) — no draw.io
 * object — so a neutral file that does not redraw the source deck is refused
 * before any translation (`checkNeutral`, LVS with lib/lvs.js).
 *
 * Conventions: y down; coordinates in the target's units (draw.io: px);
 * `mirror` is applied before `rot` (degrees, clockwise).
 */
import { allCells, cellInfo } from './model.js';
import { classify, activePins, pinOrderFor } from './components.js';
import { pinAbs, polylineOf } from './route.js';
import { connectivity, extractNetlist } from './netlist.js';
import { compare } from './lvs.js';

const r1 = (v) => Math.round(v * 2) / 2;   // half-unit grid for matching points
const key = (p) => `${r1(p.x)},${r1(p.y)}`;

/** The neutral schematic of a draw.io page. */
export function toNeutral(model, { target = { tool: 'drawio', unit: 'px', grid: 10 }, source = {} } = {}) {
  const cells = allCells(model).map(cellInfo), byId = new Map(cells.map((c) => [c.id, c]));
  const conn = connectivity(model), ex = extractNetlist(model);
  const exByRef = new Map(ex.components.map((c) => [String(c.ref).toUpperCase(), c]));
  const netAt = new Map();   // point key -> net (drawn terminals)
  const term = (cell, pin) => { const n = conn.netOf.get(cell.id + ':' + pin.name); return n == null ? '0' : n; };
  const components = [];
  for (const { cell, cls } of conn.components) {
    if (cls.mapping == null) continue;
    const ref = String(cell.refdes || cell.id), e = exByRef.get(ref.toUpperCase());
    const pins = {};
    for (const pin of activePins(cls)) { const at = pinAbs(cell, pin), net = term(cell, pin); pins[pin.name] = { at: [r1(at.x), r1(at.y)], net }; netAt.set(key(at), net); }
    const order = pinOrderFor(cls);
    // terminals the symbol does not draw (MOS bulk, BJT substrate): their nets, by SPICE index
    const hidden = {};
    if (e) e.fullNodes.forEach((n, i) => { if (e.fullNodes.length > e.nodes.length && !(i < order.length && pins[order[i]])) hidden[i] = n; });
    components.push({
      ref, symbol: cls.shape?.key || null,
      at: [r1(cell.x + cell.w / 2), r1(cell.y + cell.h / 2)], size: [cell.w, cell.h],
      rot: Number(cell.rotation || 0), mirror: { h: !!cell.flipH, v: !!cell.flipV },
      pins, spice: { prefix: cls.prefix, order, hidden, value: e ? e.value : '', model: e ? e.symbolModel : null },
    });
  }
  const rails = [], ports = [];
  for (const g of conn.grounds) for (const pin of activePins(g.cls)) { const at = pinAbs(g.cell, pin); rails.push({ net: '0', kind: 'ground', at: [r1(at.x), r1(at.y)] }); netAt.set(key(at), '0'); }
  for (const t of conn.taps) for (const pin of activePins(t.cls)) {
    const at = pinAbs(t.cell, pin), net = String(t.cls.net);
    if (t.cls.role === 'power') rails.push({ net, kind: 'supply', at: [r1(at.x), r1(at.y)] });
    else ports.push({ name: net, net, at: [r1(at.x), r1(at.y)], rot: Number(t.cell.rotation || 0), mirror: { h: !!t.cell.flipH, v: !!t.cell.flipV } });
    netAt.set(key(at), net);
  }
  // wires: polylines; a wire's net from a terminal at one of its ends (junction
  // ends are resolved by the wires already named, until nothing changes)
  const raw = cells.filter((c) => c.kind === 'edge').map((e) => ({ id: e.id, pts: (polylineOf(e, byId) || []).map((p) => ({ x: r1(p.x), y: r1(p.y) })) })).filter((w) => w.pts.length >= 2);
  const netOfWire = new Map();
  for (let round = 0; round < raw.length + 1; round++) {
    let changed = false;
    for (const w of raw) {
      if (netOfWire.has(w.id)) continue;
      const n = netAt.get(key(w.pts[0])) ?? netAt.get(key(w.pts.at(-1)));
      if (n != null) { netOfWire.set(w.id, n); for (const p of [w.pts[0], w.pts.at(-1)]) if (!netAt.has(key(p))) netAt.set(key(p), n); changed = true; }
    }
    if (!changed) break;
  }
  const wires = raw.map((w) => ({ net: netOfWire.get(w.id) ?? null, points: w.pts.map((p) => [p.x, p.y]) }));
  const junctions = cells.filter((c) => c.kind === 'vertex' && classify(c).role === 'junction').map((j) => { const at = { x: r1(j.x + j.w / 2), y: r1(j.y + j.h / 2) }; return { net: netAt.get(key(at)) ?? null, at: [at.x, at.y] }; });
  return { format: 'schema-neutre/1', target, source, components, wires, junctions, ports, rails };
}

/** The netlist the neutral schematic draws, from its geometry alone. */
export function neutralNetlist(N) {
  const parent = new Map(), find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const add = (a) => { if (!parent.has(a)) parent.set(a, a); return a; };
  const union = (a, b) => { const ra = find(add(a)), rb = find(add(b)); if (ra !== rb) parent.set(ra, rb); };
  const P = (p) => 'P:' + `${r1(p[0])},${r1(p[1])}`;
  const points = [];   // every connection point, to test against wire segments
  for (const c of N.components) for (const [pn, p] of Object.entries(c.pins)) { union('C:' + c.ref + ':' + pn, P(p.at)); points.push(p.at); }
  N.rails.forEach((r, i) => { union('R:' + i, P(r.at)); points.push(r.at); });
  N.ports.forEach((t, i) => { union('T:' + i, P(t.at)); points.push(t.at); });
  N.junctions.forEach((j) => points.push(j.at));
  N.wires.forEach((w, i) => { for (const p of w.points) union('W:' + i, P(p)); points.push(w.points[0], w.points.at(-1)); });
  // a point lying ON a wire segment joins that wire (a T, a junction dot)
  const on = (p, a, b) => (Math.abs(a[0] - b[0]) < 0.5 ? Math.abs(p[0] - a[0]) < 0.5 && p[1] >= Math.min(a[1], b[1]) - 0.5 && p[1] <= Math.max(a[1], b[1]) + 0.5
    : Math.abs(a[1] - b[1]) < 0.5 && Math.abs(p[1] - a[1]) < 0.5 && p[0] >= Math.min(a[0], b[0]) - 0.5 && p[0] <= Math.max(a[0], b[0]) + 0.5);
  N.wires.forEach((w, i) => { for (let k = 1; k < w.points.length; k++) for (const p of points) if (on(p, w.points[k - 1], w.points[k])) union('W:' + i, P(p)); });
  // names: ground 0, supply / port names, else fresh
  const name = new Map();
  N.rails.forEach((r, i) => { const k = find('R:' + i); if (r.kind === 'ground' || !name.has(k)) name.set(k, r.kind === 'ground' ? '0' : r.net); });
  N.ports.forEach((t, i) => { const k = find('T:' + i); if (!name.has(k)) name.set(k, t.net); });
  let n = 0; const used = new Set([...name.values()].map((x) => String(x).toUpperCase()));
  const netOf = (k) => { const r = find(k); if (!name.has(r)) { let nm; do { nm = 'n' + (++n); } while (used.has(nm.toUpperCase())); name.set(r, nm); } return name.get(r); };
  const components = N.components.map((c) => {
    const nodes = c.spice.order.map((pn) => (c.pins[pn] ? netOf('C:' + c.ref + ':' + pn) : '?'));
    const fullNodes = [...nodes];
    for (const [i, net] of Object.entries(c.spice.hidden || {}).sort((a, b) => a[0] - b[0])) fullNodes.splice(Number(i), 0, net);
    return { ref: c.ref, prefix: c.spice.prefix, nodes, fullNodes, value: c.spice.value, symbolModel: c.spice.model };
  });
  return { components, issues: [] };
}

/** LVS of a neutral schematic against the parsed source deck. */
export function checkNeutral(N, parsed) {
  return compare(neutralNetlist(N), parsed);
}
