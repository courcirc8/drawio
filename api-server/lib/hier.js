/**
 * hier.js — HIERARCHICAL drawing of a SPICE netlist: one page per .subckt
 * (flat, local names), one page per bank of switched parts found in the top
 * level, and a TOP page where every X instance and every bank is a block with
 * its pins.
 *
 * Why (schemas-lisibles, 2026-10-25, Orchestrator GO for analog-design): a
 * hierarchical netlist (TIA Butterworth 3: ota1..ota3 + 6 switched banks,
 * ~200 parts once flattened) is unreadable on one flat sheet. Decisions:
 *  (a) one page per DEFINITION (default), `per: 'instance'` for one page per
 *      instance path (overlays that differ per instance);
 *  (b) ladders / banks of the top level grouped AUTOMATICALLY into `bank_*`
 *      pages (designers do not rewrite their netlists), the top stays readable;
 *  (c) IHP SG13G2 primitives read by lib/pdk-ihp.js.
 * Every page is checked by LVS against its own netlist, and the whole drawing,
 * flattened back through the blocks, against the flattened netlist.
 */
import { parseSpice, extractNetlist } from './netlist.js';
import { Sheet, emit, placeTwo, placeTr, placeDevice, portVert, tapGnd, tapVdd } from './place-manuel.js';
import { blockPinsStyle } from './components.js';
import { newDocument, getPage, addPage, normalizeOrigin } from './model.js';
import { compare } from './lvs.js';
import { geoLvs } from './geo-lvs.js';
import { annotation as annotationOf } from './place-manuel.js';
import { brokawReading, importBrokaw } from './place-brokaw.js';
import { withGroundAlias } from './ground-alias.js';

const RAILNAME = /^(0|vdd\w*|vss\w*|avdd\w*|dvdd\w*|vcc\w*|vee\w*|gnd\w*|power(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?|ground(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?)$/i;

/** parts of a bank or a resistor string from which it gets its own page */
export const GROUP_PAGE_MIN = 12;

/** text of a netlist whose top level is the body of .subckt `def` (other definitions kept) */
function bodyText(parsed, def) {
  const out = [];
  for (const d of Object.values(parsed.subckts)) {
    out.push(`.subckt ${d.name} ${d.pins.join(' ')}`, ...d.lines, `.ends ${d.name}`);
  }
  out.push(...(def ? def.lines : []), '.end');
  return out.join('\n');
}

/** the top level of `text` with every defined X kept as a block; definitions read the same way */
export function hierReading(text, opts = {}) {
  const flat = parseSpice(text);
  const top = parseSpice(text, { blocks: true });
  const defs = new Map();          // name (as written) -> {name, pins, parsed}
  const visit = (name) => {
    const d = flat.subckts[String(name).toUpperCase()];
    if (!d || defs.has(d.name)) return;
    const parsed = parseSpice(`* .subckt ${d.name}\n` + bodyText(flat, d), { blocks: true });
    parsed.pins = [...d.pins];        // the page's ports (manuel engine: every pin named on its page)
    defs.set(d.name, { name: d.name, pins: d.pins, parsed, symbol: symbolOf(d, parsed, opts.symbols), macro: !!d.macro });
    for (const c of parsed.components) if (c.block) visit(c.block);
  };
  for (const c of top.components) if (c.block) visit(c.block);
  const banks = opts.banks === false ? [] : bankReading(top).map((b) => ({ ...b, kind: 'bank' }));
  const taken = new Set(banks.flatMap((b) => b.parts.map((c) => c.ref)));
  const chains = opts.banks === false ? [] : chainReading(top, taken);
  // a group becomes its own page only when large (Eric, 2026-10-26: too many pages draw
  // badly); a shorter resistor string or bank stays on its parent page
  const large = (b) => b.parts.length >= GROUP_PAGE_MIN;
  return { flat, top, defs, banks: [...banks, ...chains].filter(large), instances: flat.instances };
}

/* ------------------------------------------------------------ symbols */
/** the symbol of a definition on the page that instantiates it (D2, PLAN-HIERARCHIE §3.2):
 *  'ota' (triangle, one output), 'ota_fd' (triangle, outp / outn) or 'box'. An explicit
 *  choice wins: opts.symbols { name: 'ota' | 'opamp' | 'ota_fd' | 'box' }, else a comment
 *  `*.symbol ota` in the .subckt; without one, the role: an input pair on two pins (same
 *  device, common source), a diode (the mirror) and one or two output pins. */
const SYMBOLS = { ota: 'ota', opamp: 'ota', amp: 'ota', ota_fd: 'ota_fd', opamp_fd: 'ota_fd', box: 'box', block: 'box' };
function symbolOf(d, parsed, given = {}) {
  const key = Object.keys(given || {}).find((k) => k.toLowerCase() === d.name.toLowerCase());
  const hint = key != null ? given[key] : (d.lines.map((l) => /^\s*\*\s*\.?symbol\s+(\S+)/i.exec(l)).find(Boolean) || [])[1];
  if (hint != null) return SYMBOLS[String(hint).toLowerCase()] || 'box';
  const pins = new Set(d.pins.map((p) => p.toLowerCase()));
  const trs = parsed.components.filter((c) => /^[MQ]$/.test(c.prefix) && c.nodes.length >= 3);
  const lc = (n) => String(n).toLowerCase();
  const pair = trs.some((a) => trs.some((b) => a !== b && a.model === b.model && lc(a.nodes[2]) === lc(b.nodes[2]) && !pins.has(lc(a.nodes[2])) &&
    a.nodes[1] !== b.nodes[1] && pins.has(lc(a.nodes[1])) && pins.has(lc(b.nodes[1]))));
  const diode = trs.some((c) => c.nodes[0] === c.nodes[1]);
  const outs = d.pins.filter((p) => OUT_RE.test(p)).length;
  return pair && diode && outs >= 1 && outs <= 2 ? (outs === 2 ? 'ota_fd' : 'ota') : 'box';
}

/* ------------------------------------------------------------ chains */
/** SERIES CHAINS of the top level (a resistor built of N unit resistors):
 *  two-pin parts of one kind joined end to end through nets used by exactly
 *  those two parts (no rail, no block pin). Returns [{name, kind:'chain', pins:[a, b], parts}] */
export function chainReading(parsed, taken = new Set()) {
  const all = parsed.components;
  const deg = new Map();
  for (const c of all) for (const n of new Set(c.nodes)) deg.set(n, (deg.get(n) || 0) + 1);
  const cand = all.filter((c) => !c.block && !taken.has(c.ref) && /^[RCL]$/.test(c.prefix) && new Set(c.nodes).size === 2);
  const inner = (n, a, b) => !RAILNAME.test(n) && deg.get(n) === 2 && a.prefix === b.prefix;
  const byNet = new Map();
  for (const c of cand) for (const n of c.nodes) { if (!byNet.has(n)) byNet.set(n, []); byNet.get(n).push(c); }
  const seen = new Set(), chains = [];
  for (const c0 of cand) {
    if (seen.has(c0.ref)) continue;
    // walk both ways from c0 through inner nets
    const next = (c, from) => {
      const n = c.nodes.find((m) => m !== from);
      const cs = byNet.get(n) || [];
      const d = cs.length === 2 ? cs.find((x) => x !== c) : null;
      return d && inner(n, c, d) && !seen.has(d.ref) ? { d, n } : null;
    };
    let parts = [c0], nets = [c0.nodes[0], c0.nodes[1]];
    seen.add(c0.ref);
    for (let s = next(c0, nets[0]); s; s = next(s.d, s.n)) { parts.push(s.d); nets.push(s.d.nodes.find((m) => m !== s.n)); seen.add(s.d.ref); }
    for (let s = next(c0, nets[1]); s; s = next(s.d, s.n)) { parts.unshift(s.d); nets.unshift(s.d.nodes.find((m) => m !== s.n)); seen.add(s.d.ref); }
    if (parts.length < 2) continue;
    // name: the refs' common prefix ("XRF1u0".."XRF1u22" -> chain_XRF1)
    let pre = parts[0].ref;
    for (const c of parts) while (!c.ref.startsWith(pre)) pre = pre.slice(0, -1);
    pre = pre.replace(/[u_]?\d*$/i, '') || parts[0].ref;
    let name = 'chain_' + pre.replace(/[^A-Za-z0-9_]/g, ''), k = 2;
    while (chains.some((x) => x.name === name)) name = `chain_${pre}_${k++}`;
    chains.push({ name, kind: 'chain', pins: [nets[0], nets[nets.length - 1]], nets, parts });
  }
  return chains;
}

/* ------------------------------------------------------------ banks */
/** BANKS of the top level: groups of parts joined only through private nets,
 *  touching the same set of HUB nets (rails and nets used by >= 5 parts); three
 *  groups or more with one signature form a bank, with the parts joining two
 *  of its hubs directly (the unswitched capacitor) when they are of the same
 *  kind as the bank's parts on those hubs. Returns [{name, pins, parts}]. */
export function bankReading(parsed, minGroups = 3) {
  const comps = parsed.components.filter((c) => !c.block);
  const all = parsed.components;
  const deg = new Map();
  for (const c of all) for (const n of new Set(c.nodes)) deg.set(n, (deg.get(n) || 0) + 1);
  const hub = (n) => RAILNAME.test(n) || (deg.get(n) || 0) >= 5 || all.some((c) => c.block && c.nodes.includes(n));
  // union of parts through private nets
  const par = new Map(comps.map((c) => [c.ref, c.ref]));
  const find = (r) => { while (par.get(r) !== r) r = par.get(r); return r; };
  const byNet = new Map();
  for (const c of comps) for (const n of new Set(c.nodes)) if (!hub(n)) { if (!byNet.has(n)) byNet.set(n, []); byNet.get(n).push(c); }
  for (const cs of byNet.values()) for (let i = 1; i < cs.length; i++) par.set(find(cs[i].ref), find(cs[0].ref));
  const groups = new Map();
  for (const c of comps) { const r = find(c.ref); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); }
  // a private net must stay inside its group (a net shared with a block is a hub)
  const sig = (g) => [...new Set(g.flatMap((c) => c.nodes.filter(hub)))].sort().join('|');
  const bySig = new Map();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const s = sig(g);
    if (s.split('|').filter((n) => !RAILNAME.test(n)).length < 2) continue;
    if (!bySig.has(s)) bySig.set(s, []);
    bySig.get(s).push(g);
  }
  const banks = [], taken = new Set();
  for (const [s, gs] of bySig) {
    if (gs.length < minGroups) continue;
    const pins = s.split('|');
    const parts = gs.flat();
    // a part straight between two of the hubs, of the kind the bank uses on them
    for (const c of comps) {
      if (taken.has(c.ref) || parts.includes(c) || groups.get(find(c.ref)).length !== 1) continue;
      const ns = [...new Set(c.nodes)];
      if (ns.length !== 2 || !ns.every((n) => pins.includes(n) && !RAILNAME.test(n))) continue;
      if (ns.some((n) => parts.some((p) => p.prefix === c.prefix && p.nodes.includes(n)))) parts.push(c);
    }
    for (const c of parts) taken.add(c.ref);
    // order the pins: signal hubs first (as met in the parts), rails last
    const order = [...pins].sort((a, b) => (RAILNAME.test(a) - RAILNAME.test(b)) || parts.findIndex((c) => c.nodes.includes(a)) - parts.findIndex((c) => c.nodes.includes(b)));
    banks.push({ name: bankName(order, banks), pins: order, parts });
  }
  return banks;
}
function bankName(pins, banks) {
  const sig = pins.filter((n) => !RAILNAME.test(n)).slice(0, 2).map((n) => n.replace(/[^A-Za-z0-9_]/g, '')).join('_');
  let name = 'bank_' + sig, k = 2;
  while (banks.some((b) => b.name === name)) name = `bank_${sig}_${k++}`;
  return name;
}


