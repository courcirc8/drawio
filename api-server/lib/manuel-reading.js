/**
 * manuel-reading.js — the reading behind engine "manuel" (lib/place-manuel.js):
 * a netlist read the way a textbook figure is built (schemas-lisibles,
 * 2026-10-24, Eric: "qualitative jump, schematics like Razavi").
 *
 *  1. rails: one supply (top) and ground `0` (bottom);
 *  2. frames: the signal core; the bias generators (diodes fed by a source,
 *     dividers: channel-connected groups whose nets only drive gates) and the
 *     common-mode feedback (a differential pair driving gates of the core) go
 *     to frames of their own, joined to the core by NET LABELS (orchestrator
 *     2026-10-24: labels for bias / frame-crossing nets only, signal nets stay
 *     wires);
 *  3. columns: the DC branches, top rail -> bottom rail, read from the
 *     channel terminals (MOS drain / source, BJT collector / emitter, the two
 *     ends of a two-terminal part); a branch that splits or merges (a tail)
 *     ends there and the part below hangs from the merge node;
 *  4. symmetry: columns paired by a net mapping grown from the differential
 *     pair (or a mirror pair) — mirrored about one axis;
 *  5. the rest: bridges (passive chains between two column nodes: Miller R-C),
 *     gate networks (a passive group driving one gate: divider, sensing
 *     resistors) and gate nets (shared bias line, riser from a node, port).
 *
 * `manuelReading(parsed)` returns null when one of these steps does not hold
 * (the caller then keeps the other engines): that is the "sure" criterion.
 */

export const SUPPLY = /^(a?v(dd|cc)\w*|vpwr|vdda|dvdd|vcca|power(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?)$/i;
const GND = '0';
export const BIASNAME = /^(v?bias\w*|vb\w*|[np]bias\w*|vc[mnp]\w*|vref\w*|vg\w*)$/i;
const OUTNAME = /^(v?out\w*|o(ut)?[pn]?)$/i;

const isMos = (c) => c.prefix === 'M';
const isBjt = (c) => c.prefix === 'Q';
const isTr = (c) => isMos(c) || isBjt(c);
export const isP = (c) => (isMos(c) && /pmos|pfet|pch|\bp\b|_p/i.test(c.model || c.value || '')) || (isBjt(c) && /pnp/i.test(c.model || c.value || ''));
const TWO = new Set(['R', 'C', 'L', 'I', 'V', 'D']);

/** channel terminals of a part as [top, bottom] when the polarity fixes them,
 *  or [a, b] unordered for a two-terminal part. */
export function chan(c) {
  if (isTr(c)) return isP(c) ? [c.nodes[2], c.nodes[0]] : [c.nodes[0], c.nodes[2]];
  return [c.nodes[0], c.nodes[1]];
}
export const gateOf = (c) => (isTr(c) ? c.nodes[1] : null);
const isRail = (n, R) => n === R.top || n === R.bot;

function railsOf(parsed) {
  const nets = new Set(parsed.components.flatMap((c) => c.nodes));
  if (!nets.has(GND)) return null;
  const sup = [...nets].filter((n) => SUPPLY.test(n));
  if (sup.length > 1) return null;
  return { top: sup[0] || null, bot: GND };
}

class UF {
  constructor() { this.p = new Map(); }
  f(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); this.p.set(x, r); return r; }
  u(a, b) { this.p.set(this.f(a), this.f(b)); }
}

/** channel-connected groups (gates cut, rails cut) */
function cccs(comps, R) {
  const uf = new UF();
  for (const c of comps) {
    uf.f(c.ref);
    for (const n of chan(c)) if (!isRail(n, R)) uf.u(c.ref, 'n:' + n);
  }
  const g = new Map();
  for (const c of comps) { const r = uf.f(c.ref); if (!g.has(r)) g.set(r, []); g.get(r).push(c); }
  return [...g.values()];
}

const sizeKey = (c) => `${c.prefix}|${isP(c)}|${(c.value || '').toLowerCase()}`;

/** nets of a group, by terminal kind */
function netUse(comps) {
  const use = new Map();
  const add = (n, k, c) => { if (!use.has(n)) use.set(n, { chan: [], gate: [] }); use.get(n)[k].push(c); };
  for (const c of comps) { for (const n of chan(c)) add(n, 'chan', c); const g = gateOf(c); if (g) add(g, 'gate', c); }
  return use;
}

