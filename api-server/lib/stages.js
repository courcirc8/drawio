/**
 * stages.js — topological reading of a netlist as a designer reads it:
 * a ROLE for every component, the DC BRANCHES (columns from the supply to
 * ground), the STAGES those branches form, and the stages' order along the
 * signal (Eric 2026-10-09: "la reconnaissance topologique est toujours la clef
 * d'un schéma lisible"). Pure analysis: it never moves anything; a placement
 * engine will consume it (step C of the plan in ETAT.md).
 *
 * Ideas (no code) from the open-source study, references/ANALYSE.md:
 *   - ALIGN-public (BSD-3): drain/source fixed from the rails before reading
 *     roles; a pin-set view of each device ({D,G} = diode).
 *   - MAGICAL (BSD-3): current paths supply -> ground through drain/source as
 *     the columns (here BOUNDED, not exhaustive); a part shared by the two
 *     halves of a pair (tail, bias) belongs to the pair.
 *   - asg (MIT): stage column = longest path from the inputs.
 * The motif registry (lib/motifs.js) gives the primitives (pairs, mirrors,
 * cascodes, CS / CG / follower stages, switches, loads); this module fills the
 * roles it leaves out (current sources, degeneration, feedback, coupling,
 * bias networks) and builds branches, stages and their order.
 *
 * analyseStages(parsed) -> {
 *   rails: {supply:[...], ground:[...]},
 *   roles: {ref: role},                 // see ROLES below
 *   branches: [[ref top ... ref bottom]],
 *   stages: [{id, refs, branches:[i], kind, rank, inputs:[net], outputs:[net]}],
 *   coverage: {actives, activesWithRole, parts, partsInStage}
 * }
 */
import { detectMotifs, railNets } from './motifs.js';
import { isPmosLike } from './patterns.js';

export const ROLES = ['diff-pair', 'cross-coupled', 'mirror-ref', 'mirror-out', 'cascode', 'tail', 'current-source',
  'common-source', 'common-gate', 'follower', 'shunt-feedback', 'switch', 'inverter', 'diode', 'amplifier',
  'load', 'degeneration', 'feedback', 'coupling', 'bias', 'shunt', 'source', 'dummy', 'varactor', 'unknown'];

const GND_RE = /^(0|gnd\w*|vss\w*|vee\w*|agnd|dgnd|avss|dvss|v-)$/i;
const BIAS_RE = /^(vb|vbias|bias|vg\d|vcas|vc\d|vref|vbn|vbp|vcm)/i;   // (not IB: AnalogGenie's current ports are drains as well)
const INPUT_RE = /^(in|vin|iin|rf|sig|lo|inp|inm|inn|vip|vim|vi\b|vi[pn])/i;
// clock / control nets (AnalogGenie names them VCLK1, VLATCH1): a device they
// gate is a switch, whatever pair it seems to form
const CLOCK_RE = /^(v?clk|v?ck\d|v?phi|ph\d|v?latch|clock|en\b|enb?\d|sel|v?sw\d|v?cont|v?ctrl|v?ctl|φ)/i;
const OUTPUT_RE = /^(out|vout|if|outp|outm|outn|op|om|vo\b|vo[pn])/i;
const WAVE_RE = /\b(ac|sin|sine|pulse|pwl|exp|sffm)\b/i;
const isActive = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';
const isActiveC = isActive;
const isAmp = (c) => c.prefix === 'X' || c.prefix === 'E' || c.prefix === 'G';
const twoPin = (c) => 'RLCDI'.includes(c.prefix);

