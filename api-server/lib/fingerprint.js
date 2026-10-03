/**
 * fingerprint.js — topology fingerprint of a netlist, names and values ignored.
 *
 * Weisfeiler-Lehman hashing (3 rounds) of the bipartite device/net graph:
 * devices labelled by kind (nmos/pmos/npn/pnp/R/C/L/D/V/I/S/X…), transistor
 * pins by position (D/G/S), nets by role (ground, supply, other).
 *   wl     — equal for the same topology (value or name changes do not matter);
 *   wlSet  — the set of all WL labels: Jaccard(wlSet) finds NEAR variants
 *            (a cap added, a stage repeated). Used to seal evaluation circuits
 *            and to keep their variants out of every tuning set.
 */
import crypto from 'node:crypto';
import { isPmosLike } from './patterns.js';

const h = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

function kindOf(c) {
  if (c.prefix === 'M') return isPmosLike(c) ? 'pmos' : 'nmos';
  if (c.prefix === 'Q') return isPmosLike(c) ? 'pnp' : 'npn';
  return c.prefix;
}

/** WL fingerprint of a parsed netlist. */
export function fingerprint(parsed) {
  const supply = (n) => /^(a?v(dd|cc)d?|vee|v\+|v-|vpos|vneg)$/i.test(n);
  const nodes = new Map();           // id -> {label, nbrs}
  const net = (n) => { const id = 'n:' + n; if (!nodes.has(id)) nodes.set(id, { label: n === '0' ? 'gnd' : supply(n) ? 'sup' : 'net', nbrs: [] }); return id; };
  for (const c of parsed.components) {
    const id = 'd:' + c.ref;
    nodes.set(id, { label: kindOf(c), nbrs: [] });
    c.nodes.forEach((n, i) => {
      const nid = net(n);
      // pin position matters for transistors (D/G/S), not for two-terminal parts
      const pin = 'MQJ'.includes(c.prefix) ? String(i) : '';
      nodes.get(id).nbrs.push(nid + '#' + pin);
      nodes.get(nid).nbrs.push(id + '#' + pin);
    });
  }
  let lab = new Map([...nodes].map(([k, v]) => [k, v.label]));
  const all = new Set(lab.values());
  const local = [];   // multiset of depth-1 and depth-2 labels of DEVICES (local neighbourhoods)
  for (let r = 0; r < 3; r++) {
    const next = new Map();
    for (const [k, v] of nodes) {
      const ms = v.nbrs.map((x) => { const [nid, pin] = x.split('#'); return pin + ':' + lab.get(nid); }).sort().join(',');
      next.set(k, h(lab.get(k) + '|' + ms));
    }
    lab = next;
    for (const x of lab.values()) all.add(x);
    if (r < 2) for (const [k, x] of lab) if (k.startsWith('d:')) local.push(r + ':' + x);
  }
  const multiset = [...lab.values()].sort().join(',');
  return { wl: h(multiset), wlSet: [...all].sort(), local: local.sort() };
}


/** Weighted (multiset) Jaccard of two `local` arrays: robust to a part added
 *  or a stage repeated — the measure used to call two circuits VARIANTS. */
export function variantSimilarity(a, b) {
  const ca = new Map(), cb = new Map();
  for (const x of a) ca.set(x, (ca.get(x) || 0) + 1);
  for (const x of b) cb.set(x, (cb.get(x) || 0) + 1);
  let mn = 0, mx = 0;
  for (const k of new Set([...ca.keys(), ...cb.keys()])) { const x = ca.get(k) || 0, y = cb.get(k) || 0; mn += Math.min(x, y); mx += Math.max(x, y); }
  return mx ? mn / mx : 0;
}

/** Jaccard similarity of two wlSet arrays. */
export function similarity(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