export function manuelReading(parsed) {
  try { return read(parsed); } catch { return null; }
}

function read(parsed) {
  const comps = parsed.components;
  if (comps.length < 3 || comps.length > 40) return null;
  if (comps.some((c) => !isTr(c) && !TWO.has(c.prefix))) return null;
  if (comps.some((c) => isTr(c) && c.nodes.length < 3)) return null;
  const R = railsOf(parsed);
  if (!R) return null;
  const all = netUse(comps);
  const degree = (n) => (all.get(n)?.chan.length || 0) + (all.get(n)?.gate.length || 0);
  // ports: signal nets with one terminal, or output-named nets
  const isPort = (n) => !isRail(n, R) && (degree(n) === 1 || OUTNAME.test(n)) && !/^o\d/i.test(n);
  const groups = cccs(comps, R);
  const nTr = (g) => g.filter(isTr).length;
  const netsOf = (g) => new Set(g.flatMap((c) => [...chan(c), gateOf(c)].filter((n) => n && !isRail(n, R))));
  const chanNets = (g) => new Set(g.flatMap((c) => chan(c).filter((n) => !isRail(n, R))));
  // core: the group with the input pair (gates on ports) else the most transistors
  const inputs = [...all.keys()].filter((n) => !isRail(n, R) && all.get(n).chan.length === 0 && degree(n) >= 1 && isPort(n) && !BIASNAME.test(n));
  const score = (g) => nTr(g) * 10 + g.length + (g.some((c) => inputs.includes(gateOf(c))) ? 1000 : 0);
  const core = [...groups].sort((a, b) => score(b) - score(a))[0];
  if (nTr(core) < 1) return null;
  const coreNets = chanNets(core);
  // classify the other groups
  const frames = { core: [...core], bias: [], cmfb: [] };
  const gateNets = new Map(); // net -> gates (parts) of the core
  for (const c of core) { const g = gateOf(c); if (g && !isRail(g, R)) { if (!gateNets.has(g)) gateNets.set(g, []); gateNets.get(g).push(c); } }
  const rest = groups.filter((g) => g !== core);
  const pairIn = (g) => {
    const trs = g.filter(isTr);
    for (let i = 0; i < trs.length; i++) for (let j = i + 1; j < trs.length; j++) {
      const a = trs[i], b = trs[j];
      if (sizeKey(a) === sizeKey(b) && chan(a)[1] === chan(b)[1] && !isRail(chan(a)[1], R) && gateOf(a) !== gateOf(b)) return [a, b];
    }
    return null;
  };
  // groups whose gates hang on the core's branches close a loop with it (a
  // self-biased bandgap, an output branch): they join the core, until stable
  for (let grew = true; grew;) {
    grew = false;
    for (const g of [...rest]) {
      if (pairIn(g) || !g.some((c) => isTr(c) && coreNets.has(gateOf(c)))) continue;
      frames.core.push(...g); rest.splice(rest.indexOf(g), 1);
      for (const n of chanNets(g)) coreNets.add(n);
      grew = true;
    }
  }
  // start-up kick (cascoded OTA of the TIA proj5, 2026-10-26): core transistors with a channel end on a rail
  // whose gate net is driven only by resistors and capacitors between that net and the rails, one resistor
  // and one capacitor at least (a power-on RC: a plain divider, a source or a lone capacitor is a bias), are
  // drawn apart, in a « Démarrage » frame, with that RC
  frames.startup = [];
  const rcOnly = (n) => { const u = all.get(n); return !!u && u.chan.some((c) => c.prefix === 'C') && u.chan.some((c) => c.prefix === 'R') && u.chan.every((c) => (c.prefix === 'R' || c.prefix === 'C') && chan(c).every((m) => m === n || isRail(m, R))); };
  const kickGates = new Set();
  for (const c of [...frames.core]) {
    const g = gateOf(c);
    if (!g || isRail(g, R) || !chan(c).some((n) => isRail(n, R)) || !rcOnly(g)) continue;
    frames.core.splice(frames.core.indexOf(c), 1); frames.startup.push(c); kickGates.add(g);
  }
  // a replica bias branch inside the core's channel group (the cascode bias of a telescopic stage): a series
  // path from a rail to a core node, its inner nodes joined by that path only, holding a diode whose node only
  // feeds gates of other core parts; every transistor's gate on its own diode node or on a net that is not a
  // core channel node (a bias line). Drawn in the bias frame; the node it hangs on becomes a label. A diode
  // node driving an input pair (a bandgap core branch into its amplifier) is not a bias line, nor the
  // reference of a mirror hanging on the same node X, nor a path through half of an input pair.
  const pairGates = new Set(), pairParts = new Set();
  for (const a of comps.filter(isTr)) for (const b of comps.filter(isTr)) {
    if (a !== b && sizeKey(a) === sizeKey(b) && a.nodes[2] === b.nodes[2] && !isRail(a.nodes[2], R) && gateOf(a) !== gateOf(b)) { pairGates.add(gateOf(a)); pairParts.add(a); }
  }
  for (let moved = true; moved;) {
    moved = false;
    const cu = netUse(frames.core);
    for (const d of frames.core.filter((c) => isTr(c) && chan(c).includes(gateOf(c)))) {
      const vd = gateOf(d);
      if (pairGates.has(vd)) continue;
      const path = [d], ends = [];
      for (const n0 of chan(d)) {
        let n = n0, prev = d;
        while (!isRail(n, R) && cu.get(n).chan.length === 2) {
          const nx = cu.get(n).chan.find((c) => c !== prev);
          if (path.includes(nx)) break;
          path.push(nx); prev = nx; n = chan(nx).find((m) => m !== n);
        }
        ends.push(n);
      }
      const railEnds = ends.filter((n) => isRail(n, R));
      if (railEnds.length !== 1 || path.length > 4) continue;
      const X = ends.find((n) => !isRail(n, R));
      if ((cu.get(X)?.chan.length || 0) < 3) continue;
      const inP = new Set(path);
      if (path.some((c) => pairParts.has(c))) continue;         // half of an input pair is never a replica
      if (!cu.get(vd).chan.every((c) => inP.has(c)) || !cu.get(vd).gate.some((c) => !inP.has(c))) continue;
      // a mirror reference (the gate users' channel on the same node X) stays with its mirror
      if (cu.get(vd).gate.some((c) => !inP.has(c) && chan(c).includes(X))) continue;
      const pathNets = new Set(path.flatMap((c) => chan(c)));
      const coreChan = new Set(frames.core.filter((c) => !inP.has(c)).flatMap((c) => chan(c)));
      // a gate shared with a core part outside the path is a signal (analoggenie/954: VIN1 on M2 and M4)
      const sharedGate = (n) => frames.core.some((c) => !inP.has(c) && gateOf(c) === n);
      if (!path.filter(isTr).every((c) => gateOf(c) === vd || chan(c).includes(gateOf(c)) || (!coreChan.has(gateOf(c)) && !pathNets.has(gateOf(c)) && !inputs.includes(gateOf(c)) && (BIASNAME.test(gateOf(c)) || !sharedGate(gateOf(c)))))) continue;
      for (const c of path) frames.core.splice(frames.core.indexOf(c), 1);
      frames.bias.push(...path);
      moved = true;
      break;
    }
  }
  const later = [];          // passive groups driving the gate of one part: joined to that part's frame
  for (const g of rest) {
    const nets = chanNets(g);
    const drivesCore = [...nets].some((n) => gateNets.has(n));
    const hasPort = [...nets].some((n) => isPort(n) && !BIASNAME.test(n));
    if (pairIn(g) && drivesCore) { frames.cmfb.push(...g); continue; }
    if (g.every((c) => !isTr(c))) { later.push(g); continue; }
    if ((!hasPort || [...nets].every((n) => !isPort(n) || BIASNAME.test(n)))) { frames.bias.push(...g); continue; }
    frames.core.push(...g); // a stray signal group: drawn with the core
  }
  // sensing resistors inside the core: passive parts whose nets are only outputs / CMFB nets
  if (frames.cmfb.length) {
    const cmNets = new Set(frames.cmfb.flatMap((c) => [...chan(c), gateOf(c)]).filter(Boolean));
    const moved = frames.core.filter((c) => !isTr(c) && chan(c).every((n) => isRail(n, R) || cmNets.has(n) || OUTNAME.test(n)) && chan(c).some((n) => cmNets.has(n)));
    for (const c of moved) { frames.core.splice(frames.core.indexOf(c), 1); frames.cmfb.push(c); }
    // and the parts hanging from the sensing node only (a resistor to a rail)
    const sense = new Set(moved.flatMap((c) => chan(c)).filter((n) => cmNets.has(n)));
    for (const c of [...frames.core]) if (!isTr(c) && chan(c).some((n) => sense.has(n)) && chan(c).every((n) => isRail(n, R) || sense.has(n))) { frames.core.splice(frames.core.indexOf(c), 1); frames.cmfb.push(c); }
  }
  for (const g of later) {
    const nets = chanNets(g);
    // the power-on RC: a group on the kick nets only (a rail-only group, a supply or a decoupling, has none)
    if (nets.size > 0 && [...nets].every((n) => kickGates.has(n))) { frames.startup.push(...g); continue; }
    // a pure bias generator (a divider between the rails whose taps only drive
    // gates) goes to the bias frame; a network that also touches a signal net
    // (sensing resistors on the outputs, a reference input) joins the frame
    // of the gate it drives
    const inG = new Set(g.map((c) => c.ref));
    const signal = [...nets].some((n) => isPort(n) || comps.some((c) => !inG.has(c.ref) && chan(c).includes(n)));
    if (!signal) { frames.bias.push(...g); continue; }
    const target = Object.entries(frames).filter(([, ps]) => ps.some((c) => nets.has(gateOf(c))));
    if (target.length === 1 && g.length <= 4) target[0][1].push(...g);
    else if (target.length === 0 || [...nets].every((n) => !isPort(n) || BIASNAME.test(n))) frames.bias.push(...g);
    else return null;
  }
  const gateNetwork = [];
  // each frame must be readable as columns
  const out = { rails: R, frames: [], gateNetwork, ports: new Set([...all.keys()].filter(isPort)), inputs };
  for (const [kind, parts] of Object.entries(frames)) {
    if (!parts.length) continue;
    const net = readFrame(kind, parts, R, comps);
    if (!net) return null;
    out.frames.push(net);
  }
  // nets crossing frames (or bias-type nets without a driver) are drawn as labels
  const frameOf = new Map();
  for (const f of out.frames) for (const p of f.parts) frameOf.set(p.ref, f.kind);
  const labelNets = new Set();
  for (const [n, u] of all) {
    if (isRail(n, R)) continue;
    const fs = new Set([...u.chan, ...u.gate].map((c) => frameOf.get(c.ref)));
    if (fs.size > 1) labelNets.add(n);
    else if (u.chan.length === 0 && u.gate.length >= 1 && !isPort(n)) labelNets.add(n);   // externally driven bias line
    else if (BIASNAME.test(n) && u.gate.length >= 1) labelNets.add(n);   // a bias line: named, gates fed by labels (orchestrator 2026-10-24)
  }
  out.labelNets = labelNets;
  out.frameOf = frameOf;
  out.sure = true;
  return out;
}

