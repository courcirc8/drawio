/**
 * place-classab.js — engine "classab": the CLASS-AB OUTPUT STAGE drawn as
 * textbooks draw it (Eric's list, 2026-10-12, third batch): the two output
 * devices stacked in one column on the right, the output between them; the
 * bias string between their two gate (base) nodes in a column just left of
 * them, its feeding source over it, the driver under it.
 *
 *        I ─┐        │
 *           A ───────┤ Q1 (top: PMOS source / NPN collector on the supply)
 *          ▼ D1      ├──── OUT
 *          ▼ D2      │
 *           B ───────┤ Q2 (bottom)
 *   IN ───┤ driver   │
 *
 * Read: a complementary pair joined at the output — common source (drains on
 * the output, sources on the rails) or follower (sources on the output, drains
 * on the rails) — whose gates are two different nodes A (top) and B (bottom)
 * joined by a SERIES string of diodes, diode-connected devices, resistors or a
 * floating device (Monticelli: a pair of opposite devices in parallel), with
 * no rail and not the output inside. Feeders: a source / resistor / device
 * from A to the supply, from B to the ground (the driver: a common-source
 * device, drain on B). AUTO_CLASSAB=0 disables.
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

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss|power(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?|ground(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?)$/i;
const GNDN = /^(0|gnd\w*|vss\w*|vee\w*|avss|dvss|ground(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?)$/i;
const isAct = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];
const SUP = (n) => RAIL.test(n) && !GNDN.test(n);

/** The two current-carrying terminals of a part as a 2-terminal element
 *  (a device: drain / source), or null. */
const ends = (c) => (isAct(c) ? [D(c), S(c)] : ['R', 'C', 'D', 'V', 'I', 'L'].includes(c.prefix) && c.nodes.length >= 2 ? c.nodes.slice(0, 2) : null);

