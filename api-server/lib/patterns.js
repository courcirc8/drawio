/**
 * patterns.js — reconnaissance de structures analogiques dans une netlist
 * SPICE parsée : paires différentielles, miroirs de courant, cascodes,
 * paires cross-couplées, queues de polarisation, diodes. Utilisé par le
 * placement (place2) et exposé via POST /structures pour inspection.
 */

function isMos(c) { return c.prefix === 'M' || c.prefix === 'Q'; }
export function isPmosLike(c) {
  return (c.prefix === 'M' && /pmos|pfet|pch/i.test(c.model || '')) ||
         (c.prefix === 'Q' && /pnp/i.test(c.model || ''));
}
// nodes: M/Q = [D, G, S]
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];

/**
 * @param parsed {components} de parseSpice
 * @returns {diffPairs, mirrors, cascodes, crossCoupled, diodes, tails, summary}
 */
export function detectStructures(parsed) {
  const comps = parsed.components;
  const mos = comps.filter(isMos);
  const railNames = new Set(['0']);
  for (const n of new Set(comps.flatMap((c) => c.nodes))) {
    if (/^(vdd|vcc|vss|avdd|dvdd)$/i.test(n)) railNames.add(n);
  }
  const out = { diffPairs: [], mirrors: [], cascodes: [], crossCoupled: [], diodes: [], tails: [] };

  // diodes (gate == drain)
  for (const c of mos) if (G(c) === D(c)) out.diodes.push({ ref: c.ref, net: G(c) });

  // paires différentielles : 2 MOS de même type, sources communes (hors rail),
  // gates distinctes
  for (let i = 0; i < mos.length; i++) {
    for (let j = i + 1; j < mos.length; j++) {
      const a = mos[i], b = mos[j];
      // la masse est un rail : deux MOS à source massée (Wilson M2/M3) ne
      // forment pas une paire — le flip « gates extérieures » écrasait la
      // règle 28 du miroir
      if (S(a) !== S(b) || railNames.has(S(a)) || S(a) === '0') continue;
      if (isPmosLike(a) !== isPmosLike(b)) continue;
      if (G(a) === G(b)) continue;
      out.diffPairs.push({ refs: [a.ref, b.ref], tailNet: S(a), gates: [G(a), G(b)] });
    }
  }

  // cross-couplés : G(a)==D(b) et G(b)==D(a)
  for (let i = 0; i < mos.length; i++) {
    for (let j = i + 1; j < mos.length; j++) {
      const a = mos[i], b = mos[j];
      // même polarité exigée : la boucle NMOS/PMOS d'un beta-multiplier
      // (G(M2)=D(M3), G(M3)=D(M2)) n'est PAS un cross-couplage de VCO
      if (isPmosLike(a) !== isPmosLike(b)) continue;
      if (G(a) === D(b) && G(b) === D(a) && D(a) !== D(b)) {
        out.crossCoupled.push({ refs: [a.ref, b.ref], nets: [D(a), D(b)] });
      }
    }
  }

  // miroirs de courant : groupe de MOS même type, même gate net, même source
  // net (rail en général), contenant une diode sur ce gate net
  const byGate = new Map();
  for (const c of mos) {
    const key = G(c) + '|' + S(c) + '|' + (isPmosLike(c) ? 'p' : 'n');
    if (!byGate.has(key)) byGate.set(key, []);
    byGate.get(key).push(c);
  }
  // les branches de sortie peuvent avoir la même gate mais une AUTRE source ?
  // (miroir simple : sources communes). On groupe par gate net + type, et on
  // exige une diode dans le groupe.
  const byGateType = new Map();
  for (const c of mos) {
    const key = G(c) + '|' + (isPmosLike(c) ? 'p' : 'n');
    if (!byGateType.has(key)) byGateType.set(key, []);
    byGateType.get(key).push(c);
  }
  for (const [key, group] of byGateType) {
    if (group.length < 2) continue;
    const diode = group.find((c) => G(c) === D(c));
    if (diode == null) continue;
    out.mirrors.push({ refs: group.map((c) => c.ref), diode: diode.ref,
      gateNet: key.split('|')[0], outputs: group.filter((c) => c !== diode).map((c) => c.ref) });
  }

  // cascodes : D(bas) == S(haut), net interne à exactement 2 terminaux MOS,
  // même type, pas une paire diff (sources non partagées ailleurs)
  const netCount = new Map();
  for (const c of comps) for (const n of c.nodes) netCount.set(n, (netCount.get(n) || 0) + 1);
  for (const hi of mos) {
    for (const lo of mos) {
      if (hi === lo || isPmosLike(hi) !== isPmosLike(lo)) continue;
      const mid = isPmosLike(hi) ? D(hi) : S(hi);
      const loTop = isPmosLike(lo) ? S(lo) : D(lo);
      if (mid !== loTop || railNames.has(mid)) continue;
      if ((netCount.get(mid) || 0) !== 2) continue;
      out.cascodes.push({ top: hi.ref, bottom: lo.ref, net: mid });
    }
  }

  // queues : composant (MOS ou I) dont le drain/la sortie alimente le tailNet
  // d'une paire diff
  for (const p of out.diffPairs) {
    for (const c of comps) {
      if (isMos(c) && D(c) === p.tailNet) out.tails.push({ ref: c.ref, pair: p.refs });
      if (c.prefix === 'I' && c.nodes.includes(p.tailNet)) out.tails.push({ ref: c.ref, pair: p.refs });
    }
  }

  // quads double-équilibrés (Gilbert) : deux paires dont les nets de queue
  // sont les deux drains d'une même paire inférieure
  out.quads = [];
  for (let i = 0; i < out.diffPairs.length; i++) {
    for (let j = 0; j < out.diffPairs.length; j++) {
      if (i === j) continue;
      const P1 = out.diffPairs[i], P2 = out.diffPairs[j];
      const lower = out.diffPairs.find((P0) => P0 !== P1 && P0 !== P2 &&
        P0.refs.some((r) => { const c = mos.find((k) => k.ref === r); return c != null && D(c) === P1.tailNet; }) &&
        P0.refs.some((r) => { const c = mos.find((k) => k.ref === r); return c != null && D(c) === P2.tailNet; }));
      if (lower != null && i < j) {
        out.quads.push({ pairs: [P1.refs, P2.refs], rfPair: lower.refs, refs: [...P1.refs, ...P2.refs] });
      }
    }
  }

  out.summary = {
    diffPairs: out.diffPairs.length, mirrors: out.mirrors.length,
    cascodes: out.cascodes.length, crossCoupled: out.crossCoupled.length,
    diodes: out.diodes.length, tails: out.tails.length, quads: out.quads.length,
  };
  return out;
}
