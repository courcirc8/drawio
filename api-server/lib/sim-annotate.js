/**
 * sim-annotate.js — SIMULATION RESULTS on the drawing (simulator ↔ drawio
 * bridge, Simulation session + Eric, 2026-10-10; format drawio-sim-annotations/1,
 * ~/ClaudeCode/simulation/passerelle/INTERFACE.md).
 *
 * The simulation stays with the Simulation session; drawio only draws and
 * annotates. An INERT layer is added after routing (cells marked
 * apiAnnotation=1 and drawioSimAnnotation=1, never a wire value: that would
 * rename a net — the principle of lib/annotate.js):
 *   nodes    the DC voltage of each node, next to one pin of that node;
 *   devices  "Ic 4,66 mA · gm 164 mS" (MOS: Id, gm) under each transistor's
 *            name, ORANGE when its region is abnormal (bipolar not "actif
 *            direct", MOS not "saturation");
 *   summary  a box above the drawing: corner / temperature, S21, S11, NF,
 *            supply current, and the optional `summary_extra` lines as given.
 * A node carrying only a port (one part pin) is not annotated.
 * Nodes are found through the DRAWING NETLIST (the one imported — internal
 * nodes are renamed in the drawing): pin k of part R is on node n ⇒ the drawn
 * part R's pin k. Names compared without case. Keys absent are not shown.
 */
import { allCells, cellInfo, addVertex, deleteCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, polylineOf } from './route.js';
import { parseSpice } from './netlist.js';

const FORMAT = /^drawio-sim-annotations\/1(\.|$)/;
const MARK = 'drawioSimAnnotation';

/** 0.000811 V -> "811 µV"; 4.66e-3 A -> "4,66 mA" (French decimal comma, 3 significant digits). */
export function eng(v, unit) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  v = Number(v);
  if (v === 0) return `0 ${unit}`;
  const P = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
  const a = Math.abs(v);
  const [f, p] = P.find(([k]) => a >= k * 0.9995) || P[P.length - 1];
  const x = v / f;
  const s = Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2);
  return `${s.replace('.', ',')} ${p}${unit}`;
}
const dB = (v) => (v == null ? '' : `${Number(v).toFixed(1).replace('.', ',')} dB`);

/** Remove the layer. */
export function clearSim(model) {
  let n = 0;
  for (const c of allCells(model).map(cellInfo)) if (c.kind === 'vertex' && c.style.map.get(MARK) === '1') { deleteCell(model, c.id); n++; }
  return n;
}

/**
 * @param model   the page (drawn, routed)
 * @param sim     the drawio-sim-annotations/1 object
 * @param opts.netlist  the drawing netlist text (the one imported)
 * @param opts.show     Set of 'nodes' | 'devices' | 'summary' (default all)
 * @returns {annotated_nodes, annotated_devices, unmatched (not in the drawing),
 *           unplaced (no clear spot: listed in the summary box), summary}
 */
