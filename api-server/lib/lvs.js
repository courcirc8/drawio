/**
 * lvs.js — Layout-vs-Schematic style comparison between the netlist extracted
 * from the drawio schematic and a reference SPICE netlist. Components are
 * matched by ref; net correspondence is derived structurally (extracted net
 * names are synthetic, only ground '0' matches by name).
 */

/** @param extracted {components:[{ref,prefix,nodes,value}]} — from extractNetlist
 *  @param golden {components:[…]} — from parseSpice */
export function compare(extracted, golden) {
  const ex = new Map(extracted.components.map((c) => [c.ref.toUpperCase(), c]));
  const go = new Map(golden.components.map((c) => [c.ref.toUpperCase(), c]));
  const report = { match: true, missing: [], extra: [], type_mismatches: [], value_mismatches: [], net_mismatches: [] };

  for (const ref of go.keys()) if (!ex.has(ref)) report.missing.push(go.get(ref).ref);
  for (const ref of ex.keys()) if (!go.has(ref)) report.extra.push(ex.get(ref).ref);

  const common = [...go.keys()].filter((r) => ex.has(r));
  for (const ref of common) {
    const a = ex.get(ref), b = go.get(ref);
    if (a.prefix !== b.prefix) report.type_mismatches.push({ ref: b.ref, schematic: a.prefix, netlist: b.prefix });
    if (a.value && b.value && norm(a.value) !== norm(b.value)) {
      report.value_mismatches.push({ ref: b.ref, schematic: a.value, netlist: b.value });
    }
  }

  // structural net matching over common components:
  // terminal = "REF.pinIndex" -> net name on each side; nets correspond when
  // their terminal sets are equal.
  const termsA = new Map(), termsB = new Map(); // net -> Set(terms)
  for (const ref of common) {
    ex.get(ref).nodes.forEach((netName, i) => addTerm(termsA, netName, ref + '.' + i));
    go.get(ref).nodes.forEach((netName, i) => addTerm(termsB, netName, ref + '.' + i));
  }
  const sigA = signatures(termsA), sigB = signatures(termsB);
  for (const [sig, nets] of sigA) {
    if (!sigB.has(sig)) {
      for (const netName of nets) {
        report.net_mismatches.push({ schematic_net: netName, terminals: [...termsA.get(netName)].sort(),
          hint: closest(termsA.get(netName), termsB) });
      }
    }
  }
  for (const [sig, nets] of sigB) {
    if (!sigA.has(sig)) {
      for (const netName of nets) {
        report.net_mismatches.push({ netlist_net: netName, terminals: [...termsB.get(netName)].sort(),
          hint: closest(termsB.get(netName), termsA) });
      }
    }
  }
  // ground must match by name when present on both sides
  if (termsA.has('0') && termsB.has('0') && setSig(termsA.get('0')) !== setSig(termsB.get('0'))) {
    // already reported structurally; flag explicitly
    report.ground_mismatch = { schematic: [...termsA.get('0')].sort(), netlist: [...termsB.get('0')].sort() };
  }

  report.values_match = report.value_mismatches.length === 0;
  report.match = report.missing.length === 0 && report.extra.length === 0 &&
    report.type_mismatches.length === 0 && report.net_mismatches.length === 0;
  report.compared_components = common.length;
  return report;
}

function norm(v) { return String(v).replace(/\s+/g, ' ').trim().toLowerCase(); }
function addTerm(map, net, term) {
  if (!map.has(net)) map.set(net, new Set());
  map.get(net).add(term);
}
function setSig(set) { return [...set].sort().join(','); }
function signatures(terms) {
  const m = new Map();
  for (const [net, set] of terms) {
    const sig = setSig(set);
    if (!m.has(sig)) m.set(sig, []);
    m.get(sig).push(net);
  }
  return m;
}
/** most-overlapping net on the other side, as a debugging hint */
function closest(set, others) {
  let best = null, bn = 0;
  for (const [net, oset] of others) {
    const inter = [...set].filter((t) => oset.has(t)).length;
    if (inter > bn) { bn = inter; best = { net, shared_terminals: inter }; }
  }
  return best;
}
