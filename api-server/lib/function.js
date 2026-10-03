/**
 * function.js — what a netlist IS (LNA, VCO, op-amp, reference, rectifier…)
 * and what each of its blocks and nets does.
 *
 * WHY: the generator places by structure (motifs, blocks) but never knew the
 * circuit's function, so it could not use the conventions published schematics
 * of that function follow (data/ieee-motifs.json: an LNA puts its supply on top
 * in 90 % of 195 published schematics, a mixer is drawn symmetric in 83 %).
 *
 * Method — no training, the statistics of the IEEE archive are the model:
 *   naive Bayes over circuit types t:
 *     log P(t)                                     prior = share of t in the archive
 *   + Σ_motifs  log P(motif present | t)          motif_share of t (detected or absent)
 *   + Σ_kinds   log P(component kind present | t) 1 - exp(-mean count) (Poisson)
 *   + net-name cues (rf/lo/if, clk, vco…)         small, hand-set, documented below
 * Power circuits are absent from the archive's types: the bridge motifs of
 * lib/motifs.js decide them by rule (rectifier, inverter, DC-DC).
 *
 * Measured on benchmark/function-labels.json (tuning circuits only).
 */
import fs from 'node:fs';
import { detectMotifs, railNets } from './motifs.js';
import { isPmosLike } from './patterns.js';

const STATS = JSON.parse(fs.readFileSync(new URL('../data/ieee-motifs.json', import.meta.url), 'utf8'));
const TYPES = Object.keys(STATS.by_type).filter((t) => t !== 'tous' && t !== 'sans type');
const ALPHA = Number(process.env.FN_ALPHA ?? 0.25);
const KW = Number(process.env.FN_KW ?? 0.5);
const clamp = (p) => Math.min(0.97, Math.max(0.03, p));

/** Motifs our detectors can see AND the archive counts. */
function usableMotifs() {
  const known = new Set(Object.keys(STATS.by_type.tous.motif_share));
  return ['differential-pair', 'current-mirror', 'cascode', 'cross-coupled-pair', 'diode-connected', 'tail', 'latch',
    'inverter', 'common-source', 'common-gate', 'source-follower', 'switch', 'inductive-degeneration',
    'resistive-feedback', 'matching-network'].filter((m) => known.has(m));
}
const MOTIF_KEYS = usableMotifs();

/** Component kinds as the archive names them. V sources are left out: a
 *  simulation deck always has some, a published schematic rarely draws them. */
function kindsOf(parsed) {
  const k = new Set();
  for (const c of parsed.components) {
    if (c.prefix === 'M') k.add(isPmosLike(c) ? 'pmos' : 'nmos');
    else if (c.prefix === 'Q') k.add(isPmosLike(c) ? 'pnp' : 'npn');
    else if ('RCL'.includes(c.prefix)) k.add(c.prefix);
    else if (c.prefix === 'D') k.add('diode');
    else if (c.prefix === 'S') k.add('switch');
    else if (c.prefix === 'X' || c.prefix === 'E') k.add('opamp');
    else if (c.prefix === 'I') k.add('isource');
    else if (c.prefix === 'J') k.add('jfet');
  }
  return k;
}
const KIND_KEYS = ['nmos', 'pmos', 'npn', 'pnp', 'R', 'C', 'L', 'diode', 'switch', 'opamp', 'isource', 'jfet'];

/** Net-name cues: [regex on any net name, type, log-likelihood bonus]. Hand-set,
 *  deliberately weak (a name is a hint, the structure decides). */
const NAME_CUES = [
  [/^(lo|lo[pmn+-]?|if|if[pmn+-]?)$/i, 'mixer', 1.5],
  [/^(rf|rf[pmn+-]?|rfin|ant)$/i, 'LNA', 0.8], [/^(rf|rf[pmn+-]?)$/i, 'mixer', 0.6],
  [/^(clk|clkb|ck|phi\d?)$/i, 'ADC', 0.4], [/^(clk|clkb|ck)$/i, 'logic', 0.4], [/^(clk|clkb|ck)$/i, 'clock', 0.4],
  [/^(up|dn|down|cp|vctrl|vtune|vc)$/i, 'PLL', 0.8], [/^(vtune|vctrl|vc)$/i, 'VCO', 0.8],
  [/^(vref|vbg|vptat|iref)$/i, 'reference', 1.2],
  [/^(lx|sw|vsw)$/i, 'DC-DC', 0.8],
];

