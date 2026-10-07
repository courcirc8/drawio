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
 *   3. Each net is rewired as a Manhattan minimum spanning tree over its pins.
 *      Source-coupled pairs are mirrored (gates outwards), two-transistor
 *      mirrors face each other, other transistors turn their gate to its driver,
 *      two-terminal parts turn their pins towards their nets.
 *   4. Grid wiring (2026-10-07): every link of the tree gets a FIXED path when a
 *      clean one exists — straight line, L, or escape + horizontal / vertical
 *      corridor — checked against bodies, foreign pins and the fixed wires of
 *      other nets; only the rest goes to routePage (libavoid).
 * The caller's LVS gate decides whether the result is usable.
 */
import fs from 'node:fs';
import { allCells, cellInfo, addWire, normalizeOrigin, deleteCell, updateCell } from './model.js';
import { importNetlist2 } from './place2.js';
import { routePage, pinAbs, rotatedAabb } from './route.js';
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
    const rb = rotatedAabb(c);   // a rotated part (resistor at -90) spans its rotated box
    parts.push({ cell: c, cls, pc, pins, x: c.x, y: c.y, w: c.w, h: c.h, bx: rb.x - c.x, by: rb.y - c.y, bw: rb.w, bh: rb.h, taps: [], kind: kindOf(pc), roles: rolesOf(pc) });
  }
  // a vertical two-terminal part on a rail turns its rail pin towards the rail
  // (ground pin at the bottom, supply pin on top): place2 can draw it upside
  // down, and the ground symbol then hangs beside the part with a wire round it
  const isGndN = (n) => /^(0|gnd|vss|vee|avss|dvss|agnd|dgnd|vgnd)$/i.test(n), isSupN = (n) => RAIL.test(n) && !isGndN(n);
  if (opts.saRailTurn ?? (process.env.SA_RAIL_TURN !== '0')) for (const p of parts) {
    if (['M', 'Q'].includes(p.pc.prefix) || p.pins.length !== 2 || p.bh <= p.bw) continue;
    const ya = pinAbs(p.cell, p.pins[0]).y, yb = pinAbs(p.cell, p.pins[1]).y, [na, nb] = p.pc.nodes;
    const bad = (isGndN(na) && !isGndN(nb) && ya < yb) || (isGndN(nb) && !isGndN(na) && yb < ya)
      || (isSupN(na) && !RAIL.test(nb) && ya > yb) || (isSupN(nb) && !RAIL.test(na) && yb > ya);
    if (!bad) continue;
    const rot = (((p.cell.rotation || 0) + 180) % 360 + 360) % 360;
    updateCell(model, p.cell.id, { rotation: rot });
    p.cell = cellInfo(allCells(model).find((n) => cellInfo(n).id === p.cell.id));
  }
  if (parts.length < 3) { await routePage(model, placed.wires, {}); normalizeOrigin(model); return placed; }
  const pinNet = (p, i) => p.pc.nodes[i];
  // symbols: grouped with the closest part pin on their net
  const taps = [];
  const RAILSYM = opts.saRailSymbols ?? (process.env.SA_RAIL_SYMBOLS !== '0');
  const pinOffOf = (p, i) => { const a = pinAbs(p.cell, p.pins[i]); return { x: a.x - p.cell.x, y: a.y - p.cell.y }; };
  const pinDir = (p, o) => { const d = [[o.x - p.bx, -1, 0], [p.bx + p.bw - o.x, 1, 0], [o.y - p.by, 0, -1], [p.by + p.bh - o.y, 0, 1]].sort((x, y) => x[0] - y[0])[0]; return { x: d[1], y: d[2] }; };
  for (const c of cells) {
    if (c.kind !== 'vertex' || c.x == null) continue;
    const cls = classify(c);
    if (cls.role === 'other' && String(c.value || '').trim()) {   // a text label (refdes, value): follows the closest part
      let bp = parts.find((p) => c.id === `LBL_${p.cell.id}` || c.id === `LBL_${p.pc.ref}`) || null, bd = bp ? 0 : Infinity;
      if (!bp) for (const p of parts) { const d = Math.hypot(p.x + p.w / 2 - (c.x + c.w / 2), p.y + p.h / 2 - (c.y + c.h / 2)); if (d < bd) { bd = d; bp = p; } }
      // a refdes label sits centred under its own part (place2's spot can be next to another one)
      const own = bp && bd === 0;
      if (bp) bp.labels = [...(bp.labels || []), { cell: c, ...(own && bp.bh > bp.bw * 1.5 && !['M', 'Q'].includes(bp.pc.prefix)   // a vertical two-terminal part: label on its left
        ? { ox: Math.round(bp.bx - c.w - 6), oy: Math.round(bp.by + (bp.bh - c.h) / 2) }
        : { ox: own ? Math.round(bp.bx + (bp.bw - c.w) / 2) : c.x - bp.x, oy: own ? bp.by + bp.bh + 4 : c.y - bp.y }) }];
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
    if (best) {
      t.ox = c.x - best.p.x; t.oy = c.y - best.p.y; best.p.taps.push(t);
      // supply and ground symbols sit straight on their pin's line: ground below
      // a pin facing down (or beside it, then below), supply above a pin facing up
      const pin0 = pinOffOf(best.p, best.i), tp = t.pin && { x: t.pin.x * c.w, y: t.pin.y * c.h };
      if (RAILSYM && tp && (cls.role === 'ground' || cls.role === 'power')) {
        const d = pinDir(best.p, pin0), down = cls.role === 'ground';
        let px = pin0.x, py = pin0.y;
        if (d.y === (down ? 1 : -1)) py += down ? 20 : -20;
        else if (d.x !== 0) { px += d.x * 30; py += down ? 20 : -20; }
        else px = null;   // pin facing away from its rail: keep place2's spot
        if (px != null) { t.ox = Math.round(px - tp.x); t.oy = Math.round(py - tp.y); }
      }
      // a port sits on its pin's line, outside the part (place2's spot can be
      // in the middle of the circuit once the parts have moved)
      if (RAILSYM && tp && cls.role === 'port') {
        const d = pinDir(best.p, pin0);
        // only when the port's own pin faces the part (its body then extends outwards)
        if ((d.x > 0 && tp.x < c.w / 2) || (d.x < 0 && tp.x > c.w / 2)) { t.ox = Math.round(pin0.x + d.x * 40 - tp.x); t.oy = Math.round(pin0.y - tp.y); }
      }
    }
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
    if (!lastOn.has(n)) { lastOn.set(n, i); return; }
    // two elements sharing BOTH terminals are in parallel, not in series (two
    // mirror outputs tied together were stacked in one column)
    const j = lastOn.get(n), a = dcNets(parts[i]), b = dcNets(parts[j]);
    if (a.every((x) => b.includes(x)) && b.every((x) => a.includes(x))) return;
    uf[find(i)] = find(j);
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
    let x0 = p.x + p.bx, y0 = p.y + p.by, x1 = x0 + p.bw, y1 = y0 + p.bh;
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
  // impose the pair / mirror rows exactly (check.py rules 14 and 26), unless a
  // half is already held by a rail row
  if (opts.saPairRow ?? (process.env.SA_PAIR_ROW !== '0')) {
    // whole groups (a 3-transistor mirror is three pairs: imposed pair by pair
    // they pulled each other apart, rule 26 found on a small circuit)
    const inRail = new Set(railRows.flat());
    const ufr = parts.map((_, i) => i), fr = (i) => (ufr[i] === i ? i : (ufr[i] = fr(ufr[i])));
    for (const [i, j] of rows) ufr[fr(i)] = fr(j);
    const grp = new Map();
    for (const [i, j] of rows) for (const k of [i, j]) { const r = fr(k); if (!grp.has(r)) grp.set(r, new Set()); grp.get(r).add(k); }
    for (const set of grp.values()) {
      const g = [...set], held = g.filter((k) => inRail.has(k));
      if (held.length && new Set(held.map((k) => Math.round(cy(parts[k])))).size > 1) continue;   // held by two different rows
      const ys = (held.length ? held : g).map((k) => cy(parts[k])).sort((a, b) => a - b);
      const m = ys[Math.floor(ys.length / 2)];
      for (const k of g) if (!inRail.has(k)) parts[k].y = Math.round(m - parts[k].h / 2);
    }
  }
  // impose the branch columns exactly (median centre of each branch)
  for (const g of columns) { const xs = g.map((i) => lx(i)).sort((a, b) => a - b); const m = xs[Math.floor(xs.length / 2)]; for (const i of g) parts[i].x = Math.round(m - dcOff[i]); }
  // parts forced onto one row must not overlap: spread them along the row,
  // moving a part's whole branch column with it
  for (const g of railRows) {
    const order2 = g.map((i) => i).sort((a, b) => parts[a].x - parts[b].x);
    for (let k = 1; k < order2.length; k++) {
      const prev = parts[order2[k - 1]], cur2 = parts[order2[k]];
      const shift = Math.round(prev.x + prev.bx + prev.bw + u * 0.8 - cur2.x - cur2.bx);
      if (shift <= 0) continue;
      const ch = chainOf.get(order2[k]);
      const moved = ch != null ? columns[ch] : [order2[k]];
      for (const i of moved) parts[i].x += shift;
    }
  }
  snap(cx, (p, v) => { p.x = Math.round(v - p.w / 2); });
  // mirror source-coupled pairs: gates outwards; two-transistor current
  // mirrors (same gate and source): gates face to face (check.py rule 28)
  const mirrorKey = (p) => `${p.kind}|${p.pc.nodes[1]}|${p.pc.nodes[2]}`;
  const mirrorSize = new Map();
  for (const p of parts) if (p.pc.prefix === 'M') mirrorSize.set(mirrorKey(p), (mirrorSize.get(mirrorKey(p)) || 0) + 1);
  const flip = (p, want) => {
    const was = String(p.cell.style.map.get('flipH') || '0') === '1';
    p.flipStyle = { flipH: want ? 1 : null };   // an object: a string was split into garbage keys and never flipped
    if (was !== want) { const k = parts.indexOf(p); p.x = Math.round(p.x + 2 * dcOff[k] - p.w); }   // the drain-source lead stays where it was
  };
  const MIRROR = opts.saMirrorFlip ?? (process.env.SA_MIRROR_FLIP !== '0');
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i], b = parts[j];
    if (a.pc.prefix !== 'M' || b.pc.prefix !== 'M' || a.kind !== b.kind) continue;
    if (a.pc.nodes[2] !== b.pc.nodes[2] || Math.abs(cy(a) - cy(b)) > u * 0.3) continue;
    const [L, Rt] = cx(a) <= cx(b) ? [a, b] : [b, a];
    // stencil gate pin is on the left (W)
    if (a.pc.nodes[1] === b.pc.nodes[1]) { if (MIRROR && mirrorSize.get(mirrorKey(a)) === 2) { flip(L, true); flip(Rt, false); } continue; }
    if (RAIL.test(a.pc.nodes[2])) continue;
    // a pair: exactly two transistors on that source, neither already turned as
    // a mirror half (a mirror sharing its source with a third device was undone)
    if (parts.filter((q) => q.pc.prefix === 'M' && q.kind === a.kind && q.pc.nodes[2] === a.pc.nodes[2]).length !== 2 || a.flipStyle || b.flipStyle) continue;
    flip(L, false); flip(Rt, true);   // the right device is flipped
  }
  // any other transistor turns its gate (base) towards what drives it: the mean
  // x of the other parts and ports on its gate net
  if (opts.saGateFace ?? (process.env.SA_GATE_FACE !== '0')) for (const p of parts) {
    if (!['M', 'Q'].includes(p.pc.prefix) || p.flipStyle) continue;
    const g = p.pc.nodes[1]; if (g == null || RAIL.test(g)) continue;
    const xs = [];
    for (const q of parts) if (q !== p && q.pc.nodes.includes(g)) xs.push(cx(q));
    for (const t of taps) if (t.owner && String(t.net).toLowerCase() === String(g).toLowerCase()) xs.push(t.owner.x + t.ox + t.cell.w / 2);
    if (!xs.length) continue;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (Math.abs(m - cx(p)) < u * 0.3) continue;
    flip(p, m > cx(p));   // stencil gate on the left: flipped faces right
  }
  // legalise: snapping and imposed rows/columns can stack two parts on one spot
  // (found: two gates at the same point, wires of two nets overlapping). While two
  // parts (with their symbols) overlap, shift the right-hand one (with its whole
  // branch column) to the right, keeping rows and columns.
  // clearance between neighbours: room for a couple of wire lanes (SA_GAP, in units)
  const GAP = opts.saGap ?? (process.env.SA_GAP != null ? Number(process.env.SA_GAP) : 0.5);
  for (let round = 0; round < 200; round++) {
    let moved = false;
    for (let i = 0; i < parts.length && !moved; i++) for (let j = 0; j < parts.length && !moved; j++) {
      if (i === j) continue;
      // real bodies (no margin), a small clearance
      const a = parts[i], b = parts[j], cl = u * GAP;
      const body = (p) => { let x0 = p.x + p.bx, y0 = p.y + p.by, x1 = x0 + p.bw, y1 = y0 + p.bh; for (const t of p.taps) { x0 = Math.min(x0, p.x + t.ox); y0 = Math.min(y0, p.y + t.oy); x1 = Math.max(x1, p.x + t.ox + t.cell.w); y1 = Math.max(y1, p.y + t.oy + t.cell.h); } return [x0, y0, x1, y1]; };
      const A = body(a), Bb = body(b);
      const ox = Math.min(A[2], Bb[2]) - Math.max(A[0], Bb[0]) + cl, oy = Math.min(A[3], Bb[3]) - Math.max(A[1], Bb[1]) + cl;
      if (ox <= 0 || oy <= 0) continue;
      const ch = chainOf.get(j); const same = ch != null && ch === chainOf.get(i);
      if (same) {   // one branch column: push the lower part down
        if (cy(b) < cy(a) || (cy(b) === cy(a) && j < i)) continue;
        // push b's whole row and everything below it, so rows stay straight
        // (one pair half pushed alone broke rule 14)
        const dy = Math.ceil(oy + 1), yb = cy(b) - 1;
        if (cy(a) >= yb) b.y += dy;   // a on the same row: only b can move
        else for (const q of parts) if (cy(q) >= yb) q.y += dy;
      } else {      // otherwise push the right-hand part (and its column) right
        if (cx(b) < cx(a) || (cx(b) === cx(a) && j < i)) continue;
        for (const k of ch != null ? columns[ch] : [j]) parts[k].x += Math.ceil(ox + 1);
      }
      moved = true;
    }
    if (!moved) break;
  }
  // a vertical two-terminal part whose two nets both lead to the same side
  // (both above or both below: a resistor across a transistor's drain and
  // source drawn under it) moves beside them, at their height, when the spot
  // is free: otherwise one pin must turn back round the body (check.py wrap-around)
  if (opts.saBeside ?? (process.env.SA_BESIDE !== '0')) for (const [k, p] of parts.entries()) {
    if (['M', 'Q'].includes(p.pc.prefix) || p.pins.length !== 2 || p.bh <= p.bw || p.taps.length) continue;
    const dest = (m) => {
      const net = pinNet(p, m); if (RAIL.test(net)) return null;
      let best = null;
      parts.forEach((q, j) => { if (j !== k) q.pins.forEach((_, mm) => { if (pinNet(q, mm) === net) { const pt = { x: q.x + pinOff[j][mm].x, y: q.y + pinOff[j][mm].y }; const d = Math.abs(pt.x - p.x - pinOff[k][m].x) + Math.abs(pt.y - p.y - pinOff[k][m].y); if (!best || d < best.d) best = { d, pt }; } }); });
      return best && best.pt;
    };
    const d0 = dest(0), d1 = dest(1);
    if (!d0 || !d1) continue;
    const top = p.y + p.by, bot = top + p.bh;
    const above = d0.y < top && d1.y < top, below = d0.y > bot && d1.y > bot;
    if (!above && !below) continue;
    const yc = (d0.y + d1.y) / 2, xs = [Math.max(d0.x, d1.x) + 0.8 * u, Math.min(d0.x, d1.x) - 0.8 * u - p.bw];
    const ox = p.x, oy = p.y;
    for (const x of xs) {
      p.x = Math.round(x - p.bx); p.y = Math.round(yc - p.by - p.bh / 2);
      const A = [p.x + p.bx - 0.3 * u, p.y + p.by - 0.3 * u, p.x + p.bx + p.bw + 0.3 * u, p.y + p.by + p.bh + 0.3 * u];
      const hit = parts.some((q, j) => { if (j === k) return false; let x0 = q.x + q.bx, y0 = q.y + q.by, x1 = x0 + q.bw, y1 = y0 + q.bh; for (const t of q.taps) { x0 = Math.min(x0, q.x + t.ox); y0 = Math.min(y0, q.y + t.oy); x1 = Math.max(x1, q.x + t.ox + t.cell.w); y1 = Math.max(y1, q.y + t.oy + t.cell.h); } return A[0] < x1 && x0 < A[2] && A[1] < y1 && y0 < A[3]; });
      if (!hit) break;
      p.x = ox; p.y = oy;
    }
  }
  // fold (2026-10-07): on large circuits the rail rows and branch columns give
  // one very long strip (sheets > 3:1). Cut it between columns, where the
  // fewest nets cross, into k bands stacked top to bottom; each band keeps its
  // own rail rows (supply and ground symbols are per part). SA_FOLD=0 disables.
  const FOLD = opts.saFold ?? (process.env.SA_FOLD !== '0');
  const FOLD_AR = opts.saFoldAspect ?? 2.5;
  if (FOLD && parts.length >= 8) {
    const bx = parts.map((p) => { let x0 = p.x + p.bx, y0 = p.y + p.by, x1 = x0 + p.bw, y1 = y0 + p.bh; for (const t of p.taps) { x0 = Math.min(x0, p.x + t.ox); y0 = Math.min(y0, p.y + t.oy); x1 = Math.max(x1, p.x + t.ox + t.cell.w); y1 = Math.max(y1, p.y + t.oy + t.cell.h); } for (const l of p.labels || []) { x0 = Math.min(x0, p.x + l.ox); x1 = Math.max(x1, p.x + l.ox + l.cell.w); y1 = Math.max(y1, p.y + l.oy + l.cell.h); } return [x0, y0, x1, y1]; });
    const X0 = Math.min(...bx.map((b) => b[0])), X1 = Math.max(...bx.map((b) => b[2])), Y0 = Math.min(...bx.map((b) => b[1])), Y1 = Math.max(...bx.map((b) => b[3]));
    const W = X1 - X0, H = Y1 - Y0;
    if (W > FOLD_AR * H) {
      const k = Math.max(2, Math.round(Math.sqrt(W / (1.3 * H))));
      // units that never split: a branch column, a pair, a two-transistor mirror
      // (with their symbols); sorted by centre x and cut into k contiguous runs
      const uf2 = parts.map((_, i) => i);
      const f2 = (i) => (uf2[i] === i ? i : (uf2[i] = f2(uf2[i])));
      const join = (g) => { for (const i of g.slice(1)) uf2[f2(i)] = f2(g[0]); };
      columns.forEach(join); rows.forEach(join);
      const byGate = new Map();
      parts.forEach((p, i) => { if (p.pc.prefix === 'M' || p.pc.prefix === 'Q') { const key = `${p.kind}|${p.pc.nodes[1]}|${p.pc.nodes[2]}`; if (!byGate.has(key)) byGate.set(key, []); byGate.get(key).push(i); } });
      for (const g of byGate.values()) if (g.length === 2) join(g);
      const unitOf = new Map();
      parts.forEach((_, i) => { const r = f2(i); if (!unitOf.has(r)) unitOf.set(r, []); unitOf.get(r).push(i); });
      const units = [...unitOf.values()].map((g) => ({ g, c: g.reduce((t, i) => t + (bx[i][0] + bx[i][2]) / 2, 0) / g.length })).sort((x, y) => x.c - y.c);
      const band = new Array(parts.length).fill(0);
      const assign = (cutIdx) => { let bnd = 0; units.forEach((un, j) => { while (bnd < cutIdx.length && j >= cutIdx[bnd]) bnd++; for (const i of un.g) band[i] = bnd; }); };
      const crossingNets = () => netList.filter((ns) => new Set(ns.map((i) => band[i])).size > 1).length;
      // greedy cut indices near the targets, scored by balance and crossing nets
      const cutIdx = [];
      for (let b2 = 1; b2 < k; b2++) {
        const target = X0 + (b2 * W) / k;
        let best = null;
        for (let j = 1; j < units.length; j++) {
          if (cutIdx.some((c) => Math.abs(c - j) < 1) || (cutIdx.length && j <= cutIdx[cutIdx.length - 1])) continue;
          const xc = (units[j - 1].c + units[j].c) / 2;
          if (Math.abs(xc - target) > 0.6 * (W / k)) continue;
          assign([...cutIdx, j]);
          const sc = Math.abs(xc - target) / (W / k) * 4 + crossingNets() / Math.max(1, netList.length) * 3;
          if (!best || sc < best.sc) best = { j, sc };
        }
        if (best) cutIdx.push(best.j);
      }
      if (process.env.SA_DEBUG) console.error('FOLD', JSON.stringify({ W, H, k, units: units.length, cutIdx }));
      if (cutIdx.length) {
        assign(cutIdx);
        const gapY = 2.5 * u;
        const minX = new Map();
        parts.forEach((p, i) => minX.set(band[i], Math.min(minX.get(band[i]) ?? Infinity, bx[i][0])));
        let yOff = 0;
        for (let b2 = 0; b2 <= cutIdx.length; b2++) {
          const idx = parts.map((_, i) => i).filter((i) => band[i] === b2);
          if (!idx.length) continue;
          const y0 = Math.min(...idx.map((i) => bx[i][1])), y1 = Math.max(...idx.map((i) => bx[i][3]));
          // squeeze the holes left by the units moved to other bands: empty x runs
          // of this band shrink to one gap (interleaving and rows are kept)
          const iv2 = idx.map((i) => [bx[i][0], bx[i][2]]).sort((x, y) => x[0] - y[0]);
          const merged = [];
          for (const [x0, x1] of iv2) { if (merged.length && x0 <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], x1); else merged.push([x0, x1]); }
          const shiftAt = (x) => { let sh = X0 - merged[0][0]; for (let m = 1; m < merged.length && merged[m][0] <= x; m++) sh -= Math.max(0, merged[m][0] - merged[m - 1][1] - u * GAP * 2); return sh; };
          for (const i of idx) { parts[i].x += Math.round(shiftAt(bx[i][0])); parts[i].y += Math.round(Y0 + yOff - y0); }
          yOff += y1 - y0 + gapY;
        }
      }
    }
  }
  // two-terminal parts turn (180°) when that brings each pin nearer to the rest
  // of its net (check.py wrap-around: a pin facing away from its destination);
  // their symbols turn with them
  if (opts.saDipoleTurn ?? (process.env.SA_DIPOLE_TURN !== '0')) for (let pass = 0; pass < 2; pass++) for (const [k, p] of parts.entries()) {
    if (['M', 'Q'].includes(p.pc.prefix) || p.pins.length !== 2) continue;
    const near = (net, pt) => {
      if (RAIL.test(net)) return 0;
      let b = Infinity;
      parts.forEach((q, j) => { if (j !== k) q.pins.forEach((_, m) => { if (pinNet(q, m) === net) b = Math.min(b, Math.abs(q.x + pinOff[j][m].x - pt.x) + Math.abs(q.y + pinOff[j][m].y - pt.y)); }); });
      for (const t of taps) if (t.owner && t.owner !== p && String(t.net).toLowerCase() === String(net).toLowerCase()) b = Math.min(b, Math.abs(t.owner.x + t.ox + t.cell.w / 2 - pt.x) + Math.abs(t.owner.y + t.oy + t.cell.h / 2 - pt.y));
      return b === Infinity ? 0 : b;
    };
    const at = (m, turned) => { const o = pinOff[k][m]; return turned ? { x: p.x + p.w - o.x, y: p.y + (p.bw >= p.bh ? o.y : p.h - o.y) } : { x: p.x + o.x, y: p.y + o.y }; };
    const c0 = near(pinNet(p, 0), at(0, false)) + near(pinNet(p, 1), at(1, false));
    const c1 = near(pinNet(p, 0), at(0, true)) + near(pinNet(p, 1), at(1, true));
    if (c1 >= c0 - 1) continue;
    if (p.bw >= p.bh) {   // horizontal: a mirror keeps its text upright
      p.flipStyle = { flipH: String(p.cell.style.map.get('flipH') || '0') === '1' ? null : 1 };
      p.cell.style.map.set('flipH', p.flipStyle.flipH ? '1' : '0');
    } else { p.cell.rotation = (((p.cell.rotation || 0) + 180) % 360 + 360) % 360; p.turn = p.cell.rotation; }
    const mirrorOnly = p.bw >= p.bh;
    pinOff[k] = pinOff[k].map((o) => ({ x: p.w - o.x, y: mirrorOnly ? o.y : p.h - o.y }));
    for (const t of p.taps) { t.ox = p.w - t.ox - t.cell.w; if (!mirrorOnly) t.oy = p.h - t.oy - t.cell.h; }
  }
  // two symbols of the same rail landing on one spot (two pins of one part on
  // the supply): keep one, the net is rewired to it (check.py comp-overlap)
  const dropped = new Set();
  for (const p of parts) for (const t of p.taps) {
    if (dropped.has(t) || !['power', 'ground'].includes(t.cls.role)) continue;
    for (const q of parts) for (const t2 of q.taps) {
      if (t2 === t || dropped.has(t2) || t2.cls.role !== t.cls.role || String(t2.net).toLowerCase() !== String(t.net).toLowerCase()) continue;
      const ax = p.x + t.ox, ay = p.y + t.oy, bx2 = q.x + t2.ox, by2 = q.y + t2.oy;
      if (ax < bx2 + t2.cell.w && bx2 < ax + t.cell.w && ay < by2 + t2.cell.h && by2 < ay + t.cell.h) dropped.add(t2);
    }
  }
  for (const t of dropped) { try { deleteCell(model, t.cell.id); } catch { /* already gone */ } t.owner.taps = t.owner.taps.filter((x) => x !== t); }
  for (let k = taps.length - 1; k >= 0; k--) if (dropped.has(taps[k])) taps.splice(k, 1);
  // apply positions
  for (const p of parts) {
    updateCell(model, p.cell.id, { x: p.x, y: p.y, ...(p.flipStyle ? { style: p.flipStyle } : {}), ...(p.turn != null ? { rotation: p.turn } : {}) });
    for (const t of p.taps) updateCell(model, t.cell.id, { x: p.x + t.ox, y: p.y + t.oy });
    for (const l of p.labels || []) updateCell(model, l.cell.id, { x: p.x + l.ox, y: p.y + l.oy });
  }
  // rewire: Manhattan MST over the terminals of each net
  const after = new Map(allCells(model).map(cellInfo).map((c) => [c.id, c]));
  const terms = new Map();
  const addT = (net, id, pin) => { const k = String(net).toLowerCase(); if (!terms.has(k)) terms.set(k, []); const c = after.get(id); terms.get(k).push({ id, pin, at: pinAbs(c, pin) }); };
  for (const p of parts) p.pins.forEach((pin, i) => addT(pinNet(p, i), p.cell.id, pin));
  for (const t of taps) if (t.pin) addT(t.net, t.cell.id, t.pin);
  // grid wiring (SA_GRID=0 disables): the placement puts DC branches in columns
  // and pairs / mirrors on rows, so many connections are a straight vertical or
  // horizontal line between two pins. Such a line is drawn as a FIXED straight
  // wire when it crosses no body (its own two parts only next to their pins),
  // passes no foreign pin and runs along or ends on no wire of another net; the
  // spanning tree of each net prefers these lines. The rest goes to the router.
  const GRID = opts.saGrid ?? (process.env.SA_GRID !== '0');
  const bodies = [...after.values()].filter((c) => c.kind === 'vertex' && c.x != null && c.w >= 12 && classify(c).role !== 'junction' && classify(c).role !== 'other')
    .map((c) => ({ id: c.id, ...rotatedAabb(c) }));
  const netOfPin = [];   // every terminal, for the foreign-pin test
  for (const [k, ts] of terms) for (const t of ts) netOfPin.push({ net: k, at: t.at });
  const fixedSegs = [];  // {net, a, b} of the fixed wires already drawn
  const segHitsRect = (a, b, r) => {   // axis-aligned segment against a rectangle: length inside
    if (a.x === b.x) { if (a.x <= r.x || a.x >= r.x + r.w) return 0; return Math.max(0, Math.min(Math.max(a.y, b.y), r.y + r.h) - Math.max(Math.min(a.y, b.y), r.y)); }
    if (a.y <= r.y || a.y >= r.y + r.h) return 0; return Math.max(0, Math.min(Math.max(a.x, b.x), r.x + r.w) - Math.max(Math.min(a.x, b.x), r.x));
  };
  const dPtSeg = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy; const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0; return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); };
  // outward direction of a pin: the side of its cell it sits on
  const dirOf = (t) => {
    const c = after.get(t.id); const r = rotatedAabb(c); const a = t.at;
    const d = [[a.x - r.x, -1, 0], [r.x + r.w - a.x, 1, 0], [a.y - r.y, 0, -1], [r.y + r.h - a.y, 0, 1]].sort((x, y) => x[0] - y[0])[0];
    return { x: d[1], y: d[2] };
  };
  // a polyline [A.at … B.at] is acceptable when every segment is axis-aligned,
  // crosses no body (the end parts only next to their pin), passes no foreign
  // pin, and neither runs along nor touches a fixed wire of another net;
  // returns its crossings with other nets (allowed, but they cost)
  const pathOk = (net, A, B, pts) => {
    let crossings = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a2 = pts[k], b2 = pts[k + 1];
      if (Math.abs(a2.x - b2.x) > 0.5 && Math.abs(a2.y - b2.y) > 0.5) return null;
      if (Math.hypot(a2.x - b2.x, a2.y - b2.y) < 0.5) continue;
      const vert = Math.abs(a2.x - b2.x) <= 0.5;
      for (const r of bodies) {
        const ownA = r.id === A.id && k === 0, ownB = r.id === B.id && k === pts.length - 2;
        // a foreign body with a 2 px clearance (a wire on its edge reads as crossing it)
        if (!ownA && !ownB) { if (segHitsRect(a2, b2, { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 }) > 0) return null; continue; }
        const inside = segHitsRect(a2, b2, { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 });
        if (inside <= 0) continue;
        // its own part: only the lead next to its pin (check.py: 8 px)
        const own = ownA ? a2 : b2, far = ownA ? b2 : a2;
        const clip = { x: Math.max(r.x, Math.min(r.x + r.w, far.x)), y: Math.max(r.y, Math.min(r.y + r.h, far.y)) };
        if (Math.hypot(clip.x - own.x, clip.y - own.y) > 6) return null;
      }
      // no wire along the flank of a body (check.py channel-hug / edge-hug)
      for (const r of bodies) {
        if (vert && r.h >= 60 && (Math.abs(a2.x - r.x) < 3 || Math.abs(a2.x - r.x - r.w) < 3)
          && Math.min(Math.max(a2.y, b2.y), r.y + r.h) - Math.max(Math.min(a2.y, b2.y), r.y) > 12) return null;
        if (!vert && r.h >= 60 && (Math.abs(a2.y - r.y) < 3 || Math.abs(a2.y - r.y - r.h) < 3)
          && Math.min(Math.max(a2.x, b2.x), r.x + r.w) - Math.max(Math.min(a2.x, b2.x), r.x) > 24) return null;
      }
      for (const q of netOfPin) if (q.net !== net && dPtSeg(q.at, a2, b2) < 8) return null;
      for (const f of fixedSegs) {
        if (f.net === net) {   // same net: on top of it or well apart (check.py rule 29)
          const fv = Math.abs(f.a.x - f.b.x) <= 0.5;
          if (fv !== vert) continue;
          const d = vert ? Math.abs(f.a.x - a2.x) : Math.abs(f.a.y - a2.y);
          const lo = vert ? Math.max(Math.min(a2.y, b2.y), Math.min(f.a.y, f.b.y)) : Math.max(Math.min(a2.x, b2.x), Math.min(f.a.x, f.b.x));
          const hi = vert ? Math.min(Math.max(a2.y, b2.y), Math.max(f.a.y, f.b.y)) : Math.min(Math.max(a2.x, b2.x), Math.max(f.a.x, f.b.x));
          if (d >= 0.6 && d < 14 && hi - lo > 18) return null;
          continue;
        }
        if (dPtSeg(a2, f.a, f.b) < 4 || dPtSeg(b2, f.a, f.b) < 4 || dPtSeg(f.a, a2, b2) < 4 || dPtSeg(f.b, a2, b2) < 4) return null;
        const fv = Math.abs(f.a.x - f.b.x) <= 0.5;
        if (fv !== vert) { crossings++; continue; }
        const d = vert ? Math.abs(f.a.x - a2.x) : Math.abs(f.a.y - a2.y);
        const lo = vert ? Math.max(Math.min(a2.y, b2.y), Math.min(f.a.y, f.b.y)) : Math.max(Math.min(a2.x, b2.x), Math.min(f.a.x, f.b.x));
        const hi = vert ? Math.min(Math.max(a2.y, b2.y), Math.max(f.a.y, f.b.y)) : Math.min(Math.max(a2.x, b2.x), Math.max(f.a.x, f.b.x));
        if (d < 12 && hi - lo > 0) return null;
      }
    }
    // perpendicular crossings were counted on both segments of a crossing pair only once per fixed segment: an estimate
    return { crossings };
  };
  const clean = (pts) => {   // drop repeated and collinear points
    const o = [];
    for (const q of pts) { if (o.length && Math.hypot(o[o.length - 1].x - q.x, o[o.length - 1].y - q.y) < 0.5) continue; o.push(q); }
    for (let k = o.length - 2; k >= 1; k--) { const a2 = o[k - 1], b2 = o[k], c2 = o[k + 1]; if ((Math.abs(a2.x - b2.x) < 0.5 && Math.abs(b2.x - c2.x) < 0.5) || (Math.abs(a2.y - b2.y) < 0.5 && Math.abs(b2.y - c2.y) < 0.5)) o.splice(k, 1); }
    return o;
  };
  const straightOk = (net, A, B) => {
    const a = A.at, b = B.at;
    if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) return false;
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1) return false;
    const b2 = { ...b }; if (Math.abs(a.x - b.x) <= 0.5) b2.x = a.x; else b2.y = a.y;
    const ok = pathOk(net, A, B, [a, b2]);
    return ok && ok.crossings === 0 ? [a, b2] : false;
  };
  // candidate paths between two pins: L shapes, then escape from each pin along
  // its outward direction and join through a horizontal or vertical lane
  // (corridor) chosen near the two pins; the cheapest valid one is kept
  const LANES = opts.saLanes ?? (process.env.SA_LANES !== '0');
  const routeFixed = (net, A, B) => {
    const a = A.at, b = B.at, cands = [];
    cands.push([a, { x: a.x, y: b.y }, b], [a, { x: b.x, y: a.y }, b]);
    if (LANES) {
      const da = dirOf(A), db = dirOf(B);
      for (const E of [14, 14 + G, 14 + 2 * G, 14 + 4 * G]) {
        const ea = { x: a.x + da.x * E, y: a.y + da.y * E }, eb = { x: b.x + db.x * E, y: b.y + db.y * E };
        const lo = Math.min(ea.y, eb.y), hi = Math.max(ea.y, eb.y), lx0 = Math.min(ea.x, eb.x), lx1 = Math.max(ea.x, eb.x);
        const ys = [ea.y, eb.y], xs = [ea.x, eb.x];
        for (let k = 1; k <= 14; k++) { ys.push(lo - k * G, hi + k * G, (lo + hi) / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * G); xs.push(lx0 - k * G, lx1 + k * G, (lx0 + lx1) / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * G); }
        for (const Y of ys) cands.push([a, ea, { x: ea.x, y: Y }, { x: eb.x, y: Y }, eb, b], [a, { x: a.x, y: Y }, { x: b.x, y: Y }, b]);
        for (const X of xs) cands.push([a, ea, { x: X, y: ea.y }, { x: X, y: eb.y }, eb, b], [a, { x: X, y: a.y }, { x: X, y: b.y }, b]);
      }
    }
    let best = null;
    for (const c0 of cands) {
      const pts = clean(c0);
      if (pts.length < 2) continue;
      let len = 0; for (let k = 0; k + 1 < pts.length; k++) len += Math.abs(pts[k].x - pts[k + 1].x) + Math.abs(pts[k].y - pts[k + 1].y);
      const cost0 = len / u + (opts.saBend ?? 2.5) * (pts.length - 2) + (pts.length - 2 > 2 ? 4 : 0);   // basics: > 2 bends is a detour
      if (best && cost0 >= best.cost) continue;
      const ok = pathOk(net, A, B, pts);
      if (!ok) continue;
      const cost = cost0 + 3 * ok.crossings;
      if (!best || cost < best.cost) best = { cost, pts };
    }
    return best ? best.pts : null;
  };
  const wires = [];
  const STRAIGHT = 'edgeStyle=none;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiGridRoute=1;';
  const FIXED = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;jettySize=0;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiGridRoute=1;';
  // spanning tree of each net (straight clear lines preferred), then: straight
  // lines are fixed first (columns and rows claim their lines), then the other
  // connections, shortest first, through L shapes and corridors; what finds no
  // clean path goes to the router
  const links = [];
  const netOrder = [...terms.entries()].sort((x, y) => x[1].length - y[1].length);
  for (const [net, ts] of netOrder) {
    if (ts.length < 2) continue;
    const inT = new Set([0]);
    while (inT.size < ts.length) {
      let best = null;
      for (const i of inT) for (let j = 0; j < ts.length; j++) {
        if (inT.has(j)) continue;
        let d = Math.abs(ts[i].at.x - ts[j].at.x) + Math.abs(ts[i].at.y - ts[j].at.y);
        const st = GRID && ts[i].id !== ts[j].id ? straightOk(net, ts[i], ts[j]) : false;
        if (st) d *= 0.3;
        if (ts[i].id === ts[j].id) d = d * 4 + 4 * u;
        // a pin facing away from the other end makes the wire go round its body
        for (const [p0, p1] of [[ts[i], ts[j]], [ts[j], ts[i]]]) { const dr = dirOf(p0); if (dr.x * (p1.at.x - p0.at.x) + dr.y * (p1.at.y - p0.at.y) < -u * 0.3) d += 2 * u; }   // a diode link (gate to its own drain) only as a last resort
        if (!best || d < best.d) best = { d, i, j, st };
      }
      inT.add(best.j);
      links.push({ net, a: ts[best.i], b: ts[best.j], st: best.st, len: best.d });
    }
  }
  const fix = (l, pts) => {
    for (let k = 0; k + 1 < pts.length; k++) fixedSegs.push({ net: l.net, a: pts[k], b: pts[k + 1] });
    // a straight wire carries no waypoint (a midpoint is a vertex: another net
    // crossing exactly there read as a contact, check.py 22-contact)
    if (pts.length === 2) wires.push(addWire(model, { source: l.a.id, target: l.b.id, sourcePin: l.a.pin, targetPin: l.b.pin, style: STRAIGHT }).getAttribute('id'));
    else wires.push(addWire(model, { source: l.a.id, target: l.b.id, sourcePin: l.a.pin, targetPin: l.b.pin, style: FIXED, points: pts.slice(1, -1) }).getAttribute('id'));
  };
  const rest = [];
  for (const l of links) {
    const st = l.st && straightOk(l.net, l.a, l.b);
    if (st) fix(l, st); else rest.push(l);
  }
  rest.sort((x, y) => x.len - y.len);
  for (const l of rest) {
    const pts = GRID ? routeFixed(l.net, l.a, l.b) : null;
    if (pts) fix(l, pts);
    else wires.push(addWire(model, { source: l.a.id, target: l.b.id, sourcePin: l.a.pin, targetPin: l.b.pin }).getAttribute('id'));
  }
  await routePage(model, wires, {});
  normalizeOrigin(model);
  return { ...placed, wires };
}
