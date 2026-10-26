/**
 * place-manuel.js — engine "manuel": a netlist drawn the way a textbook figure
 * is built (schemas-lisibles, 2026-10-24; orchestrator GO the same day).
 *
 * The reading (lib/manuel-reading.js) gives frames, DC-branch columns, mirror
 * pairs and bridge chains. Here the geometry is WRITTEN, not searched:
 *
 *  - one supply line on top and one ground line at the bottom of each frame,
 *    one symbol each;
 *  - every column is a straight vertical line; P devices stacked from the top,
 *    N devices from the bottom, rows aligned across columns, so the nodes of a
 *    mirrored pair sit at the same height;
 *  - paired columns mirrored about one axis, the input pair innermost, the
 *    next stages outward, a self-symmetric column (tail) on the axis;
 *  - each net of a frame is a horizontal SPINE at its node height plus
 *    vertical drops: no router, no wire through a body by construction;
 *  - a bridge (Miller R-C) lies horizontally at the level of its two nodes;
 *  - a gate network (sensing resistors, dividers on a gate) hangs as a small
 *    ladder off the gate stub;
 *  - bias / frame-crossing nets are named by labels (orchestrator 2026-10-24:
 *    labels for bias nets only; signal nets stay wires), the auxiliary frames
 *    (bias, CMFB) are drawn apart in dashed boxes;
 *  - values in engineering notation, W/L in µm.
 *
 * `importNetlistManuel(model, parsed)` throws when a step cannot be written
 * (an unsure drawing is never returned; auto then keeps the other engines).
 */
import { addVertex, addWire } from './model.js';
import { SPICE_MAP, PIN_ORDER_OVERRIDES } from './components.js';
import { getShape } from './stencils.js';
import { manuelReading, chan, gateOf, isP, BIASNAME } from './manuel-reading.js';
import { preserveElectricalData } from './electrical-data.js';
import { geoLvs } from './geo-lvs.js';
import { brokawReading, importBrokaw } from './place-brokaw.js';

const ROW = 170, DEV_H = 110, MID = 100, RAIL_GAP = 40;
const JUNCTION = 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;contactDot=1;';
const WIRE = 'edgeStyle=none;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiManuel=1;';
const isTr = (c) => c.prefix === 'M' || c.prefix === 'Q';
const isN = (c) => isTr(c) && !isP(c);