/** Naive-Bayes ranking of the archive's types from motif and component-kind
 *  PRESENCE (and net names when known). Shared by netlists and figure readings. */
function bayesTypes(present, kinds, nets = [], stats = STATS) {
  const types0 = Object.keys(stats.by_type).filter((t) => t !== 'tous' && t !== 'sans type');
  const total = types0.reduce((s, t) => s + stats.by_type[t].schematics, 0);
  const scores = [];
  for (const t of types0) {
    const st = stats.by_type[t];
    // prior TEMPERED (exponent ALPHA): the archive's share of a type says how
    // often journals publish it, not how often a user asks for it — at full
    // weight logic/memory (1 586 of 6 900 typed schematics) absorbed the errors
    let ll = ALPHA * Math.log(st.schematics / total);
    const why = [];
    for (const m of MOTIF_KEYS) {
      const p = clamp(st.motif_share[m] ?? 0);
      const has = present.has(m);
      ll += Math.log(has ? p : 1 - p);
      if (has && p > 0.3) why.push(`${m} (${Math.round(p * 100)} % of published ${t})`);
    }
    for (const k of KIND_KEYS) {
      const p = clamp(1 - Math.exp(-(st.component_share[k] ?? 0)));
      ll += KW * Math.log(kinds.has(k) ? p : 1 - p);   // reduced weight: kinds are correlated
    }
    for (const [re, ty, bonus] of NAME_CUES) if (ty === t && nets.some((n) => re.test(n))) { ll += bonus; why.push(`net name ${nets.find((n) => re.test(n))}`); }
    scores.push({ type: t, ll, why });
  }
  const max = Math.max(...scores.map((s) => s.ll));
  const z = scores.reduce((s, x) => s + Math.exp(x.ll - max), 0);
  return scores.map((s) => ({ type: s.type, p: +(Math.exp(s.ll - max) / z).toFixed(3), why: s.why }))
    .sort((a, b) => b.p - a.p);
}

/** Recognition from LABELS instead of a netlist: the motifs and component
 *  kinds a vision reading of a published figure lists (figures.sqlite
 *  `lectures`: motifs[], components[{kind}]). Same model as recognizeFunction,
 *  no net names, no power rules (the readings have no bridge labels). */
export function recognizeFromLabels({ motifs = [], kinds = [] } = {}, stats = STATS) {
  const present = new Set(motifs);
  const k = new Set(kinds);
  return { types: bayesTypes(present, k, [], stats), motifs: [...present], kinds: [...k], rule: 'bayes-labels' };
}

/** Rank circuit types for a parsed netlist. Returns
 *  {types:[{type, p, why:[…]}], motifs, kinds, evidence}. */
