/**
 * place-pair.js — engine "pair": the DIFFERENTIAL PAIR WITH PASSIVE LOADS
 * (orchestrator 2026-10-10: the most frequent motif of the bank ≤ 25 parts,
 * 548 circuits), drawn as textbooks draw it:
 *
 *            VDD
 *       RA │      │ RB          each drain's load chain(s) straight over it,
 *    OUTN ─┤      ├─ OUTP       parallel loads on the outside; outputs at the drains
 *   INP ─┤ iA    iB ├─ INN      the pair on one row, gates outward
 *          ╲    ╱
 *   bias ─ tail                 tail centred under the pair; bias diode + reference left
 *
 * Recognised: a differential pair (lib/patterns.js) that is not a cross-coupled
 * pair nor an OTA (mirror load: lib/place-ota.js), each drain reaching the
 * supply through chains of series 2-terminal parts. Tail and bias as the OTA.
 * Positions: place-sa wires a start from the template, the template is then
 * imposed exactly in pixels; the rest is attached around (lib/template-attach.js).
 */
import { detectStructures, isPmosLike } from './patterns.js';
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell, deleteCell, addWire } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';
import { alignPorts } from './align-ports.js';
import { attachPassives } from './template-attach.js';
import { otaReading } from './place-ota.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
const GND = /^(0|gnd\w*|vss\w*|vee\w*|avss|dvss)$/i;
const isAct = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';
const TWO = new Set(['R', 'L', 'C']);
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];

/** The LC VCO / cross-coupled pair reading (same template, gates facing for
 *  the X drawn by lib/crossx.js), or null. */
export const vcoReading = (parsed) => pairReading(parsed, { cross: true });

/** The pair reading, or null. */
export function pairReading(parsed, { cross = false } = {}) {
  if (!cross && otaReading(parsed)) return null;   // a mirror load: the OTA template
  let st; try { st = detectStructures(parsed); } catch { return null; }
  const comps = parsed.components, byRef = new Map(comps.map((c) => [c.ref, c]));
  const on = (n) => comps.filter((c) => c.nodes.slice(0, isAct(c) ? 3 : 2).includes(n));
  // chains of series 2-terminal parts from a drain to the supply (the far rail)
  const loadsOf = (d, toGnd) => {
    const out = [];
    for (const p of on(d).filter((c) => TWO.has(c.prefix))) {
      const ch = [p]; let cur = p.nodes.find((x) => x !== d);
      for (let k = 0; k < 4 && !RAIL.test(cur); k++) {
        const nx = on(cur).filter((c) => TWO.has(c.prefix) && !ch.includes(c));
        if (nx.length !== 1 || on(cur).length !== 2) { cur = null; break; }
        ch.push(nx[0]); cur = nx[0].nodes.find((x) => x !== cur);
      }
      if (cur && RAIL.test(cur) && GND.test(cur) === toGnd) out.push(ch);
    }
    return out;
  };
  // cross mode (LC VCO, latch core): the CROSS-COUPLED pairs with a common
  // source; normal mode: the differential pairs that are not cross-coupled
  const cands = cross ? st.crossCoupled.filter((cc) => { const [a, b] = cc.refs.map((r) => byRef.get(r)); return S(a) === S(b); }) : st.diffPairs;
  for (const dp of cands) {
    if (!cross && st.crossCoupled.some((cc) => cc.refs.some((r) => dp.refs.includes(r)))) continue;
    const [a, b] = dp.refs.map((r) => byRef.get(r));
    const pIn = isPmosLike(a);
    const la = loadsOf(D(a), pIn), lb = loadsOf(D(b), pIn);
    if (!la.length || !lb.length) continue;
    const used = new Set([a.ref, b.ref, ...la.flat().map((p) => p.ref), ...lb.flat().map((p) => p.ref)]);
    const tail = comps.find((c) => !used.has(c.ref) && (isAct(c) ? D(c) === S(a) : ['I', 'R'].includes(c.prefix) && c.nodes.includes(S(a)) && c.nodes.some((n) => n !== S(a) && RAIL.test(n))));
    if (tail) used.add(tail.ref);
    const bias = tail && isAct(tail) ? comps.find((c) => !used.has(c.ref) && isAct(c) && G(c) === G(tail) && D(c) === G(c) && isPmosLike(c) === isPmosLike(tail)) : null;
    if (bias) used.add(bias.ref);
    const ref = bias ? comps.find((c) => !used.has(c.ref) && ['I', 'R'].includes(c.prefix) && c.nodes.includes(D(bias)) && c.nodes.some((n) => n !== D(bias) && RAIL.test(n))) : null;
    if (ref) used.add(ref.ref);
    // the pair must BE the circuit: at least 60 % of its transistors in the
    // template (a passive mixer whose pair is a detail drew worse with it)
    const acts = comps.filter(isAct).length, actUsed = [...used].filter((r) => isAct(byRef.get(r))).length;
    if (acts && actUsed / acts < 0.6) continue;
    // (cross: the capacitors between the two outputs, laid across)
    const across = cross ? comps.filter((c) => c.prefix === 'C' && !used.has(c.ref) && c.nodes.includes(D(a)) && c.nodes.includes(D(b))).map((c) => c.ref) : [];
    for (const r of across) used.add(r);
    // varactors: two C / D in series between the outputs through a middle node
    // (the tuning voltage) — laid across too, each chain apart
    const acrossChains = [];
    if (cross) for (const p1 of comps.filter((c) => ['C', 'D'].includes(c.prefix) && !used.has(c.ref) && c.nodes.slice(0, 2).includes(D(a)))) {
      const m = p1.nodes.slice(0, 2).find((x) => x !== D(a));
      if (!m || RAIL.test(m)) continue;
      const p2 = comps.find((c) => c !== p1 && ['C', 'D'].includes(c.prefix) && !used.has(c.ref) && c.nodes.slice(0, 2).includes(m) && c.nodes.slice(0, 2).includes(D(b)));
      if (p2) { acrossChains.push([p1.ref, p2.ref]); used.add(p1.ref); used.add(p2.ref); }
    }
    return { cross, across, acrossChains, iA: a.ref, iB: b.ref, loadsA: la.map((ch) => ch.map((p) => p.ref)), loadsB: lb.map((ch) => ch.map((p) => p.ref)), tail: tail?.ref, bias: bias?.ref, ref: ref?.ref, pIn, nodes: { dA: D(a), dB: D(b), s: S(a) }, used };
  }
  return null;
}