/* ---------------------------------------------------------------- notation */
const MULT = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, µ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
export function num(s) {
  const m = /^([-+]?[0-9.]+(?:e[-+]?\d+)?)(meg|[tgkmuµnpf])?/i.exec(String(s).trim());
  if (!m) return null;
  return parseFloat(m[1]) * (m[2] ? MULT[m[2].toLowerCase()] : 1);
}
/** 100000 -> "100 k", 4.97e-13 -> "497 f" */
export function eng(x, unit = '') {
  if (x == null || !isFinite(x)) return null;
  if (x === 0) return `0 ${unit}`.trim();
  for (const [p, s] of [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']]) {
    if (Math.abs(x) >= p * 0.9999) return `${+(x / p).toPrecision(3)} ${s}${unit}`.trim();
  }
  return `${+(x / 1e-15).toPrecision(3)} f${unit}`;
}
/** the annotation of a part: W/L in µm for a transistor, value + unit else */
export function annotation(c) {
  const v = String(c.value || '');
  if (c.prefix === 'Q') return (c.model || '').slice(0, 14);
  if (isTr(c)) {
    const p = (k) => { const m = new RegExp(`\\b${k}\\s*=\\s*([^\\s]+)`, 'i').exec(v); return m ? num(m[1]) : null; };
    const w = p('w'), l = p('l'), nf = p('ng') || p('nf'), mm = p('m');
    if (w == null || l == null) return (c.model || '').slice(0, 14);
    const um = (x) => +(x / 1e-6).toPrecision(4);
    return `${um(w)}/${um(l)}` + (nf > 1 ? ` ng=${nf}` : '') + (mm > 1 ? ` ×${mm}` : '');
  }
  if (c.pdk && c.params && (c.prefix === 'R' || c.prefix === 'C')) {
    // an IHP primitive (lib/pdk-ihp.js): model and W/L (or W×L) in µm
    const um = (k) => { const x = num(c.params[k] || ''); return x == null ? null : +(x / 1e-6).toPrecision(4); };
    const w = um('w'), l = um('l'), mm = num(c.params.m || '1');
    if (w == null || l == null) return c.pdk.slice(0, 14);
    return `${c.pdk} ${w}${c.prefix === 'C' ? '×' : '/'}${l}` + (mm > 1 ? ` ×${mm}` : '');
  }
  const unit = { R: 'Ω', C: 'F', L: 'H', I: 'A', V: 'V' }[c.prefix];
  if (!unit) return v.slice(0, 14);
  const dc = /\bdc\s+([^\s]+)/i.exec(v);
  const x = num(dc ? dc[1] : v.split(/\s+/).find((t) => num(t) != null) || '');
  return x == null ? v.slice(0, 14) : eng(x, unit);
}

/* --------------------------------------------------------------- the sheet */
/** intermediate drawing: vertices with absolute pins, and per net a set of
 *  orthogonal segments between points, some of them terminals (pins) */
class Sheet {
  constructor() { this.verts = []; this.texts = []; this.nets = new Map(); this.boxes = []; this.marks = []; }
  /** a corner drawn on purpose (a diode loop): its wire is exempt from the avoidable-bend check */
  mark(p) { this.marks.push({ x: p.x, y: p.y }); }
  net(n) { if (!this.nets.has(n)) this.nets.set(n, { segs: [], terms: new Map() }); return this.nets.get(n); }
  /** a vertex; pins: {name: rel {x,y}} (unflipped, unrotated, as drawio stores them) */
  vert(o) {
    const v = { ...o, pinAbs: {} };
    for (const [name, rel] of Object.entries(o.pins || {})) {
      let px = rel.x, py = rel.y;
      if (o.flip) px = 1 - px;
      let dx = (px - 0.5) * o.w, dy = (py - 0.5) * o.h;
      const r = ((o.rot || 0) % 360 + 360) % 360;
      if (r === 90) [dx, dy] = [-dy, dx]; else if (r === 180) [dx, dy] = [-dx, -dy]; else if (r === 270) [dx, dy] = [dy, -dx];
      v.pinAbs[name] = { x: o.x + o.w / 2 + dx, y: o.y + o.h / 2 + dy };
    }
    this.verts.push(v);
    return v;
  }
  /** register (vertex, pin) as a terminal of net n at its absolute position */
  term(n, v, pin) { const p = v.pinAbs[pin]; this.net(n).terms.set(key(p), { v, pin, x: p.x, y: p.y }); return { x: p.x, y: p.y }; }
  /** an orthogonal path of points on net n */
  path(n, ...pts) {
    const N = this.net(n);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) continue;
      if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) throw new Error(`manuel: oblique segment on ${n}`);
      N.segs.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
    }
  }
  text(html, x, y, w, h, align = 'left', size = 11) { this.texts.push({ html, x, y, w, h, align, size }); }
  bbox() {
    const xs = [], ys = [];
    for (const v of this.verts) { xs.push(v.x, v.x + v.w); ys.push(v.y, v.y + v.h); }
    for (const t of this.texts) { xs.push(t.x, t.x + t.w); ys.push(t.y, t.y + t.h); }
    for (const N of this.nets.values()) for (const s of N.segs) for (const p of s) { xs.push(p.x); ys.push(p.y); }
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }
  shift(dx, dy) {
    for (const v of this.verts) { v.x += dx; v.y += dy; for (const p of Object.values(v.pinAbs)) { p.x += dx; p.y += dy; } }
    for (const t of this.texts) { t.x += dx; t.y += dy; }
    for (const m of this.marks) { m.x += dx; m.y += dy; }
    for (const N of this.nets.values()) {
      for (const s of N.segs) for (const p of s) { p.x += dx; p.y += dy; }
      const terms = new Map();
      for (const t of N.terms.values()) { t.x += dx; t.y += dy; terms.set(key(t), t); }
      N.terms = terms;
    }
    for (const b of this.boxes) { b.x += dx; b.y += dy; }
  }
}
const key = (p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;

/* --------------------------------------------------------------- symbols */
function shapeOf(c) {
  const m = SPICE_MAP[c.prefix];
  if (c.prefix === 'M' && isP(c)) return m.variants.PMOS;
  if (c.prefix === 'Q' && isP(c)) return m.variants.PNP;
  return m.shape;
}
function pinNames(c) {
  const sh = shapeOf(c);
  return PIN_ORDER_OVERRIDES[sh] || SPICE_MAP[c.prefix].pinOrder;
}
function relPins(shapeKey) {
  const s = getShape(shapeKey);
  return Object.fromEntries(s.pins.map((p) => [p.name, { x: p.x, y: p.y }]));
}
function devStyle(shapeKey, flip) {
  return `shape=${shapeKey};html=1;fillColor=none;strokeColor=default;noLabel=1;` + (flip ? 'flipH=1;' : '');
}

/** a transistor whose channel line is at x = cx, top at y; dir = gate side (-1 left, +1 right) */
function placeTr(S, c, cx, y, dir) {
  const sh = shapeOf(c), s = getShape(sh), pins = relPins(sh), flip = dir > 0;
  const chx = pins.NE.x * s.w;            // channel pin offset in the unflipped frame
  const x = flip ? cx - (s.w - chx) : cx - chx;
  const v = S.vert({ id: c.ref, c, shape: sh, style: devStyle(sh, flip), x, y, w: s.w, h: s.h, flip, pins, value: c.value || '', refdes: c.ref });
  const names = pinNames(c);              // SPICE order D G S (C B E)
  const [top, bot] = chan(c);
  // a P device: top = source (index 2); an N device: top = drain (index 0)
  v.pinOf = { top: isP(c) ? names[2] : names[0], bot: isP(c) ? names[0] : names[2], gate: names[1] };
  v.netOf = { top, bot, gate: gateOf(c) };
  const tx = dir > 0 ? cx - 98 : cx + 8;
  S.text(`<b>${c.ref}</b><br><font style="font-size:10px">${annotation(c)}</font>`, tx, y + s.h / 2 - 17, 90, 34, dir > 0 ? 'right' : 'left', 12);
  return v;
}

/** a two-terminal part, vertical (centre x = cx, top pin at y) or horizontal
 *  (left pin at x = cx, centre line at y); `first` = the net at the top / left */
function placeTwo(S, c, cx, y, first, vertical, labelSide = 1) {
  const sh = shapeOf(c), s = getShape(sh), pins = relPins(sh), names = pinNames(c);
  const p0 = names[0], p1 = names[1];
  const firstPin = c.nodes[0] === first ? p0 : p1, otherPin = firstPin === p0 ? p1 : p0;
  // the pin's position in the unrotated frame decides the rotation
  const a = pins[firstPin], b = pins[otherPin];
  const horizontalPins = Math.abs(a.y - b.y) < 1e-6;    // in/out shapes: pins left/right
  let rot = 0;
  if (vertical) rot = horizontalPins ? (a.x < b.x ? 90 : 270) : (a.y < b.y ? 0 : 180);
  else rot = horizontalPins ? (a.x < b.x ? 0 : 180) : (a.y < b.y ? 270 : 90);
  // the visual length between pins
  const len = horizontalPins ? Math.abs(a.x - b.x) * s.w : Math.abs(a.y - b.y) * s.h;
  // geometry centre
  let gx, gy;
  if (vertical) { gx = cx; gy = y + len / 2; } else { gx = cx + len / 2; gy = y; }
  // pins are not always on the centre line (inductor_3: y = 1): correct with the rotated offset
  const v0 = S.vert({ id: c.ref, c, shape: sh, style: devStyle(sh, false) + (rot ? `rotation=${rot};` : ''), x: gx - s.w / 2, y: gy - s.h / 2, w: s.w, h: s.h, rot, pins, value: c.value || '', refdes: c.ref });
  const pa = v0.pinAbs[firstPin];
  const want = vertical ? { x: cx, y } : { x: cx, y };
  const dx = want.x - pa.x, dy = want.y - pa.y;
  v0.x += dx; v0.y += dy; for (const p of Object.values(v0.pinAbs)) { p.x += dx; p.y += dy; }
  v0.first = firstPin; v0.other = otherPin; v0.len = len;
  const ann = annotation(c);
  if (vertical) {
    const vis = horizontalPins ? s.h : s.w;           // visual width across
    const tx = labelSide > 0 ? cx + vis / 2 + 6 : cx - vis / 2 - 86;
    S.text(`<b>${c.ref}</b><br>${ann}`, tx, y + len / 2 - 17, 80, 34, labelSide > 0 ? 'left' : 'right', 11);
  } else {
    const vis = horizontalPins ? s.h : s.w;
    S.text(`<b>${c.ref}</b>`, cx + len / 2 - 40, y - vis / 2 - 20, 80, 18, 'center', 11);
    S.text(ann, cx + len / 2 - 40, y + vis / 2 + 2, 80, 18, 'center', 11);
  }
  return v0;
}

function junctionVert(S, p) {
  return S.vert({ id: null, kind: 'junction', style: JUNCTION, x: p.x - 3, y: p.y - 3, w: 6, h: 6, pins: {} });
}
/** supply symbol whose pin is at p (above a rail) */
function tapVdd(S, net, p) {
  const v = S.vert({ id: null, kind: 'power', style: 'shape=mxgraph.electrical.signal_sources.vss2;html=1;verticalLabelPosition=top;verticalAlign=bottom;fillColor=none;strokeColor=default;', x: p.x - 20, y: p.y - 26, w: 40, h: 26, value: net, pins: { S: { x: 0.5, y: 1 } } });
  return v;
}
function tapGnd(S, p) {
  return S.vert({ id: null, kind: 'ground', style: 'shape=mxgraph.electrical.signal_sources.signal_ground;html=1;fillColor=none;strokeColor=default;', x: p.x - 13, y: p.y, w: 26, h: 18, value: '', pins: { N: { x: 0.5, y: 0 } } });
}
/** net label (italic text) or I/O arrow whose connection point is p; side =
 *  where the glyph extends from p (-1 left, +1 right) */
function portVert(S, net, p, side, arrow, direction = 'input') {
  const w = arrow ? 64 : Math.max(30, 8 * net.length), h = arrow ? 24 : 18;
  const gx = side < 0 ? p.x - w : p.x;
  let pin = side < 0 ? 'E' : 'W', st;
  if (arrow) {
    const shape = direction === 'inout' ? 'doubleArrow' : 'singleArrow';
    const west = (direction === 'input') === (side > 0);
    st = `shape=${shape};arrowWidth=1;arrowSize=0.18;apiShape=port;portDirection=${direction};direction=${west ? 'west' : 'east'};html=0;fillColor=#ffffff;strokeColor=default;align=center;verticalAlign=middle;fontSize=12;`;
    if (west) pin = pin === 'E' ? 'W' : 'E';     // drawio rotates the anchors with direction=west
  } else {
    st = `text;html=1;apiShape=port;align=${side < 0 ? 'right' : 'left'};verticalAlign=middle;fontSize=12;fontStyle=2;spacing=2;`;
  }
  const v = S.vert({ id: null, kind: 'port', style: st, x: gx, y: p.y - h / 2, w, h, value: net, pins: { [pin]: pin === 'E' ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 } } });
  // the true connection point is p whatever the anchor rotation
  v.pinAbs[pin] = { x: p.x, y: p.y };
  v.portPin = pin;
  return v;
}

