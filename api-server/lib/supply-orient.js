/**
 * supply-orient.js — which supply is positive (top rail) and which is negative (bottom rail), and MOS turned
 * so that their supply pin faces it (Eric 08.11: "positive rail at the top, negative at the bottom, by default;
 * never by placement-cost convenience").
 *
 * Polarity of a net, from two sources:
 *   name      power_* / vdd* / vcc* / avdd* … → positive ; ground_* / vss* / gnd* / 0 / agnd* … → negative
 *   devices   bulk of a PMOS (or its source on a supply-named net) → positive ; same for NMOS → negative
 * The name wins; when name and devices disagree a warning says so (no silent guess).
 *
 * A MOS is symmetric: a layout extraction names drain and source as it finds them (LOADMIR: XM5 drain on
 * power_ana). Before any placement, a PMOS whose drain is on a positive supply and whose source is not gets
 * drain and source swapped (NMOS: negative supply), so every engine hangs it below the top rail, source up.
 * The netlist LVS treats MOS drain and source as interchangeable (lib/lvs.js), like every LVS tool.
 */

const NOT = '(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))';
export const POS_NAME = new RegExp(`^(a?vdd\\w*|dvdd\\w*|vcc\\w*|vpwr|vdda\\w*|vcca|v\\+|power(?:_${NOT}\\w+)?)$`, 'i');
export const NEG_NAME = new RegExp(`^(0|gnd\\w*|agnd\\w*|dgnd\\w*|a?vss\\w*|dvss\\w*|vee\\w*|vgnd|v-|ground(?:_${NOT}\\w+)?)$`, 'i');

const kindOf = (c) => {
  if (c.prefix !== 'M' && !(c.prefix === 'X' && /mos/i.test(c.model || ''))) return null;
  const m = String(c.model || c.value || '').toLowerCase();
  if (/pmos|pfet|^p(ch)?\b|_p$|pch/.test(m)) return 'P';
  if (/nmos|nfet|^n(ch)?\b|_n$|nch/.test(m)) return 'N';
  return null;
};
const nodesOf = (c) => c.fullNodes || c.nodes || [];

/** {net: 'pos'|'neg'} for the supply nets, and the warnings */
export function supplyPolarity(parsed) {
  const byName = new Map(), byDev = new Map(), warnings = [];
  const vote = (n, v) => { const s = byDev.get(n) || { pos: 0, neg: 0 }; s[v]++; byDev.set(n, s); };
  for (const c of parsed.components) {
    for (const n of nodesOf(c)) if (!byName.has(n)) byName.set(n, POS_NAME.test(n) ? 'pos' : NEG_NAME.test(n) ? 'neg' : null);
    const k = kindOf(c), n = nodesOf(c);
    if (!k || n.length < 3) continue;
    const v = k === 'P' ? 'pos' : 'neg';
    if (n[3] != null) vote(n[3], v);
  }
  const pol = new Map();
  for (const [n, v] of byName) if (v) pol.set(n, v);
  for (const [n, s] of byDev) {
    const d = s.pos && !s.neg ? 'pos' : s.neg && !s.pos ? 'neg' : null, named = byName.get(n);
    if (named && d && named !== d) warnings.push(`supply ${n}: named ${named === 'pos' ? 'positive' : 'negative'} but bulk of ${d === 'pos' ? 'PMOS' : 'NMOS'} only; drawn as its name says`);
    else if (!named && d && n !== '' && isRailLike(parsed, n)) pol.set(n, d);
  }
  return { pol, warnings };
}

// an unnamed bulk net is a supply only if it carries nothing but bulks and sources (no gate, no passive)
function isRailLike(parsed, net) {
  for (const c of parsed.components) {
    const n = nodesOf(c);
    if (kindOf(c)) { if (n[1] === net) return false; }
    else if (n.includes(net)) return false;
  }
  return true;
}

/** parsed -> {parsed (MOS turned), swapped: [refs], polarity: {net: pos|neg}, warnings} */
export function orientSupplies(parsed) {
  const { pol, warnings } = supplyPolarity(parsed), swapped = [];
  const components = parsed.components.map((c) => {
    const k = kindOf(c), n = nodesOf(c);
    if (!k || n.length < 3) return c;
    const own = k === 'P' ? 'pos' : 'neg';
    if (pol.get(n[0]) !== own || pol.get(n[2]) === own) return c;
    swapped.push(c.ref);
    const swap = (a) => a && a.length >= 3 ? [a[2], a[1], a[0], ...a.slice(3)] : a;
    return { ...c, nodes: swap(c.nodes), fullNodes: swap(c.fullNodes) };
  });
  return { parsed: swapped.length ? { ...parsed, components } : parsed, swapped, polarity: Object.fromEntries(pol), warnings };
}

/**
 * The rule on a drawing: every MOS with a channel pin on a positive supply sits above every MOS with a channel
 * pin on a negative supply (centre to centre). -> [{pos, neg}] pairs that break it.
 */
export function supplyOrderViolations(cells, parsed) {
  const { pol } = supplyPolarity(parsed);
  const y = new Map(cells.filter((c) => c.kind === 'vertex' && c.refdes && c.y != null).map((c) => [c.refdes, c.y + (c.h || 0) / 2]));
  const pos = [], neg = [];
  for (const c of parsed.components) {
    if (!kindOf(c) || !y.has(c.ref)) continue;
    const n = nodesOf(c), ch = [n[0], n[2]].map((x) => pol.get(x));
    if (ch.includes('pos') && !ch.includes('neg')) pos.push(c.ref);
    if (ch.includes('neg') && !ch.includes('pos')) neg.push(c.ref);
  }
  const out = [];
  for (const p of pos) for (const q of neg) if (y.get(p) >= y.get(q)) out.push({ pos: p, neg: q });
  return out;
}
