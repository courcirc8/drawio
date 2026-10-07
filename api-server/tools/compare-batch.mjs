#!/usr/bin/env node
/**
 * compare-batch.mjs — build a blind pairwise batch for /compare: circuits of the
 * TUNE split whose auto pick changes with AUTO_RULES=1 (bench runs rules0-tune /
 * rules1-tune), real circuits only, 6–30 parts, at most 2 per family; each drawn
 * by auto as it is and by auto with the rules, sides shuffled. Sealed circuits
 * and variants are refused (lib/sealed.js). Our renders only.
 * --mode basics: the previous auto (AUTO_BASICS=0 P4_POLARITY=0, run basics0-tune)
 * against the current one (defaults, run basics2-tune); circuits whose drawing changes.
 * --mode sa: current auto against the annealing engine (lib/place-sa.js) on tune
 * circuits of the textbook sources never shown to Eric before (earlier batches excluded).
 * Usage: node tools/compare-batch.mjs --batch rules-1 [--n 15] [--seed 1] [--mode rules|basics|sa]
 */
import fs from 'node:fs';
import { getPage } from '../lib/model.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { importNetlistSA } from '../lib/place-sa.js';
import { newDocument, normalizeOrigin } from '../lib/model.js';
import { exportDocument } from '../lib/render.js';
import { assertNotSealed } from '../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BATCH = arg('--batch', 'rules-1'), N = Number(arg('--n', 15)), MODE = arg('--mode', 'rules');
const [RUN_A, RUN_B] = MODE === 'sa' ? ['basics2-tune', 'basics2-tune'] : MODE === 'basics' ? ['basics0-tune', 'basics2-tune'] : ['rules0-tune', 'rules1-tune'];
const ENVS = MODE === 'basics' ? [{ AUTO_BASICS: '0', P4_POLARITY: '0', AUTO_RULES: '0' }, { AUTO_RULES: '0' }] : [{ AUTO_RULES: '0' }, { AUTO_RULES: '1' }];
let seed = Number(arg('--seed', 1));
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const RUNS = '/AI/datasets/netlists/runs', BANK = '/AI/datasets/netlists/bank';
const OUT = `${process.env.COMPARE_ROOT || '/AI/datasets/judge/compare'}/${BATCH}`;
if (fs.existsSync(OUT)) { console.error(`${OUT} exists: refusing to overwrite a batch`); process.exit(1); }
fs.mkdirSync(`${OUT}/img`, { recursive: true });
const load = (d) => new Map(fs.readdirSync(d).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => fs.readFileSync(`${d}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))).map((r) => [r.id, r]));
const a = load(`${RUNS}/${RUN_A}`), b = load(`${RUNS}/${RUN_B}`);
const man = new Map(fs.readdirSync(BANK).filter((f) => /^manifest.*\.jsonl$/.test(f))
  .flatMap((f) => fs.readFileSync(`${BANK}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))).map((r) => [r.id, r]));
const seen = new Set();
for (const d of fs.existsSync(`${OUT}/..`) ? fs.readdirSync(`${OUT}/..`) : []) {
  const f = `${OUT}/../${d}/items.jsonl`;
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) seen.add(JSON.parse(l).id);
}
const pool = [...a.values()].filter((r) => b.has(r.id) && r.split === 'tune' && !String(r.source).startsWith('gen')
  && r.parts >= 6 && r.parts <= 30 && !seen.has(r.id) && man.has(r.id)
  && (MODE === 'sa' ? ['analoggenie', 'amsnet'].includes(r.source) : (r.chosen !== b.get(r.id).chosen || (MODE === 'basics' && r.basics !== b.get(r.id).basics))));
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
  const draw = MODE === 'sa' ? async (second) => {
    if (!second) { const res = await autoPlace(p); return { res, png: await exportDocument(res.doc, getPage(res.doc), { format: 'png', scale: 1.5 }) }; }
    const doc = newDocument(); await importNetlistSA(getPage(doc), p);
    if (!compare(extractNetlist(getPage(doc)), p).match) throw new Error('sa drawing fails LVS');
    return { res: { doc, label: 'sa' }, png: await exportDocument(doc, getPage(doc), { format: 'png', scale: 1.5 }) };
  } : async (second) => { for (const k of ['AUTO_BASICS', 'P4_POLARITY', 'AUTO_RULES']) delete process.env[k]; Object.assign(process.env, ENVS[second ? 1 : 0]); const res = await autoPlace(p); return { res, png: await exportDocument(res.doc, getPage(res.doc), { format: 'png', scale: 1.5 }) }; };
  try {
    const base = await draw(false), rul = await draw(true);
    if (MODE !== 'basics' && base.res.label === rul.res.label) continue;   // same pick now: nothing to compare
    if (MODE === 'basics' && Buffer.compare(base.png.buffer, rul.png.buffer) === 0) continue;
    const n = items.length + 1, rulesLeft = rnd() < 0.5;
    fs.writeFileSync(`${OUT}/img/${n}-L.png`, (rulesLeft ? rul : base).png.buffer);
    fs.writeFileSync(`${OUT}/img/${n}-R.png`, (rulesLeft ? base : rul).png.buffer);
    items.push({ n, id: r.id, family: r.family, parts: r.parts, sides: { L: rulesLeft ? (MODE === 'basics' ? 'new' : MODE === 'sa' ? 'sa' : 'rules') : 'base', R: rulesLeft ? 'base' : (MODE === 'basics' ? 'new' : MODE === 'sa' ? 'sa' : 'rules') },
      labels: { base: base.res.label, rules: rul.res.label } });
    perFam[fam] = (perFam[fam] || 0) + 1;
  } catch { /* skip */ }
}
fs.writeFileSync(`${OUT}/items.jsonl`, items.map((x) => JSON.stringify(x)).join('\n') + '\n');
console.log(`${items.length} pairs -> ${OUT}`, perFam);
process.exit(0);
