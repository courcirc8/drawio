/**
 * ground-alias.js — a ground written `vss`, `gnd`, `agnd`… is drawn as ground
 * (orchestrator 2026-10-10, Eric's preference: one GND rail): lib/place2.js
 * gives the ground symbol and the ground rail to the net `0` only, so a deck
 * whose ground is called VSS drew it as a plain wire or a port.
 *
 * Only when it is unambiguous: the netlist has no `0` net and exactly ONE net
 * spelled like a ground. A deck with both `0` and `VSS` (a split supply, VSS
 * negative) or with two ground spellings (avss + dvss) is left as written —
 * merging them would short two rails.
 *
 * The placers see the alias renamed `0`; lib/lvs.js applies the same rule to
 * both sides, so a drawing (ground symbol = net 0) still matches the deck that
 * says VSS. Supplies keep their name (a supply tap names its net): lib/place2.js
 * reads vdd, vcc, avdd, vccd, vpwr (sky130), vdda, dvdd, vcca as the supply.
 */
/** The supply names lib/place2.js draws as a supply tap (shared with lib/place4.js). */
export const SUPPLY_NAME = /^(a?v(dd|cc)d?|vpwr|vdda|dvdd|vcca)$/i;

export const GROUND_NAME = /^(gnd|vss|vgnd|agnd|dgnd|avss|dvss|vssa|vssd|gnda|gndd|gnd!|vss!|0!)$/i;

/** The single ground alias among `nets` (iterable of names), else null. */
export function groundAlias(nets) {
  const all = new Set(nets);
  if (all.has('0')) return null;
  const al = [...new Set([...all].filter((n) => GROUND_NAME.test(String(n))).map((n) => String(n)))];
  const spellings = new Set(al.map((n) => n.toLowerCase()));
  return spellings.size === 1 ? al[0] : null;
}

const netsOf = (comps) => comps.flatMap((c) => c.fullNodes || c.nodes || []);

/** A copy of a parsed netlist with its ground alias renamed `0` (same object if none). */
export function withGroundAlias(parsed) {
  const a = groundAlias(netsOf(parsed.components));
  if (a == null) return parsed;
  const low = a.toLowerCase(), ren = (n) => (String(n).toLowerCase() === low ? '0' : n);
  return { ...parsed, groundAlias: a, components: parsed.components.map((c) => ({ ...c, nodes: c.nodes.map(ren), ...(c.fullNodes ? { fullNodes: c.fullNodes.map(ren) } : {}) })) };
}

/** Net-name mapper for one side of a comparison. */
export function groundMapper(comps) {
  const a = groundAlias(netsOf(comps));
  if (a == null) return (n) => n;
  const low = a.toLowerCase();
  return (n) => (String(n).toLowerCase() === low ? '0' : n);
}
