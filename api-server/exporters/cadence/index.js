/**
 * exporters/cadence — schema-neutre/1 → Cadence Virtuoso (last target of
 * docs/export-multi-outils.md; docs/cadence.md for the user).
 *
 * No Virtuoso and no foundry kit here, so nothing about the symbols is known
 * when the script is written: the plan carries the neutral schematic in
 * Virtuoso user units (y up, on the grid), the SPICE terminal index of every
 * drawn pin, and the connectivity the SOURCE deck expects. The runtime
 * (runtime/cadence_runtime.py; runtime/cadence_runtime.il for SKILL alone)
 * reads the real pins in the masters at the user's site, places, wires,
 * runs schCheck and compares with the deck. Two outputs:
 *   (a) a Python script for skillbridge (the user's setup at work);
 *   (b) the same in SKILL, `load("x.il")`, no dependency.
 * Symbols: analogLib by default (runtime/cadence-pdk.map), overridden by a
 * local map file the user fills in (foundry names never come back here).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPage } from '../../lib/model.js';
import { autoPlace } from '../../lib/auto.js';
import { toNeutral, checkNeutral, snapNeutral } from '../../lib/neutral.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_PY = path.join(HERE, 'runtime', 'cadence_runtime.py');
export const RUNTIME_IL = path.join(HERE, 'runtime', 'cadence_runtime.il');
export const DEFAULT_MAP = path.join(HERE, 'runtime', 'cadence-pdk.map');

const ROLE = { R: 'res', C: 'cap', L: 'ind', V: 'vsrc', I: 'isrc' };

/** A net name Virtuoso keeps as is: deck ground → gnd!; netN (Virtuoso's own) suffixed. */
export function cadNet(n) {
  const s = String(n ?? '');
  if (s === '0') return 'gnd!';
  const t = s.replace(/[^A-Za-z0-9_!<>:]/g, '_') || 'n_';
  return /^net\d+$/i.test(t) ? `${t}_d` : t;
}

/** Parameters of a deck line, as written (no default is ever added). */
function deckParams(src) {
  const v = String(src?.value ?? '').trim();
  const kv = Object.fromEntries([...v.matchAll(/\b([A-Za-z_]\w*)\s*=\s*([^\s]+)/g)].map((m) => [m[1].toLowerCase(), m[2]]));
  const first = v.split(/\s+/)[0] || null;
  const dc = /^\s*(?:dc\s+)?([-+]?[0-9.]+(?:e[-+]?\d+)?[a-z]*)\s*$/i.exec(v);
  return {
    model: src?.prefix === 'M' ? first : null,
    value: src && 'RCL'.includes(src.prefix) && !/=/.test(first || '') ? first : null,
    dc: src && 'VI'.includes(src.prefix) && dc ? dc[1] : null,
    kv,
  };
}

/** Polylines cut at every connection point lying inside one of their segments. */
function splitWires(wires, points) {
  const key = (p) => `${p[0]},${p[1]}`;
  const pts = [...new Map(points.map((p) => [key(p), p])).values()];
  const inside = (p, a, b) => (a[0] === b[0] ? p[0] === a[0] && p[1] > Math.min(a[1], b[1]) && p[1] < Math.max(a[1], b[1])
    : a[1] === b[1] && p[1] === a[1] && p[0] > Math.min(a[0], b[0]) && p[0] < Math.max(a[0], b[0]));
  const out = [];
  for (const w of wires) {
    let cur = [w.points[0]];
    for (let k = 1; k < w.points.length; k++) {
      const a = w.points[k - 1], b = w.points[k];
      const cuts = pts.filter((p) => inside(p, a, b)).sort((p, q) => (Math.abs(p[0] - a[0]) + Math.abs(p[1] - a[1])) - (Math.abs(q[0] - a[0]) + Math.abs(q[1] - a[1])));
      for (const c of cuts) { cur.push(c); out.push({ net: w.net, points: cur }); cur = [c]; }
      cur.push(b);
    }
    out.push({ net: w.net, points: cur });
  }
  return out;
}