/** columns of one frame, their pairing and ranks; null when not readable */
function readFrame(kind, parts, R, allComps) {
  const use = netUse(parts);
  const inCol = new Set();
  const cols = [];
  const chanOn = (n) => (use.get(n)?.chan || []);
  // start a column at a part, walk down while the next node is a simple series node
  const walk = (start, topNet) => {
    const col = { parts: [], top: topNet, bot: null };
    let cur = start, upNet = topNet;
    for (;;) {
      inCol.add(cur.ref);
      const [a, b] = chan(cur);
      const down = isTr(cur) ? b : (a === upNet ? b : a);
      col.parts.push({ c: cur, up: upNet, down });
      if (isRail(down, R)) { col.bot = down; break; }
      const others = chanOn(down).filter((d) => d !== cur && !inCol.has(d.ref));
      const arriving = chanOn(down).filter((d) => d !== cur && isTr(d) && chan(d)[1] === down);
      // a node where branches merge (tail) or split ends the column
      const leaving = others.filter((d) => (isTr(d) ? chan(d)[0] === down : true));
      const trLeaving = leaving.filter(isTr);
      let next = null;
      if (arriving.length === 0) {
        if (trLeaving.length === 1) next = trLeaving[0];
        else if (trLeaving.length === 0 && leaving.length === 1 && chan(leaving[0]).some((n) => isRail(n, R))) next = leaving[0];
        else if (trLeaving.length === 0 && leaving.length === 1 && others.length === 1) {
          // a resistor in series down to the next device of the branch (degeneration, a bandgap's R1)
          const r = leaving[0], far = chan(r)[0] === down ? chan(r)[1] : chan(r)[0];
          const on = chanOn(far).filter((d) => d !== r);
          if (!isRail(far, R) && on.length === 1 && isTr(on[0]) && !inCol.has(on[0].ref) && chan(on[0])[0] === far) next = r;
        }
      }
      if (!next) { col.bot = down; break; }
      upNet = down; cur = next;
    }
    return col;
  };
  // 1. from the top rail
  const startsTop = parts.filter((c) => R.top && (isTr(c) ? chan(c)[0] === R.top : chan(c).includes(R.top)));
  startsTop.sort((a, b) => (isTr(b) - isTr(a)));
  for (const c of startsTop) if (!inCol.has(c.ref)) cols.push(walk(c, R.top));
  // 2. parts hanging from a node (their top on a node already in a column), repeat
  for (let guard = 0; guard < 6; guard++) {
    let grew = false;
    const known = new Set(cols.flatMap((col) => col.parts.map((p) => p.down)).concat(cols.map((col) => col.top)));
    for (const c of parts) {
      if (inCol.has(c.ref)) continue;
      const t = chan(c);
      if (isTr(c) ? known.has(t[0]) && !isRail(t[0], R) : (t.some((n) => known.has(n) && !isRail(n, R)) && t.some((n) => isRail(n, R)))) {
        const topNet = isTr(c) ? t[0] : t.find((n) => known.has(n) && !isRail(n, R));
        // a two-terminal from a node to the TOP rail hangs upward: drawn as a column too
        cols.push(walk(c, topNet)); grew = true;
      }
    }
    if (!grew) break;
  }
  // 3. from the bottom rail upward (a column whose top is a node not yet met: a leg)
  for (const c of parts) {
    if (inCol.has(c.ref)) continue;
    const t = chan(c);
    if (isTr(c) && t[1] === R.bot) {
      // walk upward then reverse
      const chain = [c]; let up = t[0]; inCol.add(c.ref);
      for (;;) {
        if (isRail(up, R)) break;
        const cand = (use.get(up)?.chan || []).filter((d) => !inCol.has(d.ref) && isTr(d) && chan(d)[1] === up);
        if (cand.length !== 1 || (use.get(up)?.chan || []).length !== 2) break;
        chain.unshift(cand[0]); inCol.add(cand[0].ref); up = chan(cand[0])[0];
      }
      cols.push({ parts: chain.map((p) => ({ c: p, up: chan(p)[0], down: chan(p)[1] })), top: up, bot: R.bot });
    }
  }
  const bridges = parts.filter((c) => !inCol.has(c.ref));
  if (bridges.some((c) => isTr(c))) return null;          // a transistor outside every branch
  // bridge chains: two-terminal parts between non-rail nets; group series chains
  // a chain stops on a net that leaves the frame (a label or port there), not only on a frame-local junction
  const chains = bridgeChains(bridges, use, R, netUse(allComps));
  if (!chains) return null;
  pairColumns(cols, parts, R);
  return { kind, parts, cols, chains };
}

