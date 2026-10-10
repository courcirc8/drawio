/**
 * place-lna.js — engine "lna": the CASCODE LNA with inductive degeneration
 * drawn as textbooks draw it (orchestrator 2026-10-10: the simulation
 * annotations are not shown to Eric on a messy LNA — "entrée Lb→base Q1, Le
 * vers la masse, cascode Q2 au-dessus, charge Lc vers VCC, sortie à droite").
 *
 *               VCC
 *            Lc │ │ Rp          load chain(s) up to the supply, side by side
 *               ├──┤├── OUT     output coupling on the right of the collector
 *          bias ┤ Q2            cascode
 *   IN ┤├─Lb──┤ Q1              input chain on the left, at the base's height
 *               Le              degeneration chain down to ground
 *               ⏚
 *
 * Recognised (BJT or MOS, node order C/D, B/G, E/S): two devices of one type,
 * the cascode's emitter (source) on the input device's collector (drain) and
 * on nothing else; the input device's emitter (source) going to ground through
 * a chain of series parts containing an inductor; the cascode's collector
 * (drain) reaching the supply through chains of series parts. The input chain
 * is the series path from the input device's base (gate) to an external node.
 * Everything else (bias network) is attached around (lib/template-attach.js).
 * Positions: place-sa wires a start from the template, then the column is
 * imposed exactly in pixels (leads on one vertical line), as lib/place-ota.js.
 */
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';
import { alignPorts } from './align-ports.js';
import { attachPassives } from './template-attach.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
const GND = /^(0|gnd\w*|vss\w*|vee\w*|avss|dvss)$/i;
const isAct = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';
const TWO = new Set(['R', 'L', 'C']);

/** The LNA reading, or null. */
export function lnaReading(parsed) {
  const comps = parsed.components;
  const on = (n) => comps.filter((c) => c.nodes.slice(0, isAct(c) ? 3 : 2).includes(n));
  // a series chain of 2-terminal parts from node `n` until a node passing `stop`
  // (parts going back to `avoidNodes` — a base-emitter capacitor — are not the chain)
  const chain = (n, stop, avoid, avoidNodes = []) => {
    const out = []; let cur = n; const seen = new Set(avoid);
    for (let k = 0; k < 6; k++) {
      if (stop(cur)) return { parts: out, end: cur };
      const next = on(cur).filter((c) => TWO.has(c.prefix) && !seen.has(c.ref) && !c.nodes.some((x) => x !== cur && avoidNodes.includes(x)));
      if (next.length !== 1 || (k > 0 && on(cur).filter((c) => !c.nodes.some((x) => x !== cur && avoidNodes.includes(x))).length !== 2)) return null;
      const p = next[0]; seen.add(p.ref); out.push(p);
      cur = p.nodes.find((x) => x !== cur);
    }
    return null;
  };
  for (const q1 of comps.filter(isAct)) for (const q2 of comps.filter((c) => isAct(c) && c !== q1 && c.prefix === q1.prefix)) {
    const [c1, b1, e1] = q1.nodes, [c2, b2, e2] = q2.nodes;
    if (e2 !== c1 || on(c1).filter(isAct).length !== 2) continue;
    // degeneration: emitter chain to ground with an inductor
    const deg = chain(e1, (n) => GND.test(n), [q1.ref], [b1, c1]);
    if (!deg || !deg.parts.some((p) => p.prefix === 'L')) continue;
    // loads: every chain from the cascode's collector to the supply
    const loads = [];
    for (const p of on(c2).filter((c) => TWO.has(c.prefix))) {
      const other = p.nodes.find((x) => x !== c2);
      if (RAIL.test(other) && !GND.test(other)) { loads.push([p]); continue; }
      const ch = chain(other, (n) => RAIL.test(n) && !GND.test(n), [p.ref]);
      if (ch && ch.parts.length && !GND.test(ch.end)) loads.push([p, ...ch.parts]);
    }
    if (!loads.length) continue;
    // input chain: from the base towards an external node (in, rfin…)
    let input = null;
    for (const p of on(b1).filter((c) => TWO.has(c.prefix) && c.prefix !== 'C' || c.prefix === 'L')) {
      const other = p.nodes.find((x) => x !== b1);
      const ch = chain(other, (n) => /^(in|rfin|vin|inp?)\w*$/i.test(n), [p.ref]);
      if (ch) { input = [p, ...ch.parts]; break; }
    }
    // the output coupling: a capacitor from the collector to an external node
    const out = on(c2).find((c) => c.prefix === 'C' && /^(out|rfout|vout|outp?)\w*$/i.test(c.nodes.find((x) => x !== c2) || ''));
    // the bias mirror of the input device: a resistor from its base (gate) to
    // the diode node of a diode-connected device, fed by a resistor from the supply
    let bias = null;
    for (const rb of on(b1).filter((c) => c.prefix === 'R')) {
      const bn = rb.nodes.find((x) => x !== b1);
      const q3 = comps.find((c) => isAct(c) && c !== q1 && c !== q2 && c.nodes[0] === bn && c.nodes[1] === bn && GND.test(c.nodes[2]));
      const rref = q3 && comps.find((c) => c.prefix === 'R' && c !== rb && c.nodes.includes(bn) && c.nodes.some((x) => x !== bn && RAIL.test(x) && !GND.test(x)));
      if (q3 && rref) { bias = { rb: rb.ref, q3: q3.ref, rref: rref.ref, bn }; break; }
    }
    if (bias && input && input.some((p) => p.ref === bias.rb)) bias = null;
    const used = new Set([...(bias ? [bias.rb, bias.q3, bias.rref] : []), q1.ref, q2.ref, ...deg.parts.map((p) => p.ref), ...loads.flat().map((p) => p.ref), ...(input || []).map((p) => p.ref), ...(out ? [out.ref] : [])]);
    return { q1: q1.ref, q2: q2.ref, deg: deg.parts.map((p) => p.ref), loads: loads.map((l) => l.map((p) => p.ref)), input: (input || []).map((p) => p.ref), out: out?.ref, bias, nodes: { c1, b1, e1, c2, b2 }, used };
  }
  return null;
}

