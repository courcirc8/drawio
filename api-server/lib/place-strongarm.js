/**
 * place-strongarm.js — engine "strongarm": the StrongARM latch comparator
 * drawn as textbooks draw it (Eric's list, 2026-10-10; 60 circuits of the
 * bank ≤ 25 parts hold two cross-coupled pairs of opposite polarity):
 *
 *   clk ┤P7   P5 ╳ P6   P8├ clk        precharge | cross-coupled PMOS | precharge
 *              │      │                outputs = the two columns
 *   clk ┤P9   N3 ╳ N4  P10├ clk        precharge of the inner nodes | cross-coupled NMOS
 *              │      │
 *        INP ┤ N1    N2 ├ INN          input pair, drains on the NMOS pair's sources
 *                 N11 ┤ clk            clocked tail, centred
 *
 * Recognised: a cross-coupled NMOS pair and a cross-coupled PMOS pair on the
 * same two nets (lib/patterns.js), an input pair whose drains are the NMOS
 * pair's sources, a tail on the input pair's source, and precharge devices
 * (drain on an output or inner node, source on a rail). Missing precharge
 * devices are allowed. Positions imposed exactly in pixels (as lib/place-ota.js);
 * the two X are drawn by lib/crossx.js (in the trial and in auto's polish).
 */
import { detectStructures, isPmosLike } from './patterns.js';
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell, addVertex, addWire, deleteCell, freshId } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';
import { alignPorts } from './align-ports.js';
import { attachPassives } from './template-attach.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
const isAct = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';
const byRef = (parsed, r) => parsed.components.find((c) => c.ref === r);
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];

export function strongarmReading(parsed) {
  let st; try { st = detectStructures(parsed); } catch { return null; }
  const comps = parsed.components, byRef = new Map(comps.map((c) => [c.ref, c]));
  for (const ccN of st.crossCoupled) {
    const [n3, n4] = ccN.refs.map((r) => byRef.get(r));
    if (isPmosLike(n3)) continue;
    const ccP = st.crossCoupled.find((cc) => cc !== ccN && isPmosLike(byRef.get(cc.refs[0])) && new Set([...cc.nets, ...ccN.nets]).size === 2);
    if (!ccP) continue;
    // left = the device on output A (n3's drain)
    const A = D(n3), B = D(n4);
    const [p5, p6] = ccP.refs.map((r) => byRef.get(r)).sort((u) => (D(u) === A ? -1 : 1));
    // input pair: drains on n3 / n4 sources
    const inp = st.diffPairs.map((dp) => dp.refs.map((r) => byRef.get(r))).find(([u, v]) => !isPmosLike(u) && ((D(u) === S(n3) && D(v) === S(n4)) || (D(v) === S(n3) && D(u) === S(n4))));
    if (!inp) continue;
    const n1 = D(inp[0]) === S(n3) ? inp[0] : inp[1], n2 = n1 === inp[0] ? inp[1] : inp[0];
    const used = new Set([n1, n2, n3, n4, p5, p6].map((c) => c.ref));
    const tail = comps.find((c) => !used.has(c.ref) && isAct(c) && D(c) === S(n1));
    if (tail) used.add(tail.ref);
    const pre = (net) => { const c = comps.find((x) => !used.has(x.ref) && isAct(x) && isPmosLike(x) && D(x) === net && RAIL.test(S(x))); if (c) used.add(c.ref); return c?.ref; };
    // an output inverter on each output (the usual buffer before the SR latch)
    const inv = (net) => {
      const p = comps.find((x) => !used.has(x.ref) && x.prefix === 'M' && isPmosLike(x) && G(x) === net && RAIL.test(S(x)));
      const n = p && comps.find((x) => !used.has(x.ref) && x.prefix === 'M' && !isPmosLike(x) && G(x) === net && D(x) === D(p) && RAIL.test(S(x)));
      return n ? { p: p.ref, n: n.ref, out: D(p) } : null;
    };
    const r = { n1: n1.ref, n2: n2.ref, n3: n3.ref, n4: n4.ref, p5: p5.ref, p6: p6.ref, tail: tail?.ref,
      p7: pre(A), p8: pre(B), p9: pre(S(n3)), p10: pre(S(n4)), nodes: { A, B, X: S(n3), Y: S(n4), T: S(n1) }, used };
    const iA = inv(A), iB = iA && inv(B);
    if (iA && iB) { r.invA = iA; r.invB = iB; for (const i of [iA, iB]) { used.add(i.p); used.add(i.n); } }
    return r;
  }
  return null;
}

