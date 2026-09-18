/**
 * netlist.js — SPICE netlist parsing and netlist extraction from a schematic.
 */
import { allCells, cellInfo, httpError } from './model.js';
import { classify, activePins, pinOrderFor, identityOf, SPICE_MAP } from './components.js';
import { pinAbs } from './route.js';

// ---------------------------------------------------------------- SPICE parse

/**
 * Parse a SPICE netlist. Returns {title, components:[{ref, prefix, nodes,
 * fullNodes, value, model}], warnings, subckts, couplings, directives}.
 * Handles * comments, + continuations, `.subckt … .ends` blocks and
 * X instances (FLATTENED: `X1 a b NAME` becomes `X1.M1 …` with internal nets
 * `X1.n`, recursively), `K` couplings (recorded, not drawn), and the usual
 * simulation directives (.model/.param/.tran/… kept in `directives`, no
 * warning: they carry no drawing information). Node "0"/"GND" is ground.
 *
 * An X whose .subckt is NOT defined but looks like an op-amp (3 or 5 pins,
 * LTspice `Opamps\*`, `UniversalOpamp2`, `LT10xx`, `opamp`) is drawn as an
 * op-amp symbol (SPICE_MAP.X): in+ in- [v+ v-] out. A 3-pin ideal op-amp is
 * padded with two private hidden-only nets (`<ref>.V+`, `<ref>.V-`) so it
 * extracts back to the same 5-node form as a real one.
 */
