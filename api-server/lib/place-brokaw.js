/**
 * place-brokaw.js — the BROKAW bandgap drawn like a textbook figure (engine
 * "manuel"; Eric through the Orchestrator, 2026-10-25: the analog-design
 * drawing of its Brokaw reference was unreadable).
 *
 *   Démarrage      Cœur                     Amplificateur d'erreur      Sortie
 *   ┌───────┐   vref ───┬──────┬──────┐   vdd ┬───────┐   vdd   ┐     vdd
 *   │ stack │           RD     RC1    RC2       M3 ──── M4            MP ── o
 *   │  MS   │           │vb    │c1    │c2       │       │ o ─────────┤
 *   └───────┘           RD..  Q1 ─vb─ Q2        M1     M2            ├── vref ▶
 *                              │      R1         └─tail─┘   bias      CL
 *                              └── e ─┘            MNT ─── MN0
 *                                   R2
 *
 * Reading (by roles, not by names): two NPN with one base net, a resistor
 * string from each collector to ONE net X (the output, vref), a resistor
 * string from the emitter of one to the emitter of the other (R1, under the
 * larger transistor) and from that node to the ground (R2); the base net fed
 * by a divider from X (or X itself); a MOS differential pair whose gates are
 * the two collectors, its mirror load on the supply, a tail source and its
 * diode bias (fed by a resistor from X or the supply); the output device
 * (gate = the amplifier output, channel on X); an R-C compensation from the
 * amplifier output to X; loads from X to the ground; the rest is the start-up
 * circuit, read as a series stack from the supply to the ground plus devices
 * whose gate hangs on a node of that stack. Anything else: null (not sure).
 *
 * Geometry is written, not searched: one column per branch, the error-amp
 * inputs by wires from the collectors (the far one crosses two plain wire
 * segments, never a body), bias / frame-crossing nets (vref, vb) by labels,
 * free space beside every transistor for the overlay labels of analog-design.
 */
import { Sheet, emit, placeTwo, placeTr, portVert, tapGnd, tapVdd } from './place-manuel.js';
import { SUPPLY, chan, gateOf, isP } from './manuel-reading.js';
import { geoLvs } from './geo-lvs.js';

const GND = '0';
const isMos = (c) => c.prefix === 'M';
const isNpn = (c) => c.prefix === 'Q' && !isP(c);
const TWO = new Set(['R', 'C']);

/* ---------------------------------------------------------------- reading */
export function brokawReading(parsed, opts = {}) {
  try { return read(parsed, opts); } catch { return null; }
}

/** opts.blocks: the block items of a hierarchical TOP page (lib/hier.js pageItems): an amplifier
 *  triangle on the two collectors stands for the error amplifier, a box on the rails and X for the
 *  start-up circuit (D3, PLAN-HIERARCHIE §3.2) */
