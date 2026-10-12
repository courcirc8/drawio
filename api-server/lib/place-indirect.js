/**
 * place-indirect.js — engine "indirect": the two-stage OTA with INDIRECT
 * compensation (Ahuja), the compensation capacitor fed back from the output
 * into a low-impedance node instead of the first stage's output (Eric's list,
 * 2026-10-12, first template of the batch). Two forms are read:
 *
 *   buffer   — a common-gate device (Ahuja's current buffer) between the
 *              capacitor and the first output: textbook drawing (Johns &
 *              Martin), the buffer right of the input pair, on its row, its
 *              source node joined to the output by Cc on one line, its drain
 *              dropping onto the first output's line, which runs on to the
 *              second stage's gate;
 *   cascode  — the first stage's load cascoded, Cc from the output into the
 *              cascode's source on the output side: the input pair, the
 *              cascodes and the mirror stacked in two columns, Cc on one line
 *              at that node's height out to the output column (it crosses the
 *              second stage's gate line once, as in the textbook figure).
 *
 *         tail                       │
 *     iA ─┤   ├─ iB      [mg]─┤VB   load
 *      │       │           │   ├─Cc──┤──── OUT
 *    [cA]─VB─[cB]──X──Cc───┼───┘     │
 *      │       │           └─────┤ m6
 *     mA ─┤├─ mB                     │
 * (PMOS input as drawn; an NMOS input pair is the same picture upside down.)
 *
 * Positions imposed exactly in pixels, as lib/place-ota.js; the passives
 * around are attached to their nodes (lib/template-attach.js). Taken by auto
 * only when it does at least as well as the other candidates (quality gate);
 * AUTO_INDIRECT=0 disables.
 */
import { detectStructures, isPmosLike } from './patterns.js';
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell, addWire, deleteCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';
import { alignPorts } from './align-ports.js';
import { attachPassives } from './template-attach.js';
import { teeNet, mirrorNet, biasNet, alignRails, dropAmong, STF, relPin, atPin } from './place-ota.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];
const isMos = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';

