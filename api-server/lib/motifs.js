/**
 * motifs.js — declarative registry of the analogue motifs the generator
 * recognises, and the macro-block view of a netlist they induce.
 *
 * WHY: the placement recipes ("gabarits" — quad, latch, half-latch, cascade,
 * ring, Miller lane, passive axis…) live as code paths inside place2.js
 * (2 000+ lines) with their detectors scattered next to them. Nothing lists
 * WHICH motifs exist, what rule of training/RULES.md each implements, or
 * which components of a given netlist fall under NO motif at all — and that
 * last set is exactly where the generator fails (holdout LTspice corpus,
 * 2026-09-18: discrete BJT stages with resistive bias, 46 errors on a
 * differential pair that no template claims).
 *
 * This module is the registry the next placement generation builds on
 * ("motif -> macro-block -> placement between blocks", the combination no
 * open-source tool has). It does NOT move anything: it names, detects and
 * reports. place2 keeps its own detectors for now; the registry's detectors
 * are re-derived from lib/patterns.js structures and independent graph
 * predicates, so a disagreement between the two is itself a finding.
 */
import { detectStructures, isPmosLike } from './patterns.js';

const isActive = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';
// amplifying blocks that are not transistors: op-amps (X), OTAs (G), VCVS (E)
const isAmplifier = (c) => c.prefix === 'X' || c.prefix === 'G' || c.prefix === 'E';
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];
const INPUT_RE = /^(in|vin|rf|sig|lo|clk|inp|inm|inn|vip|vim)/i;
const OUTPUT_RE = /^(out|vout|if|sa|outp|outm|outn|op|om)/i;

/** Registry. `recipe` names the placement mechanism that consumes the motif
 *  today ('place2:…') or 'none' when no template exists yet. */
export const MOTIFS = [
  { name: 'diode-connected', rules: [6, 24, 32, 58], recipe: 'place2:side-diode / in-column BJT diode',
    describe: 'MOS/BJT with gate tied to drain (bias reference); hugs its node, frame outside the body.' },
  { name: 'differential-pair', rules: [14, 18, 25, 36], recipe: 'place2:same-row pair, mirrored, tail centred',
    describe: 'Two same-polarity actives sharing a non-rail source net with distinct gates.' },
  { name: 'current-mirror', rules: [26, 28], recipe: 'place2:single-row mirror, gate bus',
    describe: 'Same gate net + a diode in the group; members on the diode row, gates face the centre.' },
  { name: 'cascode', rules: [10, 27], recipe: 'place2:conduction stack (same column)',
    describe: 'Drain of the lower device is the source of the upper one, internal net with exactly two terminals.' },
  { name: 'cross-coupled-pair', rules: [33, 34, 54, 64], recipe: 'place2:gates to centre, deliberate X',
    describe: 'Two same-polarity actives, each gate on the other drain (VCO core, latch half).' },
  { name: 'tail', rules: [14], recipe: 'place2:below its pair, centred',
    describe: 'Device or current source feeding a differential pair source net.' },
  { name: 'gilbert-quad', rules: [15, 36, 51], recipe: 'place2:quad template (drain rails, adjacent pairs)',
    describe: 'Two pairs whose tail nets are the two drains of a lower RF pair.' },
  { name: 'latch', rules: [55], recipe: 'place2:latch template (precharge/ccP/ccN trunk per output)',
    describe: 'Two cross-coupled pairs of opposite polarity on the same two nets (StrongARM).' },
  { name: 'half-latch', rules: [59], recipe: 'place2:latch template (half)',
    describe: 'One cross-coupled pair + a diff pair of the opposite polarity on the same drains (delay cell).' },
  { name: 'cascade', rules: [64], recipe: 'place2:two-stage cascade template',
    describe: 'Drains of pair A are the gates of pair B (Cherry-Hooper, multi-stage amplifiers).' },
  { name: 'inverter', rules: [58], recipe: 'place2:conduction stack',
    describe: 'NMOS + PMOS with common gate and common drain.' },
  { name: 'ring', rules: [58], recipe: 'place2:ring template (return net in a lane below)',
    describe: 'Cycle of inverters, output of the last feeding the input of the first.' },
  { name: 'miller-capacitor', rules: [49, 59], recipe: 'place2:feedback lane between rows',
    describe: 'Capacitor between gate and drain of one device that is not cross-coupled.' },
  { name: 'shunt-feedback', rules: [59], recipe: 'place2:feedback lane (Miller rule)',
    describe: 'Resistor between gate and drain of one device (TIA, inverter amplifier).' },
  { name: 'passive-axis', rules: [56, 57], recipe: 'place2:horizontal signal axis, ports at both ends',
    describe: 'No active device: series path drawn on a horizontal axis input -> output, shunts below.' },
  { name: 'bjt-resistive-stage', rules: [], recipe: 'none — holdout gap (2026-09-18)',
    describe: 'BJT/JFET whose base/gate is biased by a resistive divider from the rail and whose collector/drain load is a resistor: the classic discrete stage; no template yet.' },
  { name: 'opamp-stage', rules: [], recipe: 'none — holdout gap (2026-09-18)',
    describe: 'Op-amp (X) with a feedback passive between its output and inverting input (inverting/non-inverting/integrator stages); no template yet.' },
];