/**
 * The Virtuoso plan of a neutral schematic (drawio units, y down) and its deck.
 * scale: user units per neutral unit (10 px → one 0.0625 step by default).
 */
export function cadencePlan(N, parsed, { scale = 0.00625, grid = 0.0625, cell = 'schematic' } = {}) {
  const g = (v) => Math.round(Math.round(v / grid) * grid * 1e9) / 1e9;
  const P = (p) => [g(p[0] * scale), g(-p[1] * scale) + 0];
  const byRef = new Map(parsed.components.map((c) => [String(c.ref).toUpperCase(), c]));
  const bad = N.components.filter((c) => !(c.spice.prefix === 'M' || ROLE[c.spice.prefix]));
  if (bad.length) throw new Error(`cadence: no symbol role for prefix ${[...new Set(bad.map((c) => c.spice.prefix))].join(', ')}`);
  const components = N.components.map((c) => {
    const src = byRef.get(String(c.ref).toUpperCase());
    if (!src) throw new Error(`cadence: ${c.ref} is not in the deck`);
    const role = c.spice.prefix === 'M' ? (/pmos/i.test(c.spice.model || '') ? 'pmos' : 'nmos') : ROLE[c.spice.prefix];
    const pins = c.spice.order.map((pn, index) => (c.pins[pn] ? { index, at: P(c.pins[pn].at), net: c.pins[pn].net, label: cadNet(c.pins[pn].net) } : null)).filter(Boolean);
    const hidden = Object.entries(c.spice.hidden || {}).map(([i, net]) => ({ index: Number(i), net, label: cadNet(net) }));
    return { ref: c.ref, role, model: deckParams(src).model, params: deckParams(src), at: P(c.at), rot: c.rot, mirror: c.mirror, pins, hidden };
  });
  const ports = N.ports.map((t) => ({ name: cadNet(t.net), net: t.net, at: P(t.at) }));
  const grounds = N.rails.filter((r) => r.kind === 'ground').map((r) => ({ net: r.net, at: P(r.at) }));
  const supplies = N.rails.filter((r) => r.kind !== 'ground').map((r) => ({ net: r.net, at: P(r.at) }));
  const connPts = [...components.flatMap((c) => c.pins.map((p) => p.at)), ...N.junctions.map((j) => P(j.at)),
    ...ports.map((p) => p.at), ...grounds.map((r) => r.at), ...supplies.map((r) => r.at)];
  const raw = N.wires.map((w) => ({ net: w.net, points: w.points.map(P).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]) })).filter((w) => w.points.length >= 2);
  const wires = splitWires(raw, [...connPts, ...raw.flatMap((w) => [w.points[0], w.points.at(-1)])]);

  // labels: supply rails, and every net a hidden terminal (bulk) joins by name
  const labels = [], labelled = new Set(ports.map((p) => p.net));
  const pinAt = (at) => { for (const c of components) for (const p of c.pins) if (p.at[0] === at[0] && p.at[1] === at[1]) return { ref: c.ref, index: p.index }; return null; };
  const onWire = (net) => { const w = wires.find((x) => x.net === net); if (!w) return null; const [a, b] = w.points; return [g((a[0] + b[0]) / 2), g((a[1] + b[1]) / 2)]; };
  for (const r of supplies) {
    if (wires.some((w) => w.net === r.net && w.points.some((p) => p[0] === r.at[0] && p[1] === r.at[1]))) labels.push({ net: r.net, text: cadNet(r.net), at: r.at });
    else labels.push({ net: r.net, text: cadNet(r.net), at: r.at, pin: pinAt(r.at) });
    labelled.add(r.net);
  }
  for (const c of components) for (const h of c.hidden) {
    if (h.net === '0' || labelled.has(h.net)) continue;
    labelled.add(h.net);
    const at = onWire(h.net);
    if (at) { labels.push({ net: h.net, text: cadNet(h.net), at }); continue; }
    const pc = components.flatMap((x) => x.pins.map((p) => ({ ref: x.ref, ...p }))).find((p) => p.net === h.net);
    if (pc) labels.push({ net: h.net, text: cadNet(h.net), at: pc.at, pin: { ref: pc.ref, index: pc.index } });
  }

  // what the deck expects: every terminal on its deck node; ground; port names
  const terminals = [], ground = new Set(), portNodes = new Map();
  for (const c of components) {
    const src = byRef.get(String(c.ref).toUpperCase());
    const nodes = src.fullNodes || src.nodes;
    nodes.forEach((node, index) => terminals.push({ ref: c.ref, index, node: String(node) }));
    for (const p of c.pins) {
      const node = String(nodes[p.index]);
      if (p.net === '0') ground.add(node);
      const port = ports.find((t) => t.net === p.net);
      if (port) portNodes.set(port.name, node);
    }
    for (const h of c.hidden) if (h.net === '0') ground.add(String(nodes[h.index]));
  }
  const plan = {
    format: 'cadence-plan/1', neutral: N.format, cell, grid, scale,
    components, wires, labels, ports, grounds,
    expected: { terminals, ground: [...ground], ports: [...portNodes].map(([name, node]) => ({ name, node })) },
  };
  // a short fingerprint the report quotes (no name in it)
  return { id: crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 12), ...plan };
}