function read(parsed, opts = {}) {
  const blocks = new Map((opts.blocks || []).map((it) => [it.ref, it]));
  const isBlk = (c) => blocks.has(c.ref);
  // the bench supply (V from the supply net to the ground) is drawn apart, beside the output
  const isSrc = (c) => c.prefix === 'V' && c.nodes.length === 2 && c.nodes.includes(GND) && SUPPLY.test(c.nodes.find((n) => n !== GND) || '');
  const supplies = parsed.components.filter(isSrc);
  if (supplies.length > 1) return null;
  const comps = parsed.components.filter((c) => !isSrc(c));
  if (comps.length < 8 || comps.length > 60) return null;
  if (comps.some((c) => !isMos(c) && c.prefix !== 'Q' && !TWO.has(c.prefix) && !isBlk(c))) return null;
  const nets = new Set(comps.flatMap((c) => c.nodes));
  if (!nets.has(GND)) return null;
  const sup = [...nets].filter((n) => SUPPLY.test(n));
  if (sup.length !== 1) return null;
  const VDD = sup[0];
  const rail = (n) => n === VDD || n === GND;
  // terminals per net (channel / two-terminal ends and gates; bulks ignored)
  const on = new Map();
  const add = (n, c, k) => { if (!on.has(n)) on.set(n, []); on.get(n).push({ c, k }); };
  for (const c of comps) {
    if (isBlk(c)) for (const n of c.nodes) add(n, c, 'pin');
    else if (c.prefix === 'M' || c.prefix === 'Q') { add(c.nodes[0], c, 'top'); add(c.nodes[1], c, 'gate'); add(c.nodes[2], c, 'bot'); }
    else { add(c.nodes[0], c, 'a'); add(c.nodes[1], c, 'b'); }
  }
  const at = (n) => on.get(n) || [];
  const other = (c, n) => (c.nodes[0] === n ? c.nodes[1] : c.nodes[0]);
  const used = new Set();
  const take = (...cs) => { for (const c of cs) { if (used.has(c.ref)) throw new Error('part twice'); used.add(c.ref); } };
  /** series string of two-terminal parts from net n, starting with part p:
   *  continues through nets that only join two parts of the string */
  const string = (n, p, kinds = 'R') => {
    const parts = [p], ns = [n];
    let cur = other(p, n), last = p;
    for (;;) {
      ns.push(cur);
      const t = at(cur).filter((x) => x.c !== last);
      if (rail(cur) || at(cur).length !== 2 || t.length !== 1 || !kinds.includes(t[0].c.prefix) || !TWO.has(t[0].c.prefix)) break;
      last = t[0].c; parts.push(last); cur = other(last, cur);
    }
    return { parts, nets: ns, end: cur };
  };
  const twoOn = (n, except = new Set()) => at(n).filter((x) => TWO.has(x.c.prefix) && !except.has(x.c.ref)).map((x) => x.c);

  // 1. the core pair: two NPN on one base, collectors strung to one net X
  const npn = comps.filter(isNpn);
  let core = null;
  for (let i = 0; i < npn.length && !core; i++) for (let j = i + 1; j < npn.length && !core; j++) {
    const a = npn[i], b = npn[j];
    if (a.nodes[1] !== b.nodes[1] || a.nodes[0] === b.nodes[0] || a.nodes[2] === b.nodes[2]) continue;
    const ca = twoOn(a.nodes[0]).filter((c) => c.prefix === 'R'), cb = twoOn(b.nodes[0]).filter((c) => c.prefix === 'R');
    if (ca.length !== 1 || cb.length !== 1) continue;
    const sa = string(a.nodes[0], ca[0]), sb = string(b.nodes[0], cb[0]);
    if (sa.end !== sb.end || rail(sa.end)) continue;
    core = { a, b, rcA: sa, rcB: sb, X: sa.end };
  }
  if (!core) return null;
  const { X } = core;
  // 2. emitters: R1 from the emitter of one to the emitter of the other, R2 to ground
  let r1 = null, r2 = null;
  for (const [s, t] of [[core.a, core.b], [core.b, core.a]]) {
    const rs = twoOn(t.nodes[2]).filter((c) => c.prefix === 'R');
    if (rs.length !== 1 || at(t.nodes[2]).length !== 2) continue;
    const st = string(t.nodes[2], rs[0]);
    if (st.end !== s.nodes[2]) continue;
    const down = twoOn(s.nodes[2], new Set(st.parts.map((c) => c.ref))).filter((c) => c.prefix === 'R');
    if (down.length !== 1) continue;
    const sg = string(s.nodes[2], down[0]);
    if (sg.end !== GND) continue;
    core.small = s; core.big = t; r1 = st; r2 = sg;
  }
  if (!r1) return null;
  take(core.a, core.b, ...core.rcA.parts, ...core.rcB.parts, ...r1.parts, ...r2.parts);
  const E = core.small.nodes[2], VB = core.a.nodes[1];
  // 3. the base divider (from X to the base net, then to the ground)
  let divUp = null, divDown = null;
  if (VB !== X) {
    const up = twoOn(VB).filter((c) => c.prefix === 'R').map((c) => string(VB, c));
    divUp = up.find((s) => s.end === X); divDown = up.find((s) => s.end === GND);
    if (!divUp) return null;
    take(...divUp.parts, ...(divDown ? divDown.parts : []));
  }
  // 4. the error amplifier: the pair on the two collectors
  const CA = core.small.nodes[0], CB = core.big.nodes[0];
  const gated = (n) => at(n).filter((x) => x.k === 'gate' && isMos(x.c)).map((x) => x.c);
  let amp = null, inA = null, inB = null, lA = [null], lB = [null], diodeSide = null, O, T = null, tail = null, NB = null, biasD = null, biasR = null;
  const tri = [...blocks.values()].filter((it) => it.tri && it.pins.filter((p) => p.side === 'left').map((p) => p.net).sort().join() === [CA, CB].sort().join());
  if (tri.length === 1) {
    // the amplifier block: one output, supplies on top, grounds below, at most one bias pin (fed by a resistor from X)
    const it = tri[0], outs = it.pins.filter((p) => p.side === 'right');
    if (outs.length !== 1) return null;
    O = outs[0].net;
    if (it.pins.some((p) => rail(p.net) && (p.side !== (p.net === VDD ? 'top' : 'bottom')))) return null;
    const extra = it.pins.filter((p) => p.side !== 'left' && p.side !== 'right' && !rail(p.net));
    if (extra.length > 1) return null;
    take(it.comp);
    if (extra.length) {
      NB = extra[0].net;
      const rs = twoOn(NB).filter((c) => c.prefix === 'R');
      if (rs.length !== 1 || at(NB).length !== 2) return null;
      biasR = string(NB, rs[0]);
      if (biasR.end !== X) return null;
      take(...biasR.parts);
    }
    amp = { it, bias: extra[0] || null };
  } else {
    const mA = gated(CA), mB = gated(CB);
    if (mA.length !== 1 || mB.length !== 1) return null;
    inA = mA[0]; inB = mB[0];
    if (inA.nodes[2] !== inB.nodes[2] || isP(inA) !== isP(inB) || isP(inA)) return null;
    T = inA.nodes[2];
    const loadOf = (d) => at(d).filter((x) => x.k === 'top' && x.c !== inA && x.c !== inB && isMos(x.c) && isP(x.c) && x.c.nodes[0] === d && x.c.nodes[2] === VDD).map((x) => x.c);
    lA = loadOf(inA.nodes[0]); lB = loadOf(inB.nodes[0]);
    if (lA.length !== 1 || lB.length !== 1 || lA[0].nodes[1] !== lB[0].nodes[1]) return null;
    diodeSide = lA[0].nodes[1] === lA[0].nodes[0] ? 'A' : lB[0].nodes[1] === lB[0].nodes[0] ? 'B' : null;
    if (!diodeSide) return null;
    O = diodeSide === 'A' ? inB.nodes[0] : inA.nodes[0];
    const tails = at(T).filter((x) => x.k === 'top' && isMos(x.c) && x.c !== inA && x.c !== inB && x.c.nodes[2] === GND).map((x) => x.c);
    if (tails.length !== 1) return null;
    tail = tails[0]; NB = tail.nodes[1];
    take(inA, inB, lA[0], lB[0], tail);
    if (!rail(NB)) {
      const d = at(NB).filter((x) => x.k === 'top' && isMos(x.c) && x.c.nodes[1] === NB && x.c.nodes[2] === GND).map((x) => x.c);
      if (d.length !== 1) return null;
      biasD = d[0];
      const rs = twoOn(NB).filter((c) => c.prefix === 'R');
      if (rs.length !== 1) return null;
      biasR = string(NB, rs[0]);
      if (biasR.end !== X && biasR.end !== VDD) return null;
      take(biasD, ...biasR.parts);
  }
  }
  // 5. the output device: gate on the amplifier output, channel on X
  const outs = gated(O).filter((c) => c.nodes[0] === X || c.nodes[2] === X);
  if (outs.length !== 1) return null;
  const out = outs[0];
  take(out);
  // 6. compensation O -> X (R, C strings) and the loads X -> ground
  const comp = [];
  for (const p of twoOn(O)) {
    if (used.has(p.ref)) continue;
    const s = string(O, p, 'RC');
    if (s.end !== X) return null;
    comp.push(s); take(...s.parts);
  }
  if (comp.length > 1) return null;
  const loads = twoOn(X).filter((c) => !used.has(c.ref) && other(c, X) === GND);
  take(...loads);
  // 7. the start-up circuit: the rest, a series stack from the supply plus
  //    devices hanging (gate) on its nodes
  const rest = comps.filter((c) => !used.has(c.ref));
  let start = null;
  if (rest.length === 1 && isBlk(rest[0])) {
    // the start-up block: a box on the rails and X
    const it = blocks.get(rest[0].ref);
    if (it.tri || !rest[0].nodes.every((n) => rail(n) || n === X)) return null;
    start = { block: it };
    take(rest[0]);
  } else if (rest.length) {
    if (rest.some((c) => !isMos(c))) return null;
    const restSet = new Set(rest.map((c) => c.ref));
    const chanOn = (n) => at(n).filter((x) => x.k !== 'gate' && restSet.has(x.c.ref)).map((x) => x.c);
    const topOf = (c) => (isP(c) ? c.nodes[2] : c.nodes[0]), botOf = (c) => (isP(c) ? c.nodes[0] : c.nodes[2]);
    // the stack: from the supply down through nodes joining exactly two of its devices
    const first = rest.filter((c) => topOf(c) === VDD && botOf(c) !== X && !rail(botOf(c)));
    let stack = null;
    for (const f of first) {
      const seq = [f]; let n = botOf(f);
      for (let guard = 0; guard < 20 && n !== GND; guard++) {
        const nx = chanOn(n).filter((c) => !seq.includes(c) && topOf(c) === n);
        if (nx.length !== 1) break;
        seq.push(nx[0]); n = botOf(nx[0]);
      }
      if (n === GND && (!stack || seq.length > stack.length)) stack = seq;
    }
    if (!stack) return null;
    const stackNets = new Set(stack.slice(0, -1).map(botOf));
    const hang = rest.filter((c) => !stack.includes(c));
    // each hanging device: gate on a stack node, channel between the supply / ground and X
    for (const h of hang) {
      if (!stackNets.has(h.nodes[1])) return null;
      const ch = [h.nodes[0], h.nodes[2]];
      if (!ch.every((n) => rail(n) || n === X)) return null;
    }
    if (stack.some((c) => !(rail(c.nodes[1]) || c.nodes[1] === X || stackNets.has(c.nodes[1])))) return null;
    start = { stack, hang, topOf, botOf };
    take(...rest);
  }
  if (used.size !== comps.length) return null;
  if (supplies.length && supplies[0].nodes.find((n) => n !== GND) !== VDD) return null;
  return { VDD, X, VB, E, CA, CB, O, T, NB, core, r1, r2, divUp, divDown, amp, inA, inB, loadA: lA[0], loadB: lB[0], diodeSide, tail, biasD, biasR, out, comp: comp[0] || null, loads, start, supply: supplies[0] || null };
}