export function annotateSim(model, sim, { netlist, show = new Set(['nodes', 'devices', 'summary']) } = {}) {
  if (!sim || !FORMAT.test(String(sim.format || ''))) { const e = new Error(`format ${sim?.format} : drawio-sim-annotations/1 attendu`); e.status = 422; throw e; }
  clearSim(model);
  const cells = allCells(model).map(cellInfo), byId = new Map(cells.map((c) => [c.id, c]));
  const verts = cells.filter((c) => c.kind === 'vertex' && c.x != null);
  const parts = new Map(verts.filter((c) => classify(c).role === 'component' && c.refdes).map((c) => [String(c.refdes).toLowerCase(), c]));
  // unmatched: not in the drawing; unplaced: in it, but no clear spot nearby
  // (12 transistors in parallel, Simulation's lna_v6) — their lines go to the summary box
  const unmatched = { nodes: [], devices: [] }, unplaced = { nodes: [], devices: [] }, overflow = [];
  // obstacles: every vertex and wire segment; each placed label joins them
  // (a part's label: its text box estimated from its length — the cell is a fixed 20 px)
  const boxes = verts.filter((c) => c.style.map.get('contactDot') !== '1').map((c) => {
    if (!String(c.id).startsWith('LBL_')) {
      // the DRAWN box (a part turned by 90° keeps its unrotated geometry)
      const r = ((Number(c.style.map.get('rotation') || 0) % 180) + 180) % 180;
      return r === 90 ? { x: c.x + c.w / 2 - c.h / 2, y: c.y + c.h / 2 - c.w / 2, w: c.h, h: c.w } : { x: c.x, y: c.y, w: c.w, h: c.h };
    }
    const tw = Math.max(c.w, 9 * String(c.value || '').length) + 6, al = c.style.map.get('align') || 'center';
    return { x: al === 'right' ? c.x + c.w - tw : al === 'left' ? c.x : c.x + c.w / 2 - tw / 2, y: c.y - 2, w: tw, h: c.h + 4 };
  });
  // a part's value drawn BY the part (no separate label cell): its text box
  // beside the body, from the label position style
  for (const c of verts) {
    if (String(c.id).startsWith('LBL_') || c.style.map.get('noLabel') === '1' || !String(c.value || '').trim() || classify(c).role !== 'component') continue;
    const r = ((Number(c.style.map.get('rotation') || 0) % 180) + 180) % 180;
    const b = r === 90 ? { x: c.x + c.w / 2 - c.h / 2, y: c.y + c.h / 2 - c.w / 2, w: c.h, h: c.w } : { x: c.x, y: c.y, w: c.w, h: c.h };
    const tw = 9 * String(c.value).length + 8, th = 18, lp = c.style.map.get('labelPosition') || 'center', vp = c.style.map.get('verticalLabelPosition') || 'middle';
    const x = lp === 'left' ? b.x - tw : lp === 'right' ? b.x + b.w : b.x + b.w / 2 - tw / 2;
    const y = vp === 'top' ? b.y - th : vp === 'bottom' ? b.y + b.h : b.y + b.h / 2 - th / 2;
    boxes.push({ x, y, w: tw, h: th });
  }
  const segs = [];
  for (const e of cells.filter((c) => c.kind === 'edge')) { const p = polylineOf(e, byId); if (p) for (let i = 1; i < p.length; i++) segs.push([p[i - 1], p[i]]); }
  // (2 px around the text: a wire ending exactly at its edge touched it)
  const hitsSeg = (b0) => { const b = { x: b0.x - 2, y: b0.y - 2, w: b0.w + 4, h: b0.h + 4 }; return segs.some(([a, c]) => (Math.abs(a.x - c.x) < 0.5
    ? a.x > b.x && a.x < b.x + b.w && Math.max(a.y, c.y) > b.y && Math.min(a.y, c.y) < b.y + b.h
    : Math.abs(a.y - c.y) < 0.5 && a.y > b.y && a.y < b.y + b.h && Math.max(a.x, c.x) > b.x && Math.min(a.x, c.x) < b.x + b.w)); };
  const clear = (b) => !boxes.some((o) => o.x < b.x + b.w && o.x + o.w > b.x && o.y < b.y + b.h && o.y + o.h > b.y) && !hitsSeg(b);
  const textW = (s, size) => Math.ceil(String(s).length * size * 0.66) + 8;   // rendered text is wider than 0.58 em per character
  const put = (text, at, offsets, { size = 10, color = '#1f5fa8', bold = false } = {}) => {
    const w = textW(text, size), h = size + 6;
    for (const [dx, dy] of offsets) {
      const b = { x: Math.round(at.x + dx), y: Math.round(at.y + dy), w, h };
      if (!clear(b)) continue;
      addVertex(model, { style: `text;apiAnnotation=1;${MARK}=1;html=1;align=left;verticalAlign=middle;fillColor=none;strokeColor=none;fontSize=${size};fontColor=${color};fontStyle=${bold ? 1 : 0};`, x: b.x, y: b.y, w, h, value: text });
      boxes.push(b);
      return true;
    }
    return false;
  };
  const ring = (w) => [[6, -20], [6, 4], [-w - 6, -20], [-w - 6, 4], [10, -34], [-w - 10, -34], [10, 18], [-w - 10, 18], [24, -8], [-w - 24, -8]];
  let nNodes = 0, nDev = 0;

  // ---- nodes: through the drawing netlist (pin k of part R on node n)
  if (show.has('nodes') && sim.nodes) {
    let parsed = null;
    try { parsed = netlist ? parseSpice(/\.end\b/i.test(netlist) ? netlist : netlist + '\n.end') : null; } catch { parsed = null; }
    const pinsOf = new Map();
    for (const pc of parsed ? parsed.components : []) {
      const cell = parts.get(String(pc.ref).toLowerCase()); if (!cell) continue;
      const ps = activePins(classify(cell));
      pc.nodes.forEach((n, k) => { if (ps[k]) { const key = String(n).toLowerCase(); if (!pinsOf.has(key)) pinsOf.set(key, []); pinsOf.get(key).push(pinAbs(cell, ps[k])); } });
    }
    // a node carrying only a port (one part pin: the IN / OUT of a coupling
    // capacitor) is not annotated — its "0 V" said nothing (Simulation's wish)
    const degree = new Map();
    for (const pc of parsed ? parsed.components : []) for (const n of pc.nodes) degree.set(String(n).toLowerCase(), (degree.get(String(n).toLowerCase()) || 0) + 1);
    for (const [name, v] of Object.entries(sim.nodes)) {
      if (v == null || v.V == null || /^(0|gnd)$/i.test(name)) continue;
      if (parsed && degree.get(name.toLowerCase()) === 1) continue;
      const at = pinsOf.get(name.toLowerCase());
      const txt = eng(v.V, 'V');
      let ok = false;
      for (const p of at || []) if (put(txt, p, ring(textW(txt, 10)))) { ok = true; break; }
      if (ok) nNodes++; else if (at && at.length) { unplaced.nodes.push(name); overflow.push(`${name} : ${txt}`); } else unmatched.nodes.push(name);
    }
  }

  // ---- devices: under the transistor's name
  if (show.has('devices') && sim.devices) {
    for (const [ref, d] of Object.entries(sim.devices)) {
      const cell = parts.get(ref.toLowerCase());
      if (!cell) { unmatched.devices.push(ref); continue; }
      const bip = /npn|pnp/i.test(d.type || '') || d.Ic != null;
      const I = bip ? d.Ic : d.Id;
      const bits = [I != null ? `${bip ? 'Ic' : 'Id'} ${eng(I, 'A')}` : '', d.gm != null ? `gm ${eng(d.gm, 'S')}` : ''].filter(Boolean);
      if (!bits.length) continue;
      const abnormal = d.region != null && (bip ? d.region !== 'actif direct' : d.region !== 'saturation');
      const txt = bits.join(' · ') + (abnormal ? ` (${d.region})` : '');
      const lbl = verts.find((c) => String(c.id) === 'LBL_' + cell.refdes || String(c.id) === 'LBL_' + cell.id);
      const at = lbl ? { x: lbl.x, y: lbl.y + lbl.h } : { x: cell.x + cell.w, y: cell.y + cell.h / 2 };
      const tw = textW(txt, 10);
      // under its name first, then all around the part
      const offs = [[0, 2], [0, 16], [0, -30]];
      const c0 = { x: cell.x - at.x, y: cell.y - at.y };
      for (const [fx, fy] of [[1, 0.5], [0, 1], [0, -0.2], [-1, 0.5], [1, 1], [1, -0.2], [-1, 1], [-1, -0.2]]) {
        const bx = fx === 1 ? cell.w + 6 : fx === -1 ? -tw - 6 : 0, by = fy === 1 ? cell.h + 4 : fy < 0 ? -20 : cell.h / 2 - 8;
        for (const k of [0, 14, -14, 28, -28, 42]) offs.push([c0.x + bx, c0.y + by + k]);
      }
      for (const [dx, dy] of [[0, cell.h + 30], [0, -50], [cell.w + 30, 0], [-tw - 40, 0], [0, cell.h + 50], [-tw - 40, cell.h], [cell.w + 30, cell.h]]) offs.push([c0.x + dx, c0.y + dy]);
      if (put(txt, at, offs, { color: abnormal ? '#d9730d' : '#2e7d32', bold: abnormal })) nDev++;
      else { unplaced.devices.push(ref); overflow.push(`${ref} : ${txt}`); }
    }
  }

  // ---- summary box above the drawing
  let summary = null;
  if (show.has('summary')) {
    const lines = [];
    const s = sim.simulator || {};
    if (s.corner || s.temp_C != null) lines.push([s.corner, s.temp_C != null ? `${s.temp_C} °C` : ''].filter(Boolean).join(' · '));
    const ac = sim.ac || {};
    const rf = [ac.S21_dB != null ? `S21 ${dB(ac.S21_dB)}` : '', ac.S11_dB != null ? `S11 ${dB(ac.S11_dB)}` : '', ac.NF_dB != null ? `NF ${dB(ac.NF_dB)}` : ''].filter(Boolean);
    if (rf.length) lines.push(rf.join(' · ') + (ac.f_Hz ? ` à ${eng(ac.f_Hz, 'Hz')}` : ''));
    const I = Object.values(sim.supplies || {}).reduce((t, x) => t + (Number(x.I) || 0), 0);
    if (I) lines.push(`alimentation ${eng(I, 'A')}`);
    // free lines given by the simulation, shown as they are (IIP3, P1dB…)
    for (const l of Array.isArray(sim.summary_extra) ? sim.summary_extra : []) if (String(l).trim()) lines.push(String(l).trim().replace(/[<>]/g, ''));
    // the values with no clear spot on the drawing, listed here (never dropped)
    for (const l of overflow) lines.push(l);
    if (lines.length) {
      const x0 = Math.min(...verts.map((c) => c.x)), y0 = Math.min(...verts.map((c) => c.y));
      const w = Math.max(...lines.map((l) => textW(l, 11))) + 12, h = lines.length * 16 + 10;
      addVertex(model, { style: `text;apiAnnotation=1;${MARK}=1;html=1;align=left;verticalAlign=top;fillColor=#f7f9fc;strokeColor=#9aa9bd;rounded=1;fontSize=11;fontColor=#222222;spacingLeft=6;spacingTop=4;whiteSpace=wrap;`,
        x: Math.round(x0), y: Math.round(y0 - h - 24), w, h, value: lines.join('<br>') });
      summary = lines;
    }
  }
  return { annotated_nodes: nNodes, annotated_devices: nDev, unmatched, unplaced, summary };
}
