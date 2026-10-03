#!/usr/bin/env node
/**
 * bench-families.mjs — the quality bench, per FAMILY and per split, on the
 * netlist bank (tools/import-corpora.py + inventory-bank.mjs).
 *
 * Splits (deterministic):
 *   holdout-family — the families of benchmark/sealed-50.json holdoutFamilies,
 *                    never used for tuning, measured only;
 *   tune / test    — the other families, 60 / 40 by a hash of the circuit id.
 * Sealed circuits and their variants are skipped (lib/sealed.js); a weak
 * family label (recognizer guess) is reported as `<family>*`; generated
 * circuits (source "gen-…") are reported apart from the real ones.
 *
 * Per circuit: LVS, check.py errors/warnings/crossings, aspect, area and wire
 * length per part, long wires (> 40 % of the sheet's larger side), bends per
 * wire, published-convention score, check.py error rules. One JSON line per circuit.
 *
 * Usage:
 *   node tools/bench-families.mjs run  --out DIR [--engine auto|v2|v4] [--shard i/k] [--limit N] [--split tune|test|holdout-family|all] [--sources a,b] [--exclude-source a,b]
 *   node tools/bench-families.mjs sum  DIR [DIR2]       (DIR2: compare two runs)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { newDocument, getPage, normalizeOrigin, serialize, allCells, cellInfo } from '../lib/model.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { importNetlist2 } from '../lib/place2.js';
import { importNetlist4 } from '../lib/place4.js';
import { routePage, pinAbs } from '../lib/route.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { conventionReport } from '../lib/conventions.js';
import { assertNotSealed, bankExclusions } from '../lib/sealed.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BANK = arg('--bank', '/AI/datasets/netlists/bank');
const SEALED = JSON.parse(fs.readFileSync(path.join(HERE, '../benchmark/sealed-50.json'), 'utf8'));
const famOf = (r) => ((r.family === 'adc' || r.family === 'dac') ? 'data-converter' : r.family) + (r.familyWeak ? '*' : '');
export function splitOf(r) {
  if (SEALED.holdoutFamilies.includes(famOf(r).replace('*', ''))) return 'holdout-family';
  const h = parseInt(crypto.createHash('sha1').update(r.id).digest('hex').slice(0, 8), 16) / 0xffffffff;
  return h < 0.6 ? 'tune' : 'test';
}

function geometry(m, parsed) {
  const cells = allCells(m).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const verts = cells.filter((c) => c.kind === 'vertex' && c.x != null);
  const xs = verts.flatMap((c) => [c.x, c.x + c.w]), ys = verts.flatMap((c) => [c.y, c.y + c.h]);
  const W = Math.max(...xs) - Math.min(...xs), H = Math.max(...ys) - Math.min(...ys);
  let len = 0, bends = 0, wires = 0, long = 0;
  for (const e of cells.filter((c) => c.kind === 'edge')) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) continue;
    const pin = (pre) => ({ x: Number(e.style.map.get(pre + 'X') ?? 0.5), y: Number(e.style.map.get(pre + 'Y') ?? 0.5) });
    const pts = [pinAbs(s, pin('exit')), ...e.points, pinAbs(t, pin('entry'))];
    let l = 0; for (let i = 1; i < pts.length; i++) l += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    len += l; bends += Math.max(0, pts.length - 2); wires++;
    if (l > 0.4 * Math.max(W, H)) long++;
  }
  const n = Math.max(1, parsed.components.length);
  return { aspect: +(Math.max(W, H) / Math.max(1, Math.min(W, H))).toFixed(2), area_per_part: Math.round(W * H / n), wire_per_part: Math.round(len / n), bends_per_wire: wires ? +(bends / wires).toFixed(2) : 0, long_wires: long, wires };
}

async function run() {
  const out = arg('--out'); const engine = arg('--engine', 'auto'); const [si, sk] = (arg('--shard', '0/1')).split('/').map(Number);
  const wantSplit = arg('--split', 'all'); const limit = Number(arg('--limit', 1e9));
  // --sources a,b keeps only those sources; --exclude-source a,b drops them
  const onlySrc = arg('--sources', null)?.split(','), exSrc = (arg('--exclude-source', '') || '').split(',').filter(Boolean);
  fs.mkdirSync(out, { recursive: true });
  const ex = bankExclusions(BANK);
  const man = new Map(fs.readdirSync(BANK).filter((f) => /^manifest.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(`${BANK}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))).map((r) => [r.id, r]));
  const inv = fs.readFileSync(`${BANK}/inventory.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && (wantSplit === 'all' || splitOf(r) === wantSplit) && (!onlySrc || onlySrc.includes(r.source)) && !exSrc.includes(r.source))
    .filter((_, i) => i % sk === si).slice(0, limit);
  const fd = fs.openSync(path.join(out, `shard-${si}.jsonl`), 'w');
  const tmp = `/tmp/bf-${process.pid}.xml`;
  for (const r of inv) {
    const text = fs.readFileSync(man.get(r.id).file, 'utf8');
    const row = { id: r.id, source: r.source, family: famOf(r), split: splitOf(r), parts: r.parts, engine };
    try {
      assertNotSealed(text, r.id, { family: r.familyWeak ? null : r.family });
      const parsed = parseSpice(text);
      let doc, m, chosen = engine;
      if (engine === 'auto') { const a = await autoPlace(parsed); doc = a.doc; chosen = a.label; }
      else { doc = newDocument(); const mm = getPage(doc); if (engine === 'v2') { const p = importNetlist2(mm, parsed); await routePage(mm, p.wires, {}); normalizeOrigin(mm); } else await importNetlist4(mm, parsed); }
      m = getPage(doc);
      row.chosen = chosen;
      row.lvs = compare(extractNetlist(m), parsed).match;
      fs.writeFileSync(tmp, serialize(doc));
      const j = JSON.parse(spawnSync('python3', [path.join(HERE, 'check.py'), tmp, '--netlist', man.get(r.id).file, '--json'], { encoding: 'utf8', timeout: 120000 }).stdout);
      row.errors = j.errors; row.warnings = j.warnings; row.crossings = j.crossings ?? 0;
      row.rules = {};
      for (const v of j.violations || []) if (v.severity === 'error') row.rules[v.rule] = (row.rules[v.rule] || 0) + 1;
      Object.assign(row, geometry(m, parsed));
      try { row.conv = conventionReport(m, parsed).score; } catch { row.conv = null; }
    } catch (e) { row.failed = String(e.message || e).slice(0, 160); }
    fs.writeSync(fd, JSON.stringify(row) + '\n');
  }
  fs.closeSync(fd);
  console.log(`shard ${si}/${sk}: ${inv.length} circuits -> ${out}`);
}

function load(dir) { return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))); }
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
function table(rows) {
  const g = new Map();
  for (const r of rows) { const k = `${r.source.startsWith('gen') ? 'GEN' : 'REAL'} ${r.split.padEnd(14)} ${r.family}`; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  const out = {};
  for (const [k, rs] of [...g].sort()) {
    const ok = rs.filter((r) => !r.failed);
    out[k] = { n: rs.length, failed: rs.length - ok.length, lvs: ok.filter((r) => r.lvs).length / Math.max(1, ok.length),
      zero: ok.filter((r) => r.errors === 0).length / Math.max(1, ok.length), wide: ok.filter((r) => r.aspect > 3).length / Math.max(1, ok.length),
      conv: med(ok.map((r) => r.conv)), long: ok.reduce((s, r) => s + r.long_wires, 0) / Math.max(1, ok.length), cross: ok.reduce((s, r) => s + r.crossings, 0) / Math.max(1, ok.length) };
  }
  return out;
}
function sum() {
  const [d1, d2] = argv.slice(1);
  const t1 = table(load(d1)), t2 = d2 ? table(load(d2)) : null;
  const pct = (x) => (x == null ? '  - ' : (100 * x).toFixed(0).padStart(3) + '%');
  console.log('kind split          family                 n  fail  LVS  zero-err  >3:1  conv  long/c  cross/c' + (t2 ? '   | zero-err  >3:1  conv (run 2)' : ''));
  for (const [k, v] of Object.entries(t1)) {
    const w = t2 && t2[k];
    console.log(`${k.padEnd(40)} ${String(v.n).padStart(4)} ${String(v.failed).padStart(4)}  ${pct(v.lvs)}    ${pct(v.zero)}   ${pct(v.wide)}  ${v.conv == null ? ' -  ' : v.conv.toFixed(2)}  ${v.long.toFixed(1).padStart(5)}  ${v.cross.toFixed(1).padStart(6)}` +
      (w ? `   |    ${pct(w.zero)}   ${pct(w.wide)}  ${w.conv == null ? ' - ' : w.conv.toFixed(2)}` : ''));
  }
}
if (argv[0] === 'run') await run(); else if (argv[0] === 'sum') sum(); else { console.error('usage: run|sum (see header)'); process.exit(1); }