/* ---------------------------------------------------------------- drawing */
// a transistor's pin offsets (top, bottom, gate) for a given gate side
function trGeo(c, dir) {
  const T = new Sheet(), v = placeTr(T, c, 0, 0, dir);
  return { top: v.pinAbs[v.pinOf.top], bot: v.pinAbs[v.pinOf.bot], gate: v.pinAbs[v.pinOf.gate] };
}
const mult = (c) => {
  const m = /\b(?:m|nx)\s*=\s*([0-9.]+)/i.exec(String(c.value || '')) || (c.params && /([0-9.]+)/.exec(c.params.nx || c.params.m || ''));
  return m ? parseFloat(m[1]) : 1;
};

/** B.vertex (hierarchical top, D3): { box, tri, pinText } of lib/hier.js, to draw B.amp and B.start.block */
export function importBrokaw(model, parsed, B) {
  const S = new Sheet();
  const boxes = [];
  const lab = (net, p, side) => { const pv = portVert(S, net, p, side, false); S.term(net, pv, pv.portPin); };
  const gnd = (net, p) => { const q = { x: p.x, y: p.y + 20 }; S.path(net, p, q); S.term(net, tapGnd(S, q), 'N'); };
  const vdd = (net, p) => { const q = { x: p.x, y: p.y - 20 }; S.path(net, q, p); S.term(net, tapVdd(S, net, q), 'S'); };
  // a vertical string of two-terminal parts from net n0 (pin at (x, y)): returns the bottom point
  const vString = (s, x, y, labelSide = 1) => {
    let p = { x, y };
    s.parts.forEach((c, i) => {
      const v = placeTwo(S, c, x, p.y + (i ? 30 : 0), s.nets[i], true, labelSide);
      const a = S.term(s.nets[i], v, v.first);
      S.path(s.nets[i], p, a);
      p = S.term(s.nets[i + 1], v, v.other);
    });
    return p;
  };
  const tr = (c, cx, y, dir) => { const v = placeTr(S, c, cx, y, dir); return { v, top: S.term(v.netOf.top, v, v.pinOf.top), bot: S.term(v.netOf.bot, v, v.pinOf.bot), gate: S.term(v.netOf.gate, v, v.pinOf.gate) }; };
  const frame = (title, x0, x1, y0, y1) => boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, title });
  const rev = (st) => ({ parts: [...st.parts].reverse(), nets: [...st.nets].reverse() });   // drawn from its far end

  /* ---- core: vref bus, divider, Q pair, R1 / R2 */
  const yRef = 120;
  const xDiv = 200, xA = 380, xB = 560;           // small (A) left, big (8A) right
  const QA = B.core.small, QB = B.core.big;
  const rcA = QA === B.core.a ? B.core.rcA : B.core.rcB, rcB = QA === B.core.a ? B.core.rcB : B.core.rcA;
  const pA = vString(rev(rcA), xA, yRef, -1), pB = vString(rev(rcB), xB, yRef, 1);
  const yC = Math.max(pA.y, pB.y);
  let xL = 800, xR = 1000, xT = (xL + xR) / 2, yV = yRef, inL, inR, ldL, ldR, gL, yCA, yCB;
  if (B.amp) {
    // the amplifier triangle: the collector taps level with its '+' (upper) and '−' pins, 40 apart
    const plus = B.amp.it.pins.find((p) => p.side === 'left' && B.amp.it.tri[p.name].sign === '+');
    yCA = plus.net === B.CA ? yC + 40 : yC + 80; yCB = plus.net === B.CB ? yC + 40 : yC + 80;
  } else {
    // the amplifier's mirror first: the collector taps run below its diode loop
    inL = B.inA.nodes[1] === B.CB ? B.inA : B.inB; inR = inL === B.inA ? B.inB : B.inA;
    ldL = inL === B.inA ? B.loadA : B.loadB; ldR = inL === B.inA ? B.loadB : B.loadA;
    gL = trGeo(ldL, 1);
    const loopY = yV - gL.top.y + gL.bot.y + 20;
    // the collector nodes: c(A) tap high (its wire crosses the c(B) segment of Q(B) and the left amplifier column), c(B) lower
    yCA = Math.max(yC + 40, loopY + 30); yCB = yCA + 40;
  }
  const gA = trGeo(QA, 1), yQ = Math.max(yCA, yCB) + 40;   // Q tops below the two taps
  const qa = tr(QA, xA, yQ - gA.top.y, 1), qb = tr(QB, xB, yQ - trGeo(QB, -1).top.y, -1);
  S.path(B.CA, pA, qa.top); S.path(B.CB, pB, qb.top);
  // emitter areas: A and nA beside the bipolars (the ratio sets the PTAT voltage)
  const ma = mult(QA), mb = mult(QB), ratio = +(mb / ma).toPrecision(3);
  S.text(`<b>A</b> (×${ma})`, xA - 98, qa.bot.y + 2, 90, 18, 'right', 12);
  S.text(`<b>${ratio}A</b> (×${mb})`, xB + 8, qb.bot.y + 2, 110, 18, 'left', 12);
  // bases: a bar between the facing bases, the base net named by a label above it
  if (Math.abs(qa.gate.y - qb.gate.y) > 0.5) throw new Error('brokaw: bases not level');
  const xm = (qa.gate.x + qb.gate.x) / 2;
  S.path(B.VB, qa.gate, qb.gate);
  if (B.VB === B.X) { S.path(B.VB, { x: xm, y: qa.gate.y }, { x: xm, y: qa.gate.y - 30 }); lab(B.VB, { x: xm, y: qa.gate.y - 30 }, 1); }
  else { S.path(B.VB, { x: xm, y: qa.gate.y }, { x: xm, y: qa.gate.y - 40 }); lab(B.VB, { x: xm, y: qa.gate.y - 40 }, 1); }
  // emitters: R1 under the big one, the E line, R2 to the ground under the small one
  const pR1 = vString(B.r1, xB, qb.bot.y + 30, 1);   // from the big emitter down to E
  S.path(B.r1.nets[0], qb.bot, { x: xB, y: qb.bot.y + 30 });
  const yE = pR1.y;                                   // the E line level with R1's lower end
  S.path(B.E, pR1, { x: xA, y: yE }, qa.bot);
  const pR2 = vString(B.r2, xA, yE + 30, -1);
  S.path(B.E, { x: xA, y: yE }, { x: xA, y: yE + 30 });
  const yG = pR2.y + 20;
  gnd(GND, pR2);
  // the vref bus, named at its left end (or wired there from the start-up block)
  S.path(B.X, { x: xDiv, y: yRef }, { x: xA, y: yRef }); S.path(B.X, { x: xA, y: yRef }, { x: xB, y: yRef });   // split at RC(A)'s pin
  if (!(B.start && B.start.block)) { lab(B.X, { x: xDiv - 40, y: yRef }, -1); S.path(B.X, { x: xDiv - 40, y: yRef }, { x: xDiv, y: yRef }); }
  else { S.path(B.X, { x: xB, y: yRef }, { x: xB + 40, y: yRef }); lab(B.X, { x: xB + 40, y: yRef }, 1); }   // named at its right end
  // divider: X -> vb (labelled) -> ground
  if (B.divUp) {
    const pv = vString(rev(B.divUp), xDiv, yRef, -1);
    S.path(B.VB, pv, { x: xDiv, y: pv.y + 20 }); lab(B.VB, { x: xDiv - 30, y: pv.y + 20 }, -1); S.path(B.VB, { x: xDiv - 30, y: pv.y + 20 }, { x: xDiv, y: pv.y + 20 });
    if (B.divDown) {
      S.path(B.VB, { x: xDiv, y: pv.y + 20 }, { x: xDiv, y: pv.y + 40 });
      gnd(GND, vString(B.divDown, xDiv, pv.y + 40, -1));
    }
  }
  const coreBottom = Math.max(S.bbox().y1, yG);
  frame('Cœur', xDiv - 130, xB + 100, 40, coreBottom + 30);

  /* ---- error amplifier: mirror on top, pair, tail; the bias beside */
  let oNode, ampRight;
  if (B.amp) {
    // the triangle beside the core, its inputs wired straight from the collector taps
    const it = B.amp.it, xTri = xB + 200, yTop = Math.min(yCA, yCB) - 40;
    const tv = B.vertex.tri(S, it, xTri, yTop);
    const pin = {};
    for (const p of it.pins) { pin[p.name] = S.term(p.net, tv, p.name); B.vertex.pinText(S, it, p, pin[p.name]); }
    for (const p of it.pins) {
      const a = pin[p.name];
      if (p.net === B.CA) S.path(B.CA, { x: xA, y: yCA }, a);
      else if (p.net === B.CB) S.path(B.CB, { x: xB, y: yCB }, a);
      else if (p.net === B.VDD) vdd(B.VDD, a);
      else if (p.net === GND) gnd(GND, a);
    }
    oNode = pin[it.pins.find((p) => p.side === 'right').name];
    const xEnd = xTri + 120;
    // the bias pin: straight down past the ground symbol to its resistor, then X (labelled)
    if (B.amp.bias) {
      const a = pin[B.amp.bias.name], yb = yTop + 140;
      S.path(B.NB, a, { x: a.x, y: yb });
      const pe = vString(B.biasR, a.x, yb, 1);
      S.path(B.X, pe, { x: a.x, y: pe.y + 20 }); lab(B.X, { x: a.x, y: pe.y + 20 }, 1);
    }
    ampRight = xEnd + 60;
    frame("Amplificateur d'erreur", xTri - 40, ampRight, 40, S.bbox().y1 + 30);
  } else {
    // left: the input on c(B) (its wire straight from Q(B)); yV: the amplifier's local supply line
    const mL = tr(ldL, xL, yV - gL.top.y, 1), mR = tr(ldR, xR, yV - trGeo(ldR, -1).top.y, -1);
    S.path(B.VDD, { x: xL, y: yV }, { x: xR, y: yV }); vdd(B.VDD, { x: xT, y: yV });
    S.path(B.VDD, mL.top, { x: xL, y: yV }); S.path(B.VDD, mR.top, { x: xR, y: yV });
    S.path(ldL.nodes[1], mL.gate, mR.gate);            // the mirror's gate bar
    const diodeV = ldL.nodes[1] === ldL.nodes[0] ? mL : mR;
    const yBar = mL.gate.y, xD = diodeV === mL ? xL : xR;
    S.path(ldL.nodes[1], { x: xT, y: yBar }, { x: xT, y: diodeV.bot.y + 20 }, { x: xD, y: diodeV.bot.y + 20 });
    S.mark({ x: xT, y: diodeV.bot.y + 20 }); S.mark({ x: xD, y: diodeV.bot.y + 20 });
    // the pair: gates on the collector taps (c(A) high, c(B) lower), crossing plain wires only
    const gi = trGeo(inL, -1), yIn = yCB + 40 - (gi.gate.y - gi.top.y) + 40;
    // mirrored like the textbook pair: gates outward (left one left, right one right)
    const pl = tr(inL, xL, yIn - gi.top.y, -1), pr = tr(inR, xR, yIn - trGeo(inR, 1).top.y, 1);
    S.path(inL.nodes[0], mL.bot, pl.top); S.path(inR.nodes[0], mR.bot, pr.top);
    if (!(pl.top.y > yCA + 10) || !(pl.gate.y > yCB)) throw new Error('brokaw: pair too high');
    const sL = pl.gate.x - 30, sR = pr.gate.x + 30;
    S.path(B.CB, { x: xB, y: yCB }, { x: sL, y: yCB }, { x: sL, y: pl.gate.y }, pl.gate);
    S.path(B.CA, { x: xA, y: yCA }, { x: sR, y: yCA }, { x: sR, y: pr.gate.y }, pr.gate);
    // tail node, tail source on the axis, ground
    // tail node level with the sources (the rule of the manuel engine)
    if (Math.abs(pl.bot.y - pr.bot.y) > 0.5) throw new Error('brokaw: pair sources not level');
    const yTn = pl.bot.y;
    S.path(B.T, pl.bot, pr.bot);
    const gt = trGeo(B.tail, 1);
    const tt = tr(B.tail, xT, yTn + 30 - gt.top.y, 1);
    S.path(B.T, { x: xT, y: yTn }, tt.top);
    gnd(GND, tt.bot);
    // the bias: diode-connected device right of the tail, its resistor above from X (label) or the supply
    if (B.biasD) {
      const xN = xT + 270;
      const gd = trGeo(B.biasD, -1);
      const bd = tr(B.biasD, xN, tt.top.y - gd.top.y + gt.top.y, -1);
      // gate bar tail <-> bias diode, diode loop on the bias column
      S.path(B.NB, tt.gate, bd.gate);
      const yLoop = bd.top.y - 20;
      S.path(B.NB, { x: (tt.gate.x + bd.gate.x) / 2, y: bd.gate.y }, { x: (tt.gate.x + bd.gate.x) / 2, y: yLoop }, { x: xN, y: yLoop });
      S.mark({ x: (tt.gate.x + bd.gate.x) / 2, y: yLoop }); S.mark({ x: xN, y: yLoop });
      S.path(B.NB, bd.top, { x: xN, y: yLoop });
      const len = B.biasR.parts.length * 110 + 40;
      const yR = yLoop - len;
      const pb = vString({ parts: [...B.biasR.parts].reverse(), nets: [...B.biasR.nets].reverse() }, xN, yR, 1);
      S.path(B.NB, pb, { x: xN, y: yLoop });
      if (B.biasR.end === B.VDD) vdd(B.VDD, { x: xN, y: yR });
      else { S.path(B.X, { x: xN, y: yR }, { x: xN, y: yR - 20 }); lab(B.X, { x: xN, y: yR - 20 }, 1); }
      gnd(GND, bd.bot);
    }
    ampRight = xT + 380;
    frame("Amplificateur d'erreur", sL - 40, ampRight, 40, S.bbox().y1 + 30);
    // the amplifier output tapped just under its mirror device, above the diode loop and the collector wires
    oNode = B.O === inL.nodes[0] ? { x: xL, y: mL.bot.y + 20 } : { x: xR, y: mR.bot.y + 20 };
  }
  const ampBottom = S.bbox().y1;

  /* ---- output: the output device on the amplifier output, compensation, loads, the vref port */
  const xO = B.amp ? ampRight + 340 : 1620;
  const outDir = -1, go = trGeo(B.out, outDir);
  const ov = tr(B.out, xO, oNode.y - go.gate.y, outDir);
  S.path(B.O, oNode, ov.gate);
  const xOut = ov.top, xOutB = ov.bot;
  const topNet = ov.v.netOf.top, botNet = ov.v.netOf.bot;
  if (topNet === B.VDD) vdd(B.VDD, xOut); else lab(topNet, xOut, 1);
  // X below the device: compensation bridge, the loads, the port
  let y = xOutB.y + 40;
  S.path(botNet, xOutB, { x: xO, y });
  if (B.comp) {
    const xs = ampRight + 50;
    const yb = y;
    S.path(B.O, { x: xs, y: oNode.y }, { x: xs, y: yb });
    let p = { x: xs, y: yb };
    B.comp.parts.forEach((c, i) => {
      const v = placeTwo(S, c, p.x + (i ? 20 : 60), yb, B.comp.nets[i], false);
      S.path(B.comp.nets[i], p, S.term(B.comp.nets[i], v, v.first));
      p = S.term(B.comp.nets[i + 1], v, v.other);
    });
    S.path(B.X, p, { x: xO, y: yb });
  }
  S.path(B.X, { x: xO, y }, { x: xO + 120, y });
  const pv = portVert(S, B.X, { x: xO + 120, y }, 1, true, 'output'); S.term(B.X, pv, pv.portPin);
  let yl = y;
  B.loads.forEach((c, i) => {
    const xc = xO + 40 + i * 0;
    S.path(B.X, { x: xc, y }, { x: xc, y: y + 30 });
    const v = placeTwo(S, c, xc, y + 30, B.X, true, 1);
    S.term(B.X, v, v.first);
    const b = S.term(GND, v, v.other); gnd(GND, b); yl = Math.max(yl, b.y);
  });
  // the bench supply, apart on the right: vdd above, ground below
  if (B.supply) {
    const xv = xO + 200, c = B.supply;
    const v = placeTwo(S, c, xv, y + 30, B.VDD, true, 1);
    vdd(B.VDD, S.term(B.VDD, v, v.first));
    const b = S.term(GND, v, v.other); gnd(GND, b); yl = Math.max(yl, b.y);
  }
  frame('Sortie', ampRight + 20, xO + (B.supply ? 280 : 220), 40, Math.max(yl + 60, ampBottom + 30));

  /* ---- start-up: the block (hierarchical top), or the stack and the devices hanging on its nodes */
  if (B.start && B.start.block) {
    // X on the right side, wired to the vref bus; supply on top, ground below
    const it = { ...B.start.block, pins: B.start.block.pins.map((p) => ({ ...p, side: p.net === B.X ? 'right' : p.net === B.VDD ? 'top' : 'bottom' })) };
    const nR = it.pins.filter((p) => p.side === 'right').length, h = (Math.max(nR, 1) + 1) * 40, w = 60 * (Math.max(it.pins.filter((p) => p.side === 'top').length, it.pins.filter((p) => p.side === 'bottom').length, 2) + 1);
    const x0 = xDiv - 130 - 80 - w, v = B.vertex.box(S, it, x0, yRef - h / (nR + 1));
    for (const p of it.pins) {
      const a = S.term(p.net, v, p.name);
      if (p.side === 'right') S.path(B.X, a, { x: xDiv, y: a.y });
      else if (p.side === 'top') vdd(B.VDD, a);
      else gnd(GND, a);
    }
  } else if (B.start) {
    const xS = -420, xH = -240;
    let p = { x: xS, y: yRef };
    vdd(B.VDD, p);
    const nodeAt = new Map();
    const gatesToGnd = [];
    B.start.stack.forEach((c) => {
      const dir = -1, g = trGeo(c, dir);
      const t = tr(c, xS, p.y + 30 - g.top.y, dir);
      S.path(B.start.topOf(c), p, t.top);
      const gn = c.nodes[1];
      if (gn === GND) gatesToGnd.push(t.gate);
      else if (gn === B.VDD) { const q = { x: t.gate.x - 20, y: t.gate.y }; S.path(gn, t.gate, q); vdd(gn, q); }
      else if (gn === B.X) { const q = { x: t.gate.x - 20, y: t.gate.y }; S.path(gn, t.gate, q); lab(gn, q, -1); }
      else gatesToGnd.push(null);
      p = t.bot; nodeAt.set(B.start.botOf(c), t.bot);
    });
    // the gates on the ground: one bar on the left, one ground symbol
    const gg = gatesToGnd.filter(Boolean);
    if (gg.length) {
      const xg = gg[0].x - 30;
      for (const g of gg) S.path(GND, g, { x: xg, y: g.y });
      const yb = Math.max(...gg.map((g) => g.y));
      S.path(GND, { x: xg, y: Math.min(...gg.map((g) => g.y)) }, { x: xg, y: yb });
      gnd(GND, { x: xg, y: yb });
    }
    gnd(GND, p);
    // hanging devices, right of the stack, gate level with their node
    B.start.hang.forEach((h, i) => {
      const n = nodeAt.get(h.nodes[1]) || (() => { throw new Error('brokaw: start-up node'); })();
      const dir = -1, g = trGeo(h, dir), xh = xH + i * 160;
      // the node of the stack: a point between the two devices
      const t = tr(h, xh, n.y + 15 - g.gate.y, dir);
      const yn = t.gate.y;
      S.path(h.nodes[1], { x: xS, y: yn }, t.gate);
      for (const [pt, net] of [[t.top, t.v.netOf.top], [t.bot, t.v.netOf.bot]]) {
        if (net === B.VDD) vdd(net, pt);
        else if (net === GND) gnd(net, pt);
        else { const q = { x: pt.x, y: pt.y + (pt === t.top ? -20 : 20) }; S.path(net, pt, q); lab(net, q, 1); }
      }
    });
    const b = S.bbox();
    frame('Démarrage', xS - 120, xH + B.start.hang.length * 160 + 20, 40, b.y1 + 30);
  }
  S.boxes.push(...boxes);
  const bb = S.bbox();
  S.shift(80 - Math.min(bb.x0, ...boxes.map((x) => x.x)), 60 - Math.min(bb.y0, ...boxes.map((x) => x.y)));
  const wires = emit(model, [S], parsed, new Set([B.VDD, GND]));
  return { geo: geoLvs(model), wires };
}