export function pairLayout(parsed, P) {
  const s = P.pIn ? -1 : 1, pos = new Map(), put = (r, x, y) => { if (r && !pos.has(r)) pos.set(r, { x, y }); };
  put(P.iA, 0, 0); put(P.iB, 2.6, 0);
  P.loadsA.forEach((ch, j) => ch.forEach((r, k) => put(r, -1.2 * j, -s * (1.6 + 1.2 * k))));
  P.loadsB.forEach((ch, j) => ch.forEach((r, k) => put(r, 2.6 + 1.2 * j, -s * (1.6 + 1.2 * k))));
  put(P.tail, 1.3, s * 1.8); put(P.bias, -0.7, s * 1.8); put(P.ref, -0.7, 0);
  let k = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: 4.5 + 1.5 * (k % 3), y: 1.5 * Math.floor(k++ / 3) });
  return pos;
}

export async function importNetlistVco(model, parsed, opts = {}) {
  const P = vcoReading(parsed);
  if (!P) throw new Error('vco: no cross-coupled pair with loads');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: pairLayout(parsed, P), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await imposePair(model, parsed, P);
  return placed;
}

export async function importNetlistPair(model, parsed, opts = {}) {
  const P = pairReading(parsed);
  if (!P) throw new Error('pair: no passive-load differential pair');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: pairLayout(parsed, P), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await imposePair(model, parsed, P);
  return placed;
}

