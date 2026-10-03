/**
 * conventions.js — does a generated schematic follow the drawing conventions
 * of PUBLISHED schematics of the same function?
 *
 * The layout checks are weighted by how often the archive's schematics of the
 * recognised type follow them (data/ieee-motifs.json, by_type[t].layout):
 * supply on top is worth 0.90 for an LNA, 0.80 overall; symmetry 0.83 for a
 * mixer, 0.27 for a reference. Motif checks (load on the side of its rail,
 * degeneration below its device, input match before the gate, follower load
 * below, bridge legs vertical) carry a fixed weight MOTIF_W: the archive does
 * not count them, they are textbook rules the IEEE readings were checked
 * against by eye (docs/ieee-motifs.md).
 *
 * score = Σ weight·pass / Σ weight over the checks that APPLY to the circuit.
 * Pure geometry on the page: never moves anything.
 */
import { allCells, cellInfo } from './model.js';
import { detectMotifs, railNets } from './motifs.js';
import { recognizeFunction, netRoles, STATS } from './function.js';

const MOTIF_W = 0.8;

function centres(model) {
  const pos = new Map();
  for (const c of allCells(model).map(cellInfo)) if (c.kind === 'vertex' && c.refdes && c.x != null) pos.set(c.refdes, { x: c.x + c.w / 2, y: c.y + c.h / 2 });
  return pos;
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/** Convention report of a placed page. opts.type forces the circuit type
 *  (otherwise recognizeFunction's first guess). */
export function conventionReport(model, parsed, opts = {}) {
  const pos = centres(model);
  const fn = opts.type ? null : recognizeFunction(parsed);
  const type = opts.type || fn.types[0].type;
  const layout = (STATS.by_type[type] || STATS.by_type.tous).layout;
  const lw = (k) => (layout[k] ?? STATS.by_type.tous.layout[k] ?? 0.5);
  const roles = netRoles(parsed);
  const rails = railNets(parsed.components);
  const comps = parsed.components.filter((c) => c.prefix !== 'V' && pos.has(c.ref));
  const checks = [];
  const push = (name, weight, pass, detail) => checks.push({ name, weight: +weight.toFixed(3), pass, detail });

  // supply on top: parts on the supply sit above the parts on ground
  const supply = [...rails].filter((n) => n !== '0');
  if (supply.length) {
    const onS = comps.filter((c) => c.nodes.some((n) => supply.includes(n)) && !c.nodes.includes('0')).map((c) => pos.get(c.ref).y);
    const onG = comps.filter((c) => c.nodes.includes('0') && !c.nodes.some((n) => supply.includes(n))).map((c) => pos.get(c.ref).y);
    if (onS.length && onG.length) push('supply-top', lw('supply_top'), mean(onS) < mean(onG), { supplyY: Math.round(mean(onS)), groundY: Math.round(mean(onG)) });
  }
  // signal left to right: parts on input nets left of parts on output nets
  const ins = Object.keys(roles).filter((n) => roles[n] === 'input'), outs = Object.keys(roles).filter((n) => roles[n] === 'output');
  if (ins.length && outs.length) {
    const xi = mean(comps.filter((c) => c.nodes.some((n) => ins.includes(n))).map((c) => pos.get(c.ref).x));
    const xo = mean(comps.filter((c) => c.nodes.some((n) => outs.includes(n))).map((c) => pos.get(c.ref).x));
    if (xi != null && xo != null) push('signal-left-to-right', lw('signal_left-to-right'), xi < xo, { inputX: Math.round(xi), outputX: Math.round(xo) });
  }
  // symmetry: the two devices of each pair on one row
  const mo = detectMotifs(parsed);
  const pairs = mo.instances.filter((i) => i.motif === 'differential-pair' || i.motif === 'cross-coupled-pair');
  if (pairs.length) {
    const ok = pairs.filter((i) => { const [a, b] = i.refs.map((r) => pos.get(r)); return a && b && Math.abs(a.y - b.y) < 6; }).length;
    push('symmetric-pairs', lw('symmetric'), ok === pairs.length, { pairs: pairs.length, onOneRow: ok });
  }
  // motif-local conventions
  const railOf = (ref) => parsed.components.find((c) => c.ref === ref).nodes.find((n) => rails.has(n));
  const down = (n) => n === '0' || /^(vee|vss|v-)$/i.test(n || '');
  const rel = (a, b) => { const pa = pos.get(a), pb = pos.get(b); return pa && pb ? { dx: pa.x - pb.x, dy: pa.y - pb.y } : null; };
  for (const i of mo.instances) {
    if (i.motif === 'load') { const r = rel(i.refs[0], i.device); if (r) push(`load-on-rail-side:${i.refs[0]}`, MOTIF_W, down(railOf(i.refs[0])) ? r.dy > 20 : r.dy < -20, r); }
    if (i.motif === 'inductive-degeneration') { const r = rel(i.refs[0], i.device); if (r) push(`degeneration-below:${i.refs[0]}`, MOTIF_W, r.dy > 20, r); }
    if (i.motif === 'matching-network') { const r = rel(i.refs[0], i.device); if (r) push(`match-before-gate:${i.refs[0]}`, MOTIF_W, r.dx < -20, r); }
    if (i.motif === 'source-follower') for (const l of i.refs.slice(1)) { const r = rel(l, i.device); if (r) push(`follower-load-below:${l}`, MOTIF_W, r.dy > 20, r); }
    if (i.motif === 'diode-bridge' || i.motif === 'switch-bridge') {
      // every series pair of the bridge shares a column
      const devs = i.refs.filter((r) => /^[DS]/i.test(r) && pos.has(r));
      const cols = new Set(devs.map((r) => Math.round(pos.get(r).x / 10)));
      push(`bridge-legs-vertical:${i.refs[0]}`, MOTIF_W, cols.size <= Math.ceil(devs.length / 2) * (i.motif === 'switch-bridge' ? 2 : 1), { devices: devs.length, columns: cols.size });
    }
  }
  const W = checks.reduce((s, c) => s + c.weight, 0);
  const score = W ? +(checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0) / W).toFixed(3) : null;
  return { type, typeGuess: fn ? fn.types.slice(0, 3) : null, score, checks, failed: checks.filter((c) => !c.pass).map((c) => c.name) };
}