/* ------------------------------------------------------------ the frames */
/** lay out one frame of the reading in local coordinates on its own sheet */
function layoutFrame(F, R, ctx) {
  const S = new Sheet();
  const cols = F.cols;
  const paired = cols.some((c) => c.pair != null);
  const colOfRef = new Map(); cols.forEach((col, i) => col.parts.forEach((p) => colOfRef.set(p.c.ref, i)));
  const nodeCols = new Map();      // net -> column indices where it is a channel node
  const nodeCols0 = nodeCols;
  cols.forEach((col, i) => { for (const p of col.parts) for (const n of [p.up, p.down]) if (n !== R.top && n !== R.bot) { if (!nodeCols.has(n)) nodeCols.set(n, new Set()); nodeCols.get(n).add(i); } });
  const parentOf = (i) => { const t = cols[i].top; if (t === R.top || t === R.bot) return null; for (let j = 0; j < cols.length; j++) if (j !== i && cols[j].parts.some((p) => p.down === t)) return j; return null; };

  /* 1. sides and order ----------------------------------------------- */
  const side = new Array(cols.length).fill(0), rank = new Array(cols.length).fill(0);
  const order = { L: [], R: [], axis: [], rest: [] };
  if (paired) {
    const seedI = cols.findIndex((c) => c.seed) >= 0 ? cols.findIndex((c) => c.seed) : cols.findIndex((c) => c.pair != null);
    const sideOf = new Map();
    const first = Math.min(seedI, cols[seedI].pair);
    sideOf.set(first, -1); sideOf.set(cols[first].pair, 1); rank[first] = rank[cols[first].pair] = 0;
    const netsOf = (i) => new Set(cols[i].parts.flatMap((p) => [p.up, p.down, gateOf(p.c)]).filter((n) => n && n !== R.top && n !== R.bot && cols[i].sigma.get(n) !== n));
    for (let pass = 0; pass < cols.length; pass++) {
      for (let i = 0; i < cols.length; i++) {
        if (cols[i].pair == null || sideOf.has(i)) continue;
        const ns = netsOf(i);
        for (const [j, s] of sideOf) {
          if ([...netsOf(j)].some((n) => ns.has(n))) { sideOf.set(i, s); sideOf.set(cols[i].pair, -s); rank[i] = rank[cols[i].pair] = rank[j] + 1; break; }
        }
      }
    }
    for (let i = 0; i < cols.length; i++) if (cols[i].pair != null && !sideOf.has(i)) { const s = i < cols[i].pair ? -1 : 1; sideOf.set(i, s); rank[i] = 9; }
    const seq = (s) => [...sideOf].filter(([, x]) => x === s).map(([i]) => i).sort((a, b) => rank[a] - rank[b] || a - b);
    order.L = seq(-1); order.R = seq(1);
    // the pair of the left side mirrors the right one: same rank order
    order.R = order.L.map((i) => cols[i].pair);
    for (const i of order.L) side[i] = -1;
    for (const i of order.R) side[i] = 1;
    let axisUsed = false;
    for (let i = 0; i < cols.length; i++) {
      if (cols[i].pair != null) continue;
      const par = parentOf(i);
      if (cols[i].selfSym && !axisUsed) { order.axis.push(i); axisUsed = true; continue; }
      if (par != null && side[par] !== 0) { const L = side[par] < 0 ? order.L : order.R; L.splice(L.indexOf(par) + 1, 0, i); side[i] = side[par]; continue; }
      order.R.push(i); side[i] = 1;
    }
  } else {
    // no symmetry: left to right, a hanging column right after its parent
    for (let i = 0; i < cols.length; i++) {
      const par = parentOf(i);
      if (par != null && order.rest.includes(par)) order.rest.splice(order.rest.indexOf(par) + 1, 0, i); else order.rest.push(i);
    }
  }

  /* 2. levels and rows ----------------------------------------------- */
  const lv = cols.map(() => null);
  const nodeRegion = new Map();    // net -> {kind:'top', t} after top row t
  const depthBelow = (n, seen = new Set()) => {
    if (n === R.bot || n === R.top || seen.has(n)) return 0;
    seen.add(n);
    let d = 0;
    cols.forEach((col, j) => { if (col.top === n) d = Math.max(d, nBotOf(j) + depthBelow(col.bot, seen)); });
    return d;
  };
  const splitOf = (col) => {
    const k = col.parts.findIndex((p) => isN(p.c));
    if (k >= 0) return k;
    const n = col.parts.length, topRail = col.top === R.top, botRail = col.bot === R.bot;
    if (!topRail) return 0;
    if (botRail) return n >= 2 ? n - 1 : 1;
    return n;
  };
  const nBotOf = (j) => cols[j].parts.length - splitOf(cols[j]);
  for (const i of cols.keys()) {
    const col = cols[i];
    let s = splitOf(col);
    let baseT = 0;
    if (col.top !== R.top && col.top !== R.bot) {
      const reg = nodeRegion.get(col.top);
      if (reg && reg.kind === 'top' && s > 0) baseT = reg.t + 1; else s = 0;
    }
    const baseB = col.bot === R.bot ? 0 : depthBelow(col.bot);
    const rows = col.parts.map((p, k) => (k < s ? { top: true, r: baseT + k } : { top: false, r: baseB + (col.parts.length - 1 - k) }));
    lv[i] = { s, rows };
    col.parts.forEach((p, k) => { if (k < s && k === s - 1 && s < col.parts.length) return; if (k < s) nodeRegion.set(p.down, { kind: 'top', t: rows[k].r }); });
  }
  // UNPAIRED GATE PARTNERS (a beta multiplier, a bandgap core): two transistors of
  // adjacent columns sharing a gate net face each other across one bar; the
  // first device of a stack is moved to its partner's row when that is free
  const ubar = new Map();          // ref -> partner ref
  if (!paired) {
    const pos = new Map(order.rest.map((i, k) => [i, k]));
    const firstOfStack = (i, k) => { const r = lv[i].rows[k]; return r.top ? k === lv[i].s - 1 : k === lv[i].s; };
    for (const i of cols.keys()) for (const j of cols.keys()) {
      if (pos.get(j) !== pos.get(i) + 1) continue;
      cols[i].parts.forEach((p, k) => {
        if (!isTr(p.c) || ubar.has(p.c.ref)) return;
        const g = gateOf(p.c); if (!g || g === R.top || g === R.bot) return;
        // only a private gate net (two gates, no label, no port): other taps would land on the bar
        if (ctx.labelNets.has(g) || ctx.ports.has(g) || F.parts.filter((c) => gateOf(c) === g).length !== 2) return;
        const l = cols[j].parts.findIndex((q) => isTr(q.c) && !ubar.has(q.c.ref) && gateOf(q.c) === g && lv[j].rows[cols[j].parts.indexOf(q)].top === lv[i].rows[k].top);
        if (l < 0) return;
        const a = lv[i].rows[k], b = lv[j].rows[l];
        if (a.r !== b.r) {
          // move the one nearer its rail to the other's row (bottom stacks count upward, top stacks downward)
          const [lo, hi, li] = a.r < b.r ? [a, b, [i, k]] : [b, a, [j, l]];
          if (!firstOfStack(li[0], li[1])) return;
          lo.r = hi.r;
        }
        ubar.set(p.c.ref, cols[j].parts[l].c.ref); ubar.set(cols[j].parts[l].c.ref, p.c.ref);
      });
    }
  }
  // a gate network that climbs (two chains or more not ending on ground) needs a taller middle band
  let midH = MID;
  for (const ch of F.chains) void ch;
  {
    const satN = new Set();
    for (const ch of F.chains) for (const n of [ch.a, ch.b]) if (!nodeCols0.has(n) && n !== R.top && n !== R.bot && F.parts.some((c) => gateOf(c) === n)) satN.add(n);
    for (const n of satN) if (F.chains.filter((ch) => (ch.a === n || ch.b === n) && (ch.a === n ? ch.b : ch.a) !== R.bot).length >= 2) midH = 250;
  }
  const T = Math.max(0, ...lv.map((l) => l.rows.filter((r) => r.top).map((r) => r.r + 1)).flat());
  const B = Math.max(0, ...lv.map((l) => l.rows.filter((r) => !r.top).map((r) => r.r + 1)).flat());
  const yR = RAIL_GAP;
  const yTop = (t) => yR + 40 + t * ROW;
  const TE = T > 0 ? yTop(T - 1) + DEV_H : yR + 20;
  const midY = TE + midH / 2;
  const BS = TE + midH;
  const yBot = (b) => BS + (B - 1 - b) * ROW;
  const yG = (B > 0 ? yBot(0) + DEV_H : BS) + 40;
  const rowY = (r) => (r.top ? yTop(r.r) : yBot(r.r));

  /* 3. gate sides --------------------------------------------------- */
  const sgnOf = (i) => (paired ? side[i] : 0);
  const outward = (i) => (sgnOf(i) || -1);
  const satelliteNets = new Set();
  for (const ch of F.chains) for (const n of [ch.a, ch.b]) if (!nodeCols.has(n) && n !== R.top && n !== R.bot && F.parts.some((c) => gateOf(c) === n)) satelliteNets.add(n);
  const posIdx = new Map();        // column -> signed position index (for "toward")
  if (paired) { order.L.forEach((i, k) => posIdx.set(i, -(k + 1))); order.R.forEach((i, k) => posIdx.set(i, k + 1)); order.axis.forEach((i) => posIdx.set(i, 0)); } else order.rest.forEach((i, k) => posIdx.set(i, k));
  const gateDir = new Map();
  const sharedBar = new Map();     // ref -> partner ref (gates joined across the axis)
  for (const i of cols.keys()) {
    const col = cols[i], sg = sgnOf(i);
    col.parts.forEach((p, k) => {
      const c = p.c; if (!isTr(c)) return;
      const g = gateOf(c);
      let dir;
      const partner = col.pair != null ? cols[col.pair].parts[k]?.c : null;
      const adjacentPair = col.pair != null && rank[i] === 0 && Math.abs(posIdx.get(i)) === 1 && !order.axis.some((a) => lv[a].rows.some((r) => r.top === lv[i].rows[k].top && r.r === lv[i].rows[k].r));
      if (ubar.has(c.ref)) { dir = Math.sign(posIdx.get(colOfRef.get(ubar.get(c.ref))) - posIdx.get(i)); sharedBar.set(c.ref, ubar.get(c.ref)); }
      else if (g === R.top || g === R.bot) dir = outward(i);
      else if (ctx.ports.has(g) && !ctx.labelNets.has(g) && !nodeCols.has(g)) dir = outward(i);
      else if (partner && gateOf(partner) === g && adjacentPair && (ctx.labelNets.has(g) || !nodeCols.has(g) || nodeCols.get(g).has(i) || nodeCols.get(g).has(col.pair))) { dir = -sg; sharedBar.set(c.ref, partner.ref); }
      else if (satelliteNets.has(g)) dir = outward(i);
      else if (g === p.up || g === p.down) dir = sg ? (partner && gateOf(partner) === g && adjacentPair ? -sg : sg) : -1;
      else if (nodeCols.has(g) && !ctx.labelNets.has(g)) {
        const j = [...nodeCols.get(g)][0];
        const d = posIdx.get(j) - posIdx.get(i);
        dir = d === 0 ? (sg || -1) : Math.sign(d);
      } else if (sg && partner && gateOf(partner) !== g && satelliteNets.has(gateOf(partner))) dir = sg;   // mirror of a partner whose gate goes outward (CMFB pair: sense node / reference)
      else dir = sg ? -sg : -1;
      gateDir.set(c.ref, dir);
    });
  }

  /* 4. x of the columns --------------------------------------------- */
  const ext = (i, s) => {     // extent of column i on side s (-1 / +1)
    let e = 40;
    for (const p of cols[i].parts) {
      const c = p.c;
      if (isTr(c)) {
        const d = gateDir.get(c.ref), g = gateOf(c);
        if (d === s) e = Math.max(e, 70 + (sharedBar.has(c.ref) || [...sharedBar.values()].includes(c.ref) ? 20 : satelliteNets.has(g) ? 200 : ctx.labelNets.has(g) || ctx.ports.has(g) ? 75 : 40));
        else e = Math.max(e, 100);
      } else e = Math.max(e, (s === labelSideOf(i) ? 105 : 40));
    }
    return e;
  };
  const labelSideOf = (i) => (paired ? (side[i] || 1) : 1);
  const bridgeNeed = (i, j) => {     // a bridge between nodes of columns i and j
    let need = 0;
    for (const ch of F.chains) {
      const ca = nodeCols.get(ch.a), cb = nodeCols.get(ch.b);
      if (!ca || !cb) continue;
      if ((ca.has(i) && cb.has(j)) || (ca.has(j) && cb.has(i))) need = Math.max(need, chainLen(ch) + 110 + 30);
    }
    return need;
  };
  const xs = new Array(cols.length).fill(0);
  if (paired) {
    const half = Math.max(120, ...[order.L[0], order.R[0]].filter((i) => i != null).map((i) => ext(i, -side[i]) + 20));
    for (const s of [-1, 1]) {
      const L = s < 0 ? order.L : order.R;
      let x = s * half;
      L.forEach((i, k) => {
        if (k > 0) { const prev = L[k - 1]; x += s * Math.max(ext(prev, s) + ext(i, -s) + 30, bridgeNeed(prev, i)); }
        xs[i] = x;
      });
    }
    for (const i of order.axis) xs[i] = 0;
  } else {
    let x = 0;
    order.rest.forEach((i, k) => {
      if (k > 0) { const prev = order.rest[k - 1]; x += Math.max(ext(prev, 1) + ext(i, -1) + 30, bridgeNeed(prev, i)); }
      xs[i] = x;
    });
  }

  /* 5. devices -------------------------------------------------------- */
  const V = new Map();   // ref -> vertex
  for (const i of cols.keys()) {
    const col = cols[i];
    col.parts.forEach((p, k) => {
      const y = rowY(lv[i].rows[k]);
      if (isTr(p.c)) V.set(p.c.ref, placeTr(S, p.c, xs[i], y, gateDir.get(p.c.ref)));
      else {
        const v = placeTwo(S, p.c, xs[i], y + (DEV_H - lenOf(p.c)) / 2, p.up, true, labelSideOf(i));
        v.pinOf = { top: v.first, bot: v.other }; v.netOf = { top: p.up, bot: p.down };
        V.set(p.c.ref, v);
      }
    });
  }
  const pinP = (ref, which) => { const v = V.get(ref); return v.pinAbs[v.pinOf[which]]; };
  const term = (n, ref, which) => S.term(n, V.get(ref), V.get(ref).pinOf[which]);

  /* 6. node heights and column lines ------------------------------------ */
  const yNode = new Map();
  // the tail above a P pair: at the level of the pair's sources, the tail drops onto it (mirror of the N case)
  for (const i of cols.keys()) {
    const col = cols[i], n = col.top;
    if (col.pair == null || n === R.top || n === R.bot || !isTr(col.parts[0].c) || !order.axis.some((a) => cols[a].parts.some((p) => p.down === n))) continue;
    yNode.set(n, pinP(col.parts[0].c.ref, 'top').y);
  }
  for (const i of cols.keys()) {
    const col = cols[i], rows = lv[i].rows;
    col.parts.forEach((p, k) => {
      const n = p.down;
      if (n === R.top || n === R.bot || yNode.has(n)) return;
      const a = rows[k], b = rows[k + 1];
      if (b && a.top && !b.top) yNode.set(n, midY);
      // the last node of a column (a tail): at the level of the pin, sources joined by one line (Razavi)
      else if (!b && isTr(p.c)) yNode.set(n, pinP(p.c.ref, 'bot').y);
      else yNode.set(n, rowY(a) + DEV_H + 30);
    });
  }
  for (const i of cols.keys()) {
    const n = cols[i].top;
    if (n !== R.top && n !== R.bot && !yNode.has(n)) yNode.set(n, rowY(lv[i].rows[0]) - 30);
  }
  // per net: points on its spine (x -> point), and drops already drawn
  const spine = new Map();   // net -> Map(x -> true)
  const addSpine = (n, x) => { if (!spine.has(n)) spine.set(n, new Set()); spine.get(n).add(Math.round(x * 10) / 10); };
  for (const i of cols.keys()) {
    const col = cols[i], x = xs[i];
    col.parts.forEach((p, k) => {
      const c = p.c;
      // top terminal
      const up = p.up;
      const pt = term(up, c.ref, 'top');
      if (k === 0) {
        if (up === R.top) S.path(up, pt, { x, y: yR });
        else if (up === R.bot) S.path(up, pt, { x, y: yG });
        else { S.path(up, pt, { x, y: yNode.get(up) }); addSpine(up, x); }
      }
      const pb = term(p.down, c.ref, 'bot');
      const dn = p.down;
      if (dn === R.bot) S.path(dn, pb, { x, y: yG });
      else if (dn === R.top) S.path(dn, pb, { x, y: yR });
      else {
        const yn = yNode.get(dn);
        S.path(dn, pb, { x, y: yn }); addSpine(dn, x);
        const nx = col.parts[k + 1];
        if (nx) S.path(dn, { x, y: yn }, term(dn, nx.c.ref, 'top'));
      }
    });
  }

  /* 7. gates ---------------------------------------------------------- */
  const satAt = new Map();     // net -> {x, y, dir} gate stub end (satellite networks)
  const labelAt = [];          // {net, p, side}
  const portAt = [];           // {net, p, side, direction}
  const done = new Set();
  for (const i of cols.keys()) {
    for (const p of cols[i].parts) {
      const c = p.c; if (!isTr(c) || done.has(c.ref)) continue;
      const g = gateOf(c), dir = gateDir.get(c.ref), gp = term(g, c.ref, 'gate');
      done.add(c.ref);
      if (sharedBar.has(c.ref)) {
        const o = sharedBar.get(c.ref); done.add(o);
        const op = term(g, o, 'gate');
        const mid = { x: paired ? 0 : (gp.x + op.x) / 2, y: gp.y };
        S.path(g, gp, mid, op);
        if (nodeCols.has(g) && !ctx.labelNets.has(g)) {
          // the diode / driving node: a drop from the bar to its spine, beside the driving column
          const j = [...nodeCols.get(g)][0];
          const xr = paired ? xs[j] + (xs[j] <= 0 ? 90 : -90) : mid.x + Math.sign(xs[j] - mid.x) * 15;
          S.path(g, { x: xr, y: gp.y }, { x: xr, y: yNode.get(g) }); addSpine(g, xr);
        } else if (satelliteNets.has(g)) satAt.set(g, { x: 0, y: gp.y - 0, dir: 0, bar: true });
        else labelAt.push({ net: g, p: { x: 0, y: gp.y - 24 }, side: 1, from: mid });
        continue;
      }
      if (g === R.top || g === R.bot) {
        const e = { x: gp.x + dir * 30, y: gp.y };
        S.path(g, gp, e);
        S.path(g, e, { x: e.x, y: g === R.top ? e.y - 20 : e.y + 20 });
        ctx.localTaps.push({ sheet: S, net: g, p: { x: e.x, y: g === R.top ? e.y - 20 : e.y + 20 } });
        continue;
      }
      if (satelliteNets.has(g)) {
        const e = { x: gp.x + dir * 40, y: gp.y };
        S.path(g, gp, e);
        satAt.set(g, { x: e.x, y: e.y, dir });
        continue;
      }
      if (nodeCols.has(g) && (!ctx.labelNets.has(g) || nodeCols.get(g).has(i))) {
        const j = nodeCols.get(g).has(i) ? i : [...nodeCols.get(g)][0];
        const yn = yNode.get(g);
        let xr;
        if (j === i) xr = gp.x + dir * 20;                       // diode: local loop
        else xr = xs[j] + Math.sign(gp.x - xs[j]) * 110;         // riser beside the driving column, past its labels
        // never behind the gate pin (through the body); off a passive column, right at the gate (its labels stay clear)
        if (j !== i && (Math.sign(xr - gp.x) === -dir || cols[j].parts.every((p) => !isTr(p.c)))) xr = gp.x + dir * 20;
        S.path(g, gp, { x: xr, y: gp.y }, { x: xr, y: yn }); addSpine(g, xr);
        if (j === i) S.mark({ x: xr, y: gp.y });
        continue;
      }
      // a named stub: bias label, or an input / output port
      if (!ctx.labelNets.has(g) && !ctx.ports.has(g)) throw new Error(`manuel: signal gate net ${g} without a wire rule`);
      const e = { x: gp.x + dir * 30, y: gp.y };
      S.path(g, gp, e);
      if (ctx.ports.has(g) && !ctx.labelNets.has(g) && ctx.home.get(g) === F.kind) portAt.push({ net: g, p: e, side: dir, direction: 'input' });
      else labelAt.push({ net: g, p: e, side: dir });
    }
  }

  /* 8. chains: bridges at node level, spurs from a spine, satellites ------ */
  const placedChain = new Set();
  const drawChainH = (ch, fromNet, x0, y, dir) => {    // horizontal from x0 in direction dir; returns the far point
    let seq = ch.a === fromNet ? ch.parts : [...ch.parts].reverse();
    let net = fromNet, x = x0, prev = { x: x0, y };
    for (const c of seq) {
      const nxt = c.nodes[0] === net ? c.nodes[1] : c.nodes[0];
      const L = lenOf(c);
      const xl = dir > 0 ? x + 30 : x - 30 - L;
      const v = placeTwo(S, c, xl, y, dir > 0 ? net : nxt, false);
      V.set(c.ref, v);
      const pin = dir > 0 ? v.first : v.other, pin2 = dir > 0 ? v.other : v.first;
      S.path(net, prev, S.term(net, v, pin));
      prev = S.term(nxt, v, pin2);
      net = nxt; x = prev.x;
    }
    return { net, p: prev };
  };
  const drawChainV = (ch, fromNet, x, y0, dir, lside = 1) => {    // vertical from y0 (dir +1 down / -1 up)
    let seq = ch.a === fromNet ? ch.parts : [...ch.parts].reverse();
    let net = fromNet, y = y0, prev = { x, y: y0 };
    for (const c of seq) {
      const nxt = c.nodes[0] === net ? c.nodes[1] : c.nodes[0];
      const L = lenOf(c);
      const yt = dir > 0 ? y + 30 : y - 30 - L;
      const v = placeTwo(S, c, x, yt, dir > 0 ? net : nxt, true, lside);
      V.set(c.ref, v);
      const pin = dir > 0 ? v.first : v.other, pin2 = dir > 0 ? v.other : v.first;
      S.path(net, prev, S.term(net, v, pin));
      prev = S.term(nxt, v, pin2);
      net = nxt; y = prev.y;
    }
    return { net, p: prev };
  };
  let outDir = 1, upright = false;
  const finishEnd = (net, p, along) => {   // the far end of a chain: rail symbol, port or label
    if (net === R.bot) { const q = { x: p.x, y: p.y + (along === 'up' ? 0 : 20) }; if (along === 'up') { /* drawn upward to ground: unusual */ } S.path(net, p, q); ctx.localTaps.push({ sheet: S, net, p: q }); return; }
    if (net === R.top) { const q = { x: p.x, y: p.y - 20 }; S.path(net, p, q); ctx.localTaps.push({ sheet: S, net, p: q }); return; }
    const sideH = along === 'left' ? -1 : 1;
    if (along === 'up' && net !== R.top && !upright) {
      // the top of a climbing ladder: the name goes outward, never over the band above
      const q = { x: p.x + outDir * 16, y: p.y };
      const q0 = { x: p.x, y: p.y - 12 };
      S.path(net, p, q0, { x: q.x, y: q0.y });
      const qq = { x: q.x, y: q0.y };
      if (ctx.ports.has(net) && !ctx.labelNets.has(net) && ctx.home.get(net) === F.kind) portAt.push({ net, p: qq, side: outDir, direction: 'input' });
      else labelAt.push({ net, p: qq, side: outDir });
      return;
    }
    if (along === 'up' || along === 'down') {
      const q = { x: p.x, y: p.y + (along === 'up' ? -16 : 16) };
      S.path(net, p, q);
      if (ctx.ports.has(net) && !ctx.labelNets.has(net) && ctx.home.get(net) === F.kind) portAt.push({ net, p: q, side: 1, direction: 'input', vertical: along });
      else labelAt.push({ net, p: q, side: 1, vertical: along });
      return;
    }
    const q = { x: p.x + sideH * 16, y: p.y };
    S.path(net, p, q);
    if (ctx.ports.has(net) && !ctx.labelNets.has(net) && ctx.home.get(net) === F.kind) portAt.push({ net, p: q, side: sideH, direction: 'input' });
    else labelAt.push({ net, p: q, side: sideH });
  };
  // bridges: both ends are column nodes at the same height
  const bridgeEnd = new Set();      // net@x where a bridge leaves a spine: no name written over it
  for (const ch of F.chains) {
    const sa = spine.get(ch.a), sb = spine.get(ch.b);
    if (!sa || !sb || yNode.get(ch.a) !== yNode.get(ch.b)) continue;
    const xa = [...sa], xb = [...sb];
    // the nearest facing points of the two spines
    let best = null;
    for (const p of xa) for (const q of xb) if (!best || Math.abs(p - q) < Math.abs(best[0] - best[1])) best = [p, q];
    const [pa, pb] = best, y = yNode.get(ch.a);
    const L = chainLen(ch), dir = pb > pa ? 1 : -1;
    const start = (pa + pb) / 2 - dir * (L - 30) / 2;
    const r = drawChainH(ch, ch.a, start, y, dir);
    // the chain's first pin joins spine a, its last pin spine b
    addSpine(ch.a, start); addSpine(ch.b, r.p.x);
    bridgeEnd.add(`${ch.a}@${start}`); bridgeEnd.add(`${ch.b}@${r.p.x}`);
    placedChain.add(ch);
  }
  // satellites: ladders off a gate stub
  for (const [g, at] of satAt) {
    const mine0 = F.chains.filter((ch) => !placedChain.has(ch) && (ch.a === g || ch.b === g));
    const far = (ch) => (ch.a === g ? ch.b : ch.a);
    // parallel parts (an R || C sensing branch): one rung, the partner drawn beside it
    const twin = new Map();
    const mine = [];
    for (const ch of mine0) {
      const mate = ch.parts.length === 1 && mine.find((m) => m.parts.length === 1 && !twin.has(m) && far(m) === far(ch));
      if (mate) twin.set(mate, ch); else mine.push(ch);
    }
    mine.sort((a, b) => (far(a) === R.bot ? -1 : 0) - (far(b) === R.bot ? -1 : 0));
    const slots = ['down', 'up', 'out'];
    if (mine.length > 3) throw new Error(`manuel: gate network on ${g} too large`);
    const dir = at.dir || -1;
    if (at.bar) {
      // a satellite under a shared bar: one ladder below the bar centre
      if (mine.length > 1) throw new Error(`manuel: shared gate network on ${g}`);
    }
    const used = { down: false, up: false, out: false };
    const pick = (ch) => {
      const f = far(ch);
      const pref = f === R.bot ? ['down', 'out', 'up'] : f === R.top ? ['up', 'out', 'down'] : ['up', 'out', 'down'];
      return pref.find((s) => !used[s] && (!at.bar || s === 'down') && !(s === 'out' && twin.has(ch)));
    };
    for (const ch of mine) {
      const s = pick(ch);
      if (!s) throw new Error(`manuel: no slot on ${g}`);
      used[s] = true;
      let r;
      const mate = twin.get(ch);
      if (mate && s === 'out') throw new Error(`manuel: parallel rung on ${g} sideways`);
      let main = ch, side = mate;
      if (mate && lenOf(mate.parts[0]) > lenOf(ch.parts[0])) [main, side] = [mate, ch];
      if (s === 'down') r = drawChainV(main, g, at.x, at.y, 1, dir);
      else if (s === 'up') r = drawChainV(main, g, at.x, at.y, -1, dir);
      else r = drawChainH(main, g, at.x, at.y, dir);
      placedChain.add(ch);
      if (mate) {
        // the partner, one step outward, joined to the rung's two ends
        const x2 = at.x + dir * 120, sd = s === 'down' ? 1 : -1;   // past the rung's labels
        const q = drawChainV(side, g, x2, at.y + sd * (Math.abs(r.p.y - at.y) - lenOf(side.parts[0]) - 30) / 2, sd, dir);
        S.path(g, { x: at.x, y: at.y }, { x: x2, y: at.y }, { x: x2, y: at.y + sd * (Math.abs(r.p.y - at.y) - lenOf(side.parts[0]) - 30) / 2 });
        S.path(q.net, q.p, { x: x2, y: r.p.y }, r.p);
        placedChain.add(mate);
      }
      outDir = dir;
      // the top name straight on along the rung (no avoidable bend), for an R || C twin rung or a label end;
      // a port there may sit over another part's pin (casc_amp, analoggenie/230: review of #67)
      upright = !!mate || !(ctx.ports.has(r.net) && !ctx.labelNets.has(r.net) && ctx.home.get(r.net) === F.kind);
      finishEnd(r.net, r.p, s === 'out' ? (dir < 0 ? 'left' : 'right') : s);
      upright = false;
    }
    void slots;
  }
  // spurs: a chain from a spine outward (end on a label, port or rail)
  for (const ch of F.chains) {
    if (placedChain.has(ch)) continue;
    const from = spine.has(ch.a) ? ch.a : spine.has(ch.b) ? ch.b : null;
    if (from == null) continue;
    const pts = [...spine.get(from)];
    const cx = [...(nodeCols.get(from) || [])].map((j) => xs[j]);
    const s = paired ? (Math.sign(cx[0] || 1)) : 1;
    const xe = s > 0 ? Math.max(...pts) : Math.min(...pts);
    const r = drawChainH(ch, from, xe, yNode.get(from), s);
    addSpine(from, xe);
    placedChain.add(ch);
    finishEnd(r.net, r.p, s < 0 ? 'left' : 'right');
  }
  // loose chains (no end on a spine or a gate stub): a row below the frame
  let looseX = Math.min(0, ...xs) - 40;
  for (const ch of F.chains) {
    if (placedChain.has(ch)) continue;
    const y = yG + 70;
    const p0 = { x: looseX, y };
    const startNet = ch.a;
    finishEnd(startNet, p0, 'left');
    const r = drawChainH(ch, startNet, looseX, y, 1);
    finishEnd(r.net, r.p, 'right');
    looseX = r.p.x + 120;
    placedChain.add(ch);
  }

  /* 9. spines, their names, and the rails ------------------------------ */
  for (const [n, set] of spine) {
    const y = yNode.get(n), pts = [...set].sort((a, b) => a - b);
    for (let k = 1; k < pts.length; k++) S.path(n, { x: pts[k - 1], y }, { x: pts[k], y });
    const isPort = ctx.ports.has(n) && ctx.home.get(n) === F.kind;   // the I/O arrow in its home frame
    const isLab = !isPort && (ctx.labelNets.has(n) || ctx.ports.has(n));
    if (!isLab && !isPort) continue;
    // the name at the outer end of the spine (toward the frame's edge)
    const cx = [...(nodeCols.get(n) || [])].map((j) => xs[j]);
    let s = paired ? Math.sign(cx.reduce((a, b) => a + b, 0)) || 1 : 1;
    if (pts.length > 1 && !paired) s = pts[0] < cx[0] ? -1 : 1;
    let xe = s > 0 ? pts[pts.length - 1] : pts[0];
    // the outer end carries a bridge (a Miller R-C): the name goes on the inner end
    if (pts.length > 1 && bridgeEnd.has(`${n}@${xe}`)) { s = -s; xe = s > 0 ? pts[pts.length - 1] : pts[0]; }
    const q = { x: xe + s * 40, y };
    S.path(n, { x: xe, y }, q);
    if (isPort) portAt.push({ net: n, p: q, side: s, direction: OUTISH.test(n) ? 'output' : 'input' });
    else labelAt.push({ net: n, p: q, side: s });
  }
  for (const L of labelAt) {
    if (L.from) S.path(L.net, L.from, L.p);
    const v = L.vertical ? portVert(S, L.net, { x: L.p.x, y: L.p.y + (L.vertical === 'up' ? -9 : 9) }, 1, false) : portVert(S, L.net, L.p, L.side, false);
    if (L.vertical) { S.path(L.net, L.p, v.pinAbs[v.portPin]); }
    S.term(L.net, v, v.portPin);
  }
  for (const P of portAt) {
    const v = P.vertical ? portVert(S, P.net, { x: P.p.x, y: P.p.y + (P.vertical === 'up' ? -12 : 12) }, 1, true, P.direction) : portVert(S, P.net, P.p, P.side, true, P.direction);
    if (P.vertical) S.path(P.net, P.p, v.pinAbs[v.portPin]);
    S.term(P.net, v, v.portPin);
  }
  // rails: the column ends already reach y = yR / yG; one line, one symbol
  for (const [rail, y] of [[R.top, yR], [R.bot, yG]]) {
    if (!rail) continue;
    const N = S.nets.get(rail);
    if (!N) continue;
    const xsOn = [...new Set(N.segs.flatMap((s) => s).filter((p) => Math.abs(p.y - y) < 0.01).map((p) => Math.round(p.x * 10) / 10))].sort((a, b) => a - b);
    if (!xsOn.length) continue;
    for (let k = 1; k < xsOn.length; k++) S.path(rail, { x: xsOn[k - 1], y }, { x: xsOn[k], y });
    // the symbol between two points (never a 4-way junction), else above / below the only one
    let xt = xsOn[0];
    if (xsOn.length > 1) {
      const mid = (xsOn[0] + xsOn[xsOn.length - 1]) / 2;
      let bestGap = null;
      for (let k = 1; k < xsOn.length; k++) { const c = (xsOn[k - 1] + xsOn[k]) / 2; if (bestGap == null || Math.abs(c - mid) < Math.abs(bestGap - mid)) bestGap = c; }
      xt = bestGap;
    }
    const q = { x: xt, y: rail === R.top ? y - 24 : y + 20 };
    S.path(rail, { x: xt, y }, q);
    ctx.localTaps.push({ sheet: S, net: rail, p: q });
  }
  for (const t of ctx.localTaps.filter((t) => t.sheet === S)) {
    const v = t.net === R.bot ? tapGnd(S, t.p) : tapVdd(S, t.net, t.p);
    S.term(t.net, v, t.net === R.bot ? 'N' : 'S');
  }
  ctx.localTaps = ctx.localTaps.filter((t) => t.sheet !== S);
  S.kind = F.kind;
  return S;
}
const OUTISH = /^(v?out\w*|o(ut)?[pn]?)$/i;
const lenOf = (c) => {
  const s = getShape(shapeOf(c)), pins = relPins(shapeOf(c)), n = pinNames(c);
  const a = pins[n[0]], b = pins[n[1]];
  return Math.abs(a.y - b.y) < 1e-6 ? Math.abs(a.x - b.x) * s.w : Math.abs(a.y - b.y) * s.h;
};
const chainLen = (ch) => ch.parts.reduce((s, c) => s + lenOf(c) + 30, 30);

