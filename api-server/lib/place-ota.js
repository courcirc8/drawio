/**
 * place-ota.js — engine "ota": the 5-transistor OTA (differential pair on a
 * current-mirror load) drawn as textbooks draw it — the first template after
 * the CML comparator (orchestrator 2026-10-09: 148 circuits of the bank ≤ 25
 * parts hold this core; the two-stage Miller OTA, 28 more, extends it).
 *
 *        mA ─┤├─ mB             mirror load, gates facing (diode mA on the
 *         │  ╲   │              input side), supply on top
 *         │      ├── OUT        output on the right, at mB / iB's drain
 *   IN1 ─┤iA   iB├─ IN2         input pair, gates outward, one row
 *          ╲   ╱
 *    bias ─ tail                tail centred under the pair; its bias diode,
 *                               if any, on the same row to the left
 * (for a PMOS input pair the picture is mirrored top / bottom).
 *
 * Recognised: a differential pair whose two drains are the two sides of a
 * current mirror of the other polarity, the diode of the mirror on one drain.
 * Positions: place-sa wires a start from the template (opts.saInit, almost
 * no annealing), then the template is IMPOSED exactly in pixels — rows and
 * pin alignments (load drain over input drain, tail drain under the middle of
 * the pair's sources), each part with its satellites (rail symbols, ports
 * wired to it alone) and label — and every wire is routed again. The
 * cross-coupled X, ports and straightening are auto's polish.
 * On by default since Eric's yes (2026-10-10); AUTO_OTA=0 disables.
 */
import { detectStructures, isPmosLike } from './patterns.js';
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell, addWire, deleteCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';
import { alignPorts } from './align-ports.js';
import { attachPassives } from './template-attach.js';

const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];
const isMos = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';

/** The OTA reading, or null. */
export function otaReading(parsed) {
  let st; try { st = detectStructures(parsed); } catch { return null; }
  const byRef = new Map(parsed.components.map((c) => [c.ref, c]));
  for (const dp of st.diffPairs) {
    const [p, q] = dp.refs.map((r) => byRef.get(r));
    if (st.crossCoupled.some((cc) => cc.refs.includes(p.ref) || cc.refs.includes(q.ref))) continue;
    for (const m of st.mirrors) {
      const ms = m.refs.map((r) => byRef.get(r));
      if (ms.length !== 2 || isPmosLike(ms[0]) === isPmosLike(p)) continue;
      const dio = byRef.get(m.diode), out = ms.find((c) => c !== dio);
      // the diode on one input drain, the other mirror device on the other
      const iA = D(p) === D(dio) ? p : D(q) === D(dio) ? q : null;
      if (!iA) continue;
      const iB = iA === p ? q : p;
      if (D(out) !== D(iB)) continue;
      const used = new Set([p.ref, q.ref, dio.ref, out.ref]);
      // the tail: a transistor's drain on the source net, or a source /
      // resistor from the source net to a rail (a resistor between the pair's
      // sources and a mirror node is not a tail: AnalogGenie 155)
      const RAILN = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
      const tail = parsed.components.find((c) => !used.has(c.ref) && (isMos(c) ? D(c) === S(p)
        : ['I', 'R'].includes(c.prefix) && c.nodes.includes(S(p)) && c.nodes.some((n) => n !== S(p) && RAILN.test(n))));
      if (tail) used.add(tail.ref);
      // the tail's bias diode: same gate, gate = drain, same polarity
      const bias = tail && isMos(tail) ? parsed.components.find((c) => !used.has(c.ref) && isMos(c) && G(c) === G(tail) && D(c) === G(c) && isPmosLike(c) === isPmosLike(tail)) : null;
      if (bias) used.add(bias.ref);
      // the reference feeding the bias diode: a 2-terminal source / resistor from a rail
      const ref = bias ? parsed.components.find((c) => !used.has(c.ref) && ['I', 'R'].includes(c.prefix) && c.nodes.includes(D(bias)) && c.nodes.some((n) => n !== D(bias) && /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*)$/i.test(n))) : null;
      if (ref) used.add(ref.ref);
      return { iA: iA.ref, iB: iB.ref, mA: dio.ref, mB: out.ref, tail: tail?.ref, bias: bias?.ref, ref: ref?.ref, pmosIn: isPmosLike(p), out: D(iB), used };
    }
  }
  return null;
}