/** series chains of bridges between two "end" nets (intermediate nets of degree 2) */
function bridgeChains(bridges, use, R, allUse = use) {
  const left = new Set(bridges.map((c) => c.ref));
  const deg = (n) => (allUse.get(n)?.chan.length || 0) + (allUse.get(n)?.gate.length || 0);
  const chains = [];
  const byRef = new Map(bridges.map((c) => [c.ref, c]));
  for (const c of bridges) {
    if (!left.has(c.ref)) continue;
    // extend both ways through degree-2 nets
    let seq = [c]; left.delete(c.ref);
    for (const dir of [0, 1]) {
      for (;;) {
        const end = dir === 0 ? endNet(seq, 0) : endNet(seq, 1);
        if (isRail(end, R) || deg(end) !== 2) break;
        const nx = (use.get(end).chan || []).find((d) => left.has(d.ref));
        if (!nx) break;
        left.delete(nx.ref);
        if (dir === 0) seq = [nx, ...seq]; else seq = [...seq, nx];
      }
    }
    chains.push({ parts: seq, a: endNet(seq, 0), b: endNet(seq, 1) });
  }
  void byRef;
  return chains;
}
function endNet(seq, side) {
  if (seq.length === 1) return chan(seq[0])[side];
  if (side === 0) { const [a, b] = chan(seq[0]); const nx = chan(seq[1]); return nx.includes(a) ? b : a; }
  const [a, b] = chan(seq[seq.length - 1]); const pv = chan(seq[seq.length - 2]); return pv.includes(a) ? b : a;
}

