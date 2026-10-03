#!/usr/bin/env node
/**
 * dvd-rf-batch.mjs — a batch of RF schematics from the IEEE DVDs for Eric to
 * correct (netlist), one at a time, in tools/correct-ui (served by server.js
 * under /correct).
 *
 * Source: figures.sqlite (RAG session, read-only): figures of origin dvd-2001 /
 * dvd-2008 ONLY, caption type LNA / mixer / PA / PLL / VCO, vision reading
 * readable, 3..40 components. The vision netlist is stored on one line: it is
 * re-split before each component ref of the reading's component list.
 * Ranked by suspicion (parse error, nets with a single terminal, components
 * missing from the netlist), balanced per type. Sealed evaluation circuits and
 * their variants are refused (lib/sealed.js).
 *
 * Writes <out>/items.jsonl and <out>/img/<n>.png (crop by the RAG tool, one
 * render at a time) — on the station only, never in a repository. Prints counts.
 * Usage: node tools/dvd-rf-batch.mjs [--out DIR] [--per-type 20] [--no-images] [--rag-code DIR] [--python PATH]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parseSpice } from '../lib/netlist.js';
import { sealedStatus } from '../lib/sealed.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', '/AI/datasets/IEEE/derived/correction/rf-1');
const PER = Number(arg('--per-type', 20));
const DB = '/AI/datasets/IEEE/derived/figures.sqlite';
// code of the RAG crop tool (a checkout with rag/extract/figures.py) and its venv
const RAG = arg('--rag-code', `${process.env.HOME}/ClaudeCode/local_AI/rag`);
const PY = arg('--python', `${process.env.HOME}/ClaudeCode/local_AI/rag/.venv/bin/python`);
const FAMILY = { LNA: 'lna', mixer: 'mixer', PA: 'pa', PLL: 'pll', VCO: 'oscillator' };

/** One-line vision netlist -> SPICE lines, split before every known ref. */
export function resplit(one, refs) {
  const toks = String(one).replace(/;/g, ' ').split(/\s+/).filter(Boolean);
  const refSet = new Set(refs);
  const isRef = (t) => refSet.has(t) || /^[RCLMQDVIJSEFGHBX][A-Za-z0-9_]*\d[A-Za-z0-9_]*$/.test(t);
  const lines = [];
  let cur = null;
  for (const t of toks) {
    if (t.startsWith('*') || t.startsWith('.')) { if (cur) { lines.push(cur.join(' ')); cur = null; } continue; }
    if (isRef(t) && (cur == null || cur.length >= 3)) { if (cur) lines.push(cur.join(' ')); cur = [t]; } else if (cur) cur.push(t);
  }
  if (cur) lines.push(cur.join(' '));
  return lines.join('\n') + '\n.end\n';
}

function suspicion(text, nComp) {
  const flags = [];
  let p;
  try { p = parseSpice(text); } catch (e) { return { score: 99, flags: ['parse: ' + String(e.message).slice(0, 60)] }; }
  const deg = new Map();
  for (const c of p.components) for (const n of c.nodes) deg.set(n, (deg.get(n) || 0) + 1);
  const single = [...deg].filter(([n, d]) => d === 1 && n !== '0').length;
  if (single) flags.push(`${single} net(s) with one terminal`);
  if (p.components.length < nComp) flags.push(`${nComp - p.components.length} component(s) missing`);
  if ((p.warnings || []).length) flags.push(`${p.warnings.length} unsupported line(s)`);
  return { score: single + 2 * Math.max(0, nComp - p.components.length) + (p.warnings || []).length, flags, parts: p.components.length };
}

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare(`SELECT f.paper_id, f.page, f.rang, f.type, f.origine, l.lecture FROM lectures l JOIN figures f USING (paper_id, page, rang)
  WHERE l.erreur IS NULL AND f.origine IN ('dvd-2001','dvd-2008') AND f.type IN ('LNA','mixer','PA','PLL','VCO')`).all();
const byType = new Map();
let refused = 0;
for (const r of rows) {
  let j; try { j = JSON.parse(r.lecture); } catch { continue; }
  if (!j.readable) continue;
  const comps = (j.components || []).filter((c) => c && c.ref);
  if (comps.length < 3 || comps.length > 40) continue;
  const text = resplit(j.netlist || '', comps.map((c) => String(c.ref)));
  if (sealedStatus(text, { family: FAMILY[r.type] })) { refused++; continue; }
  const s = suspicion(text, comps.length);
  if (!byType.has(r.type)) byType.set(r.type, []);
  byType.get(r.type).push({ key: { paper_id: r.paper_id, page: r.page, rang: r.rang }, type: r.type, origine: r.origine, netlist: text, ...s });
}
fs.mkdirSync(path.join(OUT, 'img'), { recursive: true });
const items = [];
for (const [t, list] of [...byType].sort()) {
  list.sort((a, b) => a.score - b.score);
  items.push(...list.slice(0, PER));
}
// interleave types so the session is varied
items.sort((a, b) => (items.filter((x) => x.type === a.type).indexOf(a) - items.filter((x) => x.type === b.type).indexOf(b)) || (a.type < b.type ? -1 : 1));
const fd = fs.openSync(path.join(OUT, 'items.jsonl'), 'w');
let imgs = 0;
items.forEach((it, n) => {
  it.n = n + 1;
  if (!process.argv.includes('--no-images')) {
    const png = path.join(OUT, 'img', `${it.n}.png`);
    if (!fs.existsSync(png)) {
      const r = spawnSync(PY, ['-m', 'rag.extract.figures', 'crop', it.key.paper_id, String(it.key.page), String(it.key.rang), png], { cwd: RAG, encoding: 'utf8', timeout: 120000 });
      if (r.status === 0 && fs.existsSync(png)) imgs++;
    } else imgs++;
  }
  fs.writeSync(fd, JSON.stringify(it) + '\n');
});
fs.closeSync(fd);
const per = {}; for (const it of items) per[it.type] = (per[it.type] || 0) + 1;
console.log(`batch ${OUT}: ${items.length} items ${JSON.stringify(per)}, images ${imgs}, refused as sealed/variant ${refused}, median suspicion ${items.map((x) => x.score).sort((a, b) => a - b)[items.length >> 1]}`);