/** The two-stage Miller OTA: the OTA plus a second stage — a common-source
 *  device driven by the OTA output (polarity of the mirror, source on a rail),
 *  its current-source load (other polarity, drain on the second output), and
 *  the compensation capacitor (maybe with a series resistor) between the two
 *  outputs. Returns the OTA reading extended, or null. */
export function millerReading(parsed) {
  const O = otaReading(parsed);
  if (!O) return null;
  const RAILN = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
  const byRef = new Map(parsed.components.map((c) => [c.ref, c]));
  const pIn = isPmosLike(byRef.get(O.iA));
  const m6 = parsed.components.find((c) => !O.used.has(c.ref) && isMos(c) && G(c) === O.out && RAILN.test(S(c)) && isPmosLike(c) !== pIn);
  if (!m6) return null;
  const out2 = D(m6);
  const m7 = parsed.components.find((c) => !O.used.has(c.ref) && c !== m6 && isMos(c) && D(c) === out2 && RAILN.test(S(c)) && isPmosLike(c) === pIn);
  if (!m7) return null;
  // compensation: C between the outputs, or C + R in series through one node
  let cc = parsed.components.find((c) => c.prefix === 'C' && c.nodes.includes(O.out) && c.nodes.includes(out2));
  let rz = null;
  if (!cc) for (const c of parsed.components.filter((x) => x.prefix === 'C' && (x.nodes.includes(O.out) || x.nodes.includes(out2)))) {
    const mid = c.nodes.find((n) => n !== O.out && n !== out2), end = c.nodes.includes(O.out) ? out2 : O.out;
    const r = parsed.components.find((x) => x.prefix === 'R' && x.nodes.includes(mid) && x.nodes.includes(end));
    if (r) { cc = c; rz = r; break; }
  }
  if (!cc) return null;
  const used = new Set([...O.used, m6.ref, m7.ref, cc.ref, ...(rz ? [rz.ref] : [])]);
  return { ...O, m6: m6.ref, m7: m7.ref, cc: cc.ref, rz: rz?.ref, out2, used };
}

/** Template centres, in units of the median part size (place-sa's start). */
export function otaLayout(parsed, O) {
  const COL = 2, ROW = 1.8, s = O.pmosIn ? -1 : 1;   // PMOS input: mirror below, tail above
  const pos = new Map(), put = (r, x, y) => { if (r) pos.set(r, { x, y }); };
  put(O.mA, 0, -s * ROW); put(O.mB, COL, -s * ROW);
  put(O.iA, 0, 0); put(O.iB, COL, 0);
  put(O.tail, COL / 2, s * ROW); put(O.bias, COL / 2 - COL, s * ROW);
  put(O.ref, COL / 2 - COL, 0);
  // two-stage Miller: the second stage one column right of the mirror
  put(O.m6, 2 * COL + 0.5, -s * ROW); put(O.m7, 2 * COL + 0.5, s * ROW);
  let k = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: COL * 2 + COL * k++, y: 0 });
  return pos;
}

/** Engine "miller": the two-stage Miller OTA (same template, second stage on the right). */
export async function importNetlistMiller(model, parsed, opts = {}) {
  const O = millerReading(parsed);
  if (!O) throw new Error('miller: no two-stage Miller OTA');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: otaLayout(parsed, O), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await imposeOta(model, O, parsed);
  return placed;
}

/** Engine "ota". */
export async function importNetlistOta(model, parsed, opts = {}) {
  const O = otaReading(parsed);
  if (!O) throw new Error('ota: no 5T OTA core');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: otaLayout(parsed, O), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await imposeOta(model, O, parsed);
  return placed;
}

