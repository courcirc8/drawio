/**
 * fingers.js — parallel identical devices (the fingers of a layout extraction: DIFFCC has 18, TIABIAS2 30)
 * are one device of multiplier m=N, before any drawing and on both sides of the LVS (the parallel reduction of
 * every LVS tool).
 *
 * Merge key, the same as layout3d's schema (local_AI apps/layout3d/schema_dessin.py, #468 and 965efff), so that
 * both tools merge alike:
 *   MOS  (model, {drain, source} unordered, gate, bulk, w, l, nf, ng, m)
 *   C    (model, nodes in order (MIM top plate first), w, l, value)
 *   R    (model, nodes unordered, w, l, value)
 * Two devices that differ by any of these do not merge. Other devices (L, D, Q, sources, subcircuits) never do.
 * The merged device keeps the first ref in natural order (deterministic on both LVS sides) and the sum of the
 * multipliers: `m=N` in its value (and params.m), `fingers` = the refs it stands for.
 */

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
const MULT = /^(m|mult)$/i;

/** the k=v parameters of a device, from params or from its value string (a netlist without PDK) */
function paramsOf(c) {
  const out = {};
  for (const [k, v] of Object.entries(c.params || {})) out[k.toLowerCase()] = String(v);
  for (const t of String(c.value || '').split(/\s+/)) {
    const m = /^([A-Za-z_][\w]*)=(\S+)$/.exec(t);
    if (m && !(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

function keyOf(c) {
  const p = paramsOf(c), model = String(c.model || '').toLowerCase();
  const n = c.fullNodes || c.nodes || [];
  const pick = (...ks) => ks.map((k) => p[k] ?? '').join(',');
  if (c.prefix === 'M') {
    if (n.length < 3) return null;
    return ['M', model, [n[0], n[2]].sort().join('/'), n[1], n[3] ?? '', pick('w', 'l', 'nf', 'ng', 'm', 'mult')].join('|');
  }
  // a bare value (R1 a b 1k) is in the model field: it is part of the key either way
  if (c.prefix === 'C' && n.length === 2) return ['C', model, n.join('/'), pick('w', 'l', 'c', 'm', 'mult')].join('|');
  if (c.prefix === 'R' && n.length === 2) return ['R', model, [...n].sort().join('/'), pick('w', 'l', 'r', 'm', 'mult')].join('|');
  return null;
}

/** multiplier of one device (m= or mult=, 1 if absent) */
function multOf(c) {
  const p = paramsOf(c), v = parseFloat(p.m ?? p.mult ?? '1');
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** the value with its multiplier set to N */
function withMult(value, N) {
  const toks = String(value || '').split(/\s+/).filter(Boolean);
  const i = toks.findIndex((t) => /^(m|mult)=/i.test(t));
  if (i >= 0) toks[i] = `${toks[i].split('=')[0]}=${N}`; else toks.push(`m=${N}`);
  return toks.join(' ');
}

function orientation(g, keep) {
  const n = (c) => c.fullNodes || c.nodes;
  const onBulk = g.filter((c) => n(c)[3] != null && n(c)[2] === n(c)[3]);
  const pool = onBulk.length && onBulk.length < g.length ? onBulk : g;
  const votes = new Map();
  for (const c of pool) { const k = n(c)[0]; votes.set(k, (votes.get(k) || 0) + 1); }
  const best = Math.max(...votes.values());
  const tops = [...votes].filter(([, v]) => v === best).map(([k]) => k);
  const d = tops.includes(n(keep)[0]) && pool.includes(keep) ? n(keep)[0] : tops[0];
  return pool.find((c) => n(c)[0] === d) || keep;
}

/** parsed netlist -> the same with parallel identical devices merged; `merged` = {kept ref: [all refs]} */
export function mergeFingers(parsed) {
  const groups = new Map(), order = [];
  for (const c of parsed.components) {
    const k = keyOf(c);
    if (k == null) { order.push([c]); continue; }
    if (!groups.has(k)) { const g = [c]; groups.set(k, g); order.push(g); } else groups.get(k).push(c);
  }
  if (order.length === parsed.components.length) return { ...parsed, merged: {} };
  const merged = {}, components = [];
  for (const g of order) {
    if (g.length === 1) { components.push(g[0]); continue; }
    const refs = g.map((c) => c.ref).sort(natural), keep = g.find((c) => c.ref === refs[0]);
    const N = g.reduce((s, c) => s + multOf(c), 0);
    // drain and source of a MOS as most fingers have them: source on the bulk first (an extraction swaps them
    // finger by finger), then the majority, then the kept finger
    const o = g[0].prefix === 'M' ? orientation(g, keep) : keep;
    const c = { ...keep, nodes: o.nodes, fullNodes: o.fullNodes, value: withMult(keep.value, N), fingers: refs };
    if (keep.params) c.params = Object.fromEntries([...Object.entries(keep.params).filter(([k]) => !MULT.test(k)), ['m', String(N)]]);
    merged[keep.ref] = refs;
    components.push(c);
  }
  return { ...parsed, components, merged };
}
