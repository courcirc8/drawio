/**
 * place-cs.js — engine "cs": SINGLE-TRANSISTOR STAGES (common source /
 * emitter, source / emitter follower, and their cascade), drawn as textbooks
 * draw them (orchestrator 2026-10-10, Eric's order after the pair):
 *
 *        VDD          VDD
 *         │            │
 *         RD           │            one column per stage, left to right along
 *         ├── out ──┤ M2            the signal: load over the drain (CS), drain
 *   in ─┤ M1          ├── out       on the supply (follower); degeneration and
 *         RS          I/R           follower load under the source; each stage's
 *         │            │            output straight into the next gate
 *        GND          GND
 *
 * Recognised: every transistor that matters is a stage of one device whose
 * load (and degeneration) are chains of series 2-terminal parts, a current
 * source, or a current-source transistor (gate on a bias net), to a rail;
 * a stage's input is a port / passive net or the previous stage's output.
 * Positions: place-sa wires a start from the template, the template is then
 * imposed exactly in pixels; the rest is attached around (lib/template-attach.js).
 */
import { isPmosLike } from './patterns.js';
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell, deleteCell, addWire } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';
import { alignPorts } from './align-ports.js';
import { attachPassives } from './template-attach.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss|vpwr|vgnd)$/i;
const GND = /^(0|gnd\w*|vss\w*|vee\w*|avss|dvss|vgnd)$/i;
const isAct = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';
const TWO = new Set(['R', 'L']);   // a load / degeneration conducts DC (a capacitor is attached, not a load)
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];

/** The stages reading, or null: {stages:[{kind:'cs'|'sf', dev, pmos, in, out,
 *  top:[refs], bottom:[refs]}], used:Set}. */
export function csReading(parsed) {
  const comps = parsed.components;
  const acts = comps.filter(isAct);
  if (!acts.length || acts.length > 4 || comps.length > 16) return null;
  const pins = (c) => c.nodes.slice(0, isAct(c) ? 3 : 2);
  const on = (n) => comps.filter((c) => pins(c).includes(n));
  const used = new Set();
  // a chain of series 2-terminal parts (or one current source) from `n` to a
  // rail of the wanted kind; null if the net branches
  const chainTo = (n, toGnd, skip, input = null) => {
    for (const p of on(n).filter((c) => !skip.has(c.ref) && !used.has(c.ref) && (TWO.has(c.prefix) || c.prefix === 'I'))) {
      const ch = [p]; let cur = pins(p).find((x) => x !== n);
      for (let k = 0; k < 3 && cur && !RAIL.test(cur); k++) {
        const nx = on(cur).filter((c) => !ch.includes(c) && TWO.has(c.prefix) && !used.has(c.ref));
        if (nx.length !== 1 || on(cur).length !== 2) { cur = null; break; }
        ch.push(nx[0]); cur = pins(nx[0]).find((x) => x !== cur);
      }
      if (cur && RAIL.test(cur) && GND.test(cur) === toGnd) return ch.map((c) => c.ref);
    }
    // a current-source transistor: drain on n, source on the rail, gate on a bias net
    const cs = on(n).find((c) => isAct(c) && !skip.has(c.ref) && !used.has(c.ref) && D(c) === n && RAIL.test(S(c)) && GND.test(S(c)) === toGnd && !RAIL.test(G(c)) && G(c) !== n && G(c) !== input && biasGate(c));
    return cs ? [cs.ref] : null;
  };
  // a current-source load's gate sits on a BIAS: shared with a diode-connected
  // device (a mirror), or a port named like a bias, or a port only it touches
  // that is not a signal input — not an inverter's input, nor a cascode's
  // input device driven through a resistor (Razavi: Vin — Rs — Q1)
  const BIASNAME = /^(v_?b|vbias|bias|vref|vcm|vg|ib)/i;   // (not vp / vn: inputs of an amplifier)
  const biasGate = (c) => {
    const g = G(c), others = on(g).filter((x) => x !== c);
    if (others.some((x) => isAct(x) && G(x) === g && D(x) === g)) return true;
    if (BIASNAME.test(String(g))) return true;
    return !others.length && !/^v?_?in/i.test(String(g));
  };
  const stages = [];
  for (const t of acts) {
    if (used.has(t.ref)) continue;
    const pm = isPmosLike(t), up = !pm;   // NMOS: supply on top
    const supplyOk = (n) => RAIL.test(n) && GND.test(n) !== up;   // the rail over the device (VDD for NMOS)
    const groundOk = (n) => RAIL.test(n) && GND.test(n) === up;
    if (RAIL.test(G(t)) || G(t) === D(t)) continue;   // (a diode is not a stage)
    const skip = new Set([t.ref]);
    if (supplyOk(D(t)) && !RAIL.test(S(t))) {
      // follower: the output on the source, its load to the other rail
      const bottom = chainTo(S(t), up, skip, G(t));
      if (!bottom) continue;
      stages.push({ kind: 'sf', dev: t.ref, pmos: pm, in: G(t), out: S(t), top: [], bottom });
      used.add(t.ref); bottom.forEach((r) => used.add(r));
      continue;
    }
    if (!RAIL.test(D(t))) {
      // common source: the load from the drain to the supply, the source on
      // the other rail or degenerated to it
      const top = chainTo(D(t), !up, skip, G(t));
      if (!top) continue;
      top.forEach((r) => skip.add(r));
      const bottom = groundOk(S(t)) ? [] : chainTo(S(t), up, skip, G(t));
      if (!bottom) continue;
      stages.push({ kind: 'cs', dev: t.ref, pmos: pm, in: G(t), out: D(t), top, bottom });
      used.add(t.ref); top.forEach((r) => used.add(r)); bottom.forEach((r) => used.add(r));
    }
  }
  if (!stages.length) return null;
  // two stages on one output (an inverter read twice) or one input: not stages
  if (new Set(stages.map((s) => s.out)).size < stages.length) return null;
  // the stages must BE the circuit: every transistor in a stage (as a device
  // or a current-source load)
  if (acts.some((t) => !used.has(t.ref))) return null;
  // signal order: a stage whose input is another stage's output comes after it
  const order = [], left = [...stages];
  while (left.length) {
    const k = left.findIndex((s) => !left.some((o) => o !== s && o.out === s.in));
    order.push(...left.splice(k < 0 ? 0 : k, 1));
  }
  return { stages: order, used };
}