async function imposeOta(model, O, parsed) {
  const cells = () => allCells(model).map(cellInfo);
  const find = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const pinsOf = (c) => activePins(classify(c)).map((p) => pinAbs(c, p));
  const drain = (r) => pinsOf(find(r))[0], gate = (r) => pinsOf(find(r))[1], source = (r) => pinsOf(find(r))[2];
  const ctr = (r) => { const c = find(r); return { x: c.x + c.w / 2, y: c.y + c.h / 2 }; };
  const move = (ref, dx, dy = 0) => {
    dx = Math.round(dx); dy = Math.round(dy); if (!dx && !dy) return;
    const cs = cells(), me = cs.find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
    const edges = cs.filter((c) => c.kind === 'edge');
    const group = [me.id];
    for (const v of cs.filter((c) => c.kind === 'vertex' && ['power', 'ground', 'port'].includes(classify(c).role))) {
      const peers = new Set(edges.filter((e) => e.source === v.id || e.target === v.id).map((e) => (e.source === v.id ? e.target : e.source)));
      if (peers.size === 1 && peers.has(me.id)) group.push(v.id);
    }
    for (const c of cs) if (c.kind === 'vertex' && (String(c.id) === 'LBL_' + ref || String(c.id) === 'LBL_' + me.id)) group.push(c.id);
    for (const id of group) updateCell(model, id, { dx, dy });
  };
  // gates: input pair outward, mirror and tail/bias facing each other
  const face = (ref, side) => {   // side: gate on the 'left' or 'right'
    if (!ref) return;
    const c = find(ref), g = gate(ref), mid = c.x + c.w / 2;
    if ((side === 'left') !== (g.x < mid)) updateCell(model, c.id, { style: { flipH: String(c.style.map.get('flipH') || '0') === '1' ? null : 1 } });
  };
  face(O.iA, 'left'); face(O.iB, 'right'); face(O.mA, 'right'); face(O.mB, 'left');
  if (O.bias) { face(O.bias, 'right'); face(O.tail, 'left'); }
  // rows and columns, in pixels, from the input pair as found
  const H = Math.max(...[O.iA, O.iB, O.mA, O.mB].map((r) => find(r).h));
  const W = Math.max(...[O.iA, O.iB, O.mA, O.mB].map((r) => find(r).w));
  const ROW = Math.round(1.7 * H), s = O.pmosIn ? -1 : 1;
  const a = ctr(O.iA);
  // the pair far enough apart for the mirror above it, whose two devices face
  // each other (their leads on the outside, over the input leads)
  const b = ctr(O.iB); move(O.iB, a.x + Math.max(3 * W + 80, 170) - b.x, a.y - b.y);
  // loads: drain straight over the input drain, one row away
  for (const [m, i] of [[O.mA, O.iA], [O.mB, O.iB]]) { const c = ctr(m); move(m, drain(i).x - drain(m).x, a.y - s * ROW - c.y); }
  if (O.tail) {
    const t = ctr(O.tail), mid = (source(O.iA).x + source(O.iB).x) / 2;
    move(O.tail, mid - drain(O.tail).x, a.y + s * ROW - t.y);
    // the bias device left of the tail, far enough for its reference column to
    // pass left of the first input's port (its gate at gate(iA), port 40 + 64 px out)
    if (O.bias) {
      const bb = ctr(O.bias), want = Math.min(gate(O.tail).x - Math.max(1.6 * W, 110), gate(O.iA).x - 150 - (gate(O.bias).x - drain(O.bias).x));
      move(O.bias, want - gate(O.bias).x, a.y + s * ROW - bb.y);
    }
    // the reference straight over (under, PMOS input) the bias drain
    if (O.bias && O.ref) {
      const R = find(O.ref), ps = activePins(classify(R)).map((q) => pinAbs(R, q));
      const near = ps.reduce((u, v) => (s * v.y > s * u.y ? v : u));   // its end towards the bias device
      move(O.ref, drain(O.bias).x - near.x, (drain(O.bias).y - s * 40) - near.y);
    }
  }
  // the SECOND STAGE (two-stage Miller): the common-source device on the
  // mirror's row, gate facing the first output, right of the template with
  // room for the compensation capacitor; its load straight under (over) it,
  // on the tail's row, drains aligned
  if (O.m6) {
    face(O.m6, 'left'); face(O.m7, 'left');
    const m6c = ctr(O.m6), xr = Math.max(find(O.iB).x + find(O.iB).w, find(O.mB).x + find(O.mB).w);
    // room for the compensation chain (Rz, Cc) and the second stage's gate tee
    const chainW = [O.cc, O.rz].filter(Boolean).reduce((t, r) => t + Math.max(find(r).w, find(r).h) + 50, 0);
    move(O.m6, (xr + Math.max(2.6 * W, 120 + chainW) + find(O.m6).w / 2) - m6c.x, a.y - s * ROW - m6c.y);
    const m7c = ctr(O.m7);
    move(O.m7, drain(O.m6).x - drain(O.m7).x, a.y + s * ROW - m7c.y);
  }
  // the passives around the template, each attached to its node (Eric)
  const att = new Set(attachPassives(model, parsed, [O.iA, O.iB, O.mA, O.mB, O.tail, O.bias, O.ref, O.m6, O.m7].filter(Boolean), { across: [O.cc, O.rz].filter(Boolean), acrossY: O.m6 ? Math.round((drain(O.iB).y + drain(O.mB).y) / 2) : undefined }).attached);
  // parts outside the template that now overlap it go to its right (the
  // template moved under them: a BJT OTA's input followers sat on Q2)
  {
    const tpl = [O.iA, O.iB, O.mA, O.mB, O.tail, O.bias, O.ref, O.m6, O.m7].filter(Boolean).map(find);
    const box = { x0: Math.min(...tpl.map((c) => c.x)) - 60, x1: Math.max(...tpl.map((c) => c.x + c.w)) + 60, y0: Math.min(...tpl.map((c) => c.y)) - 30, y1: Math.max(...tpl.map((c) => c.y + c.h)) + 30 };   // 60 px clear on the sides (an LDO pass device sat 30 px from the second stage)
    let xr = box.x1 + 60;
    const others = cells().filter((c) => c.kind === 'vertex' && classify(c).role === 'component' && !O.used.has(String(c.refdes || '')) && !att.has(String(c.refdes || '')))
      .sort((u, v) => u.x - v.x);
    for (const c0 of others) {
      const c = find(String(c0.refdes));
      if (!(c.x < box.x1 && c.x + c.w > box.x0 && c.y < box.y1 && c.y + c.h > box.y0)) continue;
      // the first free spot on its row, right of the template
      const free = (x) => !cells().some((o) => o.kind === 'vertex' && o.id !== c.id && classify(o).role === 'component' && o.x < x + c.w + 30 && o.x + o.w + 30 > x && o.y < c.y + c.h && o.y + o.h > c.y);
      while (!free(xr)) xr += 40;
      move(String(c.refdes), xr - c.x, 0);
      xr += c.w + 60;
    }
  }
  // the output port to the right of the output node, between load and input
  // drains; the other ports at the height of their pins (lib/align-ports.js)
  {
    const cs = cells(), edges = cs.filter((c) => c.kind === 'edge');
    const ids2 = new Set([find(O.iB).id, find(O.mB).id]);
    for (const v of cs.filter((c) => c.kind === 'vertex' && classify(c).role === 'port')) {
      const es = edges.filter((e) => e.source === v.id || e.target === v.id);
      if (es.length !== 1 || !ids2.has(es[0].source === v.id ? es[0].target : es[0].source)) continue;
      const right = Math.max(find(O.iB).x + find(O.iB).w, find(O.mB).x + find(O.mB).w) + 50;
      const y = (drain(O.iB).y + drain(O.mB).y) / 2 - v.h / 2;
      updateCell(model, v.id, { x: right, y: Math.round(y), style: { flipH: null } });
    }
  }
  const ids = cells().filter((c) => c.kind === 'edge').map((e) => e.id);
  for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
  await routePage(model, ids, {});
  if (O.tail) teeNet(model, find(O.iA), find(O.iB), find(O.tail), s);
  mirrorNet(model, find(O.iA), find(O.mA), find(O.mB), s);
  outputNet(model, find(O.iB), find(O.mB), s);
  // two-stage Miller: ONE line at the first output's height — first output,
  // Rz, Cc, second output, its port
  const yC = Math.round((drain(O.iB).y + drain(O.mB).y) / 2);
  if (O.m6) outputNet(model, find(O.m7), find(O.m6), s, yC, O.out2);
  if (O.m6) { const rr = millerGate(model, find(O.m6), find(O.iB), find(O.mB), yC); if (rr.length) await routePage(model, rr, {}); }
  // the compensation line is exact: its parts and the output port are pinned
  // (the straightening pass slid them to the load's drain, off the gate tee)
  if (O.m6) {
    const ids = [O.m6, O.m7, O.cc, O.rz, ...att].filter(Boolean).map((r) => find(r)?.id).filter(Boolean);   // and the parts attached around it (the load capacitor)
    const cs = cells(), es = cs.filter((c) => c.kind === 'edge');
    for (const v of cs.filter((c) => c.kind === 'vertex' && classify(c).role === 'port')) {
      const peers = es.filter((e) => e.source === v.id || e.target === v.id).map((e) => (e.source === v.id ? e.target : e.source));
      if (peers.length && peers.every((pid) => ids.includes(pid))) ids.push(v.id);
    }
    for (const id of ids) updateCell(model, id, { style: { drawioApiPinned: 1 } });
  }
  if (O.bias && O.tail) biasNet(model, find(O.bias), find(O.tail), O.ref && find(O.ref), s);
  await alignPorts(model);
  alignRails(model);
  rebuildLocalDots(model);
}

