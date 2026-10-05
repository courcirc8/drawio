/**
 * place-sa.js — engine "sa": placement by simulated annealing against how
 * HUMANS place connected parts (Eric 2026-10-05: the rule-based engines draw
 * "nothing like a human"; option 2 of the alternatives).
 *
 *   1. place2 draws the netlist once: component cells with their orientation,
 *      supply / ground / port symbols. Every symbol is grouped with the part
 *      whose pin it serves (closest pin on its net).
 *   2. Wires and junction dots are dropped; parts (with their symbols) move on
 *      a grid to minimise
 *        Σ over connected pairs  −log P_human(offset | kinds and pin roles)
 *        + overlap penalty + λ · net half-perimeter
 *      P_human: /AI/datasets/human-layouts/relpos.json, learned on the AMSNet
 *      human drawings (tools/human/learn-relpos.py: PMOS above the NMOS sharing
 *      its drain in 98 % of 323 cases, source-coupled NMOS on one row in 95 %).
 *   3. Each net is rewired as a Manhattan minimum spanning tree over its pins,
 *      routed by routePage. Source-coupled pairs are mirrored (gates outwards).
 * The caller's LVS gate decides whether the result is usable.
 */
import fs from 'node:fs';
import { allCells, cellInfo, addWire, normalizeOrigin, deleteCell, updateCell } from './model.js';
import { importNetlist2 } from './place2.js';
import { routePage, pinAbs } from './route.js';
import { classify, activePins } from './components.js';
import { isPmosLike } from './patterns.js';

const RELPOS = '/AI/datasets/human-layouts/relpos.json';
let STATS = null;
const stats = () => (STATS ??= JSON.parse(fs.readFileSync(RELPOS, 'utf8')));
const RAIL = /^(0|gnd|vdd|vss|vcc|vee|avdd|avss|dvdd|dvss|agnd|dgnd|vpwr|vgnd)$/i;

function rolesOf(c) {
  const names = c.prefix === 'M' ? ['D', 'G', 'S', 'B'] : c.prefix === 'Q' ? ['C', 'B', 'E', 'S'] : ['p', 'n'];
  const m = new Map();
  c.nodes.slice(0, names.length).forEach((n, i) => { if (!m.has(n)) m.set(n, names[i]); });
  return m;
}
const kindOf = (c) => (c.prefix === 'M' ? (isPmosLike(c) ? 'pmos' : 'nmos') : c.prefix === 'Q' ? (/pnp/i.test(c.model || '') ? 'pnp' : 'npn') : c.prefix);

