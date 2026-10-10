/**
 * netcheck.js — errors IN THE NETLIST itself (not in the drawing), found
 * before drawing (Eric 2026-10-10):
 *
 *   mirror without a reference current — the diode-connected device of a
 *   current mirror whose drain node has NO other DC element (no current
 *   source, resistor, transistor channel, inductor or voltage source): its
 *   reference branch carries no imposed current. The source was forgotten in
 *   the netlist. Not repaired — never invented: reported (review page) and
 *   the netlist is excluded from the measures (bank journal).
 *   A node with an external name (a terminal of the circuit — IB1, IREF, VB,
 *   BIAS…) is fed from outside and is not an error; nor is a numbered node
 *   driven by a source elsewhere.
 */
import { detectStructures } from './patterns.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
// an internal node: a number or a tool-generated name (net12, n3, N_5)
const INTERNAL = /^(\d+|net\d*\w*|n_?\d+\w*|x\d+)$/i;

/** DC terminals of a part: [net, ...] (gates, bases and capacitors carry none). */
function dcNets(c) {
  if (['M', 'J'].includes(c.prefix)) return [c.nodes[0], c.nodes[2]];
  if (c.prefix === 'Q') return [c.nodes[0], c.nodes[2]];
  if (['R', 'L', 'I', 'V', 'D'].includes(c.prefix)) return c.nodes.slice(0, 2);
  return [];
}

/** @returns [{ref, net, message}] — one per mirror diode without a reference current */
export function mirrorsWithoutReference(parsed) {
  let st; try { st = detectStructures(parsed); } catch { return []; }
  const byRef = new Map(parsed.components.map((c) => [c.ref, c]));
  const out = [];
  for (const m of st.mirrors) {
    const d = byRef.get(m.diode);
    if (!d) continue;
    const net = d.nodes[0];
    if (RAIL.test(net) || !INTERNAL.test(net)) continue;
    const feeders = parsed.components.filter((c) => c !== d && dcNets(c).includes(net));
    if (!feeders.length) out.push({ ref: d.ref, net, message: `miroir ${m.refs.join('/')} : la branche de référence (${d.ref}, nœud ${net}) n'a aucun courant imposé — source oubliée dans la netlist` });
  }
  return out;
}