export function parseSpice(text, opts = {}) {
  const rawLines = String(text).split(/\r?\n/);
  // join continuations
  const lines = [];
  for (const raw of rawLines) {
    if (/^\s*\+/.test(raw) && lines.length > 0) {
      lines[lines.length - 1] += ' ' + raw.replace(/^\s*\+/, '');
    } else {
      lines.push(raw);
    }
  }
  const components = [];
  const warnings = [];
  const directives = [];
  const couplings = [];
  const subckts = {};
  let title = null;
  let first = true;
  // ---- pass 1: lift .subckt blocks out of the main body
  const body = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    const low = line.toLowerCase();
    if (low.startsWith('.subckt')) {
      const t = line.split(/\s+/);
      const pins = t.slice(2).filter((x) => !x.includes('='));
      cur = { name: t[1], key: (t[1] || '').toUpperCase(), pins, lines: [] };
      if (cur.name) subckts[cur.key] = cur; else warnings.push('malformed .subckt skipped: ' + line);
      first = false;
      continue;
    }
    if (low.startsWith('.ends')) { cur = null; continue; }
    if (cur != null) cur.lines.push(raw); else body.push(raw);
  }
  // Directives with NO electrical content for a drawing (analyses, model
  // cards, includes, output control): recorded, never a warning. Directives
  // that DO change the circuit but cannot live in a schematic (.param/.step
  // substitute values, .func, .ic/.nodeset) stay warnings so strict LVS keeps
  // rejecting a reference the drawing cannot faithfully represent
  // (RENDER-LVS.md; test 'strict LVS rejects directive').
  const SIM_DIRECTIVES = /^\.(model|include|inc|lib|option|options|tran|ac|dc|op|temp|meas|measure|global|backanno|save|probe|four|noise|tf|control|endc|pz|sens|disto|wave|plot|print|width|end|title)\b/;
  const ELEC_DIRECTIVES = /^\.(param|params|step|func|ic|nodeset|csparam)\b/;

  const emit = (line, ctx) => {
    const tokens = line.split(/\s+/);
    const ref0 = tokens[0];
    const prefix = ref0[0].toUpperCase();
    const ref = ctx.prefix + ref0;
    const mapNet = (n) => {
      const nn = normNode(n);
      if (nn === '0') return '0';
      if (ctx.nets.has(nn)) return ctx.nets.get(nn);
      return ctx.prefix ? ctx.prefix + nn : nn;
    };
    if (prefix === 'K') {
      // K1 L1 L2 k — a coupling has no terminals; recorded for the emitter/BOM
      couplings.push({ ref, inductors: tokens.slice(1, 3).map((r) => ctx.prefix + r), value: tokens[3] || '' });
      return;
    }
    if (prefix === 'X') {
      // X<ref> n1 … nN NAME [param=…]
      const rest = tokens.slice(1).filter((x) => !x.includes('='));
      const name = rest[rest.length - 1];
      const nodes0 = rest.slice(0, -1);
      const def = subckts[(name || '').toUpperCase()];
      if (def) {
        if (ctx.depth >= 8) { warnings.push('subckt nesting too deep, instance skipped: ' + line); return; }
        if (def.pins.length !== nodes0.length) { warnings.push(`X ${ref}: ${nodes0.length} nodes for .subckt ${def.name} with ${def.pins.length} pins, instance skipped`); return; }
        const nets = new Map();
        for (let i = 0; i < def.pins.length; i++) nets.set(def.pins[i], mapNet(nodes0[i]));
        const sub = { prefix: ref + '.', nets, depth: ctx.depth + 1 };
        for (const l of def.lines) {
          const t = l.trim();
          if (t === '' || t.startsWith('*')) continue;
          if (t.startsWith('.')) { if (!SIM_DIRECTIVES.test(t.toLowerCase())) warnings.push('directive ignored in .subckt ' + def.name + ': ' + t); continue; }
          emit(t, sub);
        }
        return;
      }
      // undefined subckt: op-amp heuristic, else unsupported
      const opampLike = (nodes0.length === 3 || nodes0.length === 5) &&
        (/opamp|op_amp|universalopamp|^lt[0-9]|^ad[0-9]|^tl0|^lm[0-9]|^ne5|^op[0-9]|^ua7|^lf3|^mcp6|^opa[0-9]|^ada[0-9]/i.test(name || '') || nodes0.length === 3);
      if (!opampLike) { warnings.push('unsupported element skipped (undefined .subckt ' + name + '): ' + line); return; }
      const n = nodes0.map(mapNet);
      const fullNodes = n.length === 5 ? n : [n[0], n[1], ref + '.V+', ref + '.V-', n[2]];
      const nodes = [fullNodes[0], fullNodes[1], fullNodes[4]];
      components.push({ ref, prefix: 'X', nodes, fullNodes, value: name || '', model: name || '' });
      return;
    }
    const map = SPICE_MAP[prefix];
    if (map == null) { warnings.push('unsupported element skipped: ' + line); return; }
    let nNodes = map.pinOrder.length + (map.dropNodes ? map.dropNodes.length : 0);
    if (tokens.length < 1 + nNodes) { warnings.push('malformed line skipped: ' + line); return; }
    let nodes = tokens.slice(1, 1 + nNodes).map(mapNet);
    const fullNodes = [...nodes];
    let rest = tokens.slice(1 + nNodes);
    if (map.dropNodes) nodes = nodes.filter((_, i) => !map.dropNodes.includes(i));
    // V/I may carry "DC 5" style values
    if (!rest.length) warnings.push('missing value or model: ' + line);
    const value = rest.join(' ');
    components.push({ ref, prefix, nodes, fullNodes, value, model: ['M', 'Q', 'D', 'J'].includes(prefix) ? (rest[0] || '') : (rest[rest.length - 1] || '') });
  };

  const top = { prefix: '', nets: new Map(), depth: 0 };
  for (let ln = 0; ln < body.length; ln++) {
    const line = body[ln].trim();
    if (line === '' || line.startsWith('*')) { if (first && line.startsWith('*')) { title = line.slice(1).trim(); first = false; } continue; }
    if (line.startsWith('.')) {
      const d = line.toLowerCase();
      if (SIM_DIRECTIVES.test(d)) { if (!d.startsWith('.end') && !d.startsWith('.title')) directives.push(line); }
      else if (ELEC_DIRECTIVES.test(d)) { directives.push(line); warnings.push('directive not representable in a schematic: ' + line); }
      else warnings.push('directive ignored: ' + line);
      first = false;
      continue;
    }
    first = false;
    emit(line, top);
  }
  const dup = components.map((c) => c.ref).filter((r, i, a) => a.findIndex(x => x.toUpperCase() === r.toUpperCase()) !== i);
  if (dup.length) throw httpError(400, 'duplicate refs in netlist: ' + [...new Set(dup)].join(', '));
  return { title, components, warnings, subckts, couplings, directives };
}

function normNode(n) {
  return /^(0|gnd|ground)$/i.test(n) ? '0' : n;
}

// ------------------------------------------------------- schematic extraction

const EPS = 0.02;

class UnionFind {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
    return r;
  }
  union(a, b) { this.p.set(this.find(a), this.find(b)); }
}

/**
 * Build the connectivity of a page.
 * Returns {components:[{ref,prefix,cls,cell}], terms: Map<termKey,{cell,pin}>,
 * netOf: Map<termKey, netName>, nets: Map<netName, termKey[]>, issues:[…]}
 * termKey = `${cellId}:${pinName}`.
 */