/** The reading, or null. */
export function indirectReading(parsed) {
  let st; try { st = detectStructures(parsed); } catch { return null; }
  const comps = parsed.components;
  for (const dp of st.diffPairs) {
    const [p, q] = dp.refs.map((r) => comps.find((c) => c.ref === r));
    if (!p || !q || st.crossCoupled.some((cc) => cc.refs.includes(p.ref) || cc.refs.includes(q.ref))) continue;
    const pIn = isPmosLike(p), other = (c) => isMos(c) && isPmosLike(c) !== pIn && c !== p && c !== q;
    // each side's load: [cascode] then the mirror device (source on a rail)
    const load = (x, casc) => {
      const c = casc ? comps.find((y) => other(y) && D(y) === D(x) && !RAIL.test(S(y)) && !RAIL.test(G(y))) : null;
      if (casc && !c) return null;
      const m = comps.find((y) => other(y) && y !== c && D(y) === (c ? S(c) : D(x)) && RAIL.test(S(y)));
      return m ? { c, m } : null;
    };
    for (const casc of [true, false]) {
      const lp = load(p, casc), lq = load(q, casc);
      if (!lp || !lq || lp.m === lq.m || G(lp.m) !== G(lq.m) || (casc && (lp.c === lq.c || G(lp.c) !== G(lq.c)))) continue;
      // the diode side: the mirror's gate on its input drain (low-voltage
      // cascode mirror) or on its own drain
      const isDiode = (x, l) => G(l.m) === D(x) || G(l.m) === D(l.m);
      const [iA, lA, iB, lB] = isDiode(p, lp) ? [p, lp, q, lq] : isDiode(q, lq) ? [q, lq, p, lp] : [];
      if (!iA || isDiode(iB, lB)) continue;
      const used = new Set([p, q, lp.m, lq.m, lp.c, lq.c].filter(Boolean).map((c) => c.ref));
      const out = D(iB);
      // the second stage: common source on the first output, source on a rail
      const m6 = comps.find((c) => !used.has(c.ref) && isMos(c) && isPmosLike(c) !== pIn && G(c) === out && RAIL.test(S(c)));
      if (!m6) continue;
      const out2 = D(m6);
      // the compensation: Cc (maybe with Rz in series) from the second output
      // to X — the output-side cascode's source, or the source of a
      // common-gate buffer whose drain is the first output
      const xNode = (n) => {
        if (casc && n === S(lB.c)) return { kind: 'cascode' };
        const mg = comps.find((c) => !used.has(c.ref) && c !== m6 && isMos(c) && isPmosLike(c) === pIn && S(c) === n && D(c) === out && !RAIL.test(G(c)));
        return mg ? { kind: 'buffer', mg } : null;
      };
      let comp = null;
      for (const c of comps.filter((x) => x.prefix === 'C' && !used.has(x.ref))) {
        const [a, b] = c.nodes;
        const far = a === out2 ? b : b === out2 ? a : null;
        if (far != null) { const k = xNode(far); if (k) { comp = { cc: c, x: far, ...k }; break; } continue; }
        // C + R in series through one node: either order
        for (const [cn, rn] of [[a, b], [b, a]]) {
          const r = comps.find((y) => y.prefix === 'R' && !used.has(y.ref) && y.nodes.includes(rn) && (y.nodes.includes(out2) || false) && y.nodes.length >= 2);
          if (r) { const k = xNode(cn); if (k && cn !== rn) { comp = { cc: c, rz: r, x: cn, ...k }; break; } }
          const r2 = comps.find((y) => y.prefix === 'R' && !used.has(y.ref) && y.nodes.includes(cn) && !y.nodes.includes(out2));
          if (r2 && rn === out2) { const far2 = r2.nodes.find((n) => n !== cn); const k = xNode(far2); if (k) { comp = { cc: c, rz: r2, x: far2, ...k }; break; } }
        }
        if (comp) break;
      }
      if (!comp || (comp.kind === 'cascode') !== casc) continue;
      used.add(m6.ref); used.add(comp.cc.ref); if (comp.rz) used.add(comp.rz.ref); if (comp.mg) used.add(comp.mg.ref);
      // the second stage's load: a device of the pair's polarity, or a
      // resistor / current source to a rail
      const m7 = comps.find((c) => !used.has(c.ref) && isMos(c) && isPmosLike(c) === pIn && D(c) === out2 && RAIL.test(S(c)));
      if (m7) used.add(m7.ref);
      const ld = m7 ? null : comps.find((c) => !used.has(c.ref) && ['R', 'I'].includes(c.prefix) && c.nodes.includes(out2) && c.nodes.some((n) => n !== out2 && RAIL.test(n) && n !== S(m6)));
      if (ld) used.add(ld.ref);
      // the tail, its bias diode and reference (as lib/place-ota.js)
      const tail = comps.find((c) => !used.has(c.ref) && (isMos(c) ? D(c) === S(p)
        : ['I', 'R'].includes(c.prefix) && c.nodes.includes(S(p)) && c.nodes.some((n) => n !== S(p) && RAIL.test(n))));
      if (tail) used.add(tail.ref);
      const bias = tail && isMos(tail) ? comps.find((c) => !used.has(c.ref) && isMos(c) && G(c) === G(tail) && D(c) === G(c) && isPmosLike(c) === isPmosLike(tail)) : null;
      if (bias) used.add(bias.ref);
      const ref = bias ? comps.find((c) => !used.has(c.ref) && ['I', 'R'].includes(c.prefix) && c.nodes.includes(D(bias)) && c.nodes.some((n) => n !== D(bias) && RAIL.test(n))) : null;
      if (ref) used.add(ref.ref);
      return {
        kind: comp.kind, pmosIn: pIn, iA: iA.ref, iB: iB.ref, mA: lA.m.ref, mB: lB.m.ref, cA: lA.c?.ref, cB: lB.c?.ref,
        mg: comp.mg?.ref, m6: m6.ref, m7: m7?.ref, load: ld?.ref, loadPin: ld ? ld.nodes.indexOf(out2) : null, cc: comp.cc.ref, rz: comp.rz?.ref,
        tail: tail?.ref, tailK: tail ? tail.nodes.indexOf(S(p)) : null, bias: bias?.ref, ref: ref?.ref, out, out2, x: comp.x, used,
        // the second stage's load device biased from the tail's gate: its gate
        // wire is drawn over the tail (a straight line ran through it)
        m7Tail: !!(m7 && tail && isMos(tail) && G(m7) === G(tail)),
      };
    }
  }
  return null;
}

/** place-sa's start, in units of the median part size. */
export function indirectLayout(parsed, R) {
  const C = 2, W = 1.8, u = R.pmosIn ? 1 : -1, k = R.cA ? 2 : 1;
  const pos = new Map(), put = (r, x, y) => { if (r) pos.set(r, { x, y }); };
  put(R.iA, 0, 0); put(R.iB, C, 0);
  put(R.cA, 0, u * W); put(R.cB, C, u * W);
  put(R.mA, 0, u * W * k); put(R.mB, C, u * W * k);
  put(R.tail, C / 2, -u * W); put(R.bias, -C / 2, -u * W); put(R.ref, -C / 2, 0);
  put(R.mg, 2 * C, 0);
  const x6 = R.mg ? 3 * C : 2 * C + 0.5;
  put(R.m6, x6, u * W * k); put(R.m7, x6, -u * W); put(R.load, x6, -u * W);
  let n = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: x6 + C + C * n++, y: 0 });
  return pos;
}