export function classabReading(parsed) {
  const comps = parsed.components;
  const acts = comps.filter(isAct);
  for (const top of acts) for (const bot of acts) {
    if (top === bot || !isPmosLike(top) === !isPmosLike(bot)) continue;
    // CS: PMOS / PNP on top (source on the supply); follower: NMOS / NPN on top (drain on the supply)
    let kind = null, out = null;
    if (isPmosLike(top) && D(top) === D(bot) && SUP(S(top)) && GNDN.test(S(bot)) && !RAIL.test(D(top))) { kind = 'cs'; out = D(top); }
    else if (!isPmosLike(top) && S(top) === S(bot) && SUP(D(top)) && GNDN.test(D(bot)) && !RAIL.test(S(top))) { kind = 'follower'; out = S(top); }
    if (!kind) continue;
    const A = G(top), B = G(bot);
    if (A === B || RAIL.test(A) || RAIL.test(B) || A === out || B === out) continue;
    // the series string from A to B: steps of one part, or two parallel ones
    const used = new Set([top.ref, bot.ref]);
    const steps = [];
    let n = A;
    for (let k = 0; k < 4 && n !== B; k++) {
      const at = comps.filter((c) => !used.has(c.ref) && ends(c) && ends(c).includes(n) && !ends(c).some((x) => RAIL.test(x) || x === out) && ends(c)[0] !== ends(c)[1]);
      // the next node: prefer B
      const nexts = [...new Set(at.map((c) => ends(c).find((x) => x !== n)))];
      const next = nexts.includes(B) ? B : nexts.length === 1 ? nexts[0] : null;
      if (!next) break;
      const parts = at.filter((c) => ends(c).includes(next));
      if (!parts.length || parts.length > 2) break;
      for (const p of parts) used.add(p.ref);
      steps.push({ from: n, to: next, parts: parts.map((p) => p.ref) });
      n = next;
    }
    if (n !== B || !steps.length) continue;
    // common source: the gate nodes are driven inside the circuit (not an
    // input), and a device in the string is a diode or a FLOATING source whose
    // gate is a bias (a bias name, or a diode's node) — not a signal, a clock
    if (kind === 'cs') {
      if ([A, B, ...steps.map((st) => st.to)].some((x) => /^v?in/i.test(x))) continue;
      const isBias = (g) => /^(v?b|vbias|bias|vcas|vc\d)/i.test(g) || comps.some((c) => isAct(c) && D(c) === g && G(c) === g);
      if (steps.some((st) => st.parts.some((r) => { const c = comps.find((x) => x.ref === r); return isAct(c) && G(c) !== D(c) && G(c) !== S(c) && !isBias(G(c)); }))) continue;
    }
    // feeders: A to the supply, B to the ground (a device: drain on the node)
    // (a device: drain on the node, source on the rail — or a follower: source
    // on the node, drain on the rail)
    const feed = (node, railOk) => comps.find((c) => !used.has(c.ref) && (isAct(c) ? (D(c) === node && railOk(S(c))) || (S(c) === node && railOk(D(c))) : ends(c) && ends(c).includes(node) && ends(c).some((x) => x !== node && railOk(x))));
    const fA = feed(A, SUP), fB = feed(B, (x) => GNDN.test(x));
    if (fA) used.add(fA.ref);
    if (fB) used.add(fB.ref);
    if (!fA && !fB && !comps.some((c) => c.prefix === 'P')) { /* ports may feed A / B */ }
    // helpers of a string device (a Vbe multiplier: a diode from A to its
    // base, a resistor from its base to B): a short chain A → gate → B
    const helpers = [];
    for (const st of steps) for (const r of st.parts) {
      const c = comps.find((x) => x.ref === r), g = isAct(c) ? G(c) : null;
      if (!g || [A, B, ...steps.map((x) => x.to)].includes(g) || RAIL.test(g)) continue;
      const hop = (from, to) => comps.find((x) => !used.has(x.ref) && ends(x) && ends(x).includes(from) && ends(x).includes(to));
      const h1 = hop(st.from, g), h2 = h1 && hop(g, st.to);
      if (h1 && h2) { used.add(h1.ref); used.add(h2.ref); helpers.push({ dev: r, g, parts: [h1.ref, h2.ref], from: st.from, to: st.to }); }
    }
    // loads on the output: 2-terminal parts to a rail (or to a net of their own)
    const loads = comps.filter((c) => !used.has(c.ref) && ends(c) && !isAct(c) && ends(c).includes(out) && (() => { const o = ends(c).find((x) => x !== out); return RAIL.test(o) || comps.filter((y) => y.nodes.includes(o)).length === 1; })());
    for (const c of loads) used.add(c.ref);
    return { kind, top: top.ref, bot: bot.ref, out, A, B, steps, fA: fA?.ref, fB: fB?.ref, helpers, loads: loads.map((c) => c.ref), used };
  }
  return null;
}

/** place-sa's start (units of the median part size). */
export function classabLayout(parsed, R) {
  const pos = new Map(), L = Math.max(2, R.steps.length);
  pos.set(R.top, { x: 2, y: 0 }); pos.set(R.bot, { x: 2, y: 1.6 * L });
  R.steps.forEach((s, k) => s.parts.forEach((r, j) => pos.set(r, { x: -j * 1.2, y: 1.6 * (k + 0.5) })));
  if (R.fA) pos.set(R.fA, { x: 0, y: -1.6 }); if (R.fB) pos.set(R.fB, { x: 0, y: 1.6 * (L + 1) });
  let n = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: -3 - 1.5 * n++, y: 0 });
  return pos;
}