/** A pair's source net (two sources + the tail's drain) as ONE line beside
 *  the pair, the tail's wire teeing into it (s: +1 line below, -1 above). */
function teeNet(model, A, B, F, s = 1) {
  const rel = (c, k) => activePins(classify(c))[k];
  const sA = rel(A, 2), sB = rel(B, 2), dF = rel(F, 0);
  const at = (e, end, c, r) => (end === 'exit' ? e.source : e.target) === c.id && Math.abs(Number(e.style.map.get(end + 'X') ?? -1) - r.x) < 0.02 && Math.abs(Number(e.style.map.get(end + 'Y') ?? -1) - r.y) < 0.02;
  const onNet = (e, end) => at(e, end, A, sA) || at(e, end, B, sB) || at(e, end, F, dF);
  const old = allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && onNet(e, 'exit') && onNet(e, 'entry'));
  if (old.length !== 2) return;
  const pa = pinAbs(A, sA), pb = pinAbs(B, sB), pf = pinAbs(F, dF);
  if (Math.abs(pa.y - pb.y) > 0.5 || s * (pf.y - pa.y) <= 20) return;
  const y = Math.round(pa.y + s * Math.min(26, Math.abs(pf.y - pa.y) / 2));
  const st = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiTemplate=1;';
  for (const e of old) deleteCell(model, e.id);
  addWire(model, { source: A.id, target: B.id, sourcePin: sA, targetPin: sB, style: st, points: [{ x: pa.x, y }, { x: pb.x, y }] });
  const near = Math.abs(pf.x - pa.x) < Math.abs(pf.x - pb.x) ? [A, sA, pa] : [B, sB, pb];
  addWire(model, { source: F.id, target: near[0].id, sourcePin: dF, targetPin: near[1], style: st, points: [{ x: pf.x, y }, { x: near[2].x, y }] });
}