export function strongarmLayout(parsed, R) {
  const pos = new Map(), put = (r, x, y) => { if (r) pos.set(r, { x, y }); };
  put(R.p7, -1.6, 0); put(R.p5, 0, 0); put(R.p6, 3.2, 0); put(R.p8, 4.8, 0);
  put(R.p9, -1.6, 1.8); put(R.n3, 0, 1.8); put(R.n4, 3.2, 1.8); put(R.p10, 4.8, 1.8);
  put(R.n1, 0.4, 3.6); put(R.n2, 2.8, 3.6); put(R.tail, 1.6, 5.4);
  let k = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: 7 + 1.5 * (k % 3), y: 1.5 * Math.floor(k++ / 3) });
  return pos;
}

export async function importNetlistStrongarm(model, parsed, opts = {}) {
  const R = strongarmReading(parsed);
  if (!R) throw new Error('strongarm: no StrongARM core');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: strongarmLayout(parsed, R), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await impose(model, parsed, R);
  return placed;
}

async function impose(model, parsed, R) {
  const cells = () => allCells(model).map(cellInfo);
  const find = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const pins = (r) => { const c = find(r); return activePins(classify(c)).map((p) => pinAbs(c, p)); };
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
    const c = find(ref), g = pins(ref)[1], mid = c.x + c.w / 2;
    if ((side === 'left') !== (g.x < mid)) updateCell(model, c.id, { style: { flipH: String(c.style.map.get('flipH') || '0') === '1' ? null : 1 } });
  };
  // gates: cross-coupled pairs facing (the X), input pair and clocked devices outward
  face(R.p5, 'right'); face(R.p6, 'left'); face(R.n3, 'right'); face(R.n4, 'left');
  face(R.n1, 'left'); face(R.n2, 'right'); face(R.p7, 'left'); face(R.p9, 'left'); face(R.p8, 'right'); face(R.p10, 'right'); face(R.tail, 'left');
  const W = Math.max(...[R.n3, R.n4, R.p5, R.p6].map((r) => find(r).w)), H = Math.max(...[R.n3, R.n4, R.p5, R.p6].map((r) => find(r).h));
  const GAP = Math.max(3.4 * W, 280), A = 12;   // the output line = the PMOS X's drain line (lib/crossx.js)
  // the two output columns: the leads of P5 / N3 (left) and P6 / N4 (right);
  // between the drains three lines: the PMOS X, the output ports, the NMOS X
  const x0 = pins(R.p5)[0].x, yP = pins(R.p5)[0].y, x1 = x0 + GAP, yO = yP + A;
  const lead = (ref, k, x, y) => { if (!ref) return; const p = pins(ref)[k]; move(ref, x - p.x, y - p.y); };
  lead(R.p6, 0, x1, yP);
  lead(R.n3, 0, x0, yP + 76); lead(R.n4, 0, x1, yP + 76);   // room for the two X lines
  // input pair: drains under the NMOS pair's sources (inner nodes X / Y)
  const sX = pins(R.n3)[2], sY = pins(R.n4)[2], XY = 64;
  lead(R.n1, 0, sX.x, sX.y + XY); lead(R.n2, 0, sY.x, sY.y + XY);
  if (R.tail) { const a = pins(R.n1)[2], b = pins(R.n2)[2]; lead(R.tail, 0, (a.x + b.x) / 2, a.y + Math.max(H, 90)); }
  // precharge devices outside the columns: on the outputs (drain a little above
  // the output line, which passes under them) and on the inner nodes
  const Wp = Math.max(1.2 * W, 100);
  lead(R.p7, 0, x0 - Wp, yO - 24); lead(R.p8, 0, x1 + Wp, yO - 24);
  // the inner nodes' ones nearer the columns: their sources rise straight to the rail
  const Wi = Math.max(0.6 * W, 50);
  lead(R.p9, 0, x0 - Wi, sX.y + XY); lead(R.p10, 0, x1 + Wi, sY.y + XY);   // drains level with the input pair's: straight wires
  // output inverters outside the clock buses, gates facing in, centred on the output line
  if (R.invA) {
    const gx = (r) => pins(r)[1].x;
    const lg = [R.p7, R.p9, R.tail].filter(Boolean), rg = [R.p8, R.p10].filter(Boolean);
    for (const [I, side] of [[R.invA, 'left'], [R.invB, 'right']]) {
      face(I.p, side === 'left' ? 'right' : 'left'); face(I.n, side === 'left' ? 'right' : 'left');
      const edge = side === 'left' ? Math.min(...lg.map(gx)) - 30 - 90 : Math.max(...(rg.length ? rg : [R.p6]).map(gx)) + 30 + 90;
      // gate column at `edge`: the leads beyond it
      const dg = pins(I.p)[0].x - pins(I.p)[1].x;
      lead(I.p, 0, edge + dg, yO - 30); lead(I.n, 0, edge + dg, yO + 30);
    }
  }
  // the clock: a bus outside each column of precharge gates, the two joined
  // under the circuit, one CLK port on the tail's gate line (no connection by
  // name, Eric 2026-10-09); OUT ports on the output lines, outside
  const cs0 = cells(), edges0 = cs0.filter((c) => c.kind === 'edge');
  const gone = new Set(), del = (id) => { if (!gone.has(id)) { gone.add(id); deleteCell(model, id); } };
  const portsOf = (net) => cs0.filter((c) => c.kind === 'vertex' && classify(c).role === 'port' && String(classify(c).net || '').toLowerCase() === String(net).toLowerCase());
  const portStyle = (t) => (t.style.leading ? t.style.leading + ';' : '') + [...t.style.map].filter(([k]) => !['rotation', 'flipH', 'flipV', 'direction', 'verticalLabelPosition', 'verticalAlign', 'labelPosition', 'align', 'horizontal'].includes(k)).map(([k, v]) => k + '=' + v).join(';') + ';';
  const pinRel = (r, k) => activePins(classify(find(r)))[k];
  const FIX = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiTemplate=1;';
  const fixed = [];
  const wire = (a, ka, b, kb, points, style = FIX) => fixed.push(addWire(model, { source: find(a)?.id ?? a, target: find(b)?.id ?? b, sourcePin: typeof ka === 'number' ? pinRel(a, ka) : ka, targetPin: typeof kb === 'number' ? pinRel(b, kb) : kb, style, points }));
  const clkNet = R.tail ? G(byRef(parsed, R.tail)) : null;
  const left = [R.p7, R.p9].filter((r) => r && G(byRef(parsed, r)) === clkNet), right = [R.p8, R.p10].filter((r) => r && G(byRef(parsed, r)) === clkNet);
  const clocked = [...left, ...right, R.tail];
  const clkTerms = parsed.components.flatMap((c) => c.nodes.map((n, k) => ({ c, n, k })).filter((t) => t.n === clkNet));
  const clkPort = clkNet ? portsOf(clkNet) : [];
  if (clkNet && !RAIL.test(clkNet) && clkPort.length <= 1 && clkTerms.every((t) => clocked.includes(t.c.ref) && t.k === 1)) {
    for (const o of clkPort) { for (const e of edges0) if (e.source === o.id || e.target === o.id) del(e.id); }
    for (const r of clocked) {
      const c = find(r), pin = pinRel(r, 1);
      const at = (e, end) => Math.abs(Number(e.style.map.get(end + 'X') ?? -1) - pin.x) < 0.02 && Math.abs(Number(e.style.map.get(end + 'Y') ?? -1) - pin.y) < 0.02;
      for (const e of edges0) if ((e.source === c.id && at(e, 'exit')) || (e.target === c.id && at(e, 'entry'))) del(e.id);
    }
    const g = (r) => pins(r)[1], gT = g(R.tail);
    const xL = Math.min(gT.x, ...left.map((r) => g(r).x)) - 30;
    const all = [...cells()].filter((c) => c.kind === 'vertex' && classify(c).role === 'component');
    const yB = Math.max(...all.map((c) => c.y + c.h)) + 100, xG = gT.x - 20;   // under the tail's ground symbol
    for (let i = 1; i < left.length; i++) wire(left[i - 1], 1, left[i], 1, [{ x: xL, y: g(left[i - 1]).y }, { x: xL, y: g(left[i]).y }]);
    if (left.length) wire(left.at(-1), 1, R.tail, 1, [{ x: xL, y: g(left.at(-1)).y }, { x: xL, y: yB }, { x: xG, y: yB }, { x: xG, y: gT.y }]);
    if (right.length) {
      const xR = Math.max(...right.map((r) => g(r).x)) + 30;
      for (let i = 1; i < right.length; i++) wire(right[i - 1], 1, right[i], 1, [{ x: xR, y: g(right[i - 1]).y }, { x: xR, y: g(right[i]).y }]);
      wire(right.at(-1), 1, R.tail, 1, [{ x: xR, y: g(right.at(-1)).y }, { x: xR, y: yB }, { x: xG, y: yB }, { x: xG, y: gT.y }]);
    }
    const o = clkPort[0];
    if (o) updateCell(model, o.id, { style: { rotation: null, flipH: null, flipV: null, direction: null }, x: gT.x - 40 - 64, y: gT.y - 12, w: 64, h: 24 });
    if (o) wire(o.id, { x: 1, y: 0.5 }, R.tail, 1, []);
  }
  // output ports: on the output line, outside the precharge devices; the
  // links the old port carried are given back to the column's drain
  // each output: the precharge drain joins the column on the output line (the
  // wires its drain carried go to the column's drain: same net); the OUT port
  // (if the net has one) on that line, outside
  const atPin = (e, id, rel) => !rel ? null : (e.source === id && Math.abs(Number(e.style.map.get('exitX')) - rel.x) < 0.02 && Math.abs(Number(e.style.map.get('exitY')) - rel.y) < 0.02) ? 'source'
    : (e.target === id && Math.abs(Number(e.style.map.get('entryX')) - rel.x) < 0.02 && Math.abs(Number(e.style.map.get('entryY')) - rel.y) < 0.02) ? 'target' : null;
  const other = (e, side) => side === 'source' ? { id: e.target, pin: { x: Number(e.style.map.get('entryX')), y: Number(e.style.map.get('entryY')) } } : { id: e.source, pin: { x: Number(e.style.map.get('exitX')), y: Number(e.style.map.get('exitY')) } };
  for (const [net, dev, col, I] of [[R.nodes.A, R.p7, R.p5, R.invA], [R.nodes.B, R.p8, R.p6, R.invB]]) {
    const ps = portsOf(net), o = ps.length === 1 && !I ? ps[0] : null;
    const anchor = dev || col, c = find(anchor), C = find(col), isL = col === R.p5;
    const lost = [];
    const drop = (id, rel) => { for (const e of edges0) { if (gone.has(e.id)) continue; const side = atPin(e, id, rel); if (!side && !(o && (e.source === id || e.target === id) && id === o.id)) continue; const end = other(e, side || (e.source === id ? 'source' : 'target')); if (!(end.id === C.id && Math.abs(end.pin.x - pinRel(col, 0).x) < 0.02 && Math.abs(end.pin.y - pinRel(col, 0).y) < 0.02) && end.id !== o?.id && !(dev && end.id === c.id)) lost.push(end); del(e.id); } };
    if (o) drop(o.id, null);
    if (dev) drop(c.id, pinRel(dev, 0));
    if (I) {
      // its gates leave the router: joined to the output line below
      const near = (u, v) => Math.abs(u.x - v.x) < 0.02 && Math.abs(u.y - v.y) < 0.02;
      const invGate = (l) => [I.p, I.n].some((r) => find(r).id === l.id && near(l.pin, pinRel(r, 1)));
      for (const r of [I.p, I.n]) drop(find(r).id, pinRel(r, 1));
      for (let i = lost.length - 1; i >= 0; i--) if (invGate(lost[i])) lost.splice(i, 1);
      const gp = pins(I.p)[1], gn = pins(I.n)[1], xs = (gp.x + (isL ? 24 : -24)), xd2 = pins(anchor)[0].x;
      wire(I.p, 1, anchor, 0, [{ x: xs, y: gp.y }, { x: xs, y: yO }, { x: xd2, y: yO }]);
      wire(I.n, 1, I.p, 1, [{ x: xs, y: gn.y }, { x: xs, y: gp.y }]);
      // its output: drains joined, the port (if any) outside on the output line
      const dp = pins(I.p)[0];
      for (const e of edges0) { if (gone.has(e.id)) continue; const sp = atPin(e, find(I.p).id, pinRel(I.p, 0)) || atPin(e, find(I.n).id, pinRel(I.n, 0)); if (!sp) continue; const end = other(e, sp); if (end.id === find(I.p).id || end.id === find(I.n).id) del(e.id); }
      wire(I.n, 0, I.p, 0, []);
      const po = portsOf(I.out); if (po.length === 1) {
        const q = po[0]; for (const e of edges0) if (!gone.has(e.id) && (e.source === q.id || e.target === q.id)) { const end = other(e, e.source === q.id ? 'source' : 'target'); del(e.id); if (end.id !== find(I.p).id && end.id !== find(I.n).id) addWire(model, { source: find(I.p).id, target: end.id, sourcePin: pinRel(I.p, 0), targetPin: end.pin, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }); }
        updateCell(model, q.id, { style: { rotation: null, flipH: null, flipV: null, direction: null }, x: isL ? dp.x - 140 : dp.x + 76, y: yO - 12, w: 64, h: 24 });
        wire(q.id, { x: isL ? 1 : 0, y: 0.5 }, I.p, 0, [{ x: dp.x, y: yO }]);
      }
    }
    const xd = pins(anchor)[0].x;
    if (o) {
      const px = isL ? Math.min(c.x, x0) - 140 : Math.max(c.x + c.w, x1) + 76;
      updateCell(model, o.id, { style: { rotation: null, flipH: null, flipV: null, direction: null }, x: px, y: yO - 12, w: 64, h: 24 });
      wire(o.id, { x: isL ? 1 : 0, y: 0.5 }, anchor, 0, dev ? [{ x: xd, y: yO }] : []);
    }
    if (dev) wire(dev, 0, col, 0, [{ x: xd, y: yO }, { x: pins(col)[0].x, y: yO }]);
    const seen = new Set();
    for (const l of lost) { const k = l.id + ':' + l.pin.x + ':' + l.pin.y; if (seen.has(k)) continue; seen.add(k); addWire(model, { source: C.id, target: l.id, sourcePin: pinRel(col, 0), targetPin: l.pin, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }); }
  }
  // a ground drawn as a plain net (`vss` with no symbol: lib/place2.js gives
  // symbols to `0` only): when only template sources sit on it, one wired line
  // under the clock line joins them, instead of the router's loops
  const gNet = R.tail ? S(byRef(parsed, R.tail)) : null;
  const hasSym = (net) => cells().some((c) => c.kind === 'vertex' && ['power', 'ground'].includes(classify(c).role) && String(classify(c).net || (classify(c).role === 'ground' ? '0' : '')).toLowerCase() === String(net).toLowerCase());
  if (gNet && gNet !== '0' && RAIL.test(gNet) && !hasSym(gNet)) {
    const gp = parsed.components.flatMap((c) => c.nodes.slice(0, 3).map((n, k) => ({ r: c.ref, k, n })).filter((t) => t.n === gNet));
    const on = [R.tail, R.invA?.n, R.invB?.n].filter(Boolean);
    if (on.length > 1 && !portsOf(gNet).length && gp.every((t) => on.includes(t.r) && t.k === 2)) {
      for (const r of on) { const c = find(r), rel = pinRel(r, 2); for (const e of cells().filter((x) => x.kind === 'edge')) if (atPin(e, c.id, rel)) del(e.id); }
      const yG = Math.max(...cells().filter((c) => c.kind === 'vertex' && classify(c).role === 'component').map((c) => c.y + c.h)) + 140, t = pins(R.tail)[2];
      for (const r of on.slice(1)) { const q = pins(r)[2]; wire(r, 2, R.tail, 2, [{ x: q.x, y: yG }, { x: t.x, y: yG }]); }
    }
  }
  // passives hung on the template's nodes (lib/template-attach.js); the rest
  // beside it, right of everything drawn so far (ports, clock bus)
  const tpl = [...R.used];
  // only passives whose other end is a rail drawn as a symbol (a plain `vss`
  // net has none: hanging from it put load capacitors over the X)
  const symNets = new Set(['0', ...cells().filter((c) => c.kind === 'vertex' && classify(c).role === 'power').map((c) => String(classify(c).net || '').toLowerCase())]);
  const hang = { ...parsed, components: parsed.components.filter((c) => !'RCL'.includes(c.prefix) || c.nodes.some((n) => symNets.has(String(n).toLowerCase()))) };
  const att = new Set(attachPassives(model, hang, tpl).attached);
  const rest = cells().filter((v) => v.kind === 'vertex' && classify(v).role === 'component' && !R.used.has(String(v.refdes || '')) && !att.has(String(v.refdes || '')));
  if (rest.length) {
    const restIds = new Set(rest.map((c) => c.id)), T = tpl.map(find).filter(Boolean);
    const drawn = cells().filter((c) => c.kind === 'vertex' && c.x != null && !restIds.has(c.id) && !String(c.id).startsWith('LBL_'));
    const xs = fixed.flatMap((e) => Array.from(e.getElementsByTagName('mxPoint')).map((q) => Number(q.getAttribute('x')) || 0));
    const xMax = Math.max(...drawn.map((c) => c.x + c.w), ...xs), y0b = Math.min(...T.map((c) => c.y)), y1b = Math.max(...T.map((c) => c.y + c.h));
    const rx0 = Math.min(...rest.map((c) => c.x)), ry0 = Math.min(...rest.map((c) => c.y)), ry1 = Math.max(...rest.map((c) => c.y + c.h));
    for (const c of rest) move(String(c.refdes), (xMax + 140) - rx0, (y0b + y1b) / 2 - (ry0 + ry1) / 2);
  }
  // the inner nodes drawn straight: NMOS source down to the input drain, the
  // precharge drain across to it (when the node holds just these three pins)
  for (const [n, i, pre] of [[R.n3, R.n1, R.p9], [R.n4, R.n2, R.p10]]) {
    if (!pre) continue;
    const net = D(byRef(parsed, i)), terms = parsed.components.flatMap((c) => c.nodes.map((x, k) => ({ r: c.ref, k, x })).filter((t) => t.x === net));
    const want = new Set([`${n}:2`, `${i}:0`, `${pre}:0`]);
    if (terms.length !== 3 || !terms.every((t) => want.has(`${t.r}:${t.k}`))) continue;
    const ends = new Map([[n, 2], [i, 0], [pre, 0]].map(([r, k]) => [find(r).id, pinRel(r, k)]));
    const onPin = (e, end) => { const id = end === 'exit' ? e.source : e.target, p = ends.get(id); return p && Math.abs(Number(e.style.map.get(end + 'X')) - p.x) < 0.02 && Math.abs(Number(e.style.map.get(end + 'Y')) - p.y) < 0.02; };
    const es = cells().filter((e) => e.kind === 'edge' && (onPin(e, 'exit') || onPin(e, 'entry')));
    if (!es.every((e) => onPin(e, 'exit') && onPin(e, 'entry'))) continue;
    for (const e of es) del(e.id);
    const a = pins(i)[0], b = pins(pre)[0], c = pins(n)[2];
    wire(n, 2, i, 0, [{ x: a.x, y: (a.y + c.y) / 2 }]); wire(pre, 0, i, 0, [{ x: (a.x + b.x) / 2, y: a.y }], FIX.replace('orthogonalEdgeStyle', 'none'));   // straight across: no jetty off the corner pin
  }
  const fixedIds = new Set(fixed.map((e) => e?.getAttribute?.('id') ?? e?.id));
  const ids = cells().filter((c) => c.kind === 'edge' && !fixedIds.has(c.id)).map((e) => e.id);
  for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
  await routePage(model, ids, {});
  await alignPorts(model);
  for (const r of R.used) { const c = find(r); if (c) updateCell(model, c.id, { style: { drawioApiPinned: 1 } }); }
  rebuildLocalDots(model);
}