/** Template centres, in units of the median part size. */
export function lnaLayout(parsed, L) {
  const pos = new Map(), put = (r, x, y) => { if (r && !pos.has(r)) pos.set(r, { x, y }); };
  put(L.q1, 0, 0); put(L.q2, 0, -1.8);
  L.deg.forEach((r, k) => put(r, 0.25, 1.4 + 1.2 * k));
  L.loads.forEach((ch, j) => ch.forEach((r, k) => put(r, 0.25 + 1.6 * j, -3.2 - 1.2 * k)));
  L.input.forEach((r, k) => put(r, -1.6 - 1.4 * k, 0));
  put(L.out, 1.8, -2.6);
  let k = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: 3.5 + 1.6 * (k % 3), y: -1.8 + 1.6 * Math.floor(k++ / 3) });
  return pos;
}

export async function importNetlistLna(model, parsed, opts = {}) {
  const L = lnaReading(parsed);
  if (!L) throw new Error('lna: no inductively degenerated cascode');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: lnaLayout(parsed, L), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await imposeLna(model, parsed, L);
  return placed;
}

async function imposeLna(model, parsed, L) {
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
  // devices: base (gate) on the left
  for (const r of [L.q1, L.q2]) {
    const c = find(r), g = pins(r)[1];
    if (g.x > c.x + c.w / 2) updateCell(model, c.id, { style: { flipH: String(c.style.map.get('flipH') || '0') === '1' ? null : 1 } });
  }
  // a 2-terminal part upright (resistor drawn 100 x 20: rotation 90), its end on `upNet` on top
  const upright = (r, upNet) => {
    const pc = comp.get(r), k = pc.nodes.indexOf(upNet), me = find(r);
    const lying = me.w > me.h;
    for (const v of lying ? [{ rotation: 90 }, { rotation: 270 }] : [{ flipV: null }, { flipV: 1 }]) {
      updateCell(model, me.id, { style: v });
      const ps = pins(r); if (k < 0 || ps[k].y <= ps[1 - k].y) break;
    }
  };
  const lying = (r, leftNet) => {
    const pc = comp.get(r), k = pc.nodes.indexOf(leftNet), me = find(r);
    for (const v of me.w >= me.h ? [{ rotation: null, flipH: null }, { rotation: null, flipH: 1 }] : [{ rotation: 90 }, { rotation: 270 }]) {
      updateCell(model, me.id, { style: v });
      const ps = pins(r); if (k < 0 || ps[k].x <= ps[1 - k].x) break;
    }
  };
  const H = Math.max(find(L.q1).h, find(L.q2).h), GAP = 40;
  // the column: Q2's emitter (source) straight over Q1's collector (drain)
  { const a = pins(L.q1)[0], b = pins(L.q2)[2]; move(L.q2, a.x - b.x, (a.y - GAP) - b.y); }
  const X = pins(L.q1)[0].x;
  // degeneration chain under Q1's emitter
  let topY = pins(L.q1)[2].y, net = L.nodes.e1;
  for (const r of L.deg) {
    upright(r, net);
    const pc = comp.get(r), k = pc.nodes.indexOf(net), ps = pins(r);
    move(r, X - ps[k].x, topY + GAP - ps[k].y);
    net = pc.nodes.find((n) => n !== net); topY = pins(r)[1 - k].y;
  }
  // load chains over Q2's collector, side by side (the first in the column)
  L.loads.forEach((ch, j) => {
    let botY = pins(L.q2)[0].y, n = L.nodes.c2;
    const x = X + j * 110;
    for (const r of ch) {
      const pc = comp.get(r), other = pc.nodes.find((m) => m !== n);
      upright(r, other);
      const k = pc.nodes.indexOf(n), ps = pins(r);
      move(r, x - ps[k].x, (botY - GAP - (j ? 0 : 20)) - ps[k].y);
      n = other; botY = pins(r)[1 - k].y;
    }
  });
  // input chain on the left of Q1's base, at its height, from the base outwards
  { let n = L.nodes.b1, xr = pins(L.q1)[1].x; const y = pins(L.q1)[1].y;
    for (const r of L.input) {
      const pc = comp.get(r), other = pc.nodes.find((m) => m !== n);
      lying(r, other);
      const k = pc.nodes.indexOf(n), ps = pins(r);
      move(r, (xr - GAP) - ps[k].x, y - ps[k].y);
      n = other; xr = pins(r)[1 - k].x;
    } }
  // output coupling to the right of the collector node
  if (L.out) {
    const pc = comp.get(L.out); lying(L.out, L.nodes.c2);
    const k = pc.nodes.indexOf(L.nodes.c2), ps = pins(L.out), y = (pins(L.q2)[0].y + (L.loads[0] ? pins(L.loads[0][0])[comp.get(L.loads[0][0]).nodes.indexOf(L.nodes.c2)].y : pins(L.q2)[0].y)) / 2;
    move(L.out, (X + Math.max(2, L.loads.length) * 110) - ps[k].x, Math.round(y) - ps[k].y);
  }
  // the bias mirror: RB hanging from the base, Q3 on its left (collector node
  // level with RB's lower end), RREF over Q3 up to the supply
  if (L.bias) {
    const B = L.bias, gb = pins(L.q1)[1];
    upright(B.rb, L.nodes.b1);
    { const k = comp.get(B.rb).nodes.indexOf(L.nodes.b1), ps = pins(B.rb); move(B.rb, (gb.x - 30) - ps[k].x, (gb.y + 30) - ps[k].y); }
    const kb = comp.get(B.rb).nodes.indexOf(B.bn), bot = pins(B.rb)[kb];
    { const c = find(B.q3), g = pins(B.q3)[1]; if (g.x < c.x + c.w / 2) updateCell(model, c.id, { style: { flipH: String(c.style.map.get('flipH') || '0') === '1' ? null : 1 } }); }   // base on the right, facing RB
    // left of the whole input chain (and its port): RREF then rises to the
    // supply without crossing the input line
    const inL = [...L.input.map(find).filter(Boolean), ...cells().filter((v) => v.kind === 'vertex' && classify(v).role === 'port')
      .filter((v) => { const pc = L.input.length && comp.get(L.input[L.input.length - 1]); return pc && pc.nodes.some((n) => String(n).toLowerCase() === String(v.value || '').trim().toLowerCase()); })];
    const xLeft = inL.length ? Math.min(...inL.map((c) => c.x)) - 80 : bot.x - 150;
    { const cp = pins(B.q3)[0]; move(B.q3, Math.min(bot.x - 150, xLeft) - cp.x, (bot.y + 30) - cp.y); }
    upright(B.rref, comp.get(B.rref).nodes.find((n) => n !== B.bn));
    { const k = comp.get(B.rref).nodes.indexOf(B.bn), ps = pins(B.rref), cp = pins(B.q3)[0]; move(B.rref, cp.x - ps[k].x, (cp.y - GAP) - ps[k].y); }
  }
  // the rest around (bias network)
  const tpl = [...L.used];
  const att = new Set(attachPassives(model, parsed, tpl).attached);
  // the remaining parts (bias network, sources) moved TOGETHER — their own
  // arrangement kept — to the left of the template, centred on its height
  const T = tpl.map(find).filter(Boolean);
  const box = { x0: Math.min(...T.map((c) => c.x)), y0: Math.min(...T.map((c) => c.y)), y1: Math.max(...T.map((c) => c.y + c.h)) };
  const rest = cells().filter((v) => v.kind === 'vertex' && classify(v).role === 'component' && !L.used.has(String(v.refdes || '')) && !att.has(String(v.refdes || '')));
  const RAILS = RAIL;
  // (a source between two rails — the supply — in the bottom-left corner: in
  // the middle, ground wires of the bias crossed it)
  const isSupply = (c) => { const pc = comp.get(String(c.refdes)); return pc && ['V', 'I'].includes(pc.prefix) && pc.nodes.slice(0, 2).every((n) => RAIL.test(n)); };
  const sup = rest.filter(isSupply), rest2 = rest.filter((c) => !isSupply(c));
  const all = [...T, ...cells().filter((v) => att.has(String(v.refdes || '')))];
  const xMin = Math.min(...all.map((c) => c.x)), yMax = Math.max(...all.map((c) => c.y + c.h));
  if (rest2.length) {
    const rx1 = Math.max(...rest2.map((c) => c.x + c.w)), ry0 = Math.min(...rest2.map((c) => c.y)), ry1 = Math.max(...rest2.map((c) => c.y + c.h));
    const dx = (xMin - 120) - rx1, dy = (box.y0 + box.y1) / 2 - (ry0 + ry1) / 2;
    for (const c of rest2) move(String(c.refdes), dx, dy);
  }
  let xs = Math.min(xMin, ...rest2.map((c) => find(String(c.refdes)).x)) - 120;
  for (const c of sup) { const cc = find(String(c.refdes)); move(String(c.refdes), (xs - cc.w) - cc.x, (yMax - cc.h) - cc.y); xs -= cc.w + 60; }
  const ids = cells().filter((c) => c.kind === 'edge').map((e) => e.id);
  for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
  await routePage(model, ids, {});
  await alignPorts(model);
  // a port wired to the TOP pin of a standing 2-terminal part (the bias port
  // on its source, under the bias resistor): on the left, a little above the
  // pin, its wire teeing into the vertical over that pin
  {
    const cs = cells(), byId = new Map(cs.map((c) => [c.id, c])), es = cs.filter((c) => c.kind === 'edge');
    for (const v of cs.filter((c) => c.kind === 'vertex' && classify(c).role === 'port')) {
      const own = es.filter((e) => e.source === v.id || e.target === v.id);
      if (own.length !== 1) continue;
      const e = own[0], atSrc = e.source === v.id, part = byId.get(atSrc ? e.target : e.source);
      if (!part || !/^[RCLVI]$/.test(comp.get(String(part.refdes || ''))?.prefix || '')) continue;
      const end = atSrc ? 'entry' : 'exit', pe = atSrc ? 'exit' : 'entry';
      const pin = pinAbs(part, { x: Number(e.style.map.get(end + 'X') ?? 0.5), y: Number(e.style.map.get(end + 'Y') ?? 0.5) });
      const ps = activePins(classify(part)).map((q) => pinAbs(part, q));
      if (ps.length !== 2 || pin.y > Math.min(ps[0].y, ps[1].y) + 1) continue;   // the top pin only
      const y = Math.round(pin.y - 22), x = Math.round(pin.x - 40 - v.w);
      const clear = !cs.some((o) => o.kind === 'vertex' && o.id !== v.id && classify(o).role === 'component' && o.x < x + v.w + 40 && o.x + o.w > x && o.y < y + v.h / 2 + 4 && o.y + o.h > y - v.h / 2 - 4);
      if (!clear) continue;
      updateCell(model, v.id, { x, y: y - Math.round(v.h / 2), style: { flipH: null } });
      updateCell(model, e.id, { points: [{ x: Math.round(pin.x), y }], style: { [pe + 'X']: 1, [pe + 'Y']: 0.5, edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: 1, drawioApiTemplate: 1 } });
    }
  }
  // a port on top of a part (the bias port on its resistor): slid sideways
  for (const v of cells().filter((c) => c.kind === 'vertex' && classify(c).role === 'port')) {
    const hit = (x) => cells().some((o) => o.kind === 'vertex' && o.id !== v.id && classify(o).role === 'component' && o.x < x + v.w + 6 && o.x + o.w + 6 > x && o.y < v.y + v.h && o.y + o.h > v.y);
    if (!hit(v.x)) continue;
    for (const dx of [40, -40, 80, -80, 120, -120, 160, -160]) if (!hit(v.x + dx)) { updateCell(model, v.id, { dx }); break; }
  }
  // the template's own parts stay exact (the straightening pass moved the
  // input chain off the gate's height)
  for (const r of L.used) { const c = find(r); if (c) updateCell(model, c.id, { style: { drawioApiPinned: 1 } }); }
  rebuildLocalDots(model);
}