/** mirror pairs of columns + self-symmetric ones, by a growing net mapping */
function pairColumns(cols, parts, R) {
  const sig = (col) => col.parts.map((p) => sizeKey(p.c)).join('/');
  const sigma = new Map();      // net -> partner net
  const map = (a, b) => { if (a === b) return true; if (sigma.has(a) && sigma.get(a) !== b) return false; if (sigma.has(b) && sigma.get(b) !== a) return false; sigma.set(a, b); sigma.set(b, a); return true; };
  const colOf = new Map(); cols.forEach((col, i) => col.parts.forEach((p) => colOf.set(p.c.ref, i)));
  // seeds: differential pairs (same size, same source node, different gates)
  const trs = parts.filter(isTr);
  for (let i = 0; i < trs.length; i++) for (let j = i + 1; j < trs.length; j++) {
    const a = trs[i], b = trs[j];
    if (sizeKey(a) === sizeKey(b) && chan(a)[1] === chan(b)[1] && gateOf(a) !== gateOf(b) && colOf.get(a.ref) !== colOf.get(b.ref)) {
      const ca = cols[colOf.get(a.ref)], cb = cols[colOf.get(b.ref)];
      if (ca.pair == null && cb.pair == null && sig(ca) === sig(cb)) { ca.pair = colOf.get(b.ref); cb.pair = colOf.get(a.ref); ca.seed = cb.seed = true; }
    }
  }
  // else mirrors: two same-size devices sharing a gate, on two columns of the same signature
  if (!cols.some((c) => c.pair != null)) {
    for (let i = 0; i < trs.length; i++) for (let j = i + 1; j < trs.length; j++) {
      const a = trs[i], b = trs[j];
      if (sizeKey(a) === sizeKey(b) && gateOf(a) === gateOf(b) && colOf.get(a.ref) !== colOf.get(b.ref)) {
        const ca = cols[colOf.get(a.ref)], cb = cols[colOf.get(b.ref)];
        if (ca.pair == null && cb.pair == null && sig(ca) === sig(cb)) { ca.pair = colOf.get(b.ref); cb.pair = colOf.get(a.ref); }
      }
    }
  }
  const mapCols = (ca, cb) => {
    let ok = true;
    ca.parts.forEach((p, k) => { const q = cb.parts[k].c; ok = map(p.up, cb.parts[k].up) && map(p.down, cb.parts[k].down) && (!gateOf(p.c) || map(gateOf(p.c), gateOf(q))) && ok; });
    return ok;
  };
  cols.forEach((c, i) => { if (c.pair != null && c.pair > i) mapCols(c, cols[c.pair]); });
  // grow: unpaired columns of equal signature whose nets correspond under sigma
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < cols.length; i++) {
      if (cols[i].pair != null) continue;
      for (let j = i + 1; j < cols.length; j++) {
        if (cols[j].pair != null || sig(cols[i]) !== sig(cols[j])) continue;
        const A = cols[i], B = cols[j];
        const corr = A.parts.some((p, k) => { const q = B.parts[k].c; const ga = gateOf(p.c), gb = gateOf(q); return (ga && sigma.get(ga) === gb) || sigma.get(p.down) === B.parts[k].down || sigma.get(p.up) === B.parts[k].up; });
        if (corr) { A.pair = j; B.pair = i; mapCols(A, B); break; }
      }
    }
  }
  // self-symmetric: every net maps to itself (tail current source)
  for (const c of cols) {
    if (c.pair != null) continue;
    const ns = c.parts.flatMap((p) => [p.up, p.down, gateOf(p.c)]).filter((n) => n && !isRail(n, R));
    // a node that drives the gates of both columns of a pair (the power-on RC of a kick pair) sits on the axis too
    const drivesPair = (n) => cols.some((d) => d.pair != null && d.parts.some((p) => gateOf(p.c) === n) && cols[d.pair].parts.some((p) => gateOf(p.c) === n));
    c.selfSym = cols.some((d) => d.pair != null) && ns.every((n) => !sigma.has(n) || sigma.get(n) === n) && ns.some((n) => cols.some((d) => d.pair != null && (d.bot === n || d.top === n)) || (c.parts.every((p) => !isTr(p.c)) && drivesPair(n)));   // tail below an N pair or above a P pair
  }
  for (const c of cols) c.sigma = sigma;
}