export async function importNetlistIndirect(model, parsed, opts = {}) {
  const R = indirectReading(parsed);
  if (!R) throw new Error('indirect: no two-stage OTA with indirect compensation');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: indirectLayout(parsed, R), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await impose(model, parsed, R);
  return placed;
}

async function impose(model, parsed, R) {
  const cells = () => allCells(model).map(cellInfo);
  const find = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const pinsOf = (r) => { const c = find(r); return activePins(classify(c)).map((p) => pinAbs(c, p)); };
  const drain = (r) => pinsOf(r)[0], gate = (r) => pinsOf(r)[1], source = (r) => pinsOf(r)[2];
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
    const c = find(ref), g = gate(ref), mid = c.x + c.w / 2;
    if ((side === 'left') !== (g.x < mid)) updateCell(model, c.id, { style: { flipH: String(c.style.map.get('flipH') || '0') === '1' ? null : 1 } });
  };
  const u = R.pmosIn ? 1 : -1, s = -u;   // u: from the pair towards the mirror (screen y)
  face(R.iA, 'left'); face(R.iB, 'right'); face(R.mA, 'right'); face(R.mB, 'left');
  face(R.cA, 'right'); face(R.cB, 'left');
  // the tail's gate towards its bias diode (left); with no diode but the
  // second stage's load on the same gate, towards that load (one straight line)
  if (R.bias) { face(R.bias, 'right'); face(R.tail, 'left'); } else if (R.m7Tail) face(R.tail, 'right');
  face(R.mg, 'left'); face(R.m6, 'left'); face(R.m7, 'left');
  const core = [R.iA, R.iB, R.mA, R.mB];
  const H = Math.max(...core.map((r) => find(r).h)), W = Math.max(...core.map((r) => find(r).w));
  const ROW = Math.round(1.7 * H), TROW = R.m7Tail ? Math.round(ROW + 0.5 * H) : ROW;   // room over the tail for the load's gate wire
  const a = ctr(R.iA);
  // the pair: room between the columns for the mirror's diode link and, with
  // cascodes, the cascodes' bias port above their gate line
  const b = ctr(R.iB); move(R.iB, a.x + (R.cA ? Math.max(3 * W + 140, 250) : Math.max(3 * W + 80, 170)) - b.x, a.y - b.y);
  // each column: [cascode] then mirror, drains straight under the input drains
  const yM = a.y + u * ROW * (R.cA ? 2 : 1);
  for (const [i, c, m] of [[R.iA, R.cA, R.mA], [R.iB, R.cB, R.mB]]) {
    let top = drain(i).x;
    if (c) { const cc = ctr(c); move(c, top - drain(c).x, a.y + u * ROW - cc.y); top = source(c).x; }
    const mc = ctr(m); move(m, top - drain(m).x, yM - mc.y);
  }
  if (R.tail) {
    const t = ctr(R.tail), mid = (source(R.iA).x + source(R.iB).x) / 2;
    move(R.tail, mid - pinsOf(R.tail)[R.tailK].x, a.y - u * TROW - t.y);
    if (R.bias) {
      const bb = ctr(R.bias), want = Math.min(gate(R.tail).x - Math.max(1.6 * W, 110), gate(R.iA).x - 150 - (gate(R.bias).x - drain(R.bias).x));
      move(R.bias, want - gate(R.bias).x, a.y - u * TROW - bb.y);
      if (R.ref) {
        const F = find(R.ref), ps = activePins(classify(F)).map((q) => pinAbs(F, q));
        const near = ps.reduce((v, w) => (s * w.y > s * v.y ? w : v));
        move(R.ref, drain(R.bias).x - near.x, (drain(R.bias).y - s * 40) - near.y);
      }
    }
  }
  // right of the first stage: [the buffer, on the pair's row, far enough for
  // the input port and its own bias port between], then the second stage on
  // the mirror's row, its load straight over (under) its drain
  const xr = () => Math.max(...[R.iB, R.mB, R.cB].filter(Boolean).map((r) => find(r).x + find(r).w));
  let left = xr();
  if (R.mg) {
    const g = ctr(R.mg);
    move(R.mg, gate(R.iB).x + 250 - gate(R.mg).x, a.y - g.y);
    left = find(R.mg).x + find(R.mg).w;
  }
  const chainW = [R.cc, R.rz].filter(Boolean).reduce((t, r) => t + Math.max(find(r).w, find(r).h) + 50, 0);
  {
    const c6 = ctr(R.m6), room = R.mg ? 130 + chainW : Math.max(2.6 * W, 120 + chainW);
    move(R.m6, left + room - find(R.m6).x, yM - c6.y);
  }
  if (R.m7) { const c7 = ctr(R.m7); move(R.m7, drain(R.m6).x - drain(R.m7).x, a.y - u * TROW - c7.y); }
  // biased from the tail's gate: its gate level with the tail's edge facing
  // the pair, the gate wire then crosses over the tail in one L
  if (R.m7Tail && R.bias) { const T = find(R.tail), yk = s > 0 ? T.y - 14 : T.y + T.h + 14; move(R.m7, 0, yk - gate(R.m7).y); }
  // the X node's height: the compensation line
  const yX = R.cA ? Math.round((source(R.cB).y + drain(R.mB).y) / 2) : Math.round(source(R.mg).y - u * 22);
  // the passives around, Cc (+ Rz) lying on the X line between X and the output
  const tplRefs = [R.iA, R.iB, R.mA, R.mB, R.cA, R.cB, R.mg, R.m6, R.m7, R.tail, R.bias, R.ref].filter(Boolean);
  const att = new Set(attachPassives(model, parsed, tplRefs, { across: [R.cc, R.rz].filter(Boolean), acrossY: yX }).attached);
  // the second stage's passive load: upright, straight over (under) the drain
  if (R.load) {
    const L = find(R.load), pc = parsed.components.find((c) => c.ref === R.load), k = pc.nodes.indexOf(R.out2);
    const ps = activePins(classify(L)).map((q) => pinAbs(L, q));
    if (k >= 0 && ps.length === 2 && Math.abs(ps[0].x - ps[1].x) < 1) move(R.load, drain(R.m6).x - ps[k].x, yX - u * 40 - ps[k].y);
    att.add(R.load);
  }
  // the output line: on the longest free stretch of the output column; load
  // capacitors (output to a rail) stand on it to the right, the port beyond
  const GNDN = /^(0|gnd\w*|vss\w*|vee\w*|avss|dvss)$/i;
  const stand = (ref, net, x, y, down) => {   // upright, pin on `net` at (x, y), the other end down / up
    const c0 = find(ref), pc = parsed.components.find((c) => c.ref === ref), k = pc.nodes.indexOf(net);
    for (const rot of [0, 90, 180, 270]) {
      updateCell(model, c0.id, { style: { rotation: rot || null, flipV: null, flipH: null } });
      const ps = pinsOf(ref);
      if (ps.length === 2 && Math.abs(ps[0].x - ps[1].x) < 1 && (down ? ps[k].y < ps[1 - k].y : ps[k].y > ps[1 - k].y)) break;
    }
    const q = pinsOf(ref)[k]; move(ref, x - q.x, y - q.y);
  };
  const two = (c) => ['R', 'C', 'L', 'I', 'V'].includes(c.prefix) && c.nodes.length >= 2 && !R.used.has(c.ref);
  const yP = (() => {
    const ys = [drain(R.m6).y, yX, ...(R.m7 ? [drain(R.m7).y] : []), ...(R.load ? [pinsOf(R.load)[R.loadPin].y] : [])].sort((p, q) => p - q);
    let best = { g: -1, y: drain(R.m6).y - u * 30 };
    for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > best.g) best = { g: ys[i] - ys[i - 1], y: Math.round((ys[i] + ys[i - 1]) / 2) };
    return best.y;
  })();
  const caps = parsed.components.filter((c) => two(c) && c.nodes.slice(0, 2).includes(R.out2) && RAIL.test(c.nodes.slice(0, 2).find((n) => n !== R.out2) || ''));
  caps.forEach((c, k) => { const down = GNDN.test(c.nodes.slice(0, 2).find((n) => n !== R.out2)); stand(c.ref, R.out2, Math.round(drain(R.m6).x + 70 + 70 * k), yP + (down ? 24 : -24), down); att.add(c.ref); });
  // the buffer's bias source on X (to a rail beyond it): straight beyond its source
  if (R.mg) for (const c of parsed.components.filter((c) => two(c) && c.nodes.slice(0, 2).includes(R.x) && RAIL.test(c.nodes.slice(0, 2).find((n) => n !== R.x) || ''))) {
    const down = GNDN.test(c.nodes.slice(0, 2).find((n) => n !== R.x));
    if (down !== (-u > 0)) continue;   // its rail on the far side of the buffer
    stand(c.ref, R.x, source(R.mg).x, yX - u * 30, down); att.add(c.ref); break;
  }
  R.caps = caps.map((c) => c.ref); R.yP = yP;
  // parts outside the template now overlapping it go to its right
  {
    const tpl = tplRefs.map(find);
    const box = { x0: Math.min(...tpl.map((c) => c.x)) - 60, x1: Math.max(...tpl.map((c) => c.x + c.w)) + 60, y0: Math.min(...tpl.map((c) => c.y)) - 30, y1: Math.max(...tpl.map((c) => c.y + c.h)) + 30 };
    let x = box.x1 + 60;
    const others = cells().filter((c) => c.kind === 'vertex' && classify(c).role === 'component' && !R.used.has(String(c.refdes || '')) && !att.has(String(c.refdes || ''))).sort((p, q) => p.x - q.x);
    for (const c0 of others) {
      const c = find(String(c0.refdes));
      if (!(c.x < box.x1 && c.x + c.w > box.x0 && c.y < box.y1 && c.y + c.h > box.y0)) continue;
      const free = (xx) => !cells().some((o) => o.kind === 'vertex' && o.id !== c.id && classify(o).role === 'component' && o.x < xx + c.w + 30 && o.x + o.w + 30 > xx && o.y < c.y + c.h && o.y + o.h > c.y);
      while (!free(x)) x += 40;
      move(String(c.refdes), x - c.x, 0);
      x += c.w + 60;
    }
  }
  // every wire routed again, then the template's nets drawn on purpose
  const ids = cells().filter((c) => c.kind === 'edge').map((e) => e.id);
  for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
  await routePage(model, ids, {});
  const F = (r) => find(r);
  if (R.tail) teeNet(model, F(R.iA), F(R.iB), F(R.tail), s, R.tailK);
  if (R.cA) cascodeColumns(model, R, F, s); else mirrorNet(model, F(R.iA), F(R.mA), F(R.mB), s);
  const yO = R.cA ? Math.round((drain(R.iB).y + drain(R.cB).y) / 2) : Math.round((drain(R.iB).y + drain(R.mB).y) / 2);
  const reroute = firstOutput(model, R, F, yO);
  reroute.push(...secondOutput(model, R, F, yX));
  if (R.m7Tail) reroute.push(...loadGate(model, R, F, s));
  reroute.push(...compLine(model, R, F, yX));
  if (reroute.length) await routePage(model, reroute, {});
  if (R.bias && R.tail) biasNet(model, F(R.bias), F(R.tail), R.ref && F(R.ref), s);
  await alignPorts(model);
  alignRails(model);
  // the ports this template placed stay put (the straightening pass slid the
  // cascodes' bias port off its stem onto the line)
  for (const v of cells().filter((c) => c.kind === 'vertex' && c.style.map.get('drawioApiIndirect') === '1')) updateCell(model, v.id, { style: { drawioApiPinned: 1 } });
  for (const r of [...R.used, ...(R.caps || [])]) { const c = find(r); if (c) updateCell(model, c.id, { style: { drawioApiPinned: 1 } }); }
  rebuildLocalDots(model);
}