/** Start positions (units) for place-sa: one column per stage. */
export function csLayout(parsed, R) {
  const pos = new Map(), put = (r, x, y) => { if (r && !pos.has(r)) pos.set(r, { x, y }); };
  R.stages.forEach((st, i) => {
    const s = st.pmos ? -1 : 1, x = 2.4 * i;
    put(st.dev, x, 0);
    st.top.forEach((r, k) => put(r, x, -s * 1.5 * (k + 1)));
    st.bottom.forEach((r, k) => put(r, x, s * 1.5 * (k + 1)));
  });
  let k = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: 2.4 * R.stages.length + 1.5 * (k % 3), y: 1.5 * Math.floor(k++ / 3) });
  return pos;
}

export async function importNetlistCs(model, parsed, opts = {}) {
  const R = csReading(parsed);
  if (!R) throw new Error('cs: no single-transistor stages');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: csLayout(parsed, R), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await imposeCs(model, parsed, R);
  return placed;
}

async function imposeCs(model, parsed, R) {
  const cells = () => allCells(model).map(cellInfo);
  const find = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const pins = (r) => { const c = find(r); return activePins(classify(c)).map((p) => pinAbs(c, p)); };
  const comp = new Map(parsed.components.map((c) => [c.ref, c]));
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
  // a transistor: gate on the left, pin `upPin` (0 drain, 2 source) above the other
  const orient = (ref, upPin) => {
    const me = find(ref);
    for (const v of [{ rotation: null, flipV: null, flipH: null }, { flipV: 1 }, { flipH: 1 }, { flipH: 1, flipV: 1 }]) {
      updateCell(model, me.id, { style: { rotation: null, flipV: null, flipH: null, ...v } });
      const c = find(ref), p = pins(ref);
      if (p[upPin].y < p[2 - upPin].y - 1 && p[1].x < c.x + c.w / 2) return;
    }
  };
  // a 2-terminal part upright, pin on `upNet` on top
  const upright = (r, upNet) => {
    const pc = comp.get(r), k = pc.nodes.indexOf(upNet), me = find(r), lying = me.w > me.h;
    for (const v of (lying ? [{ rotation: 90 }, { rotation: 270 }] : [{ rotation: null }, { rotation: 180 }]).map((o) => ({ flipH: null, flipV: null, ...o }))) {   // (no mirror with a rotation: the renderer and pinAbs disagree on flipH + rotation)
      updateCell(model, me.id, { style: v });
      const ps = pins(r); if (k < 0 || ps[k].y <= ps[1 - k].y) break;
    }
  };
  // a chain from net n of the device, up (dir -1) or down (dir +1), in column x
  const GAP = 40;
  const stack = (chain, n, x, yEdge, dir) => {
    for (const r of chain) {
      const pc = comp.get(r);
      if (isAct(pc)) {   // a current-source transistor: its drain towards the stage
        orient(r, dir < 0 ? 2 : 0);
        const d = pins(r)[0];
        move(r, x - d.x, (yEdge + dir * GAP) - d.y);
        return;
      }
      const other = pc.nodes.slice(0, 2).find((m) => m !== n);
      upright(r, dir < 0 ? other : n);
      const k = pc.nodes.indexOf(n), ps = pins(r);
      move(r, x - ps[k].x, (yEdge + dir * GAP) - ps[k].y);
      n = other; yEdge = pins(r)[1 - k].y;
    }
  };
  let x0 = null, prevOutY = null;
  const feeds = [];   // [load ref | device ref, pin index, next device]: the straight wire into the next gate
  for (const [i, st] of R.stages.entries()) {
    const s = st.pmos ? -1 : 1;
    // NMOS: drain on top; PMOS: source on top
    orient(st.dev, s > 0 ? 0 : 2);
    const c = find(st.dev), W = c.w;
    const g = pins(st.dev)[1];
    // the column: right of the previous one; the gate at the previous output's height
    const tx = i === 0 ? c.x : x0 + Math.max(3.2 * W, 220);
    const ty = i > 0 && R.stages[i - 1].out === st.in && prevOutY != null ? c.y + (prevOutY - g.y) : c.y;
    move(st.dev, tx - c.x, ty - c.y);
    x0 = find(st.dev).x;
    const p = pins(st.dev), lead = p[0].x;
    // top: the load over the drain (CS), towards the far rail; bottom: under the source
    const topNet = s > 0 ? comp.get(st.dev).nodes[0] : comp.get(st.dev).nodes[2];
    const botNet = s > 0 ? comp.get(st.dev).nodes[2] : comp.get(st.dev).nodes[0];
    const topY = s > 0 ? p[0].y : p[2].y, botY = s > 0 ? p[2].y : p[0].y;
    stack(st.kind === 'cs' ? (s > 0 ? st.top : st.bottom) : (s > 0 ? [] : st.bottom), topNet, lead, topY, -1);
    stack(st.kind === 'cs' ? (s > 0 ? st.bottom : st.top) : (s > 0 ? st.bottom : []), botNet, lead, botY, 1);
    // the output's height: where the load meets the output node (the next
    // gate wire then runs straight from that pin, the device's lead straight
    // up / down to it), else the drain (CS) / source (follower) pin
    const loadOnOut = (st.kind === 'cs' ? st.top : st.bottom)[0];
    const lk = loadOnOut ? comp.get(loadOnOut).nodes.indexOf(st.out) : -1;
    prevOutY = loadOnOut && lk >= 0 && lk < 3 ? pins(loadOnOut)[lk].y : pins(st.dev)[st.kind === 'cs' ? 0 : 2].y;
    const nx = R.stages[i + 1];
    if (nx && nx.in === st.out) feeds.push(loadOnOut && lk >= 0 && lk < 3 ? [loadOnOut, lk, nx.dev] : [st.dev, st.kind === 'cs' ? 0 : 2, nx.dev]);
  }
  // the GATE NETWORK of a stage driven from outside (Razavi: Vin — C_B — X,
  // R_B from X to V_B): series parts on the gate's line, lying, towards the
  // input; a part from the gate net to a rail or to a bias port hangs from
  // that line (ground below, supply / bias above); all left of the gate
  const lie = (r, leftNet) => {
    const pc = comp.get(r), k = pc.nodes.indexOf(leftNet), me = find(r), lying = me.w > me.h;
    for (const v of (lying ? [{ rotation: null, flipH: null }, { rotation: null, flipH: 1 }] : [{ rotation: 90 }, { rotation: 270 }]).map((o) => ({ flipH: null, flipV: null, ...o }))) {   // (a mirror, not 180°: the label stays upright)
      updateCell(model, me.id, { style: v });
      const ps = pins(r); if (k < 0 || ps[k].x <= ps[1 - k].x) break;
    }
  };
  const gateNet = new Set(), gateLines = [];   // [net, y, [[ref, pin index]…]] drawn straight afterwards
  const portNets = new Set(parsed.ports || []);
  // a rail, or a bias port (a net only this part touches, named like a bias)
  const isBiasEnd = (n) => RAIL.test(n) || (on2(n).length === 1 && /^(v_?b|vbias|bias|vref|vcm|vg)/i.test(String(n)));
  function on2(n) { return parsed.components.filter((c) => c.nodes.slice(0, isAct(c) ? 3 : 2).includes(n)); }
  for (const [i, st] of R.stages.entries()) {
    if (i > 0 && R.stages[i - 1].out === st.in) continue;
    const g = pins(st.dev)[1];
    let n = st.in, x = g.x - 50, y = g.y, hang = 0;
    const line = [[st.dev, 1]];
    for (let step = 0; step < 3; step++) {
      const here = on2(n).filter((c) => !R.used.has(c.ref) && !gateNet.has(c.ref) && !isAct(c) && c.nodes.length >= 2 && ['R', 'C', 'L'].includes(c.prefix));
      const shunt = here.filter((c) => isBiasEnd(c.nodes.slice(0, 2).find((m) => m !== n)));
      const series = here.filter((c) => !shunt.includes(c));
      for (const c of shunt) {
        const o = c.nodes.slice(0, 2).find((m) => m !== n), down = RAIL.test(o) ? GND.test(o) : true;
        upright(c.ref, down ? n : o);
        const k = c.nodes.indexOf(n), ps = pins(c.ref);
        move(c.ref, (x - 20 - 70 * hang++) - ps[k].x, y - ps[k].y);   // its pin ON the gate line
        gateNet.add(c.ref); if (n === st.in) line.push([c.ref, k]);
      }
      if (series.length !== 1) break;
      const c = series[0], o = c.nodes.slice(0, 2).find((m) => m !== n);
      lie(c.ref, o);
      const k = c.nodes.indexOf(n), ps = pins(c.ref);
      move(c.ref, (x - 20 - 70 * hang) - ps[k].x, y - ps[k].y);
      gateNet.add(c.ref); if (n === st.in) line.push([c.ref, k]);
      x = pins(c.ref)[1 - k].x - 30; hang = 0; n = o;
    }
    if (line.length > 2) gateLines.push(line);
  }
  for (const r of gateNet) R.used.add(r);
  const dbg = (t) => { if (process.env.CS_DEBUG) for (const r of [...gateNet]) console.error(t, r, pins(r).map((q) => Math.round(q.x) + ',' + Math.round(q.y)).join(' ')); };
  dbg('placed');
  void portNets;
  // supply / ground symbols wired to the template: just over (under) the
  // highest (lowest) pin they feed, not where the annealing left them
  {
    const cs = cells(), byId = new Map(cs.map((c) => [c.id, c])), edges = cs.filter((c) => c.kind === 'edge');
    const tplIds = new Set([...R.used].map((r) => find(r)?.id).filter(Boolean));
    for (const v of cs.filter((c) => c.kind === 'vertex' && ['power', 'ground'].includes(classify(c).role))) {
      const pinsAt = edges.filter((e) => (e.source === v.id && tplIds.has(e.target)) || (e.target === v.id && tplIds.has(e.source))).map((e) => {
        const [oid, end] = e.source === v.id ? [e.target, 'entry'] : [e.source, 'exit'];
        return pinAbs(byId.get(oid), { x: Number(e.style.map.get(end + 'X') ?? 0.5), y: Number(e.style.map.get(end + 'Y') ?? 0.5) });
      });
      if (!pinsAt.length) continue;
      const up = classify(v).role === 'power', at = pinsAt.reduce((a, b) => ((up ? b.y < a.y : b.y > a.y) ? b : a));
      updateCell(model, v.id, { x: Math.round(at.x - v.w / 2), y: Math.round(up ? at.y - 30 - v.h : at.y + 30) });
    }
  }
  dbg('rails');
  const tpl = [...R.used];
  const att = new Set(attachPassives(model, parsed, tpl).attached);
  // remaining parts together, on the right of the template
  const T = tpl.map(find).filter(Boolean);
  const rest = cells().filter((v) => v.kind === 'vertex' && classify(v).role === 'component' && !R.used.has(String(v.refdes || '')) && !att.has(String(v.refdes || '')));
  if (rest.length) {
    const all = [...T, ...cells().filter((v) => att.has(String(v.refdes || '')))];
    const xMax = Math.max(...all.map((c) => c.x + c.w)), y0 = Math.min(...T.map((c) => c.y)), y1 = Math.max(...T.map((c) => c.y + c.h));
    const rx0 = Math.min(...rest.map((c) => c.x)), ry0 = Math.min(...rest.map((c) => c.y)), ry1 = Math.max(...rest.map((c) => c.y + c.h));
    for (const c of rest) move(String(c.refdes), (xMax + 120) - rx0, (y0 + y1) / 2 - (ry0 + ry1) / 2);
  }
  dbg('attached');
  const ids = cells().filter((c) => c.kind === 'edge').map((e) => e.id);
  for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
  await routePage(model, ids, {});
  // each stage's output straight into the next gate: the wires the router
  // drew at that gate are replaced by one from the load's pin; whatever they
  // joined is joined to that pin instead (routed again)
  const wireStyle = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;';
  for (const [src, k, dev] of feeds) {
    const S0 = find(src), G0 = find(dev); if (!S0 || !G0) continue;
    const sRel = activePins(classify(S0))[k], gRel = activePins(classify(G0))[1], gp = pinAbs(G0, gRel);
    const cs = cells(), es = cs.filter((c) => c.kind === 'edge'), byId = new Map(cs.map((c) => [c.id, c]));
    const endAt = (e, end) => { const id = end === 'exit' ? e.source : e.target; return pinAbs(byId.get(id), { x: Number(e.style.map.get(end + 'X') ?? 0.5), y: Number(e.style.map.get(end + 'Y') ?? 0.5) }); };
    const atGate = es.filter((e) => (e.source === G0.id && Math.hypot(endAt(e, 'exit').x - gp.x, endAt(e, 'exit').y - gp.y) < 2) || (e.target === G0.id && Math.hypot(endAt(e, 'entry').x - gp.x, endAt(e, 'entry').y - gp.y) < 2));
    const rejoin = [];
    for (const e of atGate) {
      const [oid, oend] = e.source === G0.id ? [e.target, 'entry'] : [e.source, 'exit'];
      const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
      deleteCell(model, e.id);
      if (!(oid === S0.id && Math.abs(orel.x - sRel.x) < 1e-6 && Math.abs(orel.y - sRel.y) < 1e-6)) rejoin.push([oid, orel]);
    }
    const sp = pinAbs(S0, sRel);
    addWire(model, { source: S0.id, target: G0.id, sourcePin: sRel, targetPin: gRel, style: wireStyle + 'drawioApiFixedRoute=1;drawioApiTemplate=1;', points: Math.abs(sp.y - gp.y) < 1 ? [] : [{ x: Math.round(sp.x), y: Math.round(gp.y) }] });
    const added = [];
    for (const [oid, orel] of rejoin) added.push(addWire(model, { source: oid, target: S0.id, sourcePin: orel, targetPin: sRel, style: wireStyle }));
    const ids = added.map((w) => (typeof w === 'string' ? w : w?.id)).filter(Boolean);
    if (ids.length) await routePage(model, ids, {});
  }
  // the gate line: its pins in a row, joined by straight wires (the router
  // otherwise went round a hanging part's pin lying on the line)
  for (const line of gateLines) {
    const pts = line.map(([r, k]) => { const c = find(r); const rel = activePins(classify(c))[k]; return { id: c.id, rel, at: pinAbs(c, rel) }; }).sort((a, b) => a.at.x - b.at.x);
    const ids = new Set(pts.map((p) => p.id)), cs = cells(), byId = new Map(cs.map((c) => [c.id, c]));
    const onPin = (e, end, p) => { const id = end === 'exit' ? e.source : e.target; if (id !== p.id) return false; const a = pinAbs(byId.get(id), { x: Number(e.style.map.get(end + 'X') ?? 0.5), y: Number(e.style.map.get(end + 'Y') ?? 0.5) }); return Math.hypot(a.x - p.at.x, a.y - p.at.y) < 2; };
    // (two parts of the line share no net but the gate's: every wire between them is on it)
    void onPin;
    const mine = cs.filter((e) => e.kind === 'edge' && ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
    if (!mine.length || [...ids].length !== pts.length) continue;
    for (const e of mine) deleteCell(model, e.id);
    // (a straight segment: the orthogonal style would leave a hanging part's top pin upwards first)
    for (let i = 1; i < pts.length; i++) addWire(model, { source: pts[i - 1].id, target: pts[i].id, sourcePin: pts[i - 1].rel, targetPin: pts[i].rel, style: 'edgeStyle=none;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiTemplate=1;', points: [] });
  }
  await alignPorts(model);
  for (const r of R.used) { const c = find(r); if (c) updateCell(model, c.id, { style: { drawioApiPinned: 1 } }); }
  rebuildLocalDots(model);
}