export function analyseStages(parsed) {
  const comps = parsed.components;
  const byRef = new Map(comps.map((c) => [c.ref, c]));
  const rails = railNets(comps);
  const ground = new Set([...rails].filter((n) => GND_RE.test(n)));
  ground.add('0');
  const supply = new Set([...rails].filter((n) => !ground.has(n)));
  // a DC source that only feeds gates through a series R / C is a SIGNAL
  // source drawn without a waveform (textbook "Vin"), not a supply
  const gateOnly = (n, via) => comps.filter((c) => c !== via && c.nodes.includes(n)).every((c) => (isActiveC(c) && c.nodes[1] === n) || c.prefix === 'C' || c.prefix === 'V')
    && comps.some((c) => isActiveC(c) && c.nodes[1] === n);
  for (const n of [...supply]) {
    const here = comps.filter((c) => c.nodes.includes(n));
    if (here.some((c) => c.prefix === 'V') && here.every((c) => c.prefix === 'V' || (['R', 'C'].includes(c.prefix) && gateOnly(c.nodes[0] === n ? c.nodes[1] : c.nodes[0], c))))
      supply.delete(n);
  }
  const isRail = (n) => ground.has(n) || supply.has(n);

  // terminals with drain/source fixed from the rails (ALIGN idea): an NMOS
  // whose "drain" is on ground (or a PMOS whose "drain" is on the supply) is
  // read the other way round
  const T = new Map();
  for (const c of comps.filter(isActive)) {
    let [d, g, s] = c.nodes;
    const p = c.prefix === 'Q' ? /pnp/i.test(c.model || c.value || '') : isPmosLike(c);
    if ((!p && ground.has(d) && !ground.has(s)) || (p && supply.has(d) && !supply.has(s))) [d, s] = [s, d];
    T.set(c.ref, { d, g, s, p });
  }
  const on = new Map();
  for (const c of comps) for (const n of c.nodes) { if (!on.has(n)) on.set(n, []); on.get(n).push(c); }
  const at = (n) => on.get(n) || [];

  // ---- bias nets: mirror gates, named bias nets, nets fed only by resistors
  // to rails / DC sources (dividers), gates of diode devices
  const signalSrc = new Set(comps.filter((c) => (c.prefix === 'V' || c.prefix === 'I') && WAVE_RE.test(c.value || '')).flatMap((c) => c.nodes).filter((n) => !isRail(n)));
  const inputs = new Set([...new Set(comps.flatMap((c) => c.nodes))].filter((n) => !isRail(n) && (INPUT_RE.test(n) || signalSrc.has(n))));
  const biasNet = (n) => {
    if (isRail(n) || inputs.has(n)) return false;
    if (BIAS_RE.test(n)) return true;
    const here = at(n);
    if (here.some((c) => isActive(c) && T.get(c.ref).g === n && T.get(c.ref).d === n)) return true;   // diode gate
    // only gates, resistors to rails and DC sources: a divider or a reference;
    // or gates only (an external bias pin, Vb in a textbook figure). A net
    // with no gate on it is never a bias net (a passive node).
    const gates = here.filter((c) => isActive(c) && T.get(c.ref).g === n);
    if (!gates.length) return false;
    if (!here.every((c) => gates.includes(c) || (c.prefix === 'R' && c.nodes.some(isRail)) || (c.prefix === 'V' && !WAVE_RE.test(c.value || '')) || c.prefix === 'C')) return false;
    if (here.some((c) => c.prefix === 'R' || c.prefix === 'V') || gates.length >= 2) return true;
    // one gate on a bare pin: Vb or Vin? A bias pin feeds a device in LOAD
    // position (its drain shared with another device's drain, no passive load);
    // an input pin feeds a gain device (its own load)
    const t = T.get(gates[0].ref);
    const dn = at(t.d);
    return !dn.some((c) => ['R', 'L'].includes(c.prefix)) && dn.some((c) => c !== gates[0] && isActive(c) && T.get(c.ref).d === t.d);
  };
  // EXPLICIT bias only (a bare numbered pin may be Vb or Vin: undecidable):
  // a rail, a bias name, a divider / DC source, or a gate shared with devices
  // outside the group under test
  const explicitBias = (n, group = []) => {
    if (isRail(n) || BIAS_RE.test(n)) return true;
    if (inputs.has(n)) return false;
    const here = at(n);
    // a divider is a bias only when its resistors go to rails (one from an
    // output node is a feedback divider)
    const rs = here.filter((c) => c.prefix === 'R');
    if (rs.some((c) => c.nodes.some(isRail)) && rs.every((c) => c.nodes.some(isRail)) && here.every((c) => (isActive(c) && T.get(c.ref).g === n) || ['R', 'C', 'V'].includes(c.prefix))) return true;
    return here.filter((c) => isActive(c) && T.get(c.ref).g === n && !group.includes(c.ref)).length >= 1 && here.every((c) => isActive(c) && T.get(c.ref).g === n);
  };
  // ---- roles: primitives of the motif registry first
  const roles = {};
  const set = (ref, role) => { if (!roles[ref] || roles[ref] === 'unknown') roles[ref] = role; };
  const m = detectMotifs(parsed);
  for (const c of comps.filter(isActive)) if (CLOCK_RE.test(T.get(c.ref).g)) roles[c.ref] = 'switch';
  // a MOS with drain and source tied is a varactor / MOS capacitor
  for (const c of comps.filter(isActive)) if (T.get(c.ref).d === T.get(c.ref).s) roles[c.ref] = 'varactor';
  // cross-coupled before differential: a cross-coupled pair also shares its sources
  const order = ['cross-coupled-pair', 'differential-pair', 'current-mirror', 'cascode', 'tail', 'switch', 'inverter',
    'common-source', 'common-gate', 'source-follower', 'bjt-resistive-stage', 'opamp-stage', 'diode-connected', 'load'];
  const name = { 'differential-pair': 'diff-pair', 'cross-coupled-pair': 'cross-coupled', 'cascode': 'cascode', 'tail': 'tail',
    'switch': 'switch', 'inverter': 'inverter', 'common-source': 'common-source', 'common-gate': 'common-gate',
    'source-follower': 'follower', 'bjt-resistive-stage': 'common-source', 'opamp-stage': 'amplifier', 'diode-connected': 'diode' };
  for (const motif of order) {
    for (const i of m.instances.filter((x) => x.motif === motif)) {
      // a loop through a diode-connected device's gate is a mirror with
      // feedback, not a cross-coupled pair (a latch has no diode on its nodes)
      // a differential pair has two SIGNAL gates: one gate on a bias net makes
      // it a follower / cascode arrangement, read by the fallback
      if (motif === 'differential-pair' && i.refs.some((r) => isActive(byRef.get(r)) && explicitBias(T.get(r).g, i.refs))) continue;
      if (motif === 'cross-coupled-pair' && (i.nets || []).some((n) => comps.some((k) => isActive(k) && T.get(k.ref).g === n && T.get(k.ref).d === n))) continue;
      // gates on a rail: diode-connected LOADS side by side, not a mirror
      if (motif === 'current-mirror' && isRail(i.gateNet)) { for (const r of i.refs) set(r, 'load'); continue; }
      if (motif === 'current-mirror') { set(i.diode, 'mirror-ref'); for (const r of i.refs) if (r !== i.diode) set(r, 'mirror-out'); continue; }
      if (motif === 'cascode') { set(i.refs[0], 'cascode'); continue; }
      if (motif === 'load') { for (const r of i.refs) if (!isActive(byRef.get(r))) set(r, 'load'); continue; }
      const dev = i.device ? [i.device] : i.refs.filter((r) => isActive(byRef.get(r)) || isAmp(byRef.get(r)));
      for (const r of dev) set(r, name[motif]);
    }
  }

  // current sources: a device fed by a bias gate with its source (emitter) on a
  // rail, drain elsewhere
  for (const c of comps.filter(isActive)) {
    const t = T.get(c.ref);
    if ((!roles[c.ref] || roles[c.ref] === 'diode') && biasNet(t.g) && isRail(t.s) && !isRail(t.d)) roles[c.ref] = t.g === t.d ? 'diode' : 'current-source';
  }
  // BJT diode (base on collector, or base and collector both on a rail: the
  // substrate PNP of a bandgap)
  for (const c of comps.filter((c) => c.prefix === 'Q')) {
    const t = T.get(c.ref);
    if (t.g === t.d || (isRail(t.g) && isRail(t.d))) roles[c.ref] = 'diode';
  }
  // DIFFERENTIAL PAIR WITH SEPARATE SOURCES: two devices of one polarity,
  // distinct non-bias gates and drains, whose sources are joined through at
  // most three passives / switches (degeneration, switched resistor ladder,
  // clocked tail of a dynamic comparator) without crossing a rail
  const pairLinks = [];
  const actives = comps.filter(isActive);
  const passable = (k) => ['R', 'C', 'L'].includes(k.prefix) || roles[k.ref] === 'switch';
  const linkPath = (from, to) => {
    let frontier = [[from, []]]; const seen = new Set([from]);
    for (let depth = 0; depth < 3; depth++) {
      const next = [];
      for (const [n, path] of frontier) for (const k of at(n)) {
        if (!passable(k)) continue;
        const ends = isActive(k) ? [T.get(k.ref).d, T.get(k.ref).s] : k.nodes.slice(0, 2);
        if (!ends.includes(n)) continue;
        const o = ends[0] === n ? ends[1] : ends[0];
        if (o === to) return [...path, k.ref];
        if (isRail(o) || seen.has(o)) continue;
        seen.add(o); next.push([o, [...path, k.ref]]);
      }
      frontier = next;
    }
    return null;
  };
  for (let i = 0; i < actives.length; i++) for (let j = i + 1; j < actives.length; j++) {
    const a = actives[i], b = actives[j], ta = T.get(a.ref), tb = T.get(b.ref);
    if (a.prefix !== b.prefix || ta.p !== tb.p || roles[a.ref] === 'switch' || roles[b.ref] === 'switch') continue;
    if (['diff-pair', 'cross-coupled'].includes(roles[a.ref]) && roles[a.ref] === roles[b.ref]) continue;
    if (ta.s === tb.s || isRail(ta.s) || isRail(tb.s) || ta.g === tb.g || ta.d === tb.d || isRail(ta.g) || isRail(tb.g) || biasNet(ta.g) || biasNet(tb.g)) continue;
    const path = linkPath(ta.s, tb.s);
    if (!path) continue;
    roles[a.ref] = 'diff-pair'; roles[b.ref] = 'diff-pair';
    for (const r of path) if (!roles[r] || !isActive(byRef.get(r))) roles[r] = isActive(byRef.get(r)) ? 'switch' : 'degeneration';
    pairLinks.push([a.ref, b.ref]);
  }
  // FLIPPED VOLTAGE FOLLOWER: a follower (gate = input, source = output X)
  // whose drain drives the gate of a device that sinks X to the rail
  for (const a of actives) {
    const ta = T.get(a.ref);
    const b = actives.find((k) => k !== a && T.get(k.ref).g === ta.d && T.get(k.ref).d === ta.s && isRail(T.get(k.ref).s));
    // (a biased gate makes it a low-voltage cascode mirror, read below)
    if (!b || isRail(ta.d) || isRail(ta.s) || explicitBias(ta.g) || biasNet(ta.g)) continue;
    roles[a.ref] = 'follower'; roles[b.ref] = 'shunt-feedback';
  }
  // low-voltage cascode mirror: the reference's gate is taken at the top of
  // its cascode (gate = drain of the cascode above it, not its own drain)
  for (const c of comps.filter(isActive)) {
    const t = T.get(c.ref);
    if (roles[c.ref] && !['common-source', 'cascode', 'unknown'].includes(roles[c.ref])) continue;
    const top = comps.find((k) => k !== c && isActive(k) && T.get(k.ref).p === t.p && T.get(k.ref).s === t.d && T.get(k.ref).d === t.g);
    if (!top) continue;
    const sharers = comps.filter((k) => k !== c && isActive(k) && T.get(k.ref).p === t.p && T.get(k.ref).g === t.g && T.get(k.ref).s === t.s);
    if (!sharers.length) continue;
    roles[c.ref] = 'mirror-ref';
    for (const k of sharers) if (!roles[k.ref] || ['common-source', 'unknown'].includes(roles[k.ref])) roles[k.ref] = 'mirror-out';
    if (!roles[top.ref] || roles[top.ref] === 'unknown') roles[top.ref] = 'cascode';
  }
  // fingers in parallel (same three nets, same polarity — ALIGN's PARALLEL
  // idea) are one device: they share the role found for any of them
  const fingerKey = (c) => { const t = T.get(c.ref); return [c.prefix, t.p, t.d, t.g, t.s].join('|'); };
  const fingers = new Map();
  for (const c of comps.filter(isActive)) { const k = fingerKey(c); if (!fingers.has(k)) fingers.set(k, []); fingers.get(k).push(c.ref); }
  for (const refs of fingers.values()) { const r = refs.map((x) => roles[x]).find((x) => x && x !== 'unknown'); if (r) for (const x of refs) if (!roles[x]) roles[x] = r; }
  // FALLBACK for the devices no motif claimed, read from their terminals:
  // a node is "effectively" on a rail through one passive (load,
  // degeneration) or a current source
  const viaOne = (n) => isRail(n) || at(n).some((c) => (['R', 'L'].includes(c.prefix) || c.prefix === 'I' || roles[c.ref] === 'current-source' || roles[c.ref] === 'mirror-out') && c.nodes.some((x) => x !== n && isRail(x)));
  for (const c of comps.filter(isActive)) {
    if (roles[c.ref]) continue;
    const { d, g, s } = T.get(c.ref);
    let role;
    if (isRail(d) && isRail(s)) role = 'dummy';                        // MOS capacitor, decap, dummy
    // a biased gate: current source when its source reaches the rail directly
    // or through a passive / ideal source; above another device, a cascode
    else if (isRail(g) || biasNet(g)) role = isRail(s) || at(s).some((k) => ['R', 'L', 'I'].includes(k.prefix) && k.nodes.some((x) => x !== s && isRail(x))) ? (isRail(d) ? 'dummy' : 'current-source') : inputs.has(s) ? 'common-gate' : 'cascode';
    else if (viaOne(s) && !isRail(d)) role = 'common-source';
    else if (viaOne(d) && !isRail(s)) role = 'follower';
    else role = at(d).concat(at(s)).some((k) => k !== c && isActive(k) && T.get(k.ref).p === T.get(c.ref).p && (T.get(k.ref).s === d || T.get(k.ref).d === s)) ? 'cascode' : 'switch';
    for (const x of fingers.get(fingerKey(c))) if (!roles[x]) roles[x] = role;
  }
  // a "cascode" whose drain is on the rail and whose gate is not biased is a
  // follower (its source node only looks like a stacking node)
  for (const c of comps.filter(isActive)) {
    const t = T.get(c.ref);
    if (roles[c.ref] === 'cascode' && isRail(t.d) && !isRail(t.s) && !biasNet(t.g)) roles[c.ref] = 'follower';
  }
  // a device with its source on a rail and a bias gate is a current source,
  // whatever stacking motif claimed it (the registry may take it for the top
  // of a cascode)
  for (const c of comps.filter(isActive)) {
    const t = T.get(c.ref);
    if (['cascode', 'common-source'].includes(roles[c.ref]) && isRail(t.s) && !isRail(t.d) && biasNet(t.g)) roles[c.ref] = 'current-source';
  }
  for (const c of comps.filter((c) => isActive(c) || isAmp(c))) if (!roles[c.ref]) roles[c.ref] = isAmp(c) ? 'amplifier' : 'unknown';

  // ---- branches: bounded current paths supply -> ground through D-S / C-E,
  // R, L, I and diodes (C blocks DC). MAGICAL idea, bounded here.
  const cond = (c) => isActive(c) || ['R', 'L', 'I', 'D'].includes(c.prefix);
  const ends = (c) => (isActive(c) ? [T.get(c.ref).d, T.get(c.ref).s] : [c.nodes[0], c.nodes[1]]);
  const branches = [];
  const MAXB = 200, MAXD = 10;
  // a branch ends on the other rail, or on a dead end (an external current
  // port such as AnalogGenie's IB1 tail: no element continues the path)
  const walk = (net, path, seen, stop, out) => {
    if (out.length >= MAXB || path.length > MAXD) return;
    if (stop.has(net) && path.length) { out.push([...path]); return; }
    let moved = false;
    for (const c of at(net)) {
      if (!cond(c) || seen.has(c.ref)) continue;
      const [a, b] = ends(c);
      const next = a === net ? b : b === net ? a : null;
      if (next == null || (!stop.has(next) && isRail(next))) continue;
      // current flows one way: going DOWN from the supply a PMOS (PNP) is
      // entered at its source, an NMOS (NPN) at its drain; going UP from
      // ground the other way round (no path climbs back through a pair)
      if (isActive(c)) {
        const t = T.get(c.ref), down = stop === ground;
        const entry = (t.p === down) ? t.s : t.d;
        if (net !== entry) continue;
      }
      moved = true;
      seen.add(c.ref); path.push(c.ref);
      walk(next, path, seen, stop, out);
      path.pop(); seen.delete(c.ref);
    }
    if (!moved && path.length) out.push([...path]);
  };
  for (const s of supply) walk(s, [], new Set(), ground, branches);
  // chains that never touch the supply, read from ground and reversed (top ->
  // bottom); flagged so the layout aligns their BOTTOM with the ground row
  const fromGround = [];
  for (const g of ground) walk(g, [], new Set(), supply, fromGround);
  const inSupply = new Set(branches.flat());
  for (const br of fromGround) if (!br.some((r) => inSupply.has(r))) { const top = [...br].reverse(); top.fromGround = true; branches.push(top); }
  // a part keeps its SHORTEST branch; branches made only of parts already
  // claimed are dropped
  branches.sort((a, b) => a.length - b.length);
  const branchOf = new Map(), kept = [];
  for (const br of branches) {
    const free = br.filter((r) => !branchOf.has(r));
    if (!free.length) continue;
    const id = kept.length; kept.push(br);
    for (const r of free) branchOf.set(r, id);
  }
  // branches with no supply (ground-referenced bias chains): one per part left
  for (const c of comps.filter((c) => cond(c) && !branchOf.has(c.ref) && (isActive(c) || c.nodes.some(isRail)))) {
    branchOf.set(c.ref, kept.length); kept.push([c.ref]);
  }

  // ---- stages: branches joined by a shared non-rail node of their parts
  // (a pair's two halves share the tail; a load shares the output node)
  const parent = kept.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const nodesOf = (ref) => { const c = byRef.get(ref); return isActive(c) ? [T.get(ref).d, T.get(ref).s] : c.nodes; };
  const owner = new Map();
  kept.forEach((br, i) => {
    for (const r of br) for (const n of nodesOf(r)) {
      if (isRail(n)) continue;
      if (owner.has(n)) unite(owner.get(n), i); else owner.set(n, i);
    }
  });
  // a mirror / cross-coupled pair / differential pair is one stage
  // (a mirror is NOT merged with its reference: they are joined by the gate
  // only, and the reference is the bias stage drawn on the left)
  for (const i of m.instances.filter((x) => ['cross-coupled-pair', 'differential-pair'].includes(x.motif))) {
    const bs = i.refs.map((r) => branchOf.get(r)).filter((b) => b != null);
    for (const b of bs.slice(1)) unite(bs[0], b);
  }
  for (const [a, b] of pairLinks) { const x = branchOf.get(a), y = branchOf.get(b); if (x != null && y != null) unite(x, y); }
  const groups = new Map();
  kept.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  const stages = [...groups.values()].map((bs, k) => ({ id: 'S' + (k + 1), branches: bs, refs: [...new Set(bs.flatMap((b) => kept[b]).filter((r) => branchOf.get(r) != null && bs.includes(branchOf.get(r))))] }));
  const stageOf = new Map();
  for (const st of stages) for (const r of st.refs) stageOf.set(r, st.id);

  // ---- passive roles: load (drain side), degeneration (source side),
  // shunt (to a rail elsewhere), coupling / feedback (between stages), bias
  const nodeStage = (n) => { for (const c of at(n)) if (stageOf.has(c.ref) && isActive(c)) return stageOf.get(c.ref); return null; };
  for (const c of comps.filter((c) => twoPin(c) || c.prefix === 'V')) {
    if (roles[c.ref]) continue;
    const [a, b] = c.nodes;
    if (c.prefix === 'V') { roles[c.ref] = 'source'; continue; }
    if (c.prefix === 'I') {
      // an ideal current source: the tail of a pair, else a current source
      // (reference or load) — never a "degeneration"
      const n = isRail(a) ? b : a;
      roles[c.ref] = m.instances.some((x) => x.motif === 'differential-pair' && x.tailNet === n) ? 'tail' : 'current-source';
      continue;
    }
    const rail = isRail(a) ? a : isRail(b) ? b : null, other = rail === a ? b : a;
    if (rail != null) {
      const dev = at(other).find((d) => isActive(d));
      if (dev) {
        const t = T.get(dev.ref);
        roles[c.ref] = t.d === other ? 'load' : t.s === other ? 'degeneration' : t.g === other ? 'bias' : 'shunt';
      } else roles[c.ref] = biasNet(other) ? 'bias' : 'shunt';
      continue;
    }
    const sa = nodeStage(a), sb = nodeStage(b);
    roles[c.ref] = sa && sb && sa !== sb ? 'coupling' : sa && sb ? 'feedback' : biasNet(a) || biasNet(b) ? 'bias' : 'coupling';
  }

  // ---- signal order (asg idea, on STAGES): A -> B when an output node of A
  // (drain / collector, or source of a follower) drives a gate / base in B,
  // directly or through one coupling part
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const outNodes = new Map(stages.map((s) => [s.id, new Set(s.refs.filter((r) => isActive(byRef.get(r))).flatMap((r) => { const t = T.get(r); return roles[r] === 'follower' ? [t.s] : [t.d]; }).filter((n) => !isRail(n)))]));
  const gateNodes = new Map(stages.map((s) => [s.id, new Set(s.refs.filter((r) => isActive(byRef.get(r))).map((r) => T.get(r).g).filter((n) => !isRail(n) && !biasNet(n)))]));
  const via = (n) => [n, ...at(n).filter((c) => roles[c.ref] === 'coupling').map((c) => (c.nodes[0] === n ? c.nodes[1] : c.nodes[0]))];
  const succ = new Map(stages.map((s) => [s.id, new Set()]));
  for (const a of stages) for (const n of outNodes.get(a.id)) for (const v of via(n)) for (const b of stages) {
    if (b.id !== a.id && gateNodes.get(b.id).has(v)) succ.get(a.id).add(b.id);
  }
  // rank = longest path from the input stages; cycles (feedback) cut by DFS
  const inStages = stages.filter((s) => [...gateNodes.get(s.id)].some((n) => [...via(n)].some((v) => inputs.has(v))));
  const rank = new Map();
  const visit = (id, r, stack) => {
    if (stack.has(id)) return;
    if ((rank.get(id) ?? -1) >= r) return;
    rank.set(id, r); stack.add(id);
    for (const b of succ.get(id)) visit(b, r + 1, stack);
    stack.delete(id);
  };
  for (const s of (inStages.length ? inStages : stages.filter((s) => ![...succ.values()].some((x) => x.has(s.id))))) visit(s.id, 0, new Set());
  for (const s of stages) if (!rank.has(s.id)) rank.set(s.id, 0);   // bias / reference stages: column 0
  for (const s of stages) {
    s.rank = rank.get(s.id);
    s.kind = dominantKind(s.refs.map((r) => roles[r]));
    s.inputs = [...gateNodes.get(s.id)].filter((n) => [...via(n)].some((v) => inputs.has(v)));
    s.outputs = [...outNodes.get(s.id)].filter((n) => OUTPUT_RE.test(n));
    s.columns = s.branches.map((b) => kept[b]);
  }
  stages.sort((a, b) => a.rank - b.rank);

  const allActives = comps.filter((c) => isActive(c) || isAmp(c));
  return {
    rails: { supply: [...supply], ground: [...ground] },
    roles, branches: kept, stages,
    coverage: {
      actives: allActives.length, activesWithRole: allActives.filter((c) => roles[c.ref] && roles[c.ref] !== 'unknown').length,
      parts: comps.length, partsInStage: comps.filter((c) => stageOf.has(c.ref)).length,
      partsWithRole: comps.filter((c) => roles[c.ref] && roles[c.ref] !== 'unknown').length,
    },
  };
}

function dominantKind(rs) {
  for (const k of ['diff-pair', 'cross-coupled', 'common-source', 'common-gate', 'follower', 'inverter', 'switch', 'amplifier', 'mirror-out', 'mirror-ref', 'current-source', 'diode']) if (rs.includes(k)) return k;
  return rs.includes('load') ? 'passive' : 'other';
}