/** The cascoded columns: input drain → cascode drain → (X) → mirror drain,
 *  straight; the mirror's gate line and the cascodes' bias line between the
 *  columns; the diode link from the input node (A side) down (up) to the
 *  middle of the mirror's gate line; the bias port over its line, on a stem. */
function cascodeColumns(model, R, F, s) {
  const IA = F(R.iA), IB = F(R.iB), CA = F(R.cA), CB = F(R.cB), MA = F(R.mA), MB = F(R.mB);
  const p = (c, k) => pinAbs(c, relPin(c, k));
  if (Math.abs(p(IA, 0).x - p(CA, 0).x) > 0.5 || Math.abs(p(CA, 2).x - p(MA, 0).x) > 0.5 || Math.abs(p(MA, 1).y - p(MB, 1).y) > 0.5 || Math.abs(p(CA, 1).y - p(CB, 1).y) > 0.5) return;
  const pins = [[IA, relPin(IA, 0)], [CA, relPin(CA, 0)], [CA, relPin(CA, 2)], [MA, relPin(MA, 0)], [MA, relPin(MA, 1)], [MB, relPin(MB, 1)],
    [IB, relPin(IB, 0)], [CB, relPin(CB, 0)], [CB, relPin(CB, 2)], [MB, relPin(MB, 0)], [CA, relPin(CA, 1)], [CB, relPin(CB, 1)]];
  // the bias port of the cascodes, if it is wired to them alone
  const port = soloPort(model, [[CA, relPin(CA, 1)], [CB, relPin(CB, 1)]]);
  if (port) for (const e of allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && (e.source === port.id || e.target === port.id))) deleteCell(model, e.id);
  dropAmong(model, pins);
  const w = (A, ka, B, kb, points = []) => addWire(model, { source: A.id, target: B.id, sourcePin: relPin(A, ka), targetPin: relPin(B, kb), style: STF, points });
  w(IA, 0, CA, 0); w(CA, 2, MA, 0); w(IB, 0, CB, 0); w(CB, 2, MB, 0);
  w(MA, 1, MB, 1); w(CA, 1, CB, 1);
  // the diode link: from just past the A input drain into the middle, then
  // straight to the mirror's gate line (it crosses the cascodes' bias line)
  // (left of the middle when the bias port takes the right half)
  const dI = p(IA, 0), gM = p(MA, 1), gC = p(CA, 1), xm = Math.round((gM.x + p(MB, 1).x) / 2 - (port ? Math.min(40, (p(MB, 1).x - gM.x) / 6) : 0));
  const yn = Math.round(dI.y - s * 16);
  w(IA, 0, MB, 1, [{ x: dI.x, y: yn }, { x: xm, y: yn }, { x: xm, y: gM.y }]);
  if (port) stemPort(model, port, [[CA, relPin(CA, 1)], [CB, relPin(CB, 1)]], Math.round((xm + p(CB, 1).x) / 2 + 10), gC.y, s);
}