async function imposePair(model, parsed, P) {
  const cells = () => allCells(model).map(cellInfo);
  const find = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const pins = (r) => { const c = find(r); return activePins(classify(c)).map((p) => pinAbs(c, p)); };
  const comp = new Map(parsed.components.map((c) => [c.ref, c]));
  const ctr = (r) => { const c = find(r); return { x: c.x + c.w / 2, y: c.y + c.h / 2 }; };
  const move = (ref, dx, dy = 0) => {
    dx = Math.round(dx); dy = Math.round(dy); if (!dx && !dy) return;
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
  const upright = (r, upNet) => {
    const pc = comp.get(r), k = pc.nodes.indexOf(upNet), me = find(r), lying = me.w > me.h;
    for (const v of lying ? [{ rotation: 90 }, { rotation: 270 }] : [{ rotation: null, flipV: null }, { rotation: 180, flipV: null }]) {
      updateCell(model, me.id, { style: v });
      const ps = pins(r); if (k < 0 || ps[k].y <= ps[1 - k].y) break;
    }
  };
  // (cross-coupled: gates FACING, the X between them drawn by crossx)
  if (P.cross) { face(P.iA, 'right'); face(P.iB, 'left'); } else { face(P.iA, 'left'); face(P.iB, 'right'); }
  if (P.bias) { face(P.bias, 'right'); face(P.tail, 'left'); }
  const s = P.pIn ? -1 : 1, GAP = 40;
  const W = Math.max(find(P.iA).w, find(P.iB).w);
  const a = ctr(P.iA);
  { const b = ctr(P.iB); move(P.iB, a.x + (P.cross ? Math.max(3.4 * W, 260) : Math.max(2.6 * W, 200)) - b.x, a.y - b.y); }
  // loads: chain j over (under, PMOS pair) its drain, parallel chains outwards
  for (const [chains, dev, dn, out] of [[P.loadsA, P.iA, P.nodes.dA, -1], [P.loadsB, P.iB, P.nodes.dB, 1]]) {
    chains.forEach((ch, j) => {
      let n = dn, yEdge = pins(dev)[0].y;
      const x = pins(dev)[0].x + out * j * 90;
      for (const r of ch) {
        const pc = comp.get(r), other = pc.nodes.find((m) => m !== n);
        upright(r, s > 0 ? other : n);
        const k = pc.nodes.indexOf(n), ps = pins(r);
        // (cross: the first load higher — the X's upper line runs just over the drains)
        move(r, x - ps[k].x, (yEdge - s * (GAP + 10 + (P.cross && n === dn ? 50 : 0))) - ps[k].y);
        n = other; yEdge = pins(r)[1 - k].y;
      }
    });
  }
  if (P.tail) {
    const t = ctr(P.tail), sa = pins(P.iA)[2], sb = pins(P.iB)[2];
    const dk = isAct(comp.get(P.tail)) ? 0 : comp.get(P.tail).nodes.indexOf(P.nodes.s);
    if (!isAct(comp.get(P.tail))) upright(P.tail, s > 0 ? P.nodes.s : comp.get(P.tail).nodes.find((n) => n !== P.nodes.s));
    const td = pins(P.tail)[dk];
    move(P.tail, (sa.x + sb.x) / 2 - td.x, (sa.y + s * 1.2 * find(P.iA).h) - td.y);
    if (P.bias) { const bb = ctr(P.bias); const g = pins(P.tail)[1]; move(P.bias, (g.x - Math.max(1.6 * W, 120)) - pins(P.bias)[1].x, ctr(P.tail).y - bb.y); }
    if (P.bias && P.ref) { const R = find(P.ref), ps = activePins(classify(R)).map((q) => pinAbs(R, q)); const near = ps.reduce((u, v) => (s * v.y > s * u.y ? v : u)); const d = pins(P.bias)[0]; move(P.ref, d.x - near.x, (d.y - s * 40) - near.y); }
  }
  // the TAIL NETWORK when the tail is not one part (an inductor to a node of
  // current sources / capacitors): under the middle of the source line, a
  // series part straight down, the parallel parts under it side by side; a
  // part from the source node straight to the rail beside it
  const extra = new Set();
  if (!P.tail) {
    const sa = pins(P.iA)[2], sb = pins(P.iB)[2], xm = (sa.x + sb.x) / 2, y0 = sa.y + s * 30;
    const onS = parsed.components.filter((c) => !P.used.has(c.ref) && !isAct(c) && c.nodes.slice(0, 2).includes(P.nodes.s));
    let side = 0;
    // a chain from the source node to the OPPOSITE rail (analoggenie 510: C to
    // a node, L from it to VDD under an NMOS pair) hung below came back up in
    // a long U across an input: drawn instead between the columns, towards
    // that rail (not in cross mode: the X fills the middle)
    const opp = (n) => RAIL.test(n) && GND.test(n) !== (s > 0);
    const c1 = onS.length === 1 ? onS[0] : null, o1 = c1 && c1.nodes.slice(0, 2).find((n) => n !== P.nodes.s);
    const onO = c1 && !RAIL.test(o1) ? parsed.components.filter((d) => d !== c1 && !P.used.has(d.ref) && d.nodes.includes(o1)) : [];
    if (!P.cross && onO.length === 1 && !isAct(onO[0]) && onO[0].nodes.slice(0, 2).some(opp)) {
      const d = onO[0], r = d.nodes.slice(0, 2).find(opp);
      upright(c1.ref, s > 0 ? o1 : P.nodes.s); upright(d.ref, s > 0 ? r : o1);
      const k = c1.nodes.indexOf(P.nodes.s), pc = pins(c1.ref);
      move(c1.ref, xm - pc[k].x, (pins(P.iA)[0].y - s * 20) - pc[k].y);   // above the drains: clear of the pair's labels
      const top = pins(c1.ref)[1 - k], kd = d.nodes.indexOf(o1), pd = pins(d.ref);
      move(d.ref, xm - pd[kd].x, (top.y - s * 30) - pd[kd].y);
      extra.add(c1.ref); extra.add(d.ref); onS.length = 0;
    }
    for (const c of onS) {
      const o = c.nodes.slice(0, 2).find((n) => n !== P.nodes.s);
      upright(c.ref, s > 0 ? P.nodes.s : o);
      const k = c.nodes.indexOf(P.nodes.s), ps = pins(c.ref);
      if (RAIL.test(o)) { side++; move(c.ref, (xm - side * 110) - ps[k].x, y0 - ps[k].y); extra.add(c.ref); continue; }
      move(c.ref, xm - ps[k].x, y0 - ps[k].y); extra.add(c.ref);
      const bot = pins(c.ref)[1 - k];
      const par = parsed.components.filter((d) => !P.used.has(d.ref) && !extra.has(d.ref) && d !== c && d.nodes.slice(0, 2).includes(o) && d.nodes.slice(0, 2).some((n) => n !== o && RAIL.test(n) && !opp(n)));
      par.forEach((d, j) => {
        upright(d.ref, s > 0 ? o : d.nodes.slice(0, 2).find((n) => n !== o));
        const kd = d.nodes.indexOf(o), pd = pins(d.ref);
        move(d.ref, (xm + (j - (par.length - 1) / 2) * 110) - pd[kd].x, (bot.y + s * 40) - pd[kd].y); extra.add(d.ref);
      });
    }
  }
  // capacitors (resistors) from an OUTPUT to the rail: just outside its
  // column, hanging from the output line
  for (const [dev, net, out] of [[P.iA, P.nodes.dA, -1], [P.iB, P.nodes.dB, 1]]) {
    const dp = pins(dev)[0];
    const la = (out < 0 ? P.loadsA : P.loadsB)[0]?.[0];
    const yl = la ? pins(la)[comp.get(la).nodes.indexOf(net)].y : dp.y - s * 60;
    let j = 0;
    for (const c of parsed.components.filter((d) => !P.used.has(d.ref) && !extra.has(d.ref) && ['C', 'R'].includes(d.prefix) && d.nodes.slice(0, 2).includes(net) && d.nodes.slice(0, 2).some((n) => n !== net && RAIL.test(n) && GND.test(n) === (s > 0))))
    {
      j++; upright(c.ref, s > 0 ? net : c.nodes.slice(0, 2).find((n) => n !== net));
      const k = c.nodes.indexOf(net), ps = pins(c.ref);
      move(c.ref, (dp.x + out * (130 + 90 * j)) - ps[k].x, (yl + s * 20) - ps[k].y); extra.add(c.ref);
    }
  }
  const tpl = [...P.used, ...extra];
  // across capacitors between the outputs, half-way between drains and loads
  const dYa = pins(P.iA)[0].y, la0 = P.loadsA[0]?.[0];
  // (cross: at the loads' lower ends, clear of the X; else half-way)
  const yLoad = la0 ? pins(la0)[comp.get(la0).nodes.indexOf(P.nodes.dA)].y : dYa - s * 80;
  const yAcross = P.cross ? Math.round(yLoad + s * 10) : Math.round((dYa + yLoad) / 2);
  const chainRefs = (P.acrossChains || []).flat();
  const tplA = tpl.filter((r) => !(P.across || []).includes(r) && !chainRefs.includes(r));
  const att = new Set(attachPassives(model, parsed, tplA, { across: P.across || [], acrossY: yAcross }).attached);
  (P.acrossChains || []).forEach((ch, k) => { for (const r of attachPassives(model, parsed, [...tplA, ...att], { across: ch, acrossY: yAcross - s * 60 * (k + 1) }).attached) att.add(r); });
  // remaining parts together, on the right of the template
  const T = tpl.map(find).filter(Boolean);
  const rest = cells().filter((v) => v.kind === 'vertex' && classify(v).role === 'component' && !P.used.has(String(v.refdes || '')) && !att.has(String(v.refdes || '')) && !extra.has(String(v.refdes || '')));
  if (rest.length) {
    const all = [...T, ...cells().filter((v) => att.has(String(v.refdes || '')))];
    const xMax = Math.max(...all.map((c) => c.x + c.w)), y0 = Math.min(...T.map((c) => c.y)), y1 = Math.max(...T.map((c) => c.y + c.h));
    const rx0 = Math.min(...rest.map((c) => c.x)), ry0 = Math.min(...rest.map((c) => c.y)), ry1 = Math.max(...rest.map((c) => c.y + c.h));
    for (const c of rest) move(String(c.refdes), (xMax + 120) - rx0, (y0 + y1) / 2 - (ry0 + ry1) / 2);
  }
  const ids = cells().filter((c) => c.kind === 'edge').map((e) => e.id);
  for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
  await routePage(model, ids, {});
  await alignPorts(model);
  // the outputs: each drain's port on the OUTSIDE of its column (A left, B
  // right), half-way between the load and the drain, its wire teeing into the
  // drain line
  for (const [dev, net, out] of [[P.iA, P.nodes.dA, -1], [P.iB, P.nodes.dB, 1]]) {
    const cs = cells(), es = cs.filter((c) => c.kind === 'edge');
    const port = cs.find((v) => v.kind === 'vertex' && classify(v).role === 'port' && String(v.value || '').trim().toLowerCase() === String(net).toLowerCase());
    if (!port) continue;
    const D0 = find(dev), dRel = activePins(classify(D0))[0], dp = pinAbs(D0, dRel);   // (used below)
    const load = (out < 0 ? P.loadsA : P.loadsB)[0]?.[0];
    const lp = load ? pins(load)[comp.get(load).nodes.indexOf(net)] : { y: dp.y - 2 * GAP };
    // (cross: both outputs on the line of the capacitor across, symmetric)
    const y = P.cross ? Math.round(lp.y + s * 10) : Math.round((dp.y + lp.y) / 2), x = out < 0 ? Math.round(dp.x - 40 - port.w) : Math.round(dp.x + 40);
    // a port wire to another part (the load) was that part's link to the drain:
    // the part is joined to the drain line itself
    for (const e of es.filter((e) => e.source === port.id || e.target === port.id)) {
      const [oid, oend] = e.source === port.id ? [e.target, 'entry'] : [e.source, 'exit'];
      const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
      deleteCell(model, e.id);
      if (oid === D0.id) continue;
      const O2 = cells().find((c) => c.id === oid); if (!O2) continue;
      const op = pinAbs(O2, orel);
      addWire(model, { source: oid, target: D0.id, sourcePin: orel, targetPin: dRel, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiTemplate=1;', points: Math.abs(op.x - dp.x) < 1 ? [] : [{ x: Math.round(op.x), y: Math.round((op.y + dp.y) / 2) }, { x: Math.round(dp.x), y: Math.round((op.y + dp.y) / 2) }] });
    }
    updateCell(model, port.id, { x, y: y - Math.round(port.h / 2), style: { flipH: out > 0 ? 1 : null } });
    const PP = cells().find((c) => c.id === port.id);
    const anchor = pinAbs(PP, { x: 1, y: 0.5 }).x * out < pinAbs(PP, { x: 0, y: 0.5 }).x * out ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 };
    addWire(model, { source: port.id, target: D0.id, sourcePin: anchor, targetPin: dRel, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiTemplate=1;', points: [{ x: Math.round(dp.x), y }] });
  }
  for (const r of P.used) { const c = find(r); if (c) updateCell(model, c.id, { style: { drawioApiPinned: 1 } }); }
  rebuildLocalDots(model);
}
