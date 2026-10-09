#!/usr/bin/env node
/**
 * analyse-pairs.mjs — what sets apart the drawing Eric preferred in a /compare
 * batch (eric-pairs-batch.mjs: base = auto d'avant, new = auto d'aujourd'hui)?
 * Each pair is redrawn (checked identical to the images Eric saw), then
 * measured on the checker's terms and on Eric's readability rules:
 *   gnd_src_row   share of the devices whose source / emitter is on ground that
 *                 sit on the most common row among them (1 = all aligned)
 *   vdd_src_row   same for sources / emitters on a supply
 *   dc_column     share of series links (drain/collector of one device on the
 *                 source/emitter or drain of another, net touching only those
 *                 two current terminals) drawn in one column
 *   flow_lr       share of driver -> driven links (drain/collector on the gate/base
 *                 of another device) drawn left to right
 *   load_in_column share of rail loads (R, L, C between a rail and a device's
 *                 drain/source) drawn in the device's column, on the rail side
 *   wire_units_per_part / long_wires / sheet_units  wire length in median part
 *                 sizes per part, wires > 40 % of the sheet, sheet's long side
 *   plus check.py errors and crossings, bends per wire, wire length and area
 *   per part, aspect, basics (lib/basics.js), published-layout traits
 *   (lib/layout-rules.js: rows, columns, pairs on a row, mirror symmetry).
 * Row / column = centres within 0.3 of the median part size (as layout-rules).
 * Usage: node tools/analyse-pairs.mjs --batch eric-paires [--mode old|d] [--out FILE.json]
 *   (--mode d, default for eric-paires-3: auto as it is vs criterion D + stages)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getPage, allCells, cellInfo, serialize } from '../lib/model.js';
import { parseSpice } from '../lib/netlist.js';
import { autoPlace } from '../lib/auto.js';
import { exportDocument } from '../lib/render.js';
import { basicsReport } from '../lib/basics.js';
import { layoutTraits } from '../lib/layout-rules.js';
import { classify } from '../lib/components.js';
import { assertNotSealed } from '../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BATCH = arg('--batch', 'eric-paires');
const ROOT = process.env.COMPARE_ROOT || '/AI/datasets/judge/compare', DIR = `${ROOT}/${BATCH}`;
const BANK = '/AI/datasets/netlists/bank';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const man = new Map(fs.readdirSync(BANK).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${BANK}/${f}`)).map((r) => [r.id, r]));
const answers = new Map(jsonl(`${DIR}/answers.jsonl`).map((a) => [a.n, a]));

// --mode d (series 3): base = auto as it is, new = criterion D + stage engine
const MODE = arg('--mode', BATCH === 'eric-paires-3' ? 'd' : 'old');
async function draw(p, old) {
  const keep = { AUTO_SA: process.env.AUTO_SA, AUTO_JUDGE: process.env.AUTO_JUDGE, AUTO_ASPECT: process.env.AUTO_ASPECT, AUTO_CRITERION: process.env.AUTO_CRITERION, AUTO_STAGES: process.env.AUTO_STAGES };
  for (const k of ['AUTO_CRITERION', 'AUTO_STAGES']) delete process.env[k];
  process.env.AUTO_ASPECT = '0';   // the batches compared auto as it was, without the aspect rule
  if (MODE === 'd') { if (!old) { process.env.AUTO_CRITERION = 'eric'; process.env.AUTO_STAGES = '1'; } }
  else if (old) { process.env.AUTO_SA = '0'; process.env.AUTO_JUDGE = 'js'; }
  try { const res = await autoPlace(p); return { doc: res.doc, label: res.label, png: (await exportDocument(res.doc, getPage(res.doc), { format: 'png', scale: 1.5 })).buffer }; }
  finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const GND = /^(0|gnd\w*|vss\w*|avss|dvss|vee\w*)$/i;
function ericRules(m, parsed) {
  const pos = new Map(), sizes = [];
  for (const c of allCells(m).map(cellInfo)) {
    if (c.kind !== 'vertex' || c.x == null || classify(c).role !== 'component') continue;
    pos.set(String(c.refdes || c.id), { x: c.x + c.w / 2, y: c.y + c.h / 2 }); sizes.push(Math.max(c.w, c.h));
  }
  const u = sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] || 1;
  const rails = new Set(parsed.components.filter((c) => c.prefix === 'V').flatMap((c) => c.nodes));
  const isGnd = (n) => GND.test(n), isVdd = (n) => !isGnd(n) && (rails.has(n) || /^(vdd|vcc|avdd|dvdd)/i.test(n));
  // current terminals: MOS D/S, BJT C/E (nodes order D G S / C B E)
  const dev = parsed.components.filter((c) => (c.prefix === 'M' || c.prefix === 'Q') && pos.has(c.ref)).map((c) => ({ ref: c.ref, d: c.nodes[0], s: c.nodes[2], p: pos.get(c.ref) }));
  const rowShare = (list) => {
    if (list.length < 2) return null;
    let best = 0;
    for (const a of list) best = Math.max(best, list.filter((b) => Math.abs(b.p.y - a.p.y) < 0.3 * u).length);
    return best / list.length;
  };
  const term = new Map();
  for (const d of dev) for (const n of [d.d, d.s]) term.set(n, (term.get(n) || 0) + 1);
  const links = [];
  for (const a of dev) for (const b of dev) {
    if (a.ref >= b.ref) continue;
    const shared = [a.d, a.s].filter((n) => (n === b.d || n === b.s) && !isGnd(n) && !isVdd(n) && term.get(n) === 2);
    if (shared.length) links.push(Math.abs(a.p.x - b.p.x) < 0.3 * u ? 1 : 0);
  }
  // signal flow: a device whose gate / base is driven by another's drain /
  // collector should sit to its right
  const flow = [];
  for (const a of dev) for (const b of parsed.components.filter((c) => (c.prefix === 'M' || c.prefix === 'Q') && pos.has(c.ref) && c.ref !== a.ref)) {
    if (b.nodes[1] === a.d && !isGnd(a.d) && !isVdd(a.d)) flow.push(pos.get(b.ref).x > a.p.x + 0.3 * u ? 1 : 0);
  }
  // load above its device: a two-pin part between a supply and a drain /
  // collector, drawn in the device's column above it (or below for ground loads)
  const loads = [];
  for (const c of parsed.components.filter((c) => 'RLC'.includes(c.prefix) && pos.has(c.ref))) {
    const [n1, n2] = c.nodes, rail = isVdd(n1) || isGnd(n1) ? n1 : isVdd(n2) || isGnd(n2) ? n2 : null;
    if (!rail) continue;
    const other = rail === n1 ? n2 : n1, q = pos.get(c.ref);
    for (const d of dev.filter((d) => d.d === other || d.s === other)) {
      loads.push(Math.abs(q.x - d.p.x) < 0.5 * u && (isVdd(rail) ? q.y < d.p.y : q.y > d.p.y) ? 1 : 0);
    }
  }
  return {
    flow_lr: flow.length ? flow.reduce((a, b) => a + b, 0) / flow.length : null,
    load_in_column: loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : null,
    gnd_src_row: rowShare(dev.filter((d) => isGnd(d.s))), vdd_src_row: rowShare(dev.filter((d) => isVdd(d.s))),
    dc_column: links.length ? links.reduce((a, b) => a + b, 0) / links.length : null, series_links: links.length,
  };
}

function measure(doc, parsed, file) {
  const m = getPage(doc), tmp = path.join(os.tmpdir(), `analyse-${process.pid}.drawio`);
  fs.writeFileSync(tmp, serialize(doc));
  const j = JSON.parse(spawnSync('python3', [path.join(HERE, 'check.py'), tmp, '--netlist', file, '--json'], { encoding: 'utf8', timeout: 120000 }).stdout);
  fs.rmSync(tmp, { force: true });
  const cells = allCells(m).map(cellInfo), byId = new Map(cells.map((c) => [c.id, c]));
  const verts = cells.filter((c) => c.kind === 'vertex' && c.x != null);
  const xs = verts.flatMap((c) => [c.x, c.x + c.w]), ys = verts.flatMap((c) => [c.y, c.y + c.h]);
  const W = Math.max(...xs) - Math.min(...xs), H = Math.max(...ys) - Math.min(...ys), n = Math.max(1, parsed.components.length);
  const edges = cells.filter((c) => c.kind === 'edge' && byId.has(c.source) && byId.has(c.target));
  const bends = edges.reduce((s, e) => s + e.points.length, 0);
  // wire length in median part sizes, and wires longer than 40 % of the sheet
  const ps = verts.filter((c) => classify(c).role === 'component').map((c) => Math.max(c.w, c.h)).sort((a, b) => a - b);
  const u = ps[Math.floor(ps.length / 2)] || 1;
  let len = 0, long = 0;
  for (const e of edges) {
    const a = byId.get(e.source), z = byId.get(e.target);
    const pts = [{ x: a.x + a.w / 2, y: a.y + a.h / 2 }, ...e.points, { x: z.x + z.w / 2, y: z.y + z.h / 2 }];
    let l = 0; for (let i = 1; i < pts.length; i++) l += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    len += l; if (l > 0.4 * Math.max(W, H)) long++;
  }
  const b = basicsReport(m, parsed), t = layoutTraits(m) || {};
  return {
    errors: j.errors, crossings: j.crossings ?? 0, rules: (j.violations || []).filter((v) => v.severity === 'error').reduce((o, v) => ((o[v.rule] = (o[v.rule] || 0) + 1), o), {}),
    aspect: +(Math.max(W, H) / Math.max(1, Math.min(W, H))).toFixed(2), area_per_part: Math.round(W * H / n), wire_units_per_part: +(len / u / n).toFixed(2), long_wires: long, sheet_units: +(Math.max(W, H) / u).toFixed(1), bends_per_wire: edges.length ? +(bends / edges.length).toFixed(2) : 0,
    basics: b.count, basics_rules: b.byRule,
    col_share: t.col_share, row_share: t.row_share, pair_row: t.mos_pair_row, mirror_sym: t.mos_mirror_sym, vdd_above: t.vdd_above, gnd_below: t.gnd_below,
    ...ericRules(m, parsed),
  };
}

const out = [];
for (const it of jsonl(`${DIR}/items.jsonl`)) {
  const file = man.get(it.id).file, text = fs.readFileSync(file, 'utf8');
  assertNotSealed(text, it.id, { family: null });
  const p = parseSpice(text);
  const side = { base: null, new: null };
  for (const k of ['base', 'new']) {
    const d = await draw(p, k === 'base');
    const s = it.sides.L === k ? 'L' : 'R';
    side[k] = { label: d.label, sameAsShown: Buffer.compare(d.png, fs.readFileSync(`${DIR}/img/${it.n}-${s}.png`)) === 0, ...measure(d.doc, p, file) };
  }
  const a = answers.get(it.n);
  out.push({ n: it.n, id: it.id, family: it.family, parts: it.parts, preferred: a ? a.preferred : null, comment: a && a.comment || '', base: side.base, new: side.new });
  console.error(`${it.n} ${it.family} ${it.parts} -> ${a ? a.preferred : '?'}`);
}
const f = arg('--out', `${DIR}/analyse.json`);
fs.writeFileSync(f, JSON.stringify(out, null, 1));
// table: preferred (or base when equal) minus the other, per metric
const keys = ['errors', 'crossings', 'bends_per_wire', 'wire_units_per_part', 'long_wires', 'sheet_units', 'aspect', 'basics', 'flow_lr', 'load_in_column', 'gnd_src_row', 'vdd_src_row', 'dc_column', 'pair_row', 'mirror_sym'];
console.log(['n', 'famille', 'comp.', 'préféré', 'identiques', ...keys.map((k) => k + ' (avant→auj.)')].join('\t'));
for (const r of out) {
  const fmt = (v) => (v == null ? '-' : typeof v === 'number' ? +v.toFixed(2) : v);
  console.log([r.n, r.family, r.parts, r.preferred, `${r.base.sameAsShown && r.new.sameAsShown ? 'oui' : 'NON'}`, ...keys.map((k) => `${fmt(r.base[k])}→${fmt(r.new[k])}`)].join('\t'));
}
process.exit(0);