/**
 * The plan checked alone, with Virtuoso's rules (a pin joins a wire END, a
 * wire end inside a segment is a T, same names join), as if every symbol pin
 * landed on its planned point: { opens, shorts, groundWrong, portsWrong }.
 */
export function checkPlan(plan) {
  const parent = new Map(), find = (a) => { if (!parent.has(a)) parent.set(a, a); while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const K = (p) => `P:${p[0]},${p[1]}`;
  const segs = plan.wires.flatMap((w, i) => w.points.slice(1).map((b, k) => ({ a: w.points[k], b, id: `W:${i}` })));
  const inside = (p, a, b) => (a[0] === b[0] ? p[0] === a[0] && p[1] > Math.min(a[1], b[1]) && p[1] < Math.max(a[1], b[1])
    : a[1] === b[1] && p[1] === a[1] && p[0] > Math.min(a[0], b[0]) && p[0] < Math.max(a[0], b[0]));
  plan.wires.forEach((w, i) => { for (let k = 0; k < w.points.length; k++) union(`W:${i}`, K(w.points[k])); });
  for (const s of segs) for (const t of segs) for (const e of [t.a, t.b]) if (inside(e, s.a, s.b)) union(s.id, K(e));
  for (const c of plan.components) for (const p of c.pins) union(`T:${c.ref}:${p.index}`, K(p.at));
  const named = (k, name) => union(k, `N:${name}`);
  for (const c of plan.components) for (const h of c.hidden) named(`T:${c.ref}:${h.index}`, h.label);
  for (const r of plan.grounds) named(K(r.at), 'gnd!');
  for (const t of plan.ports) named(K(t.at), t.name);
  for (const l of plan.labels) {
    const s = segs.find((x) => inside(l.at, x.a, x.b) || [x.a, x.b].some((e) => e[0] === l.at[0] && e[1] === l.at[1]));
    if (s) named(s.id, l.text); else if (l.pin) named(`T:${l.pin.ref}:${l.pin.index}`, l.text);
  }
  const nodeNets = new Map(), netNodes = new Map();
  for (const t of plan.expected.terminals) {
    const r = find(`T:${t.ref}:${t.index}`);
    if (!nodeNets.has(t.node)) nodeNets.set(t.node, new Set()); nodeNets.get(t.node).add(r);
    if (!netNodes.has(r)) netNodes.set(r, new Set()); netNodes.get(r).add(t.node);
  }
  const root = (name) => find(`N:${name}`);
  return {
    opens: [...nodeNets.values()].filter((s) => s.size > 1).length,
    shorts: [...netNodes.values()].filter((s) => s.size > 1).length,
    groundWrong: plan.expected.ground.filter((n) => !nodeNets.get(n)?.has(root('gnd!'))).length,
    portsWrong: plan.expected.ports.filter((p) => !nodeNets.get(p.node)?.has(root(p.name))).length,
  };
}
const planOk = (c) => !c.opens && !c.shorts && !c.groundWrong && !c.portsWrong;

/** (a) the Python script for skillbridge. */
export function writePython(plan, { mapText = fs.readFileSync(DEFAULT_MAP, 'utf8') } = {}) {
  const json = JSON.stringify(plan).replace(/'/g, '\\u0027');
  const map = mapText.replace(/'/g, '');
  return [
    '#!/usr/bin/env python3',
    '# Generated by drawio (exporters/cadence): a schematic for Cadence Virtuoso through skillbridge.',
    '# Usage (Virtuoso running, skillbridge server started): python3 THIS.py --lib WORKLIB [--cell NAME] [--map my.map]',
    '# Writes cadence-report.txt (counts only). Sends nothing over the network.',
    'import json',
    `PLAN = json.loads(r'''${json}''')`,
    `DEFAULT_MAP = r'''${map}'''`,
    fs.readFileSync(RUNTIME_PY, 'utf8'),
    'if __name__ == "__main__":',
    '    raise SystemExit(main())',
    '',
  ].join('\n');
}

/** A JSON value as SKILL: objects → cadxD(list("key" value ...)) tables, arrays → list(...). */
export function toSkill(v) {
  if (v === null || v === undefined || v === false) return 'nil';
  if (v === true) return 't';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v).replace(/^(-?)\./, '$10.');
  if (typeof v === 'string') return '"' + v.replace(/[\\"]/g, (m) => '\\' + m).replace(/\n/g, '\\n') + '"';
  // a point: floats (SKILL divides integers as integers)
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')) return `list(${v.map((x) => (Number.isInteger(x) ? x + '.0' : toSkill(x))).join(' ')})`;
  if (Array.isArray(v)) return v.length ? `list(${v.map(toSkill).join(' ')})` : 'nil';
  return `cadxD(list(${Object.entries(v).map(([k, x]) => `${toSkill(k)} ${toSkill(x)}`).join(' ')}))`;
}

/** (b) the SKILL-only file: load("x.il") then cadxExport("WORKLIB"). */
export function writeSkill(plan, { mapText = fs.readFileSync(DEFAULT_MAP, 'utf8') } = {}) {
  return [
    '; Generated by drawio (exporters/cadence): a schematic for Cadence Virtuoso, SKILL only.',
    '; In the CIW:  load("THIS.il")  cadxExport("WORKLIB")   [?cell "name" ?map "my.map" ?overwrite t]',
    '; Writes cadence-report.txt (counts only). Sends nothing over the network.',
    fs.readFileSync(RUNTIME_IL, 'utf8'),
    `cadxDefaultMap = ${toSkill(mapText)}`,
    `cadxPlan = ${toSkill(plan)}`,
    '',
  ].join('\n');
}

/** Netlist → { plan, python, neutral, label }; the neutral LVS must pass first. */
export async function exportCadence(parsed, opts = {}) {
  const r = await autoPlace(parsed);
  const N = toNeutral(getPage(r.doc), { target: { tool: 'cadence', unit: 'px', grid: 10 }, source: { engine: r.label } });
  if (!checkNeutral(N, parsed).match) throw new Error('cadence: the neutral schematic does not redraw the deck');
  // on the 10-unit grid = one Virtuoso step; when that merges two wires, the
  // half grid at twice the scale (a larger drawing, still on Virtuoso's grid)
  const scale = opts.scale ?? 0.00625;
  for (const [step, sc] of [[10, scale], [5, 2 * scale]]) {
    const G = snapNeutral(N, step);
    if (!checkNeutral(G, parsed).match) continue;
    const plan = cadencePlan(G, parsed, { ...opts, scale: sc }), check = checkPlan(plan);
    if (!planOk(check)) continue;
    return { plan, check, python: writePython(plan, opts), skill: writeSkill(plan, opts), neutral: G, label: r.label };
  }
  throw new Error('cadence: no grid keeps the plan equal to the deck');
}