/* ------------------------------------------------------------- emission */
/** turn each net's segments into wires between terminals and junction dots */
function emit(model, sheets, parsed, rails = new Set()) {
  const ids = new Map();       // vertex object -> cell id
  let k = 0;
  for (const S of sheets) {
    for (const v of S.verts) {
      const id = v.id || `MN_${v.kind || 'v'}_${++k}`;
      addVertex(model, { id, style: v.style, x: v.x, y: v.y, w: v.w, h: v.h, value: v.value || '', ...(v.refdes ? { refdes: v.refdes } : {}) });
      ids.set(v, id);
    }
    for (const t of S.texts) addVertex(model, { style: `text;html=1;align=${t.align};verticalAlign=middle;fontSize=${t.size};fontFamily=Helvetica;whiteSpace=wrap;apiAnnotation=1;`, x: t.x, y: t.y, w: t.w, h: t.h, value: t.html });
    for (const b of S.boxes) {
      addVertex(model, { style: 'rounded=0;fillColor=none;dashed=1;strokeColor=#888888;apiAnnotation=1;', x: b.x, y: b.y, w: b.w, h: b.h, value: '' });
      addVertex(model, { style: 'text;html=1;align=left;verticalAlign=middle;fontSize=12;fontStyle=1;apiAnnotation=1;', x: b.x + 8, y: b.y + 4, w: 200, h: 20, value: b.title });
    }
  }
  const wires = [];
  for (const S of sheets) {
    for (const [net, N] of S.nets) {
      // split segments at every point lying on another segment (T joins)
      const pts = new Map();
      const P = (p) => { const kk = key(p); if (!pts.has(kk)) pts.set(kk, { x: p.x, y: p.y, adj: new Set() }); return kk; };
      let segs = N.segs.map(([a, b]) => [a, b]);
      const allPts = [...new Set(segs.flat().map(key))].map((kk) => { const [x, y] = kk.split(',').map(Number); return { x, y }; });
      const split = [];
      for (const [a, b] of segs) {
        const inner = allPts.filter((p) => onSeg(p, a, b) && key(p) !== key(a) && key(p) !== key(b));
        const chain = [a, ...inner.sort((p, q) => dist(a, p) - dist(a, q)), b];
        for (let i = 1; i < chain.length; i++) split.push([chain[i - 1], chain[i]]);
      }
      for (const [a, b] of split) { const ka = P(a), kb = P(b); if (ka !== kb) { pts.get(ka).adj.add(kb); pts.get(kb).adj.add(ka); } }
      // stops: terminals, and points of degree != 2 (junction dots for >= 3)
      const stop = new Map();
      for (const [kk, p] of pts) {
        const t = N.terms.get(kk);
        if (t) stop.set(kk, { id: ids.get(t.v), pin: t.pin, v: t.v });
        else if (p.adj.size >= 3) {
          const id = `MN_j_${++k}`;
          addVertex(model, { id, style: JUNCTION, x: p.x - 3, y: p.y - 3, w: 6, h: 6 });
          stop.set(kk, { id, pin: null });
        } else if (p.adj.size === 1) throw new Error(`manuel: dangling end on ${net} at ${kk}`);
      }
      const used = new Set();
      const ekey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
      for (const [ks] of stop) {
        for (const nb of pts.get(ks).adj) {
          if (used.has(ekey(ks, nb))) continue;
          const way = [];
          let prev = ks, cur = nb;
          used.add(ekey(prev, cur));
          while (!stop.has(cur)) {
            const nx = [...pts.get(cur).adj].find((q) => q !== prev);
            way.push(pts.get(cur));
            used.add(ekey(cur, nx)); prev = cur; cur = nx;
          }
          const A = stop.get(ks), Bt = stop.get(cur);
          // waypoints: corners only
          const full = [pts.get(ks), ...way, pts.get(cur)];
          const corners = [];
          for (let i = 1; i < full.length - 1; i++) {
            const a = full[i - 1], b = full[i], c = full[i + 1];
            if (!((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01))) corners.push({ x: b.x, y: b.y });
          }
          const sp = A.pin ? anchorOf(A.v, A.pin) : null, tp = Bt.pin ? anchorOf(Bt.v, Bt.pin) : null;
          // rail lines are drawn on purpose, like lib/rails.js's (exempt from the avoidable-bend check)
          const w = addWire(model, { source: A.id, target: Bt.id, sourcePin: sp, targetPin: tp, style: WIRE + (rails.has(net) || corners.some((c) => S.marks.some((m) => key(m) === key(c))) ? 'drawioApiTemplate=1;' : ''), points: corners });
          wires.push(w.getAttribute('id'));
        }
      }
      // a closed loop of non-stops (cannot happen with terminals) is ignored
    }
  }
  preserveElectricalData(model, parsed);
  return wires;
}
const onSeg = (p, a, b) => (Math.abs(a.x - b.x) < 0.01 && Math.abs(p.x - a.x) < 0.01 && p.y > Math.min(a.y, b.y) - 0.01 && p.y < Math.max(a.y, b.y) + 0.01)
  || (Math.abs(a.y - b.y) < 0.01 && Math.abs(p.y - a.y) < 0.01 && p.x > Math.min(a.x, b.x) - 0.01 && p.x < Math.max(a.x, b.x) + 0.01);