export function connectivity(model) {
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const uf = new UnionFind();
  const issues = [];
  const comps = [];       // classified vertices with pins
  const grounds = [];
  const junctions = [];
  const taps = [];        // power + port symbols (net-naming single-pin cells)
  const termInfo = new Map();

  for (const c of cells) {
    if (c.kind !== 'vertex') continue;
    const cls = classify(c);
    if (cls.role === 'junction') { junctions.push(c); continue; }
    if (cls.role === 'ground') { grounds.push({ cell: c, cls }); }
    else if (cls.role === 'power' || cls.role === 'port') { taps.push({ cell: c, cls }); }
    else if (cls.role === 'component') { comps.push({ cell: c, cls }); }
    else continue;
    for (const pin of activePins(cls)) {
      termInfo.set(c.id + ':' + pin.name, { cell: c, pin });
    }
  }

  // resolve an edge endpoint to a node key
  const labelOf = new Map(); // endpoint key -> wire label
  const endpointKey = (c, which) => {
    const cellId = which === 'source' ? c.source : c.target;
    if (cellId == null) return null;
    const cell = byId.get(cellId);
    if (cell == null) return null;
    const cls = classify(cell);
    if (cls.role === 'junction') return 'J:' + cellId;
    const prefX = which === 'source' ? 'exitX' : 'entryX';
    const prefY = which === 'source' ? 'exitY' : 'entryY';
    const prefName = which === 'source' ? 'exitName' : 'entryName';
    const ax = c.style.map.get(prefX), ay = c.style.map.get(prefY);
    const nameAttr = c.style.map.get(prefName);
    const pins = activePins(cls);
    if (pins.length === 0) return 'J:' + cellId; // unknown shape: treat as single node

    // T3: prefer the persisted pin NAME (model.js addWire writes exitName/
    // entryName) over coordinate matching. Trust it only while the stored
    // exitX/exitY are still within EPS of that named pin's catalog position —
    // a human who re-drags the endpoint in the GUI moves the coordinates but
    // the name key survives untouched, so a mismatch means the name is
    // stale: re-derive by nearest-coordinate (the legacy path below) and say
    // so via `anchor-name-stale`, rather than silently trusting a name that
    // no longer points at where the wire actually lands.
    if (nameAttr != null) {
      const named = pins.find((p) => p.name === nameAttr);
      if (named != null) {
        if (ax == null || ay == null) return cellId + ':' + named.name;
        const x0 = parseFloat(ax), y0 = parseFloat(ay);
        const d0 = Math.hypot(named.x - x0, named.y - y0);
        if (d0 <= EPS) return cellId + ':' + named.name;
        let best = named, bd = d0;
        for (const p of pins) {
          const dd = Math.hypot(p.x - x0, p.y - y0);
          if (dd < bd) { bd = dd; best = p; }
        }
        issues.push({ code: 'anchor-name-stale',
          message: `wire ${c.id} ${prefName}="${nameAttr}" on ${cellId} is stale (stored anchor is ${d0.toFixed(3)} from that pin's catalog position); re-resolved by coordinates to pin "${best.name}"`,
          cells: [c.id, cellId] });
        return cellId + ':' + best.name;
      }
      // name present but is not a pin of this shape (e.g. stencil swapped
      // out from under the wire) — fall through to legacy coordinate match.
    }

    if (ax == null || ay == null) {
      if (pins.length === 1) return cellId + ':' + pins[0].name;
      issues.push({ code: 'floating-endpoint', message: `wire ${c.id} attaches to ${cellId} without a pin anchor (defaulted to pin ${pins[0].name})`, cells: [c.id, cellId] });
      return cellId + ':' + pins[0].name;
    }
    const x = parseFloat(ax), y = parseFloat(ay);
    let best = null, bd = Infinity;
    for (const p of pins) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    if (bd > EPS) issues.push({ code: 'anchor-off-pin', message: `wire ${c.id} anchor (${x},${y}) is ${bd.toFixed(3)} away from nearest pin ${best.name} of ${cellId}`, cells: [c.id, cellId] });
    return cellId + ':' + best.name;
  };

  const wiredCells = new Set();
  for (const c of cells) {
    if (c.kind !== 'edge') continue;
    if (c.source != null) wiredCells.add(String(c.source));
    if (c.target != null) wiredCells.add(String(c.target));
    const a = endpointKey(c, 'source');
    const b = endpointKey(c, 'target');
    if (a == null || b == null) {
      issues.push({ code: 'dangling-wire', message: `wire ${c.id} has an unconnected end`, cells: [c.id] });
      continue;
    }
    uf.union(a, b);
    if (c.value) labelOf.set(a, c.value);
  }

  // group terminals into nets
  const groups = new Map(); // root -> termKeys
  const add = (key) => {
    const r = uf.find(key);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(key);
  };
  for (const key of termInfo.keys()) add(key);

  // name nets: ground → 0; power/port taps → their net name; labeled wires → label; else n1..
  const netOf = new Map();
  const nets = new Map();
  let n = 0;
  const groundIds = new Set(grounds.map((g) => g.cell.id));
  const tapNetOf = new Map(taps.map((t) => [t.cell.id, t.cls.net]));
  // Synthetic names must never collide with a REAL net name (tap/port
  // label or wire label): a reference netlist whose nets are called n1..nK
  // (LTspice conversions, hand-written decks) made strict LVS compare its
  // real `n3` with our synthetic `n3` on another net (holdout
  // Boost-converter-1: 500 "named_net_mismatches"). Case-insensitive, as
  // the comparison is.
  const reserved = new Set([...tapNetOf.values(), ...labelOf.values()].map((x) => String(x).toUpperCase()));
  const fresh = () => { let nm; do { nm = 'n' + (++n); } while (reserved.has(nm.toUpperCase())); return nm; };
  for (const [root, keys] of groups) {
    let name = null;
    for (const k of keys) if (groundIds.has(k.split(':')[0])) name = '0';
    if (name == null) for (const k of keys) {
      const tn = tapNetOf.get(k.split(':')[0]);
      if (tn != null) { name = tn; break; }
    }
    if (name == null) for (const [k, lbl] of labelOf) if (uf.find(k) === root) { name = lbl; break; }
    if (name == null) name = fresh();
    for (const k of keys) {
      if (!groundIds.has(k.split(':')[0])) {
        netOf.set(k, name);
        if (!nets.has(name)) nets.set(name, []);
        nets.get(name).push(k);
      }
    }
  }
  // merge all nets named 0 (multiple ground symbols)
  return { components: comps, grounds, junctions, taps, termInfo, netOf, nets, issues, wiredCells };
}