// drawioApiTemplate: a wire drawn on purpose by a template (not an avoidable bend)
const STF = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiTemplate=1;';
const relPin = (c, k) => activePins(classify(c))[k];
const atPin = (e, end, c, r) => (end === 'exit' ? e.source : e.target) === c.id && Math.abs(Number(e.style.map.get(end + 'X') ?? -1) - r.x) < 0.02 && Math.abs(Number(e.style.map.get(end + 'Y') ?? -1) - r.y) < 0.02;
/** Delete every wire joining two of these pins ([cell, rel] pairs). */
function dropAmong(model, pins) {
  const on = (e, end) => pins.some(([c, r]) => atPin(e, end, c, r));
  for (const e of allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && on(e, 'exit') && on(e, 'entry'))) deleteCell(model, e.id);
}
/** Is a pin still wired to anything? */
const wired = (model, c, r) => allCells(model).map(cellInfo).some((e) => e.kind === 'edge' && (atPin(e, 'exit', c, r) || atPin(e, 'entry', c, r)));

/** The mirror's node as textbooks draw it: input drain straight up to the
 *  diode's drain, the gate bus straight between the two gates, the diode link
 *  dropping from the middle of the bus to the diode's drain node. */
function mirrorNet(model, IA, MA, MB, s) {
  const dI = relPin(IA, 0), dA = relPin(MA, 0), gA = relPin(MA, 1), gB = relPin(MB, 1);
  const pdI = pinAbs(IA, dI), pdA = pinAbs(MA, dA), pgA = pinAbs(MA, gA), pgB = pinAbs(MB, gB);
  if (Math.abs(pdI.x - pdA.x) > 0.5 || Math.abs(pgA.y - pgB.y) > 0.5) return;
  const pins = [[IA, dI], [MA, dA], [MA, gA], [MB, gB]];
  // the wires among these four pins are redrawn; a wire to another part of
  // the net (a resistor to the tail: AnalogGenie 155) stays on its pin
  dropAmong(model, pins);
  addWire(model, { source: IA.id, target: MA.id, sourcePin: dI, targetPin: dA, style: STF, points: [] });
  addWire(model, { source: MA.id, target: MB.id, sourcePin: gA, targetPin: gB, style: STF, points: [] });
  const xm = Math.round((pgA.x + pgB.x) / 2), yn = Math.round(pdA.y + s * 16);
  addWire(model, { source: MA.id, target: MB.id, sourcePin: dA, targetPin: gB, style: STF, points: [{ x: pdA.x, y: yn }, { x: xm, y: yn }, { x: xm, y: pgB.y }] });
}