export function recognizeFunction(parsed) {
  const mo = detectMotifs(parsed);
  const present = new Set(mo.instances.map((i) => i.motif));
  const kinds = kindsOf(parsed);
  const nets = [...new Set(parsed.components.flatMap((c) => c.nodes))];
  // power circuits: the archive has no rectifier/inverter type — decided by rule
  if (present.has('switch-bridge') || present.has('diode-bridge')) {
    const sw = present.has('switch-bridge');
    const type = sw ? 'inverter' : 'rectifier';
    return { types: [{ type, p: 0.9, why: [sw ? 'switch legs (switch-bridge)' : 'diode legs (diode-bridge)'] }], motifs: [...present], kinds: [...kinds], rule: 'power' };
  }
  const noAmp = !parsed.components.some((c) => 'MQJXEG'.includes(c.prefix));
  const diodes = parsed.components.filter((c) => c.prefix === 'D');
  // zener: a diode with its anode on ground, cathode on a node fed by a
  // resistor (shunt regulator, reference of a series-pass regulator)
  const zener = diodes.find((d) => d.nodes[0] === '0' && (/zener|bz[xv]|1n47|1n52/i.test(d.model || d.value || '') ||
    parsed.components.some((r) => r.prefix === 'R' && r.nodes.includes(d.nodes[1]))));
  if (zener && /zener|bz[xv]|1n47|1n52/i.test(zener.model || zener.value || '')) {
    return { types: [{ type: 'reference', p: 0.8, why: [`zener ${zener.ref} fed by a resistor (voltage regulator / reference)`] }], motifs: [...present], kinds: [...kinds], rule: 'zener' };
  }
  // half-wave rectifier: no amplifier, a diode in series from an AC source node to a node shunted to ground by C
  const acNets = new Set(parsed.components.filter((v) => v.prefix === 'V' && /\b(sin|sine|ac)\b/i.test(v.value || '')).flatMap((v) => v.nodes));
  if (noAmp && diodes.some((d) => acNets.has(d.nodes[0]) && parsed.components.some((c) => c.prefix === 'C' && c.nodes.includes(d.nodes[1]) && c.nodes.includes('0')))) {
    return { types: [{ type: 'rectifier', p: 0.8, why: ['diode from an AC source to a capacitor-smoothed node'] }], motifs: [...present], kinds: [...kinds], rule: 'power' };
  }
  if (noAmp && parsed.components.some((c) => c.prefix === 'S') && parsed.components.some((c) => c.prefix === 'L') && parsed.components.some((c) => c.prefix === 'D')) {
    return { types: [{ type: 'DC-DC', p: 0.8, why: ['switch + freewheel diode + inductor, no amplifier'] }], motifs: [...present], kinds: [...kinds], rule: 'power' };
  }
  const types = bayesTypes(present, kinds, nets);
  return { types, motifs: [...present], kinds: [...kinds], rule: 'bayes' };
}

/** Role of each net: supply, ground, input, output, bias, clock, internal. */
export function netRoles(parsed) {
  const rails = railNets(parsed.components);
  const roles = {};
  const sig = new Set(parsed.components.filter((c) => c.prefix === 'V' && /\b(ac|sin|sine|pulse|pwl)\b/i.test(c.value || '')).flatMap((c) => c.nodes).filter((n) => n !== '0'));
  for (const n of new Set(parsed.components.flatMap((c) => c.nodes))) {
    if (n === '0') roles[n] = 'ground';
    else if (/^(clk|clkb|ck|phi\d?|ck\d)$/i.test(n)) roles[n] = 'clock';
    else if (rails.has(n)) roles[n] = 'supply';
    else if (sig.has(n) || /^(in|vin|rf|inp|inm|inn|vip|vim|lo)/i.test(n)) roles[n] = 'input';
    else if (/^(out|vout|if|outp|outm|outn|op|om)/i.test(n)) roles[n] = 'output';
    else if (/^(vb|vbias|bias|vcas|vref|vbn|vbp|vcm)/i.test(n)) roles[n] = 'bias';
    else roles[n] = 'internal';
  }
  return roles;
}

/** Plain-language role of each macro-block (by its motif). */
const BLOCK_ROLE = {
  'differential-pair': 'differential stage', 'current-mirror': 'current mirror (bias or active load)',
  'cascode': 'cascode stage', 'cross-coupled-pair': 'cross-coupled pair (negative resistance / regeneration)',
  'gilbert-quad': 'Gilbert switching quad', latch: 'regenerative latch (comparator)', 'half-latch': 'delay cell',
  cascade: 'cascaded gain stages', inverter: 'CMOS inverter', ring: 'ring oscillator',
  'passive-axis': 'passive network (filter / matching / divider)', 'bjt-resistive-stage': 'discrete BJT gain stage',
  'opamp-stage': 'op-amp feedback stage', 'common-source': 'common-source gain stage', 'common-gate': 'common-gate stage',
  'source-follower': 'follower (buffer)', switch: 'switch (sampling / chopping)',
  'diode-bridge': 'rectifier bridge', 'switch-bridge': 'switching bridge (inverter leg)', rest: 'unclassified parts',
};
export function blockRoles(parsed) {
  return detectMotifs(parsed).blocks.map((b) => ({ id: b.id, motif: b.motif, role: BLOCK_ROLE[b.motif] || b.motif, refs: b.refs, decorations: b.decorations || [] }));
}

export { TYPES, STATS };
