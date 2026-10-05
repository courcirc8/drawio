#!/usr/bin/env node
/**
 * compare-batch.mjs — build a blind pairwise batch for /compare: circuits of the
 * TUNE split whose auto pick changes with AUTO_RULES=1 (bench runs rules0-tune /
 * rules1-tune), real circuits only, 6–30 parts, at most 2 per family; each drawn
 * by auto as it is and by auto with the rules, sides shuffled. Sealed circuits
 * and variants are refused (lib/sealed.js). Our renders only.
 * Usage: node tools/compare-batch.mjs --batch rules-1 [--n 15] [--seed 1]
 */
import fs from 'node:fs';
import { getPage } from '../lib/model.js';
import { parseSpice } from '../lib/netlist.js';
import { autoPlace } from '../lib/auto.js';
import { exportDocument } from '../lib/render.js';
import { assertNotSealed } from '../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BATCH = arg('--batch', 'rules-1'), N = Number(arg('--n', 15));
let seed = Number(arg('--seed', 1));
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const RUNS = '/AI/datasets/netlists/runs', BANK = '/AI/datasets/netlists/bank';
const OUT = `${process.env.COMPARE_ROOT || '/AI/datasets/judge/compare'}/${BATCH}`;
if (fs.existsSync(OUT)) { console.error(`${OUT} exists: refusing to overwrite a batch`); process.exit(1); }
fs.mkdirSync(`${OUT}/img`, { recursive: true });
const load = (d) => new Map(fs.readdirSync(d).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => fs.readFileSync(`${d}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))).map((r) => [r.id, r]));
const a = load(`${RUNS}/rules0-tune`), b = load(`${RUNS}/rules1-tune`);
const man = new Map(fs.readdirSync(BANK).filter((f) => /^manifest.*\.jsonl$/.test(f))
  .flatMap((f) => fs.readFileSync(`${BANK}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))).map((r) => [r.id, r]));
const pool = [...a.values()].filter((r) => b.has(r.id) && r.split === 'tune' && !String(r.source).startsWith('gen')
  && r.parts >= 6 && r.parts <= 30 && r.chosen !== b.get(r.id).chosen && man.has(r.id));
pool.sort((x, y) => (x.id < y.id ? -1 : 1));
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
const perFam = {}, items = [];
for (const r of pool) {
  if (items.length >= N) break;
  const fam = String(r.family).replace('*', '');
  if ((perFam[fam] || 0) >= 2) continue;
  const text = fs.readFileSync(man.get(r.id).file, 'utf8');
  try { assertNotSealed(text, r.id, { family: null }); } catch { continue; }
  const p = parseSpice(text);
  const draw = async (rules) => { process.env.AUTO_RULES = rules ? '1' : '0'; const res = await autoPlace(p); return { res, png: await exportDocument(res.doc, getPage(res.doc), { format: 'png', scale: 1.5 }) }; };
  try {
    const base = await draw(false), rul = await draw(true);
    if (base.res.label === rul.res.label) continue;   // same pick now: nothing to compare
    const n = items.length + 1, rulesLeft = rnd() < 0.5;
    fs.writeFileSync(`${OUT}/img/${n}-L.png`, (rulesLeft ? rul : base).png.buffer);
    fs.writeFileSync(`${OUT}/img/${n}-R.png`, (rulesLeft ? base : rul).png.buffer);
    items.push({ n, id: r.id, family: r.family, parts: r.parts, sides: { L: rulesLeft ? 'rules' : 'base', R: rulesLeft ? 'base' : 'rules' },
      labels: { base: base.res.label, rules: rul.res.label } });
    perFam[fam] = (perFam[fam] || 0) + 1;
  } catch { /* skip */ }
}
fs.writeFileSync(`${OUT}/items.jsonl`, items.map((x) => JSON.stringify(x)).join('\n') + '\n');
console.log(`${items.length} pairs -> ${OUT}`, perFam);
process.exit(0);