/** The output node: load drain straight to input drain, the output port on
 *  the right at the middle of that line, a straight wire teeing into it. */
function outputNet(model, IB, MB, s, yPort, netName) {
  const dI = relPin(IB, 0), dB = relPin(MB, 0);
  const pdI = pinAbs(IB, dI), pdB = pinAbs(MB, dB);
  if (Math.abs(pdI.x - pdB.x) > 0.5) return;
  const cs = allCells(model).map(cellInfo);
  const edges = cs.filter((e) => e.kind === 'edge');
  const pins = [[IB, dI], [MB, dB]];
  const onPins = (e) => pins.some(([c, r]) => atPin(e, 'exit', c, r) || atPin(e, 'entry', c, r));
  // a port whose wires all end on these pins
  // the node's port: its wires all end on these pins, or (its wire may go to
  // another part of the node, the Miller capacitor) it bears the net's name
  const port = cs.find((v) => v.kind === 'vertex' && classify(v).role === 'port' && (() => { const es = edges.filter((e) => e.source === v.id || e.target === v.id); return es.length && es.every(onPins); })())
    || (netName && cs.find((v) => v.kind === 'vertex' && classify(v).role === 'port' && String(v.value || '').trim().toLowerCase() === String(netName).toLowerCase()));
  const portEdges = port ? edges.filter((e) => e.source === port.id || e.target === port.id) : [];
  // the wires among these pins and the port's are redrawn; a wire to another
  // part on the node (a load capacitor, the Miller capacitor) stays on its pin
  dropAmong(model, pins);
  // a port wire to another part of the node (the Miller capacitor) was that
  // part's link: the part is joined to the node itself, along its own height
  for (const e of portEdges) {
    const [oid, oend] = e.source === port.id ? [e.target, 'entry'] : [e.source, 'exit'];
    const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
    deleteCell(model, e.id);
    if (pins.some(([c, r]) => c.id === oid && Math.abs(r.x - orel.x) < 0.02 && Math.abs(r.y - orel.y) < 0.02)) continue;
    const O2 = allCells(model).map(cellInfo).find((c) => c.id === oid);
    if (!O2) continue;
    const op = pinAbs(O2, orel);
    addWire(model, { source: oid, target: IB.id, sourcePin: orel, targetPin: dI, style: STF, points: [{ x: pdI.x, y: Math.round(op.y) }] });
  }
  addWire(model, { source: MB.id, target: IB.id, sourcePin: dB, targetPin: dI, style: STF, points: [] });
  if (port) {
    const y = yPort ?? Math.round((pdI.y + pdB.y) / 2), x = Math.round(Math.max(IB.x + IB.w, MB.x + MB.w) + 40);
    updateCell(model, port.id, { x, y: Math.round(y - port.h / 2), style: { flipH: 1 } });   // pointing out of the drawing? an output: tip on its right
    const P = allCells(model).map(cellInfo).find((c) => c.id === port.id);
    // the port's anchor on the side facing the node
    const anchor = pinAbs(P, { x: 1, y: 0.5 }).x < pinAbs(P, { x: 0, y: 0.5 }).x ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 };
    addWire(model, { source: port.id, target: IB.id, sourcePin: anchor, targetPin: dI, style: STF, points: [{ x: pdI.x, y }] });
  }
}