/* ------------------------------------------------------------ top page */
const RAIL0 = /^(0|gnd\w*|vss\w*|ground(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?)$/i;
const IN_RE = /^(v?in\w*|v?i[pn]|v?[pn]in)$/i;
const OUT_RE = /^(v?out\w*|v?o[pn]?\d*|v?o[pn]|y)$/i;
const isSupply = (n) => RAILNAME.test(n) && !RAIL0.test(n);
const isRail = (n) => RAILNAME.test(n);
/** side of a block pin from the subcircuit's own pin name */
function pinSide(name) {
  if (RAIL0.test(name)) return 'bottom';
  if (isSupply(name)) return 'top';
  if (IN_RE.test(name)) return 'left';
  if (OUT_RE.test(name)) return 'right';
  return 'bottom';
}

/** the items of a page with blocks: X instances (stages), banks, flat parts.
 *  Returns [{kind, ref, comp, nets, pins?}] */
export function pageItems(parsed, banks, symbols = new Map()) {
  const inBank = new Set(banks.flatMap((b) => b.parts.map((c) => c.ref)));
  const items = [];
  for (const c of parsed.components) {
    if (inBank.has(c.ref)) continue;
    if (c.block) {
      const it = { kind: 'block', ref: c.ref, comp: c, pins: c.pins.map((p, i) => ({ name: p, net: c.nodes[i], side: pinSide(p) })) };
      const tri = triangleOf(it, symbols.get(String(c.block).toUpperCase()));
      if (tri) { it.symbol = tri.symbol; it.tri = tri.rel; for (const p of it.pins) p.side = tri.side[p.name]; }
      items.push(it);
    }
    else items.push({ kind: 'part', ref: c.ref, comp: c });
  }
  for (const b of banks) {
    const comp = { ref: b.name, prefix: 'X', block: b.name, pins: [...b.pins], nodes: [...b.pins], fullNodes: [...b.pins], value: b.name, model: b.name, bank: true };
    items.push({ kind: 'bank', group: b.kind || 'bank', ref: b.name, comp, pins: b.pins.map((n) => ({ name: n, net: n, side: RAIL0.test(n) ? 'bottom' : isSupply(n) ? 'top' : null })) });
  }
  for (const it of items) it.nets = [...new Set(it.comp.nodes)].filter((n) => !isRail(n));
  return items;
}

/** stages (blocks, else banks) ordered by signal flow; every other item put in
 *  a group: feedback above a stage, series / input / load in the gap before a
 *  stage (gap k = before the stage of level k), sources on the left */
function topLayout(items) {
  let stages = items.filter((i) => i.kind === 'block');
  if (!stages.length) stages = items.filter((i) => i.kind === 'bank');
  const ins = new Map(), outs = new Map();
  for (const s of stages) {
    if (s.kind === 'bank') { ins.set(s, new Set(s.nets.slice(0, 1))); outs.set(s, new Set(s.nets.slice(1, 2))); continue; }
    ins.set(s, new Set(s.pins.filter((p) => p.side === 'left').map((p) => p.net)));
    outs.set(s, new Set(s.pins.filter((p) => p.side === 'right').map((p) => p.net)));
  }
  const others = items.filter((i) => !stages.includes(i));
  const on = (n) => others.filter((i) => i.nets.includes(n));
  // levels: breadth first from the stages fed by a source or an in* net
  const level = new Map();
  const fed = stages.filter((s) => [...ins.get(s)].some((n) => IN_RE.test(n) || on(n).some((i) => /^[IV]$/.test(i.comp.prefix))));
  const queue = (fed.length ? fed : stages.slice(0, 1)).map((s) => (level.set(s, 0), s));
  while (queue.length) {
    const s = queue.shift();
    const reach = new Set();
    for (const n of outs.get(s)) { reach.add(n); for (const i of on(n)) for (const m of i.nets) reach.add(m); }
    for (const t of stages) if (!level.has(t) && [...ins.get(t)].some((n) => reach.has(n))) { level.set(t, level.get(s) + 1); queue.push(t); }
  }
  for (const s of stages) if (!level.has(s)) level.set(s, Math.max(-1, ...level.values()) + 1);
  const nLev = Math.max(0, ...level.values()) + 1;
  const feedback = new Map(stages.map((s) => [s, []]));
  const gaps = Array.from({ length: nLev + 1 }, () => []);
  const sources = [];
  for (const it of others) {
    const o = stages.filter((s) => it.nets.some((n) => outs.get(s).has(n))).sort((a, b) => level.get(a) - level.get(b));
    const i = stages.filter((s) => it.nets.some((n) => ins.get(s).has(n))).sort((a, b) => level.get(a) - level.get(b));
    if (o.length && i.length) {
      const s = o[o.length - 1], t = i[0];
      if (level.get(t) <= level.get(s)) feedback.get(t).push(it);
      else gaps[level.get(s) + 1].push(it);
      it.left = it.nets.find((n) => ins.get(t).has(n) || (level.get(t) > level.get(s) && outs.get(s).has(n)));
      if (level.get(t) > level.get(s)) it.left = it.nets.find((n) => outs.get(s).has(n));
    } else if (o.length) { gaps[level.get(o[0]) + 1].push(it); it.left = it.nets.find((n) => outs.get(o[0]).has(n)); }
    else if (i.length) { gaps[level.get(i[0])].push(it); it.left = null; }
    else sources.push(it);
    // a bank's own pins: the input-side net on the left, the other signal net on the right
    if (it.kind === 'bank') {
      const left = it.left || it.nets[0], right = it.nets.find((n) => n !== left && (o.some((s) => outs.get(s).has(n)) || i.some((s) => ins.get(s).has(n))));
      for (const p of it.pins) if (!p.side) p.side = p.net === left ? 'left' : p.net === right ? 'right' : 'bottom';
    }
  }
  // the stage pins of a bank stage
  for (const s of stages) if (s.kind === 'bank') for (const p of s.pins) if (!p.side) p.side = ins.get(s).has(p.net) ? 'left' : outs.get(s).has(p.net) ? 'right' : 'bottom';
  return { stages: [...stages].sort((a, b) => level.get(a) - level.get(b)), level, feedback, gaps, sources, nLev };
}

const STUB = 20;
/** the end of a wire at p on net n, leaving in direction d ('l','r','u','d'): label, supply or ground */
function endAt(S, n, p, d) {
  const q = { x: p.x + (d === 'l' ? -STUB : d === 'r' ? STUB : 0), y: p.y + (d === 'u' ? -STUB : d === 'd' ? STUB : 0) };
  S.path(n, p, q);
  if (RAIL0.test(n) && d !== 'u') { S.term(n, tapGnd(S, q), 'N'); return; }
  if (isSupply(n) && d === 'u') { S.term(n, tapVdd(S, n, q), 'S'); return; }
  const pv = portVert(S, n, q, d === 'l' ? -1 : 1, false);
  S.term(n, pv, pv.portPin);
}
/** the box of a block (pins on its four sides by p.side), top-left corner at (x, y) */
export function blockVertex(S, it, x = 0, y = null) {
  const by = (side) => it.pins.filter((p) => p.side === side);
  const L = by('left'), R = by('right'), T = by('top'), B = by('bottom');
  const h = (Math.max(L.length, R.length, 1) + 1) * 40, w = 60 * (Math.max(T.length, B.length, 2) + 1);
  const rel = {};
  L.forEach((p, i) => { rel[p.name] = { x: 0, y: (i + 1) / (L.length + 1) }; });
  R.forEach((p, i) => { rel[p.name] = { x: 1, y: (i + 1) / (R.length + 1) }; });
  T.forEach((p, i) => { rel[p.name] = { x: (i + 1) / (T.length + 1), y: 0 }; });
  B.forEach((p, i) => { rel[p.name] = { x: (i + 1) / (B.length + 1), y: 1 }; });
  const pins = it.pins.map((p) => ({ name: p.name, ...rel[p.name] }));
  const label = it.kind === 'bank' ? `<b>${it.ref}</b><br><font style="font-size:10px">${it.bankNote}</font>` : `<b>${it.ref}</b><br>${it.comp.block}`;
  const st = `rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=default;fontSize=12;apiBlock=1;apiBlockDef=${encodeURIComponent(it.comp.block)};apiBlockPins=${blockPinsStyle(pins)};` + (it.kind === 'bank' ? 'dashed=1;' : '');
  return S.vert({ id: it.ref, c: it.comp, style: st, x, y: y == null ? -h / 2 : y, w, h, pins: rel, value: label, refdes: it.ref });
}
function drawBlock(S, it) {
  const v = blockVertex(S, it);
  for (const p of it.pins) {
    const a = S.term(p.net, v, p.name);
    endAt(S, p.net, a, { left: 'l', right: 'r', top: 'u', bottom: 'd' }[p.side]);
    // the pin name inside the box
    if (p.side === 'left' || p.side === 'right') S.text(p.name, p.side === 'left' ? a.x + 4 : a.x - 64, a.y - 9, 60, 18, p.side, 10);
  }
}
/** an amplifier triangle pointing right (box 120 x 120): '+' and '−' on the left, the output on the apex
 *  (outp / outn on the slanted sides near it), supplies on the upper side, grounds and other pins (ibias…) on
 *  the lower side, then the upper one; at most 3 per side, on the 20 grid. Returns null when the pins do not
 *  fit (two inputs and one or two outputs needed): the block stays a box. */
function triangleOf(it, symbol) {
  if (symbol !== 'ota' && symbol !== 'ota_fd') return null;
  const names = it.pins.map((p) => p.name);
  const outs = names.filter((n) => OUT_RE.test(n));
  const ins = names.filter((n) => IN_RE.test(n) && !outs.includes(n));
  if (ins.length !== 2 || outs.length !== (symbol === 'ota_fd' ? 2 : 1)) return null;
  // polarity from the name (inp / inn, vip / vin, in_plus / in_minus); when the names do not give it
  // (in1 / in2, inputcm_VNI / inputcm_VPI) the pin order places them and no sign is written: a wrong
  // '+' is worse than none (review of #68)
  const sign = (n) => (/(p|plus|pos)$/i.test(n) ? 1 : /(n|m|minus|neg)$/i.test(n) ? -1 : 0);
  const known = sign(ins[0]) !== sign(ins[1]);
  const [plus, minus] = sign(ins[0]) < sign(ins[1]) ? [ins[1], ins[0]] : [ins[0], ins[1]];
  const rel = { [plus]: { x: 0, y: 1 / 3, ...(known ? { sign: '+' } : {}) }, [minus]: { x: 0, y: 2 / 3, ...(known ? { sign: '−' } : {}) } };
  const side = { [plus]: 'left', [minus]: 'left' };
  if (outs.length === 1) { rel[outs[0]] = { x: 1, y: 0.5 }; side[outs[0]] = 'right'; }
  else {
    const [p, n] = /n$/i.test(outs[0]) ? [outs[1], outs[0]] : outs;
    rel[p] = { x: 2 / 3, y: 1 / 3 }; rel[n] = { x: 2 / 3, y: 2 / 3 }; side[p] = side[n] = 'right';
  }
  const others = names.filter((n) => !rel[n]);
  const up = others.filter((n) => isSupply(n)), down = others.filter((n) => RAIL0.test(n));
  for (const n of others) if (!up.includes(n) && !down.includes(n)) (down.length < 3 - (outs.length === 2 ? 1 : 0) ? down : up).push(n);
  const XS = { 1: [1 / 2], 2: [1 / 3, 1 / 2], 3: [1 / 6, 1 / 3, 1 / 2] };
  const cap = outs.length === 2 ? 2 : 3;     // past x = 1/2 the side meets an outp / outn stub
  if (up.length > cap || down.length > cap) return null;
  up.forEach((n, i) => { const x = XS[up.length][i]; rel[n] = { x, y: x / 2 }; side[n] = 'top'; });
  down.forEach((n, i) => { const x = XS[down.length][i]; rel[n] = { x, y: 1 - x / 2 }; side[n] = 'bottom'; });
  return { symbol, rel, side };
}
/** the amplifier triangle of a block (it.tri), top-left corner at (x, y); `pinText(S, it, p, a)` writes the
 *  '+' / '−' signs and the names of the side pins other than rails (ibias, vcmref) inside it */
export function triangleVertex(S, it, x = 0, y = -60) {
  const W = 120, H = 120;
  const pins = it.pins.map((p) => ({ name: p.name, x: it.tri[p.name].x, y: it.tri[p.name].y }));
  const rel = Object.fromEntries(pins.map((p) => [p.name, { x: p.x, y: p.y }]));
  const st = `triangle;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=default;fontSize=11;align=left;spacingLeft=14;apiBlock=1;apiSymbol=${it.symbol};apiBlockDef=${encodeURIComponent(it.comp.block)};apiBlockPins=${blockPinsStyle(pins)};`;
  return S.vert({ id: it.ref, c: it.comp, style: st, x, y, w: W, h: H, pins: rel, value: `<b>${it.ref}</b><br>${it.comp.block}`, refdes: it.ref });
}
export function trianglePinText(S, it, p, a) {
  const t = it.tri[p.name];
  if (t.sign) S.text(t.sign, a.x + 3, a.y - 9, 14, 18, 'left', 13);
  else if ((p.side === 'top' || p.side === 'bottom') && !isRail(p.name)) S.text(p.name, a.x - 25, p.side === 'top' ? a.y + 4 : a.y - 18, 50, 14, 'center', 9);
}
function drawTriangle(S, it) {
  const v = triangleVertex(S, it);
  for (const p of it.pins) {
    const a = S.term(p.net, v, p.name);
    endAt(S, p.net, a, { left: 'l', right: 'r', top: 'u', bottom: 'd' }[p.side]);
    trianglePinText(S, it, p, a);
  }
}
function drawPart(S, it) {
  const c = it.comp, [a, b] = c.nodes;
  const vertical = /^[IV]$/.test(c.prefix) || isRail(a) || isRail(b);
  if (vertical) {
    // rail at the bottom (ground) or at the top (supply); a source: its + node up
    let top = a, bot = b;
    if (RAIL0.test(a) || isSupply(b)) [top, bot] = [b, a];
    const v = placeTwo(S, c, 0, 0, top, true, 1);
    endAt(S, top, S.term(top, v, v.first), 'u');
    endAt(S, bot, S.term(bot, v, v.other), 'd');
  } else {
    const left = it.left && c.nodes.includes(it.left) ? it.left : a, right = left === a ? b : a;
    const v = placeTwo(S, c, 0, 0, left, false);
    endAt(S, left, S.term(left, v, v.first), 'l');
    endAt(S, right, S.term(right, v, v.other), 'r');
  }
}

/** a controlled source E (VCVS: n+ n- nc+ nc-) or G (VCCS, drawn as its OTA symbol) on a block page: every pin
 *  ends on the side it sits on (review of #72: a bench with a VCVS was refused) */
function drawCtrl(S, it) {
  const c = it.comp, v = placeDevice(S, c, 0, 0);
  v.names.forEach((name, i) => {
    const n = c.nodes[i], r = v.rel[name];
    if (n == null || !r) return;
    endAt(S, n, S.term(n, v, name), r.x <= 0.2 ? 'l' : r.x >= 0.8 ? 'r' : r.y <= 0.2 ? 'u' : 'd');
  });
}

/** a lone transistor: channel vertical, every terminal labelled */
function drawTr(S, it) {
  const c = it.comp;
  const v = placeTr(S, c, 0, 0, -1);
  endAt(S, v.netOf.top, S.term(v.netOf.top, v, v.pinOf.top), 'u');
  endAt(S, v.netOf.bot, S.term(v.netOf.bot, v, v.pinOf.bot), 'd');
  endAt(S, v.netOf.gate, S.term(v.netOf.gate, v, v.pinOf.gate), 'l');
}

/** a series chain drawn in rows of 6, snaking, its two ends as I/O arrows */
export function importChainPage(model, parsed, ch) {
  const S = new Sheet(), PER = 6, GAP = 40, ROW = 110;
  let pitch = 0, prevOut = null;
  ch.parts.forEach((c, k) => {
    const r = Math.floor(k / PER), j = k % PER, nin = ch.nets[k], nout = ch.nets[k + 1];
    const probe = k === 0 ? placeTwo(new Sheet(), c, 0, 0, nin, false) : null;
    if (probe) pitch = probe.len + GAP;
    const x = (r % 2 === 0 ? j : PER - 1 - j) * pitch, y = r * ROW;
    const left = r % 2 === 0 ? nin : nout;
    const v = placeTwo(S, c, x, y, left, false);
    const pIn = S.term(nin, v, left === nin ? v.first : v.other), pOut = S.term(nout, v, left === nin ? v.other : v.first);
    if (prevOut) S.path(nin, prevOut, Math.abs(prevOut.y - pIn.y) < 0.01 ? pIn : { x: prevOut.x, y: pIn.y }, pIn);
    else { const q = { x: pIn.x - STUB, y: pIn.y }; S.path(nin, pIn, q); const pv = portVert(S, nin, q, -1, true, 'inout'); S.term(nin, pv, pv.portPin); }
    prevOut = pOut;
  });
  const last = ch.nets[ch.nets.length - 1], goesRight = Math.floor((ch.parts.length - 1) / PER) % 2 === 0;
  const q = { x: prevOut.x + (goesRight ? STUB : -STUB), y: prevOut.y };
  S.path(last, prevOut, q);
  const pv = portVert(S, last, q, goesRight ? 1 : -1, true, 'inout');
  S.term(last, pv, pv.portPin);
  const wires = emit(model, [S], parsed);
  normalizeOrigin(model);
  return { wires, geo: geoLvs(model) };
}

/** draw a page whose items are blocks, banks and flat parts, by labels */
export function importBlockPage(model, parsed, banks = [], symbols = new Map()) {
  const items = pageItems(parsed, banks, symbols);
  for (const b of banks) {
    const it = items.find((i) => i.ref === b.name);
    if (it) it.bankNote = b.kind === 'chain' ? `${b.parts.length} × ${annotationOf(b.parts[0])}` : `${b.parts.length} parts`;
  }
  const Lay = topLayout(items);
  const sheets = [];
  const draw = (it) => {
    const S = new Sheet();
    if (it.kind === 'part' && it.comp.nodes.length === 2) drawPart(S, it);
    else if (it.kind === 'part' && /^[MQJ]$/.test(it.comp.prefix) && it.comp.nodes.length === 3) drawTr(S, it);
    else if (it.kind === 'part' && /^[EG]$/.test(it.comp.prefix)) drawCtrl(S, it);
    else if (it.kind === 'part') throw new Error(`hier: part ${it.ref} with ${it.comp.nodes.length} pins on a block page`);
    else if (it.tri) drawTriangle(S, it);
    else drawBlock(S, it);
    sheets.push(S);
    const b = S.bbox();
    return { S, w: b.x1 - b.x0, h: b.y1 - b.y0, b };
  };
  const place = (d, x, y) => { d.S.shift(Math.round((x - d.b.x0) / 10) * 10, Math.round((y - d.b.y0) / 10) * 10); };
  const GAPX = 60, GAPY = 30;
  /** a vertical stack of items centred on y = cy, left edge x; returns its width */
  const stack = (its, x, cy) => {
    const ds = its.map(draw);
    const H = ds.reduce((k, d) => k + d.h, 0) + GAPY * Math.max(0, ds.length - 1);
    let y = cy - H / 2;
    const W = Math.max(0, ...ds.map((d) => d.w));
    for (const d of ds) { place(d, x + (W - d.w) / 2, y); y += d.h + GAPY; }
    return W;
  };
  let x = 0;
  if (Lay.sources.length) x += stack(Lay.sources, x, 0) + GAPX * 2;
  const byLevel = Array.from({ length: Lay.nLev }, () => []);
  for (const s of Lay.stages) byLevel[Lay.level.get(s)].push(s);
  for (let k = 0; k <= Lay.nLev; k++) {
    if (Lay.gaps[k].length) x += stack(Lay.gaps[k], x, 0) + GAPX;
    if (k === Lay.nLev) break;
    // the stages of this level, one under the other, their feedback above each
    let y = 0, W = 0;
    const cols = [];
    for (const s of byLevel[k]) {
      const d = draw(s), fb = Lay.feedback.get(s).map(draw);
      W = Math.max(W, d.w, ...fb.map((f) => f.w));
      cols.push({ d, fb });
    }
    // the first stage of every level on one line (y = 0 is its centre), feedback above
    for (const { d, fb } of cols) {
      let yy = y - d.h / 2 - 20;
      for (const f of fb) { yy -= f.h; place(f, x + (W - f.w) / 2, yy); yy -= GAPY; }
      place(d, x + (W - d.w) / 2, y - d.h / 2);
      y += d.h + 120;
    }
    x += W + GAPX;
  }
  const comps = items.map((i) => i.comp);
  const wires = emit(model, sheets, { ...parsed, components: comps });
  normalizeOrigin(model);
  return { wires, geo: geoLvs(model), golden: { ...parsed, components: comps, warnings: [] }, layout: { stages: Lay.stages.map((s) => s.ref), levels: Object.fromEntries([...Lay.level].map(([s, l]) => [s.ref, l])) } };
}

/* ------------------------------------------------------------ testbench */
/** the classic bench (Eric, 2026-10-26): the DUT block in the centre, pin names on it; each supply source on
 *  the left, wired over the top to its supply pin; an input source left of its pin; the outputs wired right
 *  to their loads (to ground) and an output arrow; ground pins to ground. null when the page holds anything
 *  else (a part between two signal nets, two sources on one net): the block placer then. */
export function importTestbench(model, parsed, symbols = new Map()) {
  const items = pageItems(parsed, [], symbols);
  const blocks = items.filter((i) => i.kind === 'block');
  if (blocks.length !== 1 || blocks[0].tri) return null;
  const parts = items.filter((i) => i.kind !== 'block').map((i) => i.comp);
  const gndOf = (c) => c.nodes.find((n) => RAIL0.test(n));
  const sig = (c) => c.nodes.find((n) => !RAIL0.test(n));
  const blk = blocks[0], blkNets = new Set(blk.pins.map((p) => p.net));
  // a VCVS E n+ 0 nc+ nc- feeding the block (a supply or an input, review of #72); the V / I source driving its
  // control net, on no block pin, is drawn beside it
  const vcvs = (c) => c.prefix === 'E' && c.nodes.length === 4 && RAIL0.test(c.nodes[1]) && !RAIL0.test(c.nodes[0]);
  const ctrlNets = new Set(parts.filter(vcvs).map((c) => c.nodes[2]));
  const two = (c) => c.nodes.length === 2 && gndOf(c) && sig(c);
  const aux = parts.filter((c) => /^[VI]$/.test(c.prefix) && two(c) && ctrlNets.has(sig(c)) && !blkNets.has(sig(c)));
  if (parts.some((c) => !aux.includes(c) && !vcvs(c) && !(two(c) && /^[VIRCL]$/.test(c.prefix)))) return null;
  const auxOn = new Map(aux.map((c) => [sig(c), c]));
  const src = parts.filter((c) => (/^[VI]$/.test(c.prefix) || vcvs(c)) && !aux.includes(c)), loads = parts.filter((c) => !src.includes(c) && !aux.includes(c));
  const srcOn = new Map();
  for (const c of src) { if (srcOn.has(sig(c))) return null; srcOn.set(sig(c), c); }
  const it = { ...blk, pins: blk.pins.map((p) => ({ ...p, side: RAIL0.test(p.net) ? 'bottom' : isSupply(p.net) ? 'top' : srcOn.has(p.net) ? 'left' : 'right' })) };
  if (loads.some((c) => !it.pins.some((p) => p.net === sig(c) && p.side === 'right'))) return null;
  const S = new Sheet();
  const supplies = it.pins.filter((p) => p.side === 'top' && srcOn.has(p.net));
  const inputs = it.pins.filter((p) => p.side === 'left');
  // room for a VCVS: its control source on its left
  const extra = (p) => (vcvs(srcOn.get(p.net)) ? 120 : 0);
  const xsSup = []; let xa = 60;
  for (const p of supplies) { xa += extra(p); xsSup.push(xa); xa += 140; }
  const x0 = xa + inputs.reduce((t, p) => t + 160 + extra(p), 0) + 80 - 60;
  const v = blockVertex(S, it, x0, 0);
  const pinAt = Object.fromEntries(it.pins.map((p) => [p.name, S.term(p.net, v, p.name)]));
  // the pin names on the symbol
  for (const p of it.pins) {
    const a = pinAt[p.name];
    if (p.side === 'top') S.text(p.name, a.x - 30, a.y + 4, 60, 14, 'center', 9);
    else if (p.side === 'bottom') S.text(p.name, a.x - 30, a.y - 18, 60, 14, 'center', 9);
    else if (p.side === 'left') S.text(p.name, a.x + 4, a.y - 7, 60, 14, 'left', 9);
    else S.text(p.name, a.x - 64, a.y - 7, 60, 14, 'right', 9);
  }
  const ground = (c, vv) => endAt(S, gndOf(c), S.term(gndOf(c), vv, vv.other), 'd');
  // a VCVS: nc- on its right (ground or a label), nc+ wired from its control source on its left (or a label);
  // its name below, clear of the control wires
  const control = (c, vv, xs) => {
    const [, , np, nm] = c.nodes, w = S.term(np, vv, 'W'), e = S.term(nm, vv, 'E');
    endAt(S, nm, e, 'r');
    const a = auxOn.get(np);
    if (a) {
      const va = placeTwo(S, a, xs - 100, w.y, np, true, -1);
      S.path(np, S.term(np, va, va.first), w);
      ground(a, va);
    } else endAt(S, np, w, 'l');
    const t = S.texts[S.texts.length - (a ? 2 : 1)];
    if (t) { t.x = xs + 16; t.y = vv.pinAbs[vv.other].y + 2; t.align = 'left'; }
  };
  // supplies: the source on the far left, its top wired over the block to the pin
  supplies.forEach((p, k) => {
    const c = srcOn.get(p.net), a = pinAt[p.name], yBus = a.y - 50 - 20 * k, xs = xsSup[k];
    const vv = placeTwo(S, c, xs, yBus + 60, p.net, true, 1);
    const t = S.term(p.net, vv, vv.first);
    S.path(p.net, t, { x: xs, y: yBus }, { x: a.x, y: yBus }, a);
    ground(c, vv);
    if (vcvs(c)) control(c, vv, xs);
  });
  for (const p of it.pins.filter((q) => q.side === 'top' && !srcOn.has(q.net))) endAt(S, p.net, pinAt[p.name], 'u');
  // inputs: the source left of the block, its top level with the pin
  inputs.forEach((p, k) => {
    const c = srcOn.get(p.net), a = pinAt[p.name], xs = x0 - 80 - inputs.slice(k + 1).reduce((t, q) => t + 160 + extra(q), 0);
    const vv = placeTwo(S, c, xs, a.y + 40, p.net, true, vcvs(c) ? 1 : -1);
    S.path(p.net, S.term(p.net, vv, vv.first), { x: xs, y: a.y }, a);
    ground(c, vv);
    if (vcvs(c)) control(c, vv, xs);
  });
  for (const p of it.pins.filter((q) => q.side === 'bottom')) endAt(S, p.net, pinAt[p.name], 'd');
  // outputs: the wire to the right, each load hanging from it, the arrow at its end
  for (const p of it.pins.filter((q) => q.side === 'right')) {
    const a = pinAt[p.name], mine = loads.filter((c) => sig(c) === p.net);
    let x = a.x + 60;
    for (const c of mine) {
      const vv = placeTwo(S, c, x, a.y + 30, p.net, true, 1);
      S.path(p.net, { x, y: a.y }, S.term(p.net, vv, vv.first));
      ground(c, vv);
      x += 110;
    }
    const xe = x + (mine.length ? -40 : 0);
    S.path(p.net, a, { x: xe, y: a.y });
    const pv = portVert(S, p.net, { x: xe, y: a.y }, 1, true, 'output');
    S.term(p.net, pv, pv.portPin);
  }
  const wires = emit(model, [S], parsed);
  normalizeOrigin(model);
  return { wires, geo: geoLvs(model), golden: parsed };
}

/* ------------------------------------------------------------ the document */
/** one page drawn from `parsed` into a fresh document: blocks/banks -> block page, else autoPlace */
async function drawPage(parsed, banks, chain = null, symbols = new Map(), figure = true) {
  const doc = newDocument(), m = getPage(doc);
  if (chain) { const r = importChainPage(m, parsed, chain); return { model: m, engine: 'chain', golden: parsed, geo: r.geo }; }
  // D3: a page of blocks a flat figure reads (the Brokaw with its OTA and start-up blocks)
  const fig = figure && !banks.length ? await drawFigure(parsed, symbols) : null;
  if (fig) return fig;
  if (banks.length || parsed.components.some((c) => c.block)) {
    const r = importBlockPage(m, parsed, banks, symbols);
    return { model: m, engine: 'blocks', golden: r.golden, geo: r.geo };
  }
  const { autoPlace } = await import('./auto.js');
  const w = await autoPlace(parsed);
  return { model: getPage(w.doc), engine: w.label, golden: parsed };
}

/** D3: a page of blocks drawn like a flat figure when one reads it with its amplifier block taken as
 *  an amplifier (the Brokaw bandgap of place-brokaw.js); null otherwise. The figure draws the resistor
 *  strings itself: no bank page then. A ground_<dom> is drawn as the ground, its name kept. */
async function drawFigure(parsed, symbols) {
  const P = withGroundAlias(parsed);
  const blocks = pageItems(P, [], symbols).filter((i) => i.kind === 'block');
  if (!blocks.some((i) => i.tri)) return null;
  const B = brokawReading(P, { blocks });
  if (!B || !B.amp) return null;
  const doc = newDocument(), m = getPage(doc);
  try {
    const r = importBrokaw(m, P, { ...B, vertex: { box: blockVertex, tri: triangleVertex, pinText: trianglePinText } });
    const { labelGroundDomain } = await import('./auto.js');
    labelGroundDomain(m, P.groundAlias);
    return { model: m, engine: 'brokaw', golden: parsed, geo: r.geo };
  } catch { return null; }
}

/** the sources written inside a block .subckt (Eric, 26.10: sources belong to the tb_<bloc> testbench), read on
 *  the raw text so that a source the parser skips (H), a controlled or behavioural source (E, G, F, H, B), an
 *  XSPICE source (A with a source code model), a .subckt named like a PDK primitive and a source inside a nested
 *  definition are all seen. Exceptions:
 *  - a .subckt marked macro=1 (listed in `macro`, warned when it holds a source);
 *  - a probe VSONDE_* of value 0 (`0`, `DC 0`, `0e0`, an inline `$` / `;` comment allowed);
 *  - the testbench written as a .subckt: a tb_* definition the top only instantiates (nothing else at the top),
 *    no definition instantiates (a tb_x below a block stays a block) and whose body reads as a bench: sources,
 *    block instances and R / C / L loads, no device (a tb_ holding transistors is a block with sources);
 *  - a definition no instance reaches from the top: not drawn, a warning only.
 *  A C or L with ic= in a block: a warning (a charged 1 F capacitor is a supply in a transient with uic).
 *  The instances are read as the parser reads them (the definition: the last token without '='), and every
 *  definition the parser expands counts as used.
 *  Returns { errors, warnings, macro, benchText }: one error per definition; benchText = the text with a single
 *  pinless bench .subckt unwrapped to the top (its page then is the testbench page, no extra top page). */
const XSPICE_SOURCES = /^(d_source|filesource|sine|triangle|square|d_osc|d_pulse|d_pwm|oneshot)$/i;
const zeroValue = (x) => /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?v?$/i.test(x) && parseFloat(x) === 0;
export function blockSourceCheck(text, H = hierReading(text)) {
  const lines = [];
  let inControl = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const lw = raw.trim().toLowerCase();
    if (inControl) { if (lw.startsWith('.endc')) inControl = false; continue; }
    if (lw.startsWith('.control')) { inControl = true; continue; }
    if (/^\s*\+/.test(raw) && lines.length) lines[lines.length - 1] += ' ' + raw.replace(/^\s*\+/, '');
    else lines.push(raw);
  }
  const defs = [], stack = [], top = { insts: [], other: false }, models = new Map();
  const benchTop = [];             // [line index, definition key] of the top X lines
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/\s\$.*$/, '').replace(/;.*$/, '').trim();
    if (!line || line.startsWith('*')) continue;
    const t = line.split(/\s+/), low = t[0].toLowerCase();
    if (low === '.subckt') {
      const d = { name: t[1] || '', key: (t[1] || '').toUpperCase(), macro: t.slice(2).some((x) => /^macro=(1|true)$/i.test(x)), sources: [], xspice: [], ics: [], insts: [], pins: t.slice(2).filter((x) => !x.includes('=') && !/^params:/i.test(x)), start: i };
      defs.push(d); stack.push(d); continue;
    }
    if (low.startsWith('.ends')) { const d = stack.pop(); if (d) d.end = i; continue; }
    if (low === '.model' && t[2]) { models.set(t[1].toUpperCase(), t[2].replace(/\(.*$/, '')); continue; }
    if (low.startsWith('.')) continue;
    const at = stack[stack.length - 1] || null, ref = t[0];
    if (/^X/i.test(ref)) {
      const rest = t.slice(1).filter((x) => !x.includes('='));     // as lib/netlist.js reads an X line
      const key = String(rest[rest.length - 1] || '').toUpperCase();
      (at || top).insts.push(key);
      if (!at) benchTop.push([i, key]);
      continue;
    }
    if (!at) { top.other = true; continue; }
    if (/^[CL]/i.test(ref) && /\sic\s*=/i.test(line)) at.ics.push(ref);   // ic=1.2 or ic = 1.2
    if (/^A/i.test(ref)) { at.xspice.push([ref, String(t[t.length - 1]).toUpperCase()]); continue; }
    if (!/^[VIBEGFH]/i.test(ref)) continue;
    const v = t.slice(3);
    if (/^VSONDE_/i.test(ref) && (!v.length || (v.length === 1 && zeroValue(v[0])) || (v.length === 2 && /^dc$/i.test(v[0]) && zeroValue(v[1])))) continue;
    at.sources.push(ref);
  }
  for (const d of defs) for (const [ref, m] of d.xspice) if (XSPICE_SOURCES.test(models.get(m) || '')) d.sources.push(ref);
  const errors = [], warnings = [];
  // the parser keeps the last definition of a name: that one is drawn and checked
  const eff = new Map();
  for (const d of defs) {
    const prev = eff.get(d.key);
    if (prev) warnings.push(`.subckt ${d.name} defined twice: the last definition is drawn${prev.sources.length && d.macro ? ` (the first holds a source: ${prev.sources.join(' ')}, the second is macro=1)` : ''}`);
    eff.set(d.key, d);
  }
  const below = new Set([...eff.values()].flatMap((d) => d.insts));
  const parsedOf = (k) => [...H.defs.values()].find((d) => d.name.toUpperCase() === k)?.parsed;
  const benchBody = (k) => {
    const cs = parsedOf(k)?.components || [];
    return cs.some((c) => c.block) && cs.some((c) => /^[VIBEGFH]$/.test(c.prefix)) && cs.every((c) => c.block || /^[VIBEGFHRCL]$/.test(c.prefix));
  };
  const bench = new Set(!top.other && top.insts.length && top.insts.every((k) => /^TB_/.test(k) && eff.has(k) && !below.has(k) && benchBody(k)) ? top.insts : []);
  const reached = new Set([...H.defs.values()].map((d) => d.name.toUpperCase()).concat((H.instances || []).map((x) => String(x.def).toUpperCase())));
  const seen = new Set(), todo = [...top.insts];
  while (todo.length) { const k = todo.pop(); if (seen.has(k) || !eff.has(k)) continue; seen.add(k); reached.add(k); todo.push(...eff.get(k).insts); }
  const macro = [];
  for (const d of eff.values()) {
    if (d.macro) { macro.push(d.name); if (d.sources.length) warnings.push(`macro-model ${d.name}: sources not checked (${d.sources.join(' ')})`); continue; }
    if (d.ics.length && !bench.has(d.key) && reached.has(d.key)) warnings.push(`initial condition in block ${d.name}: ${d.ics.join(' ')} (ic= acts as a supply in a transient with uic; keep it in the testbench)`);
    if (!d.sources.length || bench.has(d.key)) continue;
    if (d.name.includes('=')) { errors.push(`source in block ${d.name}: ${d.sources.join(' ')} (a .subckt name holding '=' cannot be instantiated: rename it)`); continue; }
    if (!reached.has(d.key)) { warnings.push(`unused .subckt ${d.name} holds a source (${d.sources.join(' ')}): not instantiated, not drawn`); continue; }
    errors.push(`source in block ${d.name}: ${d.sources.join(' ')} (sources belong to the tb_<bloc> testbench; a macro-model: .subckt … macro=1)`);
  }
  let benchText;
  const b = bench.size === 1 && benchTop.length === 1 && eff.get(benchTop[0][1]);
  if (b && !b.pins.length && b.end != null) benchText = lines.filter((l, i) => i !== b.start && i !== b.end && i !== benchTop[0][0]).join('\n');
  return { errors, warnings, macro, ...(benchText ? { benchText } : {}) };
}