/** The port whose wires all end on these pins, or null. */
function soloPort(model, pins) {
  const cs = allCells(model).map(cellInfo), edges = cs.filter((e) => e.kind === 'edge');
  const on = (e) => pins.some(([c, r]) => atPin(e, 'exit', c, r) || atPin(e, 'entry', c, r));
  return cs.find((v) => v.kind === 'vertex' && classify(v).role === 'port' && (() => { const es = edges.filter((e) => e.source === v.id || e.target === v.id); return es.length && es.every(on); })()) || null;
}

/** A port on a stem off a horizontal line at height y (dir +1: under it),
 *  wired to each of these pins (the stem shared): pinned by the template. */
function stemPort(model, port, pins, x, y, dir) {
  const ys = Math.round(y + dir * 40);
  updateCell(model, port.id, { x: Math.round(x - port.w / 2), y: Math.round(ys - port.h / 2), style: { flipH: null, rotation: null, drawioApiIndirect: 1 } });
  const P = allCells(model).map(cellInfo).find((c) => c.id === port.id);
  const end = { x: 0.5, y: dir > 0 ? 0 : 1 }, tip = pinAbs(P, end);
  for (const [c, r] of pins) addWire(model, { source: port.id, target: c.id, sourcePin: end, targetPin: r, style: STF, points: [{ x: tip.x, y }] });
}