/** The bias: the tail's gate line straight to the bias diode's gate, the
 *  diode link dropping from that line to the bias drain node, the reference
 *  straight onto the bias drain, a port on the node tied in from the left. */
function biasNet(model, BI, T, REF, s) {
  const dB = relPin(BI, 0), gB = relPin(BI, 1), gT = relPin(T, 1);
  const pdB = pinAbs(BI, dB), pgB = pinAbs(BI, gB), pgT = pinAbs(T, gT);
  if (Math.abs(pgB.y - pgT.y) > 0.5) return;
  const cs = allCells(model).map(cellInfo), edges = cs.filter((e) => e.kind === 'edge');
  const pins = [[BI, dB], [BI, gB], [T, gT]];
  let refPin = null;
  if (REF) { const rs = activePins(classify(REF)); refPin = rs.reduce((u, v) => (s * pinAbs(REF, v).y > s * pinAbs(REF, u).y ? v : u)); pins.push([REF, refPin]); }
  const onPins = (e) => pins.some(([c, r]) => atPin(e, 'exit', c, r) || atPin(e, 'entry', c, r));
  const port = cs.find((v) => v.kind === 'vertex' && classify(v).role === 'port' && (() => { const es = edges.filter((e) => e.source === v.id || e.target === v.id); return es.length && es.every(onPins); })());
  const portEdges = port ? edges.filter((e) => e.source === port.id || e.target === port.id) : [];
  // the wires among these pins are redrawn; a wire to another part of the net
  // (the second stage's load gate, two-stage Miller) stays on its pin
  dropAmong(model, pins);
  for (const e of portEdges) deleteCell(model, e.id);
  addWire(model, { source: BI.id, target: T.id, sourcePin: gB, targetPin: gT, style: STF, points: [] });
  // the diode link SHORT, just beside the bias gate (a rectangle across the
  // whole gate line read as a loop: Miller renders, 2026-10-10)
  const xm = Math.round(pgB.x + Math.sign(pgT.x - pgB.x) * 22), yn = Math.round(pdB.y - s * 16);
  addWire(model, { source: BI.id, target: T.id, sourcePin: dB, targetPin: gT, style: STF, points: [{ x: pdB.x, y: yn }, { x: xm, y: yn }, { x: xm, y: pgT.y }] });
  if (REF) addWire(model, { source: REF.id, target: BI.id, sourcePin: refPin, targetPin: dB, style: STF, points: [] });
  if (port) {
    const pr = REF ? pinAbs(REF, refPin) : { y: pdB.y - s * 60 };
    const y = Math.round((pr.y + yn) / 2), x = Math.round(pdB.x - 40 - port.w);
    updateCell(model, port.id, { x, y: Math.round(y - port.h / 2), style: { flipH: null } });
    const P = allCells(model).map(cellInfo).find((c) => c.id === port.id);
    const anchor = pinAbs(P, { x: 1, y: 0.5 }).x > pinAbs(P, { x: 0, y: 0.5 }).x ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 };
    addWire(model, { source: port.id, target: BI.id, sourcePin: anchor, targetPin: dB, style: STF, points: [{ x: pdB.x, y }] });
  }
}

/** Each supply / ground symbol wired to ONE top / bottom pin straight over /
 *  under it (place-sa left them a jog away, on its shared rail line). */