export async function importNetlistSA(model, parsed, opts = {}) {
  const placed = importNetlist2(model, parsed, opts);
  const S = stats(); const NB = S.n, B = S.bin, R = S.range;
  const cells = allCells(model).map(cellInfo);
  const comps = new Map(parsed.components.map((c) => [String(c.ref), c]));
  // parts (component cells) and their pins on nets
  const parts = [];
  for (const c of cells) {
    if (c.kind !== 'vertex' || c.x == null) continue;
    const cls = classify(c);
    if (cls.role !== 'component') continue;
    const pc = comps.get(String(c.refdes || c.id));
    if (!pc) continue;
    const pins = activePins(cls);
    parts.push({ cell: c, cls, pc, pins, x: c.x, y: c.y, w: c.w, h: c.h, taps: [], kind: kindOf(pc), roles: rolesOf(pc) });
  }
  if (parts.length < 3) { await routePage(model, placed.wires, {}); normalizeOrigin(model); return placed; }
  const pinNet = (p, i) => p.pc.nodes[i];
  // symbols: grouped with the closest part pin on their net
  const taps = [];
  for (const c of cells) {
    if (c.kind !== 'vertex' || c.x == null) continue;
    const cls = classify(c);
    if (cls.role === 'other' && String(c.value || '').trim()) {   // a text label (refdes, value): follows the closest part
      let bp = null, bd = Infinity;
      for (const p of parts) { const d = Math.hypot(p.x + p.w / 2 - (c.x + c.w / 2), p.y + p.h / 2 - (c.y + c.h / 2)); if (d < bd) { bd = d; bp = p; } }
      if (bp) bp.labels = [...(bp.labels || []), { cell: c, ox: c.x - bp.x, oy: c.y - bp.y }];
      continue;
    }
    if (!['power', 'ground', 'port'].includes(cls.role)) continue;
    const net = cls.role === 'ground' ? '0' : String(cls.net || c.value || '').trim();
    let best = null;
    for (const p of parts) p.pins.forEach((pin, i) => {
      if (String(pinNet(p, i)).toLowerCase() !== net.toLowerCase() && !(cls.role === 'ground' && pinNet(p, i) === '0')) return;
      const a = pinAbs(p.cell, pin); const d = Math.hypot(a.x - (c.x + c.w / 2), a.y - (c.y + c.h / 2));
      if (!best || d < best.d) best = { d, p, i };
    });
    const t = { cell: c, cls, net, pin: activePins(cls)[0], owner: best ? best.p : null, ox: 0, oy: 0 };
    if (best) { t.ox = c.x - best.p.x; t.oy = c.y - best.p.y; best.p.taps.push(t); }
    taps.push(t);
  }
  // drop wires and junction dots: every net is rewired after placement
  for (const c of cells) if (c.kind === 'edge' || (c.kind === 'vertex' && classify(c).role === 'junction')) { try { deleteCell(model, c.id); } catch { /* removed with its dot */ } }

  const u = [...parts.map((p) => Math.max(p.w, p.h))].sort((a, b) => a - b)[Math.floor(parts.length / 2)] || 60;
  const G = Math.max(10, Math.round(u / 4));
  // connected pairs (non-rail nets) with their log-probability table
  const pairs = [];
  for (let i = 0; i < parts.length; i++) for (let j = 0; j < parts.length; j++) {
    if (i === j) continue;
    const a = parts[i], b = parts[j];
    for (const [net, ra] of a.roles) {
      if (RAIL.test(net) || !b.roles.has(net)) continue;
      const k1 = `${a.kind}:${ra}|${b.kind}:${b.roles.get(net)}`, k2 = `${a.kind}|${b.kind}`;
      const lp = S.logp[k1] || S.logp[k2] || S.logp['*'];
      pairs.push({ i, j, lp });
    }
  }
  const nets = new Map();
  parts.forEach((p, i) => p.pc.nodes.forEach((n) => { if (!RAIL.test(n)) { if (!nets.has(n)) nets.set(n, new Set()); nets.get(n).add(i); } }));
  const netList = [...nets.values()].filter((s) => s.size > 1).map((s) => [...s]);
  const box = (p) => {   // part + its symbols, with a margin
    let x0 = p.x, y0 = p.y, x1 = p.x + p.w, y1 = p.y + p.h;
    for (const t of p.taps) { x0 = Math.min(x0, p.x + t.ox); y0 = Math.min(y0, p.y + t.oy); x1 = Math.max(x1, p.x + t.ox + t.cell.w); y1 = Math.max(y1, p.y + t.oy + t.cell.h); }
    const m = u * 0.25; return [x0 - m, y0 - m, x1 + m, y1 + m];
  };
  const cx = (p) => p.x + p.w / 2, cy = (p) => p.y + p.h / 2;
  const pairCost = (q) => {
    const a = parts[q.i], b = parts[q.j];
    const ix = Math.round(((cx(b) - cx(a)) / u + R) / B), iy = Math.round(((cy(b) - cy(a)) / u + R) / B);
    return (ix < 0 || iy < 0 || ix >= NB || iy >= NB) ? -Math.min(...q.lp) + 1 : -q.lp[iy * NB + ix];
  };
  const overlap = (a, b) => { const A = box(a), Bx = box(b); const w = Math.min(A[2], Bx[2]) - Math.max(A[0], Bx[0]), h = Math.min(A[3], Bx[3]) - Math.max(A[1], Bx[1]); return w > 0 && h > 0 ? (w * h) / (u * u) : 0; };
  const hpwl = (s) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const i of s) { x0 = Math.min(x0, cx(parts[i])); x1 = Math.max(x1, cx(parts[i])); y0 = Math.min(y0, cy(parts[i])); y1 = Math.max(y1, cy(parts[i])); } return (x1 - x0 + y1 - y0) / u; };
  const OV = 30, WL = opts.saWL ?? 1.5, PULL = opts.saPull ?? 0.15;
  const cost = () => {
    let c = 0; for (const q of pairs) c += pairCost(q);
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) c += OV * overlap(parts[i], parts[j]);
    for (const s of netList) c += WL * hpwl(s);
    // compaction: every part is pulled towards the centroid (no stray parts)
    let mx = 0, my = 0; for (const p of parts) { mx += cx(p); my += cy(p); } mx /= parts.length; my /= parts.length;
    for (const p of parts) c += PULL * (Math.abs(cx(p) - mx) + Math.abs(cy(p) - my)) / u;
    return c;
  };
  // annealing (deterministic seed)
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const T0 = opts.saT0 ?? 2; let cur = cost(), T = T0;
  const iters = opts.saIters || Math.min(60000, 1500 * parts.length);
  for (let it = 0; it < iters; it++) {
    const p = parts[Math.floor(rnd() * parts.length)];
    const ox = p.x, oy = p.y;
    let q = null, qx, qy;
    if (rnd() < 0.15 && parts.length > 2) {   // swap two parts
      q = parts[Math.floor(rnd() * parts.length)]; if (q === p) continue;
      qx = q.x; qy = q.y; p.x = qx; p.y = qy; q.x = ox; q.y = oy;
    } else {
      const s = Math.max(1, Math.round(3 * (T / T0) * u / G));
      p.x = ox + G * Math.round((rnd() * 2 - 1) * s); p.y = oy + G * Math.round((rnd() * 2 - 1) * s);
    }
    const nc = cost();
    if (nc <= cur || rnd() < Math.exp((cur - nc) / T)) cur = nc;
    else { p.x = ox; p.y = oy; if (q) { q.x = qx; q.y = qy; } }
    T = T0 * Math.pow(0.002, (it + 1) / iters);
  }
  // mirror source-coupled pairs: gates outwards
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i], b = parts[j];
    if (a.pc.prefix !== 'M' || b.pc.prefix !== 'M' || a.kind !== b.kind) continue;
    if (a.pc.nodes[2] !== b.pc.nodes[2] || RAIL.test(a.pc.nodes[2]) || Math.abs(cy(a) - cy(b)) > u * 0.3) continue;
    const [L, Rt] = cx(a) <= cx(b) ? [a, b] : [b, a];
    const flip = (p, want) => { p.flipStyle = `flipH=${want ? 1 : 0};`; };
    // stencil gate pin is on the left (W): the right device is flipped
    flip(L, false); flip(Rt, true);
  }
  // apply positions
  for (const p of parts) {
    updateCell(model, p.cell.id, { x: p.x, y: p.y, ...(p.flipStyle ? { style: p.flipStyle } : {}) });
    for (const t of p.taps) updateCell(model, t.cell.id, { x: p.x + t.ox, y: p.y + t.oy });
    for (const l of p.labels || []) updateCell(model, l.cell.id, { x: p.x + l.ox, y: p.y + l.oy });
  }
  // rewire: Manhattan MST over the terminals of each net
  const after = new Map(allCells(model).map(cellInfo).map((c) => [c.id, c]));
  const terms = new Map();
  const addT = (net, id, pin) => { const k = String(net).toLowerCase(); if (!terms.has(k)) terms.set(k, []); const c = after.get(id); terms.get(k).push({ id, pin, at: pinAbs(c, pin) }); };
  for (const p of parts) p.pins.forEach((pin, i) => addT(pinNet(p, i), p.cell.id, pin));
  for (const t of taps) if (t.pin) addT(t.net, t.cell.id, t.pin);
  const wires = [];
  for (const ts of terms.values()) {
    if (ts.length < 2) continue;
    const inT = new Set([0]);
    while (inT.size < ts.length) {
      let best = null;
      for (const i of inT) for (let j = 0; j < ts.length; j++) {
        if (inT.has(j)) continue;
        const d = Math.abs(ts[i].at.x - ts[j].at.x) + Math.abs(ts[i].at.y - ts[j].at.y);
        if (!best || d < best.d) best = { d, i, j };
      }
      inT.add(best.j);
      const a = ts[best.i], b = ts[best.j];
      wires.push(addWire(model, { source: a.id, target: b.id, sourcePin: a.pin, targetPin: b.pin }).getAttribute('id'));
    }
  }
  await routePage(model, wires, {});
  normalizeOrigin(model);
  return { ...placed, wires };
}