const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
function anchorOf(v, pin) {
  const rel = v.pins[pin];
  return { x: rel.x, y: rel.y, name: pin };
}

/* ------------------------------------------------------------ ladders */
/** LADDER BETWEEN TWO BUSES (a switched capacitor / resistor bank): every part
 *  lies on one SLICE, a series path from bus A to bus B, or on a SPUR from a
 *  slice node to a net shared by the spurs (a bias net, drawn as a label) or a
 *  one-terminal net; transistor gates are one-terminal nets (control ports).
 *  Returns {A, B, slices: [{parts, nets}], spurs: Map(net -> parts)} or null. */
export function ladderReading(parsed) {
  const comps = parsed.components;
  if (comps.length < 6 || comps.length > 60) return null;
  if (comps.some((c) => !(c.prefix === 'M' || c.prefix === 'R' || c.prefix === 'C' || c.prefix === 'L' || c.prefix === 'V' || c.prefix === 'I'))) return null;
  if (comps.some((c) => c.prefix === 'M' && c.nodes.length < 3)) return null;
  // GATE SOURCES (hierarchical banks, 2026-10-25): a V/I source from the gate
  // of ONE switch to a rail or a common net, drawn hanging from that gate
  const gateUse = new Map();
  for (const c of comps) if (c.prefix === 'M') gateUse.set(gateOf(c), (gateUse.get(gateOf(c)) || 0) + 1);
  const gsrc = new Map();
  for (const c of comps.filter((c) => c.prefix === 'V' || c.prefix === 'I')) {
    const [a, b] = c.nodes, g = gateUse.get(a) === 1 ? a : gateUse.get(b) === 1 ? b : null;
    if (g == null || gsrc.has(g) || c.nodes.length !== 2 || a === b) return null;
    gsrc.set(g, { c, far: g === a ? b : a });
  }
  const srcRefs = new Set([...gsrc.values()].map((s) => s.c.ref));
  const links = (c) => chan(c);
  const use = new Map();
  for (const c of comps) for (const n of links(c)) { if (!use.has(n)) use.set(n, []); use.get(n).push(c); }
  const gates = new Map();
  for (const c of comps) { const g = gateOf(c); if (g) gates.set(g, (gates.get(g) || 0) + 1); }
  const big = [...use.keys()].filter((n) => use.get(n).length >= 3).sort((a, b) => use.get(b).length - use.get(a).length);
  for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++) {
    const r = tryBuses(big[i], big[j]) || tryBuses(big[j], big[i]);
    if (r) return r;
  }
  return null;
  function tryBuses(A, B) {
    const used = new Set(), slices = [];
    // shortest series path from A to B through each part on A (BFS on nets)
    for (const p of use.get(A)) {
      if (used.has(p.ref)) continue;
      const start = links(p).find((n) => n !== A);
      if (start == null) continue;
      if (start === B) { slices.push({ parts: [p], nets: [A, B] }); used.add(p.ref); continue; }
      const prev = new Map([[start, null]]), q = [start];
      while (q.length && !prev.has(B)) {
        const n = q.shift();
        for (const c of use.get(n) || []) {
          if (c === p || used.has(c.ref)) continue;
          const o = links(c).find((m) => m !== n);
          if (o == null || o === A || prev.has(o)) continue;
          prev.set(o, { n, c }); q.push(o);
        }
      }
      if (!prev.has(B)) return null;
      const parts = [], nets = [B];
      for (let n = B; prev.get(n); n = prev.get(n).n) { parts.unshift(prev.get(n).c); nets.unshift(prev.get(n).n); }
      parts.unshift(p); nets.unshift(A);
      for (const c of parts) used.add(c.ref);
      slices.push({ parts, nets });
    }
    if (slices.length < 3) return null;
    const inner = new Set(slices.flatMap((s) => s.nets.slice(1, -1)));
    if (inner.size !== slices.reduce((k, s) => k + s.nets.length - 2, 0)) return null;     // slices share a node
    // spurs: the rest, each from an inner node to a net outside every slice
    const spurs = new Map();
    for (const c of comps) {
      if (used.has(c.ref) || srcRefs.has(c.ref)) continue;
      if (c.prefix === 'M') return null;
      const [a, b] = links(c), from = inner.has(a) ? a : inner.has(b) ? b : null, far = from === a ? b : a;
      if (from == null || inner.has(far) || far === A || far === B) return null;
      if (!spurs.has(from)) spurs.set(from, []);
      spurs.get(from).push({ c, far });
    }
    // a transistor on a slice: entered by its top terminal, gate on a control net
    for (const s of slices) s.parts.forEach((c, k) => {
      if (c.prefix !== 'M') return;
      if (chan(c)[0] !== s.nets[k]) s.bad = true;
      const g = gateOf(c);
      if (inner.has(g) || g === A || g === B || (gates.get(g) || 0) > 1 && !BIASNAME.test(g)) s.bad = true;
    });
    if (slices.some((s) => s.bad)) return null;
    // every gate source hangs from a slice switch (not from a bus or a slice node)
    const sliceGates = new Set(slices.flatMap((s) => s.parts.filter((c) => c.prefix === 'M').map(gateOf)));
    for (const [g, s] of gsrc) if (!sliceGates.has(g) || inner.has(s.far) || s.far === A || s.far === B) return null;
    return { A, B, slices, spurs, gsrc };
  }
}