export async function importNetlistClassab(model, parsed, opts = {}) {
  const R = classabReading(parsed);
  if (!R) throw new Error('classab: no class-AB output stage');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: classabLayout(parsed, R), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await impose(model, parsed, R);
  return placed;
}

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
    if (!ref || !isAct(comp.get(ref))) return;
    const c = find(ref), g = pin(ref, 1), mid = c.x + c.w / 2;
    if ((side === 'left') !== (g.x < mid)) updateCell(model, c.id, { style: { flipH: String(c.style.map.get('flipH') || '0') === '1' ? null : 1 } });
  };
  // a 2-terminal part upright with its pin on `net` on top (at x, y)
  const stand = (ref, net, x, y) => {
    const c0 = find(ref), pc = comp.get(ref);
    const k = isAct(pc) ? (D(pc) === net ? 0 : 2) : pc.nodes.indexOf(net), kk = isAct(pc) ? (k === 0 ? 2 : 0) : 1 - k;
    if (!isAct(pc)) {
      for (const rot of [0, 90, 180, 270]) {
        updateCell(model, c0.id, { style: { rotation: rot || null, flipV: null, flipH: null } });
        const ps = pinsOf(ref);
        if (ps.length >= 2 && Math.abs(ps[k].x - ps[kk].x) < 1 && ps[k].y < ps[kk].y) break;
      }
    }
    const q = pin(ref, k); move(ref, x - q.x, y - q.y);
    return { top: k, bottom: kk };
  };
  face(R.top, 'left'); face(R.bot, 'left');
  const T = find(R.top), H = Math.max(T.h, find(R.bot).h), W = Math.max(T.w, find(R.bot).w);
  const xg = pin(R.top, 1).x;
  // a floating pair (Monticelli): the inner device's gate faces the output,
  // its bias port between the string and the output devices
  const par = R.steps.some((st) => st.parts.length > 1);
  const xs = Math.round(xg - Math.max(1.4 * W, 120) - (par ? 150 : 0));   // the string's column
  // a feeder device of the output device's type, source on the same rail,
  // stands on its row (check.py reads the two as a pair: rule 14, severe)
  const sameRow = (f, o) => f && isAct(comp.get(f)) && isPmosLike(comp.get(f)) === isPmosLike(comp.get(o)) && S(comp.get(f)) === S(comp.get(o)) && D(comp.get(f)) !== S(comp.get(f));
  R.rowA = sameRow(R.fA, R.top); R.rowB = sameRow(R.fB, R.bot);
  if (R.rowA) { face(R.fA, 'left'); const q = pin(R.fA, 0), c = ctr(R.fA), t = ctr(R.top); move(R.fA, xs - q.x, t.y - c.y); }
  const yA = R.rowA ? Math.round(pin(R.fA, 0).y + 30) : Math.round(pin(R.top, 1).y);
  // the string, top to bottom, each part's top pin on the node above; a
  // parallel part beside, to the left; the gap between parts grows until the
  // two output devices are 1.7 part heights apart
  const stepPins = [];
  const x2 = xs - Math.max(1.6 * W, 110) - 40;   // a Vbe multiplier's diode and resistor: a column left of the string
  const placeH = (r, net, x, y) => {   // a part with its pin on `net` at (x, y)
    const pc = comp.get(r);
    if (isAct(pc)) { face(r, 'right'); const k = D(pc) === net ? 0 : 2; const q = pin(r, k); move(r, x - q.x, y - q.y); }
    else { stand(r, net, x, 0); const q = pinsOf(r)[pc.nodes.indexOf(net)]; move(r, x - q.x, y - q.y); }
  };
  const placeString = (gap) => {
    stepPins.length = 0;
    let y = yA;
    for (const s of R.steps) {
      let yNext = y;
      s.parts.forEach((r, j) => {
        const x = xs - j * (Math.max(90, W) + 30), pc = comp.get(r);
        let kTop, kBot;
        const h = R.helpers.find((hh) => hh.dev === r);
        if (isAct(pc)) {
          face(r, par && j === 0 ? 'right' : 'left'); kTop = D(pc) === s.from ? 0 : 2; kBot = kTop === 0 ? 2 : 0; const q = pin(r, kTop); move(r, x - q.x, y - q.y);
          if (h) {
            // the helper diode from the node above, the device's gate level
            // with its lower end, the resistor under it
            placeH(h.parts[0], h.from, x2, y);
            const pc1 = comp.get(h.parts[0]), gy = isAct(pc1) ? pin(h.parts[0], D(pc1) === h.g ? 0 : 2).y : pinsOf(h.parts[0])[pc1.nodes.indexOf(h.g)].y;
            move(r, 0, gy - pin(r, 1).y);
            placeH(h.parts[1], h.g, x2, gy + 20);
          }
        }
        else { const k = stand(r, s.from, x, y); kTop = k.top; kBot = k.bottom; }
        stepPins.push({ r, top: kTop, bot: kBot, from: s.from, to: s.to, x });
        yNext = Math.max(yNext, pin(r, kBot).y);
      });
      y = Math.round(yNext + gap);
    }
    return y - gap;
  };
  let yB = placeString(20);
  if (R.rowA || R.rowB) { /* the rows fix the heights: no stretching */ }
  else if (yB - yA < 1.7 * H) yB = placeString(20 + (1.7 * H - (yB - yA)) / Math.max(1, R.steps.length - 1 || 1));
  if (R.steps.length === 1 && yB - yA < 1.7 * H && !R.helpers.length && !R.rowA && !R.rowB) {
    // one part: centred between the two gate heights
    const want = Math.round(1.7 * H), dy = Math.round((want - (yB - yA)) / 2);
    for (const sp of stepPins) { move(sp.r, 0, dy); for (const h of R.helpers.filter((hh) => hh.dev === sp.r)) for (const r of h.parts) move(r, 0, dy); }
    yB = yA + want;
  }
  yB = Math.round(yB);
  if (R.rowB) {
    // the driver under the string, the bottom output device on its row
    face(R.fB, 'left'); const q = pin(R.fB, 0); move(R.fB, xs - q.x, yB + 30 - q.y);
    const kO = R.kind === 'cs' ? 0 : 2, c = ctr(R.fB), b = ctr(R.bot);
    move(R.bot, pin(R.top, kO).x - pin(R.bot, kO).x, c.y - b.y);
    yB = Math.round(pin(R.fB, 0).y);
  } else { const kO = R.kind === 'cs' ? 0 : 2; move(R.bot, pin(R.top, kO).x - pin(R.bot, kO).x, yB - pin(R.bot, 1).y); }
  // helpers (a Vbe multiplier's diode and resistor): a column left of the string
  // feeders: A's over the string, B's under it (a driver's gate to the left)
  const feedAt = (ref, node, yPin, up) => {
    const pc = comp.get(ref);
    if (isAct(pc)) { face(ref, 'left'); const k = D(pc) === node ? 0 : 2, q = pin(ref, k), c = find(ref); move(ref, xs - q.x, yPin - q.y); void c; }
    else {
      const other = pc.nodes.slice(0, 2).find((x) => x !== node);
      if (up) { stand(ref, other, xs, yPin - Math.max(find(ref).w, find(ref).h)); const q = pinsOf(ref)[pc.nodes.indexOf(node)]; move(ref, xs - q.x, yPin - q.y); }
      else stand(ref, node, xs, yPin);
    }
  };
  if (R.fA && !R.rowA) feedAt(R.fA, R.A, yA - 40, true);
  // (under the multiplier's resistor too: it joins the B column above the feeder)
  const yLow = Math.max(yB, ...R.helpers.map((h) => { const pc = comp.get(h.parts[1]); return isAct(pc) ? pin(h.parts[1], D(pc) === h.to ? 0 : 2).y : pinsOf(h.parts[1])[pc.nodes.indexOf(h.to)].y; }));
  if (R.fB && !R.rowB) feedAt(R.fB, R.B, Math.round(yLow + 40), false);
  // loads on the output: standing on the output line, right of the stage
  const kOut = R.kind === 'cs' ? 0 : 2;
  const yOut = Math.round((pin(R.top, kOut).y + pin(R.bot, kOut).y) / 2), xOut = pin(R.top, kOut).x;
  R.loads.forEach((r, k) => {
    const pc = comp.get(r), o = pc.nodes.slice(0, 2).find((x) => x !== R.out);
    stand(r, R.out, Math.round(Math.max(find(R.top).x + find(R.top).w, find(R.bot).x + find(R.bot).w) + 40 + 70 * k), yOut + 24);
    // its value on its right (on the left it touched the output column)
    { const me = find(r), lbl = cells().find((x) => x.kind === 'vertex' && (String(x.id) === 'LBL_' + r || String(x.id) === 'LBL_' + me.id)); if (lbl) updateCell(model, lbl.id, { x: Math.round(me.x + me.w + 4), y: Math.round(me.y + me.h / 2 - lbl.h / 2), style: { align: 'left' } }); }
    // a load to a net of its own (a port): the port under its lower end
    const port = !RAIL.test(o) && cells().find((v) => v.kind === 'vertex' && classify(v).role === 'port' && String(classify(v).net || v.value || '').trim().toLowerCase() === String(o).toLowerCase());
    if (port) { const q = pinsOf(r)[pc.nodes.indexOf(o)]; updateCell(model, port.id, { x: Math.round(q.x + 30), y: Math.round(q.y + 30 - port.h / 2), style: { flipH: 1, rotation: null, drawioApiTemplatePort: 1, drawioApiPinned: 1 } }); R.loadPorts = [...(R.loadPorts || []), { r, port: port.id, k: pc.nodes.indexOf(o) }]; }
  });
  R.geo = { xs, x2, yA, yB, yOut, xOut, kOut };
  const tpl = [...R.used];
  const att = new Set(attachPassives(model, parsed, tpl).attached);
  // parts outside the template now overlapping it go to its left (the stage
  // is an output: what drives it comes from the left)
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
  // the output: the two output devices joined straight
  {
    const a = P(R.top, kOut), b = P(R.bot, kOut);
    if (Math.abs(pinAbs(...a).x - pinAbs(...b).x) < 0.5) { reroute.push(...moveWires(model, b[0], b[1], a[0], a[1])); dropAmong(model, [a, b]); wire(model, b, a); }
  }
  // the gate nodes: a straight line from the string's column to each gate
  const nodePin = (net) => {   // the string pin on this node nearest the column's axis
    const c = stepPins.find((s) => s.from === net) || stepPins.find((s) => s.to === net);
    if (!c) return null;
    return P(c.r, c.from === net ? c.top : c.bot);
  };
  for (const [net, dev, row, f] of [[R.A, R.top, R.rowA, R.fA], [R.B, R.bot, R.rowB, R.fB]]) {
    const np = nodePin(net), g = P(dev, 1); if (!np) continue;
    const gy = pinAbs(...g).y, pn = pinAbs(...np);
    reroute.push(...moveWires(model, g[0], g[1], np[0], np[1]));
    if (row) {
      // the feeder on the gate's row: down (up) beside it, then across to the node
      const xk = Math.round((F(f).x + F(f).w + F(dev).x) / 2);
      wire(model, g, np, [{ x: xk, y: gy }, { x: xk, y: pn.y }]);
      // the feeder's drain straight onto the string
      const fd = P(f, 0); reroute.push(...moveWires(model, fd[0], fd[1], np[0], np[1])); wire(model, fd, np);
    } else wire(model, g, np, [{ x: pn.x, y: gy }]);
  }
  // a diode-connected device in the string: its gate tied to its drain beside it
  for (const sp of stepPins) {
    const pc = comp.get(sp.r); if (!isAct(pc) || G(pc) !== D(pc)) continue;
    const g = P(sp.r, 1), d = P(sp.r, 0), pg = pinAbs(...g), pd = pinAbs(...d), up = pd.y < pg.y ? -1 : 1;
    const xo = Math.round(pg.x + (pg.x < pd.x ? -15 : 15)), yo = Math.round(pd.y + up * 15);
    reroute.push(...moveWires(model, g[0], g[1], d[0], d[1]));
    wire(model, g, d, [{ x: xo, y: pg.y }, { x: xo, y: yo }, { x: pd.x, y: yo }]);
  }
  // the string: each step's parts joined straight down the column
  for (let i = 0; i + 1 < stepPins.length; i++) {
    const u = stepPins[i], v = stepPins.find((s) => s.from === u.to && s.x === u.x);
    if (!v) continue;
    const a = P(u.r, u.bot), b = P(v.r, v.top);
    reroute.push(...moveWires(model, b[0], b[1], a[0], a[1])); dropAmong(model, [a, b]);
    wire(model, b, a);
  }
  // a Vbe multiplier: the device's gate straight to the diode's lower end,
  // the resistor under it
  for (const h of R.helpers) {
    const pc1 = comp.get(h.parts[0]), pc2 = comp.get(h.parts[1]);
    const k1 = isAct(pc1) ? (D(pc1) === h.g ? 0 : 2) : pc1.nodes.indexOf(h.g), k2 = isAct(pc2) ? (D(pc2) === h.g ? 0 : 2) : pc2.nodes.indexOf(h.g);
    const g = P(h.dev, 1), p1 = P(h.parts[0], k1), p2 = P(h.parts[1], k2);
    if (Math.abs(pinAbs(...g).y - pinAbs(...p1).y) > 0.5) continue;
    reroute.push(...moveWires(model, g[0], g[1], p1[0], p1[1]), ...moveWires(model, p2[0], p2[1], p1[0], p1[1]));
    wire(model, g, p1);
    wire(model, p2, p1);
    // the resistor's lower end across to the device's lower end (the B column)
    const kt = isAct(pc2) ? (D(pc2) === h.to ? 0 : 2) : pc2.nodes.indexOf(h.to), sp = stepPins.find((x) => x.r === h.dev);
    if (sp) {
      const q2 = P(h.parts[1], kt), qd = P(h.dev, sp.bot), y2 = pinAbs(...q2).y;
      reroute.push(...moveWires(model, q2[0], q2[1], qd[0], qd[1]));
      wire(model, q2, qd, [{ x: pinAbs(...qd).x, y: y2 }]);
    }
  }
  // the output line: loads teeing down from it, the output port beyond
  {
    const { yOut } = R.geo, a = P(R.top, kOut);
    let xr = Math.max(F(R.top).x + F(R.top).w, F(R.bot).x + F(R.bot).w);
    for (const r of R.loads) {
      const C = F(r), k = comp.get(r).nodes.indexOf(R.out), rel = activePins(classify(C))[k], at = pinAbs(C, rel);
      reroute.push(...moveWires(model, C, rel, a[0], a[1]));
      wire(model, [C, rel], a, [{ x: at.x, y: yOut }, { x: R.geo.xOut, y: yOut }]);
      xr = Math.max(xr, C.x + C.w);
    }
    const port = cells().find((v) => v.kind === 'vertex' && classify(v).role === 'port' && String(classify(v).net || v.value || '').trim().toLowerCase() === String(R.out).toLowerCase());
    if (port) {
      for (const e of cells().filter((e) => e.kind === 'edge' && (e.source === port.id || e.target === port.id))) {
        const [oid, oend] = e.source === port.id ? [e.target, 'entry'] : [e.source, 'exit'];
        const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
        deleteCell(model, e.id);
        if (oid !== a[0].id && !R.loads.some((r) => F(r).id === oid) && oid !== F(R.bot).id) reroute.push(addWire(model, { source: oid, target: a[0].id, sourcePin: orel, targetPin: a[1], style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }).getAttribute('id'));
      }
      updateCell(model, port.id, { x: Math.round(xr + 40), y: Math.round(yOut - port.h / 2), style: { flipH: 1, drawioApiTemplatePort: 1, drawioApiPinned: 1 } });
      const Pc = cells().find((c) => c.id === port.id);
      const anchor = pinAbs(Pc, { x: 1, y: 0.5 }).x < pinAbs(Pc, { x: 0, y: 0.5 }).x ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 };
      wire(model, [Pc, anchor], a, [{ x: R.geo.xOut, y: yOut }]);
    }
  }
  for (const lp of R.loadPorts || []) {
    const C = F(lp.r), rel = activePins(classify(C))[lp.k], at = pinAbs(C, rel), Pc = cells().find((c) => c.id === lp.port);
    for (const e of cells().filter((e) => e.kind === 'edge' && (e.source === lp.port || e.target === lp.port))) deleteCell(model, e.id);
    const anchor = pinAbs(Pc, { x: 1, y: 0.5 }).x < pinAbs(Pc, { x: 0, y: 0.5 }).x ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 };
    wire(model, [Pc, anchor], [C, rel], [{ x: at.x, y: Math.round(pinAbs(Pc, anchor).y) }]);
  }
  // the ports on A and B: left of the columns, on the node's line
  for (const [net, yN] of [[R.A, R.geo.yA], [R.B, R.geo.yB]]) {
    const np = stepPins.find((s) => s.from === net) || stepPins.find((s) => s.to === net); if (!np) continue;
    const pp = P(np.r, np.from === net ? np.top : np.bot), pa = pinAbs(pp[0], pp[1]);
    const port = cells().find((v) => v.kind === 'vertex' && classify(v).role === 'port' && String(classify(v).net || v.value || '').trim().toLowerCase() === String(net).toLowerCase());
    if (!port) continue;
    reroute.push(...moveWires(model, port, { x: 0, y: 0.5 }, pp[0], pp[1]));
    reroute.push(...moveWires(model, port, { x: 1, y: 0.5 }, pp[0], pp[1]));
    for (const e of cells().filter((e) => e.kind === 'edge' && (e.source === port.id || e.target === port.id))) deleteCell(model, e.id);
    const xl = Math.min(R.geo.xs, R.helpers.length ? R.geo.x2 : R.geo.xs) - 60 - port.w;
    updateCell(model, port.id, { x: Math.round(xl), y: Math.round(yN - port.h / 2), style: { flipH: null, drawioApiTemplatePort: 1, drawioApiPinned: 1 } });
    let Pc = cells().find((c) => c.id === port.id);
    const anchor = pinAbs(Pc, { x: 1, y: 0.5 }).x > pinAbs(Pc, { x: 0, y: 0.5 }).x ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 };
    { const dy = Math.round(yN - pinAbs(Pc, anchor).y); if (dy) { updateCell(model, port.id, { dy }); Pc = cells().find((c) => c.id === port.id); } }   // its tip exactly on the line
    wire(model, [Pc, anchor], pp, Math.abs(pa.y - yN) > 0.5 ? [{ x: pa.x, y: yN }] : []);
  }
  if (reroute.length) await routePage(model, reroute, {});
  await alignPorts(model);
  for (const v of cells().filter((c) => c.kind === 'vertex' && c.style.map.get('drawioApiTemplatePort') === '1')) updateCell(model, v.id, { style: { drawioApiPinned: 1 } });
  alignRails(model);
  for (const r of R.used) { const c = find(r); if (c) updateCell(model, c.id, { style: { drawioApiPinned: 1 } }); }
  rebuildLocalDots(model);
}

/** A template wire; two pins on one horizontal (vertical) drawn straight —
 *  an orthogonal wire with no waypoint leaves a bottom pin downwards first
 *  (a 10-25 px step on the drawing). */
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
