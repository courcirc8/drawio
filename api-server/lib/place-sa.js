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
  // global flow: level 0 at VDD, 1 at ground, by graph distance through parts
  // (humans draw the supply on top, ground at the bottom: the strongest convention)
  const isSup = (n) => RAIL.test(n) && n !== '0' && !/^(gnd|vss|vee|avss|dvss|agnd|dgnd|vgnd)$/i.test(n);
  const isGnd = (n) => n === '0' || /^(gnd|vss|vee|avss|dvss|agnd|dgnd|vgnd)$/i.test(n);
  // terminals that carry current: the bulk (4th MOS node, often tied to a rail)
  // must not make a transistor count as "on the supply"
  const termNets = (p) => (p.pc.prefix === 'M' || p.pc.prefix === 'Q' ? p.pc.nodes.slice(0, 3) : p.pc.nodes);
  const dist = (seed) => {
    const d = new Array(parts.length).fill(Infinity); const q = [];
    parts.forEach((p, i) => { if (termNets(p).some(seed)) { d[i] = 0; q.push(i); } });
    while (q.length) { const i = q.shift(); for (let j = 0; j < parts.length; j++) if (d[j] === Infinity && termNets(parts[i]).some((n) => !RAIL.test(n) && termNets(parts[j]).includes(n))) { d[j] = d[i] + 1; q.push(j); } }
    return d;
  };
  const dV = dist(isSup), dG = dist(isGnd);
  // no path to ground: lower the further from the supply (and symmetrically);
  // a folded cascode with external current terminals had everything at level 0
  const level = parts.map((_, i) => (dV[i] === Infinity && dG[i] === Infinity ? 0.5
    : dG[i] === Infinity ? dV[i] / (dV[i] + 1) : dV[i] === Infinity ? 1 - dG[i] / (dG[i] + 1) : dV[i] / (dV[i] + dG[i])));
  // one row: differential pairs (same source, non-rail) and mirrors (same gate and source)
  const rows = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i].pc, b = parts[j].pc;
    if (a.prefix !== 'M' || b.prefix !== 'M' || parts[i].kind !== parts[j].kind) continue;
    if ((a.nodes[2] === b.nodes[2] && !RAIL.test(a.nodes[2]) && a.nodes[1] !== b.nodes[1]) || (a.nodes[1] === b.nodes[1] && a.nodes[2] === b.nodes[2])) rows.push([i, j]);
  }
  // Eric's rules (2026-10-06, from his practice): every transistor whose SOURCE is
  // on ground shares one row; every transistor whose source is on the supply
  // shares one row (straight rails, straight source connections, fewer bends).
  // Strong term in the annealing, then imposed exactly (opts.saRailRows=false disables).
  const RAILROWS = opts.saRailRows ?? (process.env.SA_RAIL_ROWS !== '0');
  const srcOf = (p) => (p.pc.prefix === 'M' ? p.pc.nodes[2] : p.pc.prefix === 'Q' ? p.pc.nodes[2] : null);
  // generalised (conflict found on a degenerated source: the resistor between a
  // source and ground fell below the ground row): the BOTTOM element of every DC
  // branch — whatever it is (transistor source, resistor, current source) — joins
  // the ground row, the top element the supply row. Computed below with the branches.
  let railRows = [];
  // Eric's rule 3: parts carrying the SAME DC current share one column. DC
  // elements: MOS drain-source, BJT collector-emitter, R, L, I (gates, bases and
  // capacitors carry no DC). A branch is a chain of DC elements joined through
  // non-rail nets touched by exactly two DC terminals; the chain is cut at the
  // rails and wherever the current divides (3+ DC terminals on a net).
  const COLS = opts.saColumns ?? (process.env.SA_COLUMNS !== '0');
  const dcNets = (p) => (p.pc.prefix === 'M' || p.pc.prefix === 'Q' ? [p.pc.nodes[0], p.pc.nodes[2]] : ['R', 'L', 'I'].includes(p.pc.prefix) ? p.pc.nodes.slice(0, 2) : []);
  const dcDeg = new Map();
  parts.forEach((p) => dcNets(p).forEach((n) => dcDeg.set(n, (dcDeg.get(n) || 0) + 1)));
  const uf = parts.map((_, i) => i);
  const find = (i) => (uf[i] === i ? i : (uf[i] = find(uf[i])));
  // a net is NOT a series link when it joins two sources (a differential pair:
  // the current divides there) or carries an external terminal (a port injects
  // or draws current) — found on a folded cascode drawn as one single column
  const srcCount = new Map();
  parts.forEach((p) => { if ((p.pc.prefix === 'M' || p.pc.prefix === 'Q') && p.pc.nodes[2] != null) srcCount.set(p.pc.nodes[2], (srcCount.get(p.pc.nodes[2]) || 0) + 1); });
  const ported = new Set(taps.filter((t) => t.cls.role === 'port').map((t) => String(t.net).toLowerCase()));
  const lastOn = new Map();
  parts.forEach((p, i) => dcNets(p).forEach((n) => {
    if (RAIL.test(n) || dcDeg.get(n) !== 2 || (srcCount.get(n) || 0) >= 2 || ported.has(String(n).toLowerCase())) return;
    if (lastOn.has(n)) uf[find(i)] = find(lastOn.get(n)); else lastOn.set(n, i);
  }));
  const chains = new Map();
  parts.forEach((p, i) => { if (dcNets(p).length) { const r = find(i); if (!chains.has(r)) chains.set(r, []); chains.get(r).push(i); } });
  if (RAILROWS) {
    const dcOn = (p, test) => (p.pc.prefix === 'M' || p.pc.prefix === 'Q' ? test(p.pc.nodes[2]) : ['R', 'L', 'I'].includes(p.pc.prefix) && p.pc.nodes.slice(0, 2).some(test));
    railRows = [parts.map((p, i) => (dcOn(p, isGnd) && !dcOn(p, isSup) ? i : -1)).filter((i) => i >= 0),
      parts.map((p, i) => (dcOn(p, isSup) && !dcOn(p, isGnd) ? i : -1)).filter((i) => i >= 0)].filter((g) => g.length > 1);
  }
  const columns = COLS ? [...chains.values()].filter((g) => g.length > 1) : [];
  const chainOf = new Map(); columns.forEach((g, k) => g.forEach((i) => chainOf.set(i, k)));
  // a pair or mirror shares one level (its two halves can sit at different graph depths)
  for (const [i, j] of rows) { const m = (level[i] + level[j]) / 2; level[i] = level[j] = m; }
  const order = [];
  for (let i = 0; i < parts.length; i++) for (let j = 0; j < parts.length; j++) if (level[i] < level[j] - 0.2) order.push([i, j]);
  // pin alignment (Eric: fewer bends): for every non-rail net with 2-4 pins, the
  // pins of different parts should share a horizontal or a vertical line, so
  // the wire between them can be straight (an aligned pair costs 0, else
  // min(|dx|, |dy|) in units, capped at 1.5)
  const pinOff = parts.map((p) => p.pins.map((pin) => { const a = pinAbs(p.cell, pin); return { x: a.x - p.cell.x, y: a.y - p.cell.y }; }));
  // x of the DC line inside each part: transistors carry their current along the
  // drain-source (collector-emitter) lead on one side of the symbol, not at the
  // centre (human drawings align these leads: 83 % of AMSNet branches, chance 18 %)
  const dcOff = parts.map((p, i) => (p.pc.prefix === 'M' || p.pc.prefix === 'Q') && pinOff[i][0] && pinOff[i][2] ? (pinOff[i][0].x + pinOff[i][2].x) / 2 : p.w / 2);
  const lx = (i) => parts[i].x + dcOff[i];
  const pinPairs = [];
  const byNet = new Map();
  parts.forEach((p, i) => p.pins.forEach((_, k) => { const n = pinNet(p, i === undefined ? 0 : k); if (n == null || RAIL.test(n)) return; if (!byNet.has(n)) byNet.set(n, []); byNet.get(n).push([i, k]); }));
  for (const ps of byNet.values()) {
    if (ps.length < 2 || ps.length > 4) continue;
    for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) if (ps[a][0] !== ps[b][0]) pinPairs.push([ps[a], ps[b]]);
  }
  const nets = new Map();
  parts.forEach((p, i) => p.pc.nodes.forEach((n) => { if (!RAIL.test(n)) { if (!nets.has(n)) nets.set(n, new Set()); nets.get(n).add(i); } }));
  const netList = [...nets.values()].filter((s) => s.size > 1).map((s) => [...s]);
  const box = (p) => {   // part + its symbols, with a margin
    let x0 = p.x, y0 = p.y, x1 = p.x + p.w, y1 = p.y + p.h;
    for (const t of p.taps) { x0 = Math.min(x0, p.x + t.ox); y0 = Math.min(y0, p.y + t.oy); x1 = Math.max(x1, p.x + t.ox + t.cell.w); y1 = Math.max(y1, p.y + t.oy + t.cell.h); }
    const m = u * (opts.saMargin ?? 0.6); return [x0 - m, y0 - m, x1 + m, y1 + m];
  };
  const cx = (p) => p.x + p.w / 2, cy = (p) => p.y + p.h / 2;
  const pairCost = (q) => {
    const a = parts[q.i], b = parts[q.j];
    const ix = Math.round(((cx(b) - cx(a)) / u + R) / B), iy = Math.round(((cy(b) - cy(a)) / u + R) / B);
    if (ix >= 0 && iy >= 0 && ix < NB && iy < NB) return -q.lp[iy * NB + ix];
    // beyond the learned range the cost keeps growing, so a stray part is pulled back
    const ex = Math.max(0, Math.abs((cx(b) - cx(a)) / u) - R) + Math.max(0, Math.abs((cy(b) - cy(a)) / u) - R);
    return (q.lpMin ??= -Math.min(...q.lp)) + 1 + ex;
  };
  const overlap = (a, b) => { const A = box(a), Bx = box(b); const w = Math.min(A[2], Bx[2]) - Math.max(A[0], Bx[0]), h = Math.min(A[3], Bx[3]) - Math.max(A[1], Bx[1]); return w > 0 && h > 0 ? (w * h) / (u * u) : 0; };
  const hpwl = (s) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const i of s) { x0 = Math.min(x0, cx(parts[i])); x1 = Math.max(x1, cx(parts[i])); y0 = Math.min(y0, cy(parts[i])); y1 = Math.max(y1, cy(parts[i])); } return (x1 - x0 + y1 - y0) / u; };
  const OV = 30, WL = opts.saWL ?? 1.5, PULL = opts.saPull ?? 0.15, LV = opts.saLevel ?? 3, ROW = opts.saRow ?? 8, RR = opts.saRailRow ?? 10, CL = opts.saColumn ?? 10, AL = opts.saAlign ?? (process.env.SA_ALIGN != null ? Number(process.env.SA_ALIGN) : 2);
  const cost = () => {
    let c = 0; for (const q of pairs) c += pairCost(q);
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) c += OV * overlap(parts[i], parts[j]);
    for (const s of netList) c += WL * hpwl(s);
    for (const [i, j] of order) { const d = (cy(parts[i]) - cy(parts[j])) / u; if (d > -0.5) c += LV * (d + 0.5); }   // i must sit above j
    for (const [i, j] of rows) c += ROW * Math.abs(cy(parts[i]) - cy(parts[j])) / u;
    for (const [[i, k], [j, l]] of pinPairs) {
      const a = pinOff[i][k], b = pinOff[j][l];
      const dx = Math.abs(parts[i].x + a.x - parts[j].x - b.x), dy = Math.abs(parts[i].y + a.y - parts[j].y - b.y);
      c += AL * Math.min(1.5, Math.min(dx, dy) / u);
    }
    for (const g of columns) { const m = g.reduce((s2, i) => s2 + lx(i), 0) / g.length; for (const i of g) c += CL * Math.abs(lx(i) - m) / u; }
    for (const g of railRows) { const m = g.reduce((s2, i) => s2 + cy(parts[i]), 0) / g.length; for (const i of g) c += RR * Math.abs(cy(parts[i]) - m) / u; }
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
  // snap: parts almost on one row (column) share it exactly — mirrors, pairs
  // and stacks become straight lines (centres within 0.35 u)
  const snap = (key, set) => {
    const order = [...parts].sort((a, b) => key(a) - key(b));
    let grp = [order[0]];
    const flush = () => { if (grp.length > 1) { const v = grp.map(key).sort((a, b) => a - b)[Math.floor(grp.length / 2)]; for (const p of grp) set(p, v); } };
    for (const p of order.slice(1)) { if (key(p) - key(grp[grp.length - 1]) < 0.35 * u) grp.push(p); else { flush(); grp = [p]; } }
    flush();
  };
  snap(cy, (p, v) => { p.y = Math.round(v - p.h / 2); });
  // impose the rail rows exactly (median centre of each group)
  for (const g of railRows) { const ys = g.map((i) => cy(parts[i])).sort((a, b) => a - b); const m = ys[Math.floor(ys.length / 2)]; for (const i of g) parts[i].y = Math.round(m - parts[i].h / 2); }
  // impose the branch columns exactly (median centre of each branch)
  for (const g of columns) { const xs = g.map((i) => lx(i)).sort((a, b) => a - b); const m = xs[Math.floor(xs.length / 2)]; for (const i of g) parts[i].x = Math.round(m - dcOff[i]); }
  // parts forced onto one row must not overlap: spread them along the row,
  // moving a part's whole branch column with it
  for (const g of railRows) {
    const order2 = g.map((i) => i).sort((a, b) => parts[a].x - parts[b].x);
    for (let k = 1; k < order2.length; k++) {
      const prev = parts[order2[k - 1]], cur2 = parts[order2[k]];
      const shift = Math.round(prev.x + prev.w + u * 0.8 - cur2.x);
      if (shift <= 0) continue;
      const ch = chainOf.get(order2[k]);
      const moved = ch != null ? columns[ch] : [order2[k]];
      for (const i of moved) parts[i].x += shift;
    }
  }
  snap(cx, (p, v) => { p.x = Math.round(v - p.w / 2); });
  // legalise: snapping and imposed rows/columns can stack two parts on one spot
  // (found: two gates at the same point, wires of two nets overlapping). While two
  // parts (with their symbols) overlap, shift the right-hand one (with its whole
  // branch column) to the right, keeping rows and columns.
  for (let round = 0; round < 200; round++) {
    let moved = false;
    for (let i = 0; i < parts.length && !moved; i++) for (let j = 0; j < parts.length && !moved; j++) {
      if (i === j) continue;
      // real bodies (no margin), a small clearance
      const a = parts[i], b = parts[j], cl = u * 0.1;
      const body = (p) => { let x0 = p.x, y0 = p.y, x1 = p.x + p.w, y1 = p.y + p.h; for (const t of p.taps) { x0 = Math.min(x0, p.x + t.ox); y0 = Math.min(y0, p.y + t.oy); x1 = Math.max(x1, p.x + t.ox + t.cell.w); y1 = Math.max(y1, p.y + t.oy + t.cell.h); } return [x0, y0, x1, y1]; };
      const A = body(a), Bb = body(b);
      const ox = Math.min(A[2], Bb[2]) - Math.max(A[0], Bb[0]) + cl, oy = Math.min(A[3], Bb[3]) - Math.max(A[1], Bb[1]) + cl;
      if (ox <= 0 || oy <= 0) continue;
      const ch = chainOf.get(j); const same = ch != null && ch === chainOf.get(i);
      if (same) {   // one branch column: push the lower part down
        if (cy(b) < cy(a) || (cy(b) === cy(a) && j < i)) continue;
        b.y += Math.ceil(oy + 1);
      } else {      // otherwise push the right-hand part (and its column) right
        if (cx(b) < cx(a) || (cx(b) === cx(a) && j < i)) continue;
        for (const k of ch != null ? columns[ch] : [j]) parts[k].x += Math.ceil(ox + 1);
      }
      moved = true;
    }
    if (!moved) break;
  }
  // mirror source-coupled pairs: gates outwards
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i], b = parts[j];
    if (a.pc.prefix !== 'M' || b.pc.prefix !== 'M' || a.kind !== b.kind) continue;
    if (a.pc.nodes[2] !== b.pc.nodes[2] || RAIL.test(a.pc.nodes[2]) || Math.abs(cy(a) - cy(b)) > u * 0.3) continue;
    const [L, Rt] = cx(a) <= cx(b) ? [a, b] : [b, a];
    const flip = (p, want) => {
      const was = String(p.cell.style.map.get('flipH') || '0') === '1';
      p.flipStyle = `flipH=${want ? 1 : 0};`;
      if (was !== want) { const k = parts.indexOf(p); p.x = Math.round(p.x + 2 * dcOff[k] - p.w); }   // the drain-source lead stays where it was
    };
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