/** The first output: one line from the B input drain to the second stage's
 *  gate column (just left of its gate), down (up) to the gate; the buffer's
 *  drain drops onto that line. Other wires of the node are joined to the B
 *  input drain and routed again (returned). */
function firstOutput(model, R, F, yO) {
  const IB = F(R.iB), M6 = F(R.m6), MG = R.mg && F(R.mg), dI = relPin(IB, 0), g6 = relPin(M6, 1);
  const pdI = pinAbs(IB, dI), pg = pinAbs(M6, g6);
  const reroute = [];
  // wires on the gate (and the buffer's drain) are redrawn; whatever else they
  // reached is joined to the input drain
  const ends = [[M6, g6], ...(MG ? [[MG, relPin(MG, 0)]] : [])];
  for (const e of allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && ends.some(([c, r]) => atPin(e, 'exit', c, r) || atPin(e, 'entry', c, r)))) {
    const mine = ends.find(([c, r]) => atPin(e, 'exit', c, r)) ? 'exit' : 'entry';
    const [oid, oend] = mine === 'exit' ? [e.target, 'entry'] : [e.source, 'exit'];
    const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
    deleteCell(model, e.id);
    if (ends.some(([c, r]) => c.id === oid && Math.abs(r.x - orel.x) < 0.02 && Math.abs(r.y - orel.y) < 0.02)) continue;
    if (oid === IB.id && Math.abs(orel.x - dI.x) < 0.02 && Math.abs(orel.y - dI.y) < 0.02) continue;
    // still joined to the node through another wire? (the cascode / mirror drain)
    const linked = allCells(model).map(cellInfo).some((x) => x.kind === 'edge' && ((x.source === oid && x.target === IB.id) || (x.target === oid && x.source === IB.id)));
    if (linked && [R.cB, R.mB].some((r) => F(r)?.id === oid)) continue;
    reroute.push(addWire(model, { source: oid, target: IB.id, sourcePin: orel, targetPin: dI, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }).getAttribute('id'));
  }
  const x1 = Math.round(pg.x - 30);
  addWire(model, { source: M6.id, target: IB.id, sourcePin: g6, targetPin: dI, style: STF, points: [{ x: x1, y: pg.y }, { x: x1, y: yO }, { x: pdI.x, y: yO }] });
  if (MG) { const d = pinAbs(MG, relPin(MG, 0)); addWire(model, { source: MG.id, target: IB.id, sourcePin: relPin(MG, 0), targetPin: dI, style: STF, points: [{ x: d.x, y: yO }, { x: pdI.x, y: yO }] }); }
  return reroute;
}