/** the testbench reading of a top level (Eric, 2026-10-26): its sources, plus ONE block (the DUT) and
 *  passive loads only -> { dut }; sources with any other circuit -> { mixed }; no source -> null */
export function testbenchReading(top) {
  const src = top.components.filter((c) => /^[VIBEGFH]$/.test(c.prefix));
  if (!src.length) return null;
  const rest = top.components.filter((c) => !src.includes(c));
  const blocks = rest.filter((c) => c.block);
  if (blocks.length === 1 && rest.every((c) => c.block || /^[RCL]$/.test(c.prefix))) return { dut: blocks[0].block, sources: src.map((c) => c.ref) };
  return { mixed: true, sources: src.map((c) => c.ref) };
}

/** D4: set on every block cell (apiBlock) the drawio page link to the page it stands for: the page of its
 *  definition (or of its bank), or with per = 'instance' the page of its instance path */
function linkBlocks(doc, per) {
  const dias = Array.from(doc.getElementsByTagName('diagram'));
  const idOf = (name) => dias.find((d) => String(d.getAttribute('name')).toUpperCase() === String(name).toUpperCase())?.getAttribute('id');
  for (const dia of dias) {
    const page = dia.getAttribute('name');
    for (const obj of Array.from(dia.getElementsByTagName('object'))) {
      const cell = Array.from(obj.childNodes).find((n) => n.nodeName === 'mxCell');
      const st = cell?.getAttribute('style') || '';
      const def = /(?:^|;)apiBlockDef=([^;]*)/.exec(st);
      if (!/(?:^|;)apiBlock=1(;|$)/.test(st) || !def) continue;
      const ref = obj.getAttribute('refdes') || obj.getAttribute('id');
      const inst = per === 'instance' ? idOf(dia === dias[0] ? ref : `${page}.${ref}`) : null;
      const id = inst || idOf(decodeURIComponent(def[1]));
      if (id) obj.setAttribute('link', `data:page/id,${id}`);
    }
  }
}

