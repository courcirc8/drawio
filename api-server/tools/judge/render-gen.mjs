#!/usr/bin/env node
/**
 * render-gen.mjs — generated side of the judge dataset: our drawings of the
 * bank circuits (sealed circuits and variants excluded, lib/sealed.js), two per
 * circuit (auto's choice, and v2+branches), raw PNG into /AI/datasets/judge/gen-raw/
 * (normalised afterwards by normalize-dir.py with the SAME normalize.py).
 * Usage: node tools/judge/render-gen.mjs --shard i/k [--limit N]
 */
import fs from 'node:fs';
import { newDocument, getPage, normalizeOrigin } from '../../lib/model.js';
import { parseSpice } from '../../lib/netlist.js';
import { importNetlist2 } from '../../lib/place2.js';
import { routePage } from '../../lib/route.js';
import { autoPlace } from '../../lib/auto.js';
import { exportDocument } from '../../lib/render.js';
import { assertNotSealed, bankExclusions } from '../../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const [si, sk] = arg('--shard', '0/1').split('/').map(Number);
const LIMIT = Number(arg('--limit', 1e9));
const BANK = '/AI/datasets/netlists/bank', OUT = '/AI/datasets/judge/gen-raw';
const ex = bankExclusions(BANK);
const man = new Map(fs.readdirSync(BANK).filter((f) => /^manifest.*\.jsonl$/.test(f))
  .flatMap((f) => fs.readFileSync(`${BANK}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))).map((r) => [r.id, r]));
const inv = fs.readFileSync(`${BANK}/inventory.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id)).filter((_, i) => i % sk === si).slice(0, LIMIT);
const idx = fs.openSync(`${OUT}/index-${si}.jsonl`, 'a');
let n = 0;
for (const r of inv) {
  const text = fs.readFileSync(man.get(r.id).file, 'utf8');
  try { assertNotSealed(text, r.id, { family: r.familyWeak ? null : r.family }); } catch { continue; }
  const p = parseSpice(text);
  for (const variant of ['auto', 'v2b']) {
    try {
      let doc;
      if (variant === 'auto') doc = (await autoPlace(p)).doc;
      else { doc = newDocument(); const m = getPage(doc); const pl = importNetlist2(m, p, { branchExtend: true }); await routePage(m, pl.wires, {}); normalizeOrigin(m); }
      const png = await exportDocument(doc, getPage(doc), { format: 'png', scale: 1 });
      const name = `s${si}-${++n}.png`;
      fs.writeFileSync(`${OUT}/${name}`, png.buffer);
      fs.writeSync(idx, JSON.stringify({ file: name, id: r.id, family: r.family, variant, parts: r.parts }) + '\n');
    } catch { /* skip */ }
  }
}
fs.closeSync(idx);
console.log(`shard ${si}: ${n} renders`);
process.exit(0);