/** Extract a SPICE netlist string + structured form from a page. */
export function extractNetlist(model) {
  const conn = connectivity(model);
  const out = [];
  const structured = [];
  const byRef = new Map(conn.components.map(c => [String(identityOf(c.cell)).toUpperCase(), c]));
  for (const { cell, cls } of conn.components) {
    if (cls.mapping == null) {
      conn.issues.push({ code: 'unmapped-component', message: `cell ${cell.id} (${cls.shape ? cls.shape.name : '?'}) has no SPICE mapping`, cells: [cell.id] });
      continue;
    }
    const nodes = pinOrderFor(cls).map((pinName) => conn.netOf.get(cell.id + ':' + pinName) || '?');
    // T4: `spice_value` (the wrapping <object>'s attribute) is authoritative
    // over `value`/label when both exist — a GUI user could retarget the
    // visible label without meaning to change the SPICE value.
    const value = (cell.attrs && cell.attrs.spice_value != null) ? cell.attrs.spice_value : (cell.value || '');
    // T4: the emitted SPICE ref is the persisted refdes when present, never
    // the raw mxCell id — the id is what a GUI copy/paste silently reassigns.
    const ref = identityOf(cell);
    const fullNodes = [...nodes];
    if (cls.mapping.dropNodes) {
      let hidden;
      try { hidden = JSON.parse(cell.attrs?.spice_hidden_nodes || 'null'); } catch { hidden = null; }
      for (const index of cls.mapping.dropNodes) {
        const h = hidden?.find(h => h.index === index);
        let net = null;
        if (h?.anchor) {
          const target = byRef.get(String(h.anchor.ref).toUpperCase());
          const pin = target && pinOrderFor(target.cls)[h.anchor.pin];
          if (pin) net = conn.netOf.get(target.cell.id + ':' + pin);
        } else if (h?.net) net = h.net;
        if (!net) conn.issues.push({code:'missing-hidden-terminal', cells:[cell.id], message:`${ref} SPICE terminal ${index} is not represented`});
        fullNodes.splice(index, 0, net || '?');
      }
    }
    const symbolModel = /\.pmos(?:_|$)/.test(cls.shape?.key || '') ? 'PMOS' : /\.nmos(?:_|$)/.test(cls.shape?.key || '') ? 'NMOS'
      : /\.pnp_/.test(cls.shape?.key || '') ? 'PNP' : /\.npn_/.test(cls.shape?.key || '') ? 'NPN' : null;
    structured.push({ ref, prefix: cls.prefix, nodes, fullNodes, value, symbolModel });
    out.push([ref, ...fullNodes, value].join(' ').trim());
  }
  return { spice: '* extracted by drawio-api-server\n' + out.join('\n') + '\n.end\n', components: structured, issues: conn.issues, namedNets: [...new Set(conn.taps.map(t => t.cls.net))] };
}