/** Detect every motif instance of a parsed netlist.
 *  Returns {instances:[{motif, refs, nets?, extra}], blocks, uncovered, coverage, summary}. */
export function detectMotifs(parsed) {
  const comps = parsed.components;
  const byRef = new Map(comps.map((c) => [c.ref, c]));
  const st = detectStructures(parsed);
  const inst = [];
  const add = (motif, refs, extra = {}) => inst.push({ motif, refs: [...new Set(refs)], ...extra });

  for (const d of st.diodes) add('diode-connected', [d.ref], { net: d.net });
  for (const p of st.diffPairs) add('differential-pair', p.refs, { tailNet: p.tailNet, gates: p.gates });
  for (const m of st.mirrors) add('current-mirror', m.refs, { diode: m.diode, gateNet: m.gateNet });
  for (const c of st.cascodes) add('cascode', [c.top, c.bottom], { net: c.net });
  for (const c of st.crossCoupled) add('cross-coupled-pair', c.refs, { nets: c.nets });
  for (const t of st.tails) add('tail', [t.ref], { pair: t.pair });
  for (const q of st.quads) add('gilbert-quad', q.refs, { rfPair: q.rfPair, pairs: q.pairs });

  // latch / half-latch — from cross-coupled pairs and diff pairs on the same nets
  const netKey = (nets) => [...nets].sort().join('|');
  const ccByNets = new Map();
  for (const c of st.crossCoupled) {
    const k = netKey(c.nets);
    if (!ccByNets.has(k)) ccByNets.set(k, []);
    ccByNets.get(k).push(c);
  }
  for (const [k, list] of ccByNets) {
    const pol = (c) => isPmosLike(byRef.get(c.refs[0]));
    const p = list.filter((c) => pol(c)), n = list.filter((c) => !pol(c));
    if (p.length && n.length) add('latch', [...p[0].refs, ...n[0].refs], { nets: k.split('|') });
    else if (list.length === 1) {
      // a diff pair of the opposite polarity whose drains are these two nets?
      const cc = list[0];
      const ccPol = pol(cc);
      for (const dp of st.diffPairs) {
        const a = byRef.get(dp.refs[0]), b = byRef.get(dp.refs[1]);
        if (isPmosLike(a) === ccPol) continue;
        if (netKey([D(a), D(b)]) === k) add('half-latch', [...cc.refs, ...dp.refs], { nets: k.split('|') });
      }
    }
  }

  // cascade — drains of pair A == gates of pair B
  for (const A of st.diffPairs) {
    const a = byRef.get(A.refs[0]), b = byRef.get(A.refs[1]);
    const drainsA = netKey([D(a), D(b)]);
    for (const B of st.diffPairs) {
      if (A === B) continue;
      if (netKey(B.gates) === drainsA) add('cascade', [...A.refs, ...B.refs], { stageA: A.refs, stageB: B.refs, nets: drainsA.split('|') });
    }
  }

  // inverters + ring
  const mos = comps.filter((c) => c.prefix === 'M');
  const inverters = [];
  for (const n of mos.filter((c) => !isPmosLike(c))) {
    for (const p of mos.filter((c) => isPmosLike(c))) {
      if (G(n) === G(p) && D(n) === D(p) && G(n) !== D(n)) { inverters.push({ refs: [n.ref, p.ref], in: G(n), out: D(n) }); add('inverter', [n.ref, p.ref], { in: G(n), out: D(n) }); }
    }
  }
  if (inverters.length >= 3) {
    const byIn = new Map(inverters.map((i) => [i.in, i]));
    const seen = new Set();
    for (const start of inverters) {
      if (seen.has(start)) continue;
      const cyc = [start]; let cur = start;
      while (true) { const nx = byIn.get(cur.out); if (!nx || cyc.includes(nx)) { if (nx === start && cyc.length >= 3) { cyc.forEach((i) => seen.add(i)); add('ring', cyc.flatMap((i) => i.refs), { stages: cyc.length, returnNet: cur.out }); } break; } cyc.push(nx); cur = nx; }
    }
  }

  // Miller / shunt feedback: passive between gate and drain of ONE device
  const ccRefs = new Set(st.crossCoupled.flatMap((c) => c.refs));
  for (const c of comps) {
    if (c.prefix !== 'C' && c.prefix !== 'R') continue;
    const [n1, n2] = c.nodes;
    for (const t of comps.filter(isActive)) {
      if (ccRefs.has(t.ref)) continue;
      const gd = new Set([G(t), D(t)]);
      if (gd.size === 2 && gd.has(n1) && gd.has(n2) && n1 !== n2) add(c.prefix === 'C' ? 'miller-capacitor' : 'shunt-feedback', [c.ref, t.ref], { device: t.ref });
    }
  }

  // passive axis — no transistor AND no amplifier block
  if (!comps.some((c) => isActive(c) || isAmplifier(c)) && comps.length) {
    const nets = new Set(comps.flatMap((c) => c.nodes));
    const ins = [...nets].filter((n) => INPUT_RE.test(n)), outs = [...nets].filter((n) => OUTPUT_RE.test(n));
    add('passive-axis', comps.map((c) => c.ref), { inputs: ins, outputs: outs });
  }

  // BJT/JFET resistive stage (the holdout gap): base/gate biased by a
  // resistor from a rail or from a resistive divider between rails, and a
  // resistive collector/drain load to a rail. "Rail" = ground, a named
  // supply, or any net a V source ties to ground (LTspice decks name their
  // supply n4 as happily as Vcc).
  const rails = new Set(['0']);
  for (const n of new Set(comps.flatMap((c) => c.nodes))) if (/^(vdd|vcc|vee|vss|avdd|dvdd|v\+|v-)$/i.test(n)) rails.add(n);
  for (const v of comps.filter((c) => c.prefix === 'V')) { if (v.nodes[1] === '0') rails.add(v.nodes[0]); if (v.nodes[0] === '0') rails.add(v.nodes[1]); }
  const resistorsOn = (net) => comps.filter((c) => c.prefix === 'R' && c.nodes.includes(net));
  const toRail = (r) => r.nodes.some((n) => rails.has(n));
  const dividerNode = (net) => resistorsOn(net).filter(toRail).length >= 2;
  for (const t of comps.filter((c) => c.prefix === 'Q' || c.prefix === 'J')) {
    const baseR = resistorsOn(G(t)).filter((r) => toRail(r) || r.nodes.some((n) => n !== G(t) && dividerNode(n)));
    const loadR = resistorsOn(D(t)).filter(toRail);
    if (baseR.length >= 1 && loadR.length >= 1) {
      const divider = baseR.flatMap((r) => r.nodes.filter((n) => n !== G(t) && !rails.has(n) && dividerNode(n))).flatMap((n) => resistorsOn(n).filter(toRail));
      add('bjt-resistive-stage', [t.ref, ...baseR.map((r) => r.ref), ...divider.map((r) => r.ref), ...loadR.map((r) => r.ref)], { device: t.ref });
    }
  }

  // op-amp stage: X with a passive from out to in-
  for (const x of comps.filter((c) => c.prefix === 'X')) {
    const inm = x.nodes[1], out = x.nodes[2];
    const fb = comps.filter((c) => (c.prefix === 'R' || c.prefix === 'C') && c.nodes.includes(inm) && c.nodes.includes(out));
    if (fb.length) add('opamp-stage', [x.ref, ...fb.map((c) => c.ref)], { device: x.ref });
  }

  // macro-blocks: greedy union of overlapping instances of STRUCTURAL motifs
  // (a component belongs to one block); decorations (diode, tail, feedback)
  // attach to the block of their device
  const structural = new Set(['gilbert-quad', 'latch', 'half-latch', 'cascade', 'ring', 'differential-pair', 'current-mirror', 'cross-coupled-pair', 'cascode', 'inverter', 'passive-axis', 'bjt-resistive-stage', 'opamp-stage']);
  const blockOf = new Map();
  const blocks = [];
  const ordered = [...inst].sort((a, b) => b.refs.length - a.refs.length);
  for (const i of ordered) {
    if (!structural.has(i.motif)) continue;
    const free = i.refs.filter((r) => !blockOf.has(r));
    if (free.length < Math.ceil(i.refs.length / 2)) continue;   // mostly already claimed by a bigger motif
    const blk = { id: 'B' + (blocks.length + 1), motif: i.motif, refs: [...free], recipe: MOTIFS.find((m) => m.name === i.motif)?.recipe || 'none' };
    blocks.push(blk);
    for (const r of free) blockOf.set(r, blk.id);
  }
  for (const i of inst) {
    if (structural.has(i.motif)) continue;
    const host = i.refs.map((r) => blockOf.get(r)).find(Boolean);
    if (host) { const blk = blocks.find((b) => b.id === host); for (const r of i.refs) if (!blockOf.has(r)) { blk.refs.push(r); blockOf.set(r, blk.id); } blk.decorations = [...(blk.decorations || []), i.motif]; }
  }
  const uncovered = comps.map((c) => c.ref).filter((r) => !blockOf.has(r));
  const uncoveredActive = uncovered.filter((r) => isActive(byRef.get(r)) || isAmplifier(byRef.get(r)));
  const summary = {};
  for (const i of inst) summary[i.motif] = (summary[i.motif] || 0) + 1;
  return {
    instances: inst, blocks, uncovered, uncoveredActive,
    coverage: comps.length ? +(1 - uncovered.length / comps.length).toFixed(3) : 1,
    activeCoverage: comps.filter((c) => isActive(c) || isAmplifier(c)).length ? +(1 - uncoveredActive.length / comps.filter((c) => isActive(c) || isAmplifier(c)).length).toFixed(3) : 1,
    summary,
  };
}