/** the net of page P (lowercase) that carries the subcircuit pin `pin`: the pin's own name when the page writes
 *  it, else the page net on the same terminal as the pin in the page's netlist (a pin drawn as a rail symbol,
 *  ground_<dom> drawn as ground, or a pin the page leaves unnamed) */
function pageNet(P, pin) {
  const k = String(pin).toLowerCase();
  if (P.ex.components.some((c) => c.nodes.some((n) => String(n).toLowerCase() === k))) return k;
  const byRef = new Map(P.ex.components.map((c) => [String(c.ref).toUpperCase(), c]));
  for (const g of P.golden?.components || []) {
    const i = g.nodes.findIndex((n) => String(n).toLowerCase() === k), e = byRef.get(String(g.ref).toUpperCase());
    if (i >= 0 && e && e.nodes[i] != null) return String(e.nodes[i]).toLowerCase();
  }
  return k;
}

/**
 * Hierarchical drawing of `text`: { doc, pages: [{name, kind, engine, lvs, geo}],
 * map: { flatRef: {page, cell} }, lvs: { pages: {name: match}, global } }.
 * opts.per = 'definition' (default) | 'instance'.
 */
export async function importHier(text, opts = {}) {
  const per = opts.per === 'instance' ? 'instance' : 'definition';
  let H = hierReading(text, opts), SC = blockSourceCheck(text, H);
  // a bench written as a pinless .subckt tb_*: unwrapped to the top, so that its page is the testbench page
  if (SC.benchText) { text = SC.benchText; H = hierReading(text, opts); SC = blockSourceCheck(text, H); }
  // the top page: tb_<dut> when it is a testbench (its sources, the DUT one block, loads)
  const tb = testbenchReading(H.top);
  const TOP = tb?.dut ? `tb_${tb.dut}` : 'top';
  const warnings = [...SC.warnings], errors = SC.errors;
  const doc = newDocument(TOP);
  const pages = [], drawn = new Map();       // page name -> {ex, golden, pins}
  const finish = (name, kind, d, extra = {}) => {
    const m = name === TOP ? getPage(doc) : addPage(doc, name, d.model);
    // a source on a block page (any page but the testbench): a quality-gate failure, reported
    // a source on a bank page or a top that mixes sources and circuit: reported (inside a .subckt: blockSourceErrors)
    const src = (d.golden?.components || []).filter((c) => /^[VIBEGFH]$/.test(c.prefix)).map((c) => c.ref);
    if (src.length && kind !== 'testbench' && kind !== 'subckt' && kind !== 'instance') warnings.push(`source on block page ${name}: ${src.join(' ')} (write the block as a .subckt under a tb_<bloc> testbench)`);
    if (name === TOP) { const src = d.model; while (m.firstChild) m.removeChild(m.firstChild); for (const n of Array.from(src.childNodes)) m.appendChild(doc.importNode(n, true)); }
    if (opts.onPage) opts.onPage(name, m);   // tests: corrupt a page before its extraction
    const ex = extractNetlist(m), rep = compare(ex, d.golden);
    drawn.set(name, { ex, golden: d.golden, ...extra });
    pages.push({ name, kind, engine: d.engine, lvs: rep.match, ...(rep.match ? {} : { report: rep }), ...(d.geo ? { geo: d.geo.ok } : {}) });
  };
  // top
  const symbols = new Map([...H.defs.values()].map((d) => [d.name.toUpperCase(), d.symbol]));
  const figure = opts.figure === false ? null : await drawFigure(H.top, symbols);
  const banks = figure ? [] : H.banks;
  let bench = null;
  if (!figure && tb?.dut && !banks.length) {
    const d0 = newDocument(), m0 = getPage(d0);
    try { const r = importTestbench(m0, H.top, symbols); if (r && r.geo.ok) bench = { model: m0, engine: 'testbench', golden: r.golden, geo: r.geo }; } catch { /* the block placer */ }
  }
  finish(TOP, tb?.dut ? 'testbench' : 'top', figure || bench || await drawPage(H.top, banks, null, symbols, false));
  // banks: their parts with the top's net names, every pin an I/O
  for (const b of banks) finish(b.name, b.kind, await drawPage({ ...H.top, components: b.parts, warnings: [] }, [], b.kind === 'chain' ? b : null), { pins: b.pins });
  // definitions (one drawing each), copied per instance when asked
  const defPage = new Map();
  for (const d of H.defs.values()) defPage.set(d.name, await drawPage(d.parsed, [], null, symbols, opts.figure !== false));
  const pageOfInst = new Map();              // instance path -> page name
  if (per === 'instance') {
    for (const inst of H.instances) {
      finish(inst.path, 'instance', defPage.get(H.defs.get(inst.def)?.name ?? inst.def) || defPage.get([...H.defs.keys()].find((k) => k.toUpperCase() === String(inst.def).toUpperCase())), { pins: H.defs.get(inst.def)?.pins, macro: H.defs.get(inst.def)?.macro });
      pageOfInst.set(inst.path, inst.path);
    }
  } else {
    for (const d of H.defs.values()) finish(d.name, 'subckt', defPage.get(d.name), { pins: d.pins, macro: d.macro });
    for (const inst of H.instances) pageOfInst.set(inst.path, [...H.defs.keys()].find((k) => k.toUpperCase() === String(inst.def).toUpperCase()));
  }
  // map: every flattened ref -> (page, cell)
  const map = {};
  const instPaths = [...pageOfInst.keys()].sort((a, b) => b.length - a.length);
  const bankOf = new Map(banks.flatMap((b) => b.parts.map((c) => [c.ref, b.name])));
  const place = (ref) => {
    const p = instPaths.find((q) => ref.toUpperCase().startsWith(q.toUpperCase() + '.'));
    if (p) return { page: pageOfInst.get(p), cell: ref.slice(p.length + 1) };
    return { page: bankOf.get(ref) || TOP, cell: ref };
  };
  for (const c of H.flat.components) map[c.ref] = place(c.ref);
  for (const inst of H.instances) map[inst.path] = place(inst.path);
  for (const b of banks) map[b.name] = { page: TOP, cell: b.name };
  // D4: every block links to its page (drawio `link="data:page/id,<page id>"`: a click opens the block's page)
  linkBlocks(doc, per);
  // global LVS: the drawing flattened back through the blocks against the flattened netlist
  const flat = [];
  const expand = (pageName, bind, path, ns = path) => {   // ns: prefix of internal nets (a bank keeps flat refs but private nets)
    const P = drawn.get(pageName);
    const seen = new Set(P.ex.components.flatMap((c) => c.nodes));
    for (const c of P.ex.components) {
      // the page's OWN extracted nets (never renamed by the reference: a cut net
      // stays cut); a page pin (its I/O label) is bound to the net of the
      // block's terminal, a drawn internal net gets the page's prefix; a hidden
      // net (a bulk, never drawn) is a name of the netlist: the instance path
      const net = (n) => {
        const k = String(n).toLowerCase(), pre = seen.has(n) ? ns : path;
        return bind && bind.has(k) ? bind.get(k) : pre && n !== '0' ? `${pre}.${n}` : n;
      };
      const ref = path ? `${path}.${c.ref}` : c.ref;
      const sub = c.prefix === 'X' && (drawn.has(c.ref) && banks.some((b) => b.name === c.ref) ? c.ref : null);
      if (sub) { expand(sub, new Map(drawn.get(sub).pins.map((pn, i) => [String(pn).toLowerCase(), net(c.nodes[i])])), path, (path ? path + '.' : '') + sub); continue; }
      const inst = H.instances.find((i) => i.path.toUpperCase() === ref.toUpperCase());
      if (c.prefix === 'X' && inst) {
        const pg = pageOfInst.get(inst.path), pins = drawn.get(pg).pins || [];
        expand(pg, new Map(pins.map((pn, i) => [pageNet(drawn.get(pg), pn), net(c.nodes[i])])), inst.path);
        continue;
      }
      flat.push({ ...c, ref, nodes: c.nodes.map(net), ...(c.fullNodes ? { fullNodes: c.fullNodes.map(net) } : {}) });
    }
  };
  expand(TOP, null, '');
  // simulation directives (.nodeset, .ic) are not circuit: reported, not failed
  const directive = (w) => /^directive not representable/.test(typeof w === 'string' ? w : w.message || w.code || '');
  const global = compare({ components: flat, issues: [] }, { ...H.flat, warnings: (H.flat.warnings || []).filter((w) => !directive(w)) });
  warnings.push(...(H.flat.warnings || []).filter(directive));
  return { doc, pages, map, lvs: { pages: Object.fromEntries(pages.map((p) => [p.name, p.lvs])), global: global.match, ...(global.match ? {} : { globalReport: global }), ...(warnings.length ? { warnings } : {}) }, ...(errors.length ? { errors } : {}), ...(SC.macro.length ? { macroModels: SC.macro } : {}), banks: banks.map((b) => ({ name: b.name, kind: b.kind, pins: b.pins, parts: b.parts.map((c) => c.ref) })) };
}
