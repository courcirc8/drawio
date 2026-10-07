#!/usr/bin/env node
/**
 * render-gen-boxes.mjs — our drawings WITH their exact component boxes, to teach
 * the component detector our own drawing style (it found a median 14 % of the
 * parts on our renders: judge v2's features were empty on our side). TRAIN split
 * circuits only (same hash as tools/judge/train.py: sha1('gen:'+id) < 0.8), so the
 * judge's val/test drawings stay unseen; sealed circuits and variants excluded.
 * Boxes from the cell geometry through the export mapping
 * px = (x + tx) * s - clipX (lib/render.js). Classes as train-detector.py.
 * Out: /AI/datasets/judge/gen-box/<shard>-<n>.png + boxes-<shard>.jsonl
 * Usage: node tools/judge/render-gen-boxes.mjs --shard i/k [--limit N]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { newDocument, getPage, normalizeOrigin, allCells, cellInfo } from '../../lib/model.js';
import { parseSpice } from '../../lib/netlist.js';
import { importNetlist2 } from '../../lib/place2.js';
import { routePage } from '../../lib/route.js';
import { autoPlace } from '../../lib/auto.js';
import { exportDocument } from '../../lib/render.js';
import { classify, shapeKeyOf } from '../../lib/components.js';
import { assertNotSealed, bankExclusions } from '../../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const [si, sk] = arg('--shard', '0/1').split('/').map(Number);
const LIMIT = Number(arg('--limit', 1e9));
const BANK = '/AI/datasets/netlists/bank', OUT = '/AI/datasets/judge/gen-box';
fs.mkdirSync(OUT, { recursive: true });
const split = (key) => parseInt(crypto.createHash('sha1').update(key).digest('hex').slice(0, 8), 16) / 0xffffffff;
const ex = bankExclusions(BANK);
const man = new Map(fs.readdirSync(BANK).filter((f) => /^manifest.*\.jsonl$/.test(f))
  .flatMap((f) => fs.readFileSync(`${BANK}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))).map((r) => [r.id, r]));
const inv = fs.readFileSync(`${BANK}/inventory.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && split('gen:' + r.id) < 0.8)
  .filter((_, i) => i % sk === si).slice(0, LIMIT);

function klass(c) {
  const cl = classify(c), key = shapeKeyOf(c) || '';
  if (cl.role === 'junction') return c.style.map.has('apiJunctionHidden') ? null : 'dot';   // hidden bend points draw nothing
  if (cl.role === 'port') return 'terminal';
  if (cl.role === 'ground') return 'gnd';
  if (cl.role === 'power') return /^(vss|gnd|0|vee|avss|dvss)/i.test(String(cl.net)) ? 'gnd' : 'vdd';
  if (cl.role !== 'component') return null;
  if (/transistors\.nmos/.test(key)) return 'nmos';
  if (/transistors\.pmos/.test(key)) return 'pmos';
  if (cl.prefix === 'R') return 'resistor';
  if (cl.prefix === 'C') return 'capacitor';
  if (cl.prefix === 'I') return 'current';
  if (cl.prefix === 'V') return 'voltage';
  return null;   // BJT, diode, L…: not detector classes (left unlabelled, as in AMSNet)
}

const idx = fs.openSync(`${OUT}/boxes-${si}.jsonl`, 'a');
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
      const page = getPage(doc);
      const png = await exportDocument(doc, page, { format: 'png', scale: 1 });
      const { scale: s, tx, ty, clipX, clipY } = png.mapping;
      const boxes = [];
      let skipped = 0;
      for (const c of allCells(page).map(cellInfo)) {
        if (c.kind !== 'vertex' || c.x == null) continue;
        const k = klass(c);
        if (k == null) { if (classify(c).role === 'component') skipped++; continue; }
        const pad = k === 'dot' ? 3 : 0;
        boxes.push([(c.x + tx) * s - clipX - pad, (c.y + ty) * s - clipY - pad,
          (c.x + c.w + tx) * s - clipX + pad, (c.y + c.h + ty) * s - clipY + pad, k]);
      }
      const name = `${si}-${++n}.png`;
      fs.writeFileSync(`${OUT}/${name}`, png.buffer);
      fs.writeSync(idx, JSON.stringify({ file: name, id: r.id, family: r.family, variant, boxes, unlabelled: skipped }) + '\n');
    } catch { /* skip */ }
  }
}
fs.closeSync(idx);
console.log(`shard ${si}: ${n} renders`);
process.exit(0);
