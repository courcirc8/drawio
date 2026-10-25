/**
 * pdk-ihp.js — IHP SG13G2 primitives written as subcircuit instances
 * (`XM1 d g s b sg13_lv_nmos w=… l=…`), read as the SPICE element they are.
 *
 * Why (schemas-lisibles, 2026-10-25): netlists written for the IHP PDK
 * (xschem, analog-design) instantiate every device with an X line; the parser
 * skipped them all ("undefined .subckt"), so a real PDK netlist drew empty.
 * ONE table, SG13G2 only (Orchestrator decision).
 *
 * Provenance: pin order and line format read from the xschem symbols of the
 * open PDK, IHP-GmbH/IHP-Open-PDK (Apache-2.0), ihp-sg13g2/libs.tech/xschem/
 * sg13g2_pr/*.sym, commit 5e6d592e4002946a4616f798c357f0f3c06cf3b6:
 *  - sg13_{lv,hv}[_rf]_{nmos,pmos}: `@name @pinlist @model w= l= ng= m=`, pins D G S B
 *  - rppd / rsil / rhigh:           `@name @pinlist @body @model w= l= m= b=`, pins P M + body
 *  - cap_cmim:                      pins c c (2)       cap_rfcmim: c c bn (3)
 *  - npn13G2 / l / v:               pins C B E S       *_5t: C B E S T     pnpMPA: C B E
 *  - dantenna / dpantenna:          pins d d (2)
 * Only names and pin orders are used (facts), no file content is copied.
 */

/** model (lower case) -> { prefix, n: nodes on the line (min: when the optional body is omitted), keep: indices drawn } */
const TABLE = [
  { re: /^sg13_(lv|hv)(_rf)?_nmos$/, prefix: 'M', n: 4 },
  { re: /^sg13_(lv|hv)(_rf)?_pmos$/, prefix: 'M', n: 4 },
  { re: /^(rppd|rsil|rhigh)$/, prefix: 'R', n: 3, min: 2, keep: [0, 1] },
  { re: /^cap_cmim$/, prefix: 'C', n: 2 },
  { re: /^cap_rfcmim$/, prefix: 'C', n: 3, min: 2, keep: [0, 1] },
  { re: /^npn13g2[lv]?$/, prefix: 'Q', n: 4, min: 3 },
  { re: /^npn13g2[lv]?_5t$/, prefix: 'Q', n: 5 },
  { re: /^pnpmpa$/, prefix: 'Q', n: 3 },
  { re: /^d(p)?antenna$/, prefix: 'D', n: 2 },
];

export function ihpPrimitive(model) {
  const m = String(model || '').toLowerCase();
  return TABLE.find((t) => t.re.test(m)) || null;
}

/** the device parameters worth showing (w, l, ng, m, Nx) from `k=v` tokens */
export function ihpParams(tokens) {
  const p = {};
  for (const t of tokens) {
    const m = /^(w|l|ng|m|nx|b)=(.+)$/i.exec(t);
    if (m) p[m[1].toLowerCase()] = m[2];
  }
  return p;
}