function alignRails(model) {
  const cs = allCells(model).map(cellInfo), byId = new Map(cs.map((c) => [c.id, c])), edges = cs.filter((c) => c.kind === 'edge');
  for (const v of cs.filter((c) => c.kind === 'vertex' && ['power', 'ground'].includes(classify(c).role))) {
    const es = edges.filter((e) => e.source === v.id || e.target === v.id);
    if (es.length !== 1) continue;
    const e = es[0], atSrc = e.source === v.id, part = byId.get(atSrc ? e.target : e.source);
    if (!part || classify(part).role !== 'component') continue;
    const pe = atSrc ? 'entry' : 'exit', ve = atSrc ? 'exit' : 'entry';
    const pin = pinAbs(part, { x: Number(e.style.map.get(pe + 'X') ?? 0.5), y: Number(e.style.map.get(pe + 'Y') ?? 0.5) });
    const vp = pinAbs(v, { x: Number(e.style.map.get(ve + 'X') ?? 0.5), y: Number(e.style.map.get(ve + 'Y') ?? 0.5) });
    const dx = Math.round(pin.x - vp.x);
    if (!dx) continue;
    const nx = v.x + dx;
    if (cs.some((o) => o.kind === 'vertex' && o.id !== v.id && o.x != null && !String(o.id).startsWith('LBL_') && o.style.map.get('contactDot') !== '1'
      && o.x < nx + v.w && o.x + o.w > nx && o.y < v.y + v.h && o.y + o.h > v.y)) continue;
    updateCell(model, v.id, { x: nx });
    updateCell(model, e.id, { points: [], style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: 1, drawioApiTemplate: 1 } });
  }
}

/** The second stage's gate: left along the gate's height, down (up) onto the
 *  first output's line just right of the input/load column, teeing into it
 *  (the router took a loop under the compensation chain). */
function millerGate(model, M6, IB, MB, yLine) {
  const reroute = [];
  const g = relPin(M6, 1), dI = relPin(IB, 0), dB = relPin(MB, 0);
  const pg = pinAbs(M6, g), pdI = pinAbs(IB, dI), pdB = pinAbs(MB, dB);
  if (Math.abs(pdI.x - pdB.x) > 0.5 || pg.x <= pdI.x + 40) return [];
  const es = allCells(model).map(cellInfo).filter((e) => e.kind === 'edge');
  // a pin linked to the net ONLY through the gate would be cut off: each other
  // end of a gate wire is joined to the first output (input drain) first
  for (const e of es.filter((e) => atPin(e, 'exit', M6, g) || atPin(e, 'entry', M6, g))) {
    const [oid, oend] = atPin(e, 'exit', M6, g) ? [e.target, 'entry'] : [e.source, 'exit'];
    const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
    deleteCell(model, e.id);
    if (oid === IB.id && Math.abs(orel.x - dI.x) < 0.02 && Math.abs(orel.y - dI.y) < 0.02) continue;
    const linked = allCells(model).map(cellInfo).some((x) => x.kind === 'edge' && ((x.source === oid && x.target === IB.id) || (x.target === oid && x.source === IB.id)));
    if (oid === MB.id && Math.abs(orel.x - dB.x) < 0.02 && Math.abs(orel.y - dB.y) < 0.02) { if (!linked) addWire(model, { source: MB.id, target: IB.id, sourcePin: dB, targetPin: dI, style: STF, points: [] }); continue; }
    reroute.push(addWire(model, { source: oid, target: IB.id, sourcePin: orel, targetPin: dI, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }).getAttribute('id'));
  }
  // onto the compensation line (the second output's height), else the first output's middle
  const x1 = Math.round(pdI.x + 30), y1 = yLine != null && yLine > Math.min(pdI.y, pdB.y) && yLine < Math.max(pdI.y, pdB.y) ? yLine : Math.round((pdI.y + pdB.y) / 2);
  addWire(model, { source: M6.id, target: IB.id, sourcePin: g, targetPin: dI, style: STF, points: [{ x: x1, y: pg.y }, { x: x1, y: y1 }, { x: pdI.x, y: y1 }] });
  return reroute;
}