const RAIL0 = /^(0|gnd|vss|ground(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?)$/i;
function importLadder(model, parsed, L) {
  const S = new Sheet();
  const PITCH = L.gsrc && L.gsrc.size ? 400 : 320, yA = 60, GAP = 50;
  const count = new Map();
  for (const c of parsed.components) for (const n of c.nodes) count.set(n, (count.get(n) || 0) + 1);
  // the direct slice (a part straight from A to B) first, then the slices as read
  const slices = [...L.slices].sort((a, b) => a.parts.length - b.parts.length);
  const ends = [];
  let low = -Infinity;            // the lowest gate-source glyph: bus B stays below it
  slices.forEach((sl, k) => {
    const x = 160 + k * PITCH;
    let prev = { x, y: yA };
    sl.parts.forEach((c, i) => {
      const nin = sl.nets[i], nout = sl.nets[i + 1];
      const spurs = L.spurs.get(nin) || [];
      const y0 = prev.y + GAP + (spurs.length ? GAP : 0);
      let v;
      if (c.prefix === 'M') {
        v = placeTr(S, c, x, y0, -1);
        const gp = S.term(gateOf(c), v, v.pinOf.gate), e = { x: gp.x - 30, y: gp.y };
        const gs = L.gsrc && L.gsrc.get(gateOf(c));
        if (gs) {
          // the gate source hangs from the gate, its far end on ground or a label
          const g = gateOf(c), q = { x: gp.x - 50, y: gp.y };
          S.path(g, gp, q);
          const sv = placeTwo(S, gs.c, q.x, q.y + 20, g, true, -1);
          S.path(g, q, S.term(g, sv, sv.first));
          const f = S.term(gs.far, sv, sv.other), r = { x: f.x, y: f.y + 16 };
          low = Math.max(low, r.y + 20);
          S.path(gs.far, f, r);
          if (RAIL0.test(gs.far)) S.term(gs.far, tapGnd(S, r), 'N');
          else { const pv = portVert(S, gs.far, { x: r.x, y: r.y }, -1, false); S.term(gs.far, pv, pv.portPin); }
        } else {
          S.path(gateOf(c), gp, e);
          const pv = portVert(S, gateOf(c), e, -1, (count.get(gateOf(c)) || 0) <= 1);
          S.term(gateOf(c), pv, pv.portPin);
        }
      } else {
        v = placeTwo(S, c, x, y0, nin, true, 1);
        v.pinOf = { top: v.first, bot: v.other };
      }
      const top = S.term(nin, v, v.pinOf.top);
      S.path(nin, prev, top);
      // spurs from the node between the previous part and this one, to the right
      spurs.forEach((sp, j) => {
        const yn = (prev.y + top.y) / 2 + j * 0;           // one spur per node in practice
        const h = placeTwo(S, sp.c, x + 30, yn, nin, false);
        S.path(nin, { x, y: yn }, S.term(nin, h, h.first));
        const far = S.term(sp.far, h, h.other), q = { x: far.x + 16, y: yn };
        S.path(sp.far, far, q);
        const pv = portVert(S, sp.far, q, 1, (count.get(sp.far) || 0) <= 1);
        S.term(sp.far, pv, pv.portPin);
      });
      if (spurs.length > 1) throw new Error('manuel: two spurs on one ladder node');
      prev = S.term(nout, v, v.pinOf.bot);
    });
    ends.push(prev);
  });
  const yB = Math.max(...ends.map((p) => p.y) , low) + 40;
  for (const p of ends) S.path(L.B, p, { x: p.x, y: yB });
  // the buses: one line each, an I/O arrow at the left end
  const x0 = 160 - 90, x1 = 160 + (slices.length - 1) * PITCH;
  for (const [n, y] of [[L.A, yA], [L.B, yB]]) {
    S.path(n, { x: x0, y }, { x: x1, y });
    const pv = portVert(S, n, { x: x0, y }, -1, true, 'inout');
    S.term(n, pv, pv.portPin);
  }
  const wires = emit(model, [S], parsed);
  const geo = geoLvs(model);
  return { geo, wires };
}

/* ------------------------------------------------------------ entry point */
const TITLES = { bias: 'Polarisation', cmfb: 'CMFB', startup: 'Démarrage' };
export function importNetlistManuel(model, parsed, opts = {}) {
  const r = opts.reading || manuelReading(parsed);
  if (!r) {
    // a Brokaw bandgap (lib/place-brokaw.js), else a ladder between two buses
    const Bk = brokawReading(parsed);
    if (Bk) {
      const { geo, wires } = importBrokaw(model, parsed, Bk);
      if (!geo.ok && !opts.noGeo) { const e = new Error('manuel: geometric LVS failed: ' + geo.errors.slice(0, 3).map((x) => x.msg).join('; ')); e.geo = geo; throw e; }
      return { geo, engine: 'manuel', components: parsed.components.map((c) => c.ref), wires, frames: ['startup', 'core', 'amplifier', 'output'] };
    }
    const L = ladderReading(parsed);
    if (!L) { const e = new Error('manuel: reading not sure'); e.status = 422; throw e; }
    const { geo, wires } = importLadder(model, parsed, L);
    if (!geo.ok && !opts.noGeo) { const e = new Error('manuel: geometric LVS failed: ' + geo.errors.slice(0, 3).map((x) => x.msg).join('; ')); e.geo = geo; throw e; }
    return { geo, engine: 'manuel', components: parsed.components.map((c) => c.ref), wires, frames: ['ladder'] };
  }
  // the home frame of each port net: where it has channel terminals
  const home = new Map();
  for (const f of r.frames) for (const c of f.parts) for (const n of chan(c)) if (!home.has(n)) home.set(n, f.kind);
  for (const f of r.frames) for (const c of f.parts) { const g = gateOf(c); if (g && !home.has(g)) home.set(g, f.kind); }
  const ctx = { ports: r.ports, labelNets: r.labelNets, home, localTaps: [] };
  const sheets = r.frames.map((f) => layoutFrame(f, r.rails, ctx));
  // core on top, auxiliary frames side by side below it, in dashed boxes
  const core = sheets.find((s) => s.kind === 'core') || sheets[0];
  let bb = core.bbox();
  core.shift(60 - bb.x0, 60 - bb.y0);
  bb = core.bbox();
  let x = bb.x0, y = bb.y1 + 90;
  for (const S of sheets) {
    if (S === core) continue;
    const b = S.bbox();
    S.shift(x + 30 - b.x0, y + 40 - b.y0);
    const b2 = S.bbox();
    S.boxes.push({ x: b2.x0 - 30, y: b2.y0 - 40, w: b2.x1 - b2.x0 + 60, h: b2.y1 - b2.y0 + 70, title: TITLES[S.kind] || S.kind });
    x = b2.x1 + 90;
  }
  const wires = emit(model, sheets, parsed, new Set([r.rails.top, r.rails.bot].filter(Boolean)));
  // the geometric LVS is part of the engine: a drawing with a wire in the void is never returned
  const geo = geoLvs(model);
  if (!geo.ok && !opts.noGeo) { const e = new Error('manuel: geometric LVS failed: ' + geo.errors.slice(0, 3).map((x) => x.msg).join('; ')); e.geo = geo; throw e; }
  return { geo, engine: 'manuel', components: parsed.components.map((c) => c.ref), wires, frames: r.frames.map((f) => f.kind) };
}

// drawing kit shared with lib/hier.js (top page of a hierarchical netlist)
export { Sheet, emit, placeTwo, placeTr, portVert, tapGnd, tapVdd };