/** Delete the wires on one pin; whatever else they reached (not in `skip`)
 *  is joined to another pin of the same net by a new routable wire. */
function moveWires(model, C, rel, T, trel, skip = () => false) {
  const out = [];
  for (const e of allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && (atPin(e, 'exit', C, rel) || atPin(e, 'entry', C, rel)))) {
    const [oid, oend] = atPin(e, 'exit', C, rel) ? [e.target, 'entry'] : [e.source, 'exit'];
    const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
    deleteCell(model, e.id);
    if ((oid === T.id && Math.abs(orel.x - trel.x) < 0.02 && Math.abs(orel.y - trel.y) < 0.02) || (oid === C.id && Math.abs(orel.x - rel.x) < 0.02 && Math.abs(orel.y - rel.y) < 0.02) || skip(oid, orel)) continue;   // (another pin of the same part: kept)
    out.push(addWire(model, { source: oid, target: T.id, sourcePin: orel, targetPin: trel, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }).getAttribute('id'));
  }
  return out;
}

/** The second output: drain of the second stage straight to its load; on the
 *  output line, the load capacitors teeing down (up) and the port beyond. */
function secondOutput(model, R, F, yX) {
  const M6 = F(R.m6), d6 = relPin(M6, 0), pd = pinAbs(M6, d6), reroute = [];
  const L = R.m7 ? F(R.m7) : R.load ? F(R.load) : null;
  let lrel = null;
  if (L) {
    lrel = activePins(classify(L))[R.m7 ? 0 : R.loadPin];
    const pl = pinAbs(L, lrel);
    if (Math.abs(pl.x - pd.x) < 0.5) { reroute.push(...moveWires(model, L, lrel, M6, d6)); addWire(model, { source: L.id, target: M6.id, sourcePin: lrel, targetPin: d6, style: STF, points: [] }); }
  }
  const y = R.yP;
  let xr = Math.max(M6.x + M6.w, L ? L.x + L.w : 0);
  for (const r of R.caps || []) {
    const C = F(r), k = (() => { const pc = activePins(classify(C)); return pc.findIndex((q) => Math.abs(pinAbs(C, q).y - y) < 30); })();
    if (k < 0) continue;
    const rel = activePins(classify(C))[k], at = pinAbs(C, rel);
    reroute.push(...moveWires(model, C, rel, M6, d6));
    addWire(model, { source: C.id, target: M6.id, sourcePin: rel, targetPin: d6, style: STF, points: [{ x: at.x, y }, { x: pd.x, y }] });
    xr = Math.max(xr, C.x + C.w);
  }
  const cs = allCells(model).map(cellInfo);
  const port = cs.find((v) => v.kind === 'vertex' && classify(v).role === 'port' && String(v.value || '').trim().toLowerCase() === String(R.out2).toLowerCase());
  if (!port) return reroute;
  for (const e of allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && (e.source === port.id || e.target === port.id))) {
    const [oid, oend] = e.source === port.id ? [e.target, 'entry'] : [e.source, 'exit'];
    const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
    deleteCell(model, e.id);
    if (oid !== M6.id && !(L && oid === L.id)) reroute.push(addWire(model, { source: oid, target: M6.id, sourcePin: orel, targetPin: d6, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }).getAttribute('id'));
  }
  updateCell(model, port.id, { x: Math.round(xr + 40), y: Math.round(y - port.h / 2), style: { flipH: 1, drawioApiIndirect: 1 } });
  const P = allCells(model).map(cellInfo).find((c) => c.id === port.id);
  const anchor = pinAbs(P, { x: 1, y: 0.5 }).x < pinAbs(P, { x: 0, y: 0.5 }).x ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 };
  addWire(model, { source: port.id, target: M6.id, sourcePin: anchor, targetPin: d6, style: STF, points: [{ x: pd.x, y }] });
  return reroute;
}

