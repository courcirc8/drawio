/**
 * netlist.js — SPICE netlist parsing and netlist extraction from a schematic.
 */
import { allCells, cellInfo, httpError } from './model.js';
import { classify, activePins, pinOrderFor, SPICE_MAP } from './components.js';
import { pinAbs } from './route.js';

// ---------------------------------------------------------------- SPICE parse

/**
 * Parse a SPICE netlist. Returns {title, components:[{ref, prefix, nodes,
 * value, model}], warnings}. Handles * comments, + continuations; skips
 * .directives. Node "0"/"GND" is ground.
 */
export function parseSpice(text) {
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
  let title = null;
  let first = true;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (line === '' || line.startsWith('*')) { if (first && line.startsWith('*')) { title = line.slice(1).trim(); first = false; } continue; }
    if (line.startsWith('.')) {
      const d = line.toLowerCase();
      if (!d.startsWith('.end') && !d.startsWith('.title')) warnings.push('directive ignored: ' + line);
      first = false;
      continue;
    }
    first = false;
    const tokens = line.split(/\s+/);
    const ref = tokens[0];
    const prefix = ref[0].toUpperCase();
    const map = SPICE_MAP[prefix];
    if (map == null) { warnings.push('unsupported element skipped: ' + line); continue; }
    let nNodes = map.pinOrder.length + (map.dropNodes ? map.dropNodes.length : 0);
    if (tokens.length < 1 + nNodes) { warnings.push('malformed line skipped: ' + line); continue; }
    let nodes = tokens.slice(1, 1 + nNodes).map(normNode);
    let rest = tokens.slice(1 + nNodes);
    if (map.dropNodes) nodes = nodes.filter((_, i) => !map.dropNodes.includes(i));
    // V/I may carry "DC 5" style values
    const value = rest.join(' ');
    components.push({ ref, prefix, nodes, value, model: rest[rest.length - 1] || '' });
  }
  const dup = components.map((c) => c.ref).filter((r, i, a) => a.indexOf(r) !== i);
  if (dup.length) throw httpError(400, 'duplicate refs in netlist: ' + [...new Set(dup)].join(', '));
  return { title, components, warnings };
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
  const termInfo = new Map();

  for (const c of cells) {
    if (c.kind !== 'vertex') continue;
    const cls = classify(c);
    if (cls.role === 'junction') { junctions.push(c); continue; }
    if (cls.role === 'ground') { grounds.push({ cell: c, cls }); }
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
    const ax = c.style.map.get(prefX), ay = c.style.map.get(prefY);
    const pins = activePins(cls);
    if (pins.length === 0) return 'J:' + cellId; // unknown shape: treat as single node
    if (ax == null || ay == null) {
      if (pins.length === 1) return cellId + ':' + pins[0].name;
      issues.push({ code: 'floating-endpoint', message: `wire ${c.id} attaches to ${cellId} without a pin anchor`, cells: [c.id, cellId] });
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

  // name nets: ground → 0; labeled wires → label; else n1..
  const netOf = new Map();
  const nets = new Map();
  let n = 0;
  const groundIds = new Set(grounds.map((g) => g.cell.id));
  for (const [root, keys] of groups) {
    let name = null;
    for (const k of keys) if (groundIds.has(k.split(':')[0])) name = '0';
    if (name == null) for (const [k, lbl] of labelOf) if (uf.find(k) === root) { name = lbl; break; }
    if (name == null) name = 'n' + (++n);
    for (const k of keys) {
      if (!groundIds.has(k.split(':')[0])) {
        netOf.set(k, name);
        if (!nets.has(name)) nets.set(name, []);
        nets.get(name).push(k);
      }
    }
  }
  // merge all nets named 0 (multiple ground symbols)
  return { components: comps, grounds, junctions, termInfo, netOf, nets, issues, wiredCells };
}

/** Extract a SPICE netlist string + structured form from a page. */
export function extractNetlist(model) {
  const conn = connectivity(model);
  const out = [];
  const structured = [];
  for (const { cell, cls } of conn.components) {
    if (cls.mapping == null) {
      conn.issues.push({ code: 'unmapped-component', message: `cell ${cell.id} (${cls.shape ? cls.shape.name : '?'}) has no SPICE mapping`, cells: [cell.id] });
      continue;
    }
    const nodes = pinOrderFor(cls).map((pinName) => conn.netOf.get(cell.id + ':' + pinName) || '?');
    const value = cell.value || '';
    structured.push({ ref: cell.id, prefix: cls.prefix, nodes, value });
    out.push([cell.id, ...nodes, value].join(' ').trim());
  }
  return { spice: '* extracted by drawio-api-server\n' + out.join('\n') + '\n.end\n', components: structured, issues: conn.issues };
}
