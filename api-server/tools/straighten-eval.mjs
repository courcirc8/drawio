#!/usr/bin/env node
/**
 * straighten-eval.mjs — effect of the straightening pass (lib/straighten.js)
 * on drawings made by auto: avoidable bends (pins within one step of a
 * straight line), all bends, check.py errors, LVS, time. Netlists ≤ 25 parts
 * of the bank (every exclusion applied, sealed refused) or a readings batch.
 * Usage: node tools/straighten-eval.mjs [--n 200] [--split tune] [--batch DIR]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage, serialize, allCells, cellInfo } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { compare } from '../lib/lvs.js';
import { straighten, avoidableBends } from '../lib/straighten.js';
import { bankExclusions, sealedStatus } from '../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const N = Number(arg('--n', 200)), BATCH = arg('--batch'), B = '/AI/datasets/netlists/bank';
const HERE = path.dirname(new URL(import.meta.url).pathname);
let list = [];
if (BATCH) list = fs.readFileSync(`${BATCH}/items.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((x) => ({ id: x.key, text: x.netlist }));
else {
  const ex = bankExclusions(B);
  const man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(`${B}/${f}`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).map((r) => [r.id, r.file]));
  const inv = fs.readFileSync(`${B}/inventory.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && r.parts <= 25 && r.parts >= 3);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = inv.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [inv[i], inv[j]] = [inv[j], inv[i]]; }
  for (const r of inv) { if (list.length >= N) break; const text = fs.readFileSync(man.get(r.id), 'utf8'); if (!sealedStatus(text)) list.push({ id: r.id, text }); }
}
const bends = (m) => {
  const cells = allCells(m).map(cellInfo); let n = 0;
  for (const e of cells.filter((c) => c.kind === 'edge')) n += e.points.length;
  return n;
};
const check = (doc) => {
  const f = path.join(os.tmpdir(), `steval-${process.pid}.drawio`); fs.writeFileSync(f, serialize(doc));
  try { const j = JSON.parse(spawnSync('python3', [path.join(HERE, 'check.py'), f, '--json'], { encoding: 'utf8', timeout: 120000 }).stdout); const r = {}; for (const v of j.violations || []) if (v.severity === 'error') r[v.rule] = (r[v.rule] || 0) + 1; return { n: j.errors, r }; } catch { return null; } finally { fs.rmSync(f, { force: true }); }
};
const tot = { n: 0, av0: 0, av1: 0, b0: 0, b1: 0, e0: 0, e1: 0, lvsBad: 0, ms: 0, better: 0, worse: 0 };
for (const it of list) {
  let p; try { p = parseSpice(/\.end\b/i.test(it.text) ? it.text : it.text + '\n.end'); } catch { continue; }
  let r; try { r = await autoPlace(p); } catch { continue; }
  const m = getPage(r.doc);
  const a0 = avoidableBends(m).bends, b0 = bends(m), e0 = check(r.doc);
  const t = Date.now(); await straighten(m); tot.ms += Date.now() - t;
  const a1 = avoidableBends(m).bends, b1 = bends(m), e1 = check(r.doc);
  if (!compare(extractNetlist(m), p).match) tot.lvsBad++;
  tot.n++; tot.av0 += a0; tot.av1 += a1; tot.b0 += b0; tot.b1 += b1; tot.e0 += e0?.n ?? 0; tot.e1 += e1?.n ?? 0;
  for (const [k, v] of Object.entries(e1?.r || {})) { tot.rd ||= {}; tot.rd[k] = (tot.rd[k] || 0) + v - ((e0?.r || {})[k] || 0); }
  if ((e1?.n ?? 0) > (e0?.n ?? 0)) (tot.worseIds ||= []).push(it.id + ' ' + JSON.stringify(e1.r));
  if (b1 < b0) tot.better++; if (b1 > b0) tot.worse++;
}
const f = (x) => (x / Math.max(1, tot.n)).toFixed(2);
console.log(`${tot.n} dessins — coudes évitables/dessin ${f(tot.av0)} -> ${f(tot.av1)} ; coudes totaux/dessin ${f(tot.b0)} -> ${f(tot.b1)} (moins ${tot.better}, plus ${tot.worse}) ; erreurs check.py/dessin ${f(tot.e0)} -> ${f(tot.e1)} ; LVS cassé ${tot.lvsBad} ; ${Math.round(tot.ms / Math.max(1, tot.n))} ms/dessin`);
console.log('règles (après - avant):', JSON.stringify(tot.rd || {})); console.log((tot.worseIds || []).slice(0, 8).join('\n'));
process.exit(0);