/** The load's gate on the tail's bias: its gate level with the tail's edge
 *  facing the pair, one line over (under) the tail, down (up) onto the tail's
 *  gate line (a straight wire at the gate height ran through the tail). */
function loadGate(model, R, F, s) {
  const M7 = F(R.m7), T = F(R.tail), g7 = relPin(M7, 1), gT = relPin(T, 1);
  const p7 = pinAbs(M7, g7), pT = pinAbs(T, gT);
  if (!R.bias) {
    // no bias diode: the tail faces the load, one straight line between the
    // gates, the bias port (wired to these gates alone) on a stem under it
    if (Math.abs(p7.y - pT.y) > 0.5) return [];
    const port = soloPort(model, [[M7, g7], [T, gT]]);
    if (port) for (const e of allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && (e.source === port.id || e.target === port.id))) deleteCell(model, e.id);
    const reroute = moveWires(model, M7, g7, T, gT);
    addWire(model, { source: M7.id, target: T.id, sourcePin: g7, targetPin: gT, style: STF, points: [] });
    if (port) stemPort(model, port, [[T, gT], [M7, g7]], Math.round(Math.min(T.x + T.w + 60, (pT.x + p7.x) / 2)), pT.y, s);
    return reroute;
  }
  const reroute = moveWires(model, M7, g7, T, gT);
  const xg = Math.round(pT.x - 18);
  addWire(model, { source: M7.id, target: T.id, sourcePin: g7, targetPin: gT, style: STF, points: [{ x: xg, y: p7.y }, { x: xg, y: pT.y }] });
  return reroute;
}

/** The compensation line at the X node's height: X → [Rz] → Cc → output column. */
function compLine(model, R, F, yX) {
  const chain = [R.rz, R.cc].filter(Boolean).map(F);
  if (chain.some((c) => !c)) return [];
  const M6 = F(R.m6), d6 = relPin(M6, 0), pd = pinAbs(M6, d6);
  const X = R.cA ? [F(R.cB), relPin(F(R.cB), 2)] : [F(R.mg), relPin(F(R.mg), 2)];
  const px = pinAbs(X[0], X[1]);
  const pinsOf = (c) => activePins(classify(c)).map((r) => ({ r, at: pinAbs(c, r) }));
  if (chain.some((c) => pinsOf(c).some((q) => Math.abs(q.at.y - yX) > 0.5))) return [];
  // the chain's outer ends: leftmost pin to X, rightmost to the output
  const all = chain.flatMap((c) => pinsOf(c).map((q) => ({ c, ...q }))).sort((p, q) => p.at.x - q.at.x);
  const L = all[0], Rt = all[all.length - 1];
  // every wire on the chain's pins is redrawn; a part it reached other than
  // X / the second stage's drain (the load, a load capacitor) is joined to
  // that node instead (returned, to be routed)
  const reroute = [], es = allCells(model).map(cellInfo).filter((e) => e.kind === 'edge');
  const chainPin = (e, end) => all.find((q) => atPin(e, end, q.c, q.r));
  const same = (id, rel, c, r) => id === c.id && Math.abs(rel.x - r.x) < 0.02 && Math.abs(rel.y - r.y) < 0.02;
  for (const e of es) {
    const mine = chainPin(e, 'exit') ? 'exit' : chainPin(e, 'entry') ? 'entry' : null;
    if (!mine) continue;
    const q = chainPin(e, mine), [oid, oend] = mine === 'exit' ? [e.target, 'entry'] : [e.source, 'exit'];
    const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
    deleteCell(model, e.id);
    if (all.some((x) => same(oid, orel, x.c, x.r)) || same(oid, orel, X[0], X[1]) || same(oid, orel, M6, d6)) continue;
    if (q !== L && q !== Rt) continue;
    if (q === Rt && R.load && oid === F(R.load)?.id) continue;   // joined to the drain by secondOutput
    const [tc, tr] = q === L ? X : [M6, d6];
    reroute.push(addWire(model, { source: oid, target: tc.id, sourcePin: orel, targetPin: tr, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }).getAttribute('id'));
  }
  addWire(model, { source: L.c.id, target: X[0].id, sourcePin: L.r, targetPin: X[1], style: STF, points: [{ x: px.x, y: yX }] });
  addWire(model, { source: Rt.c.id, target: M6.id, sourcePin: Rt.r, targetPin: d6, style: STF, points: [{ x: pd.x, y: yX }] });
  if (chain.length === 2) { const [p, q] = [all[1], all[2]]; addWire(model, { source: p.c.id, target: q.c.id, sourcePin: p.r, targetPin: q.r, style: STF, points: [] }); }
  return reroute;
}
