#!/usr/bin/env node
/**
 * rails-renders.mjs — before / after renders of the rail modes for Eric
 * (lib/rails.js): the circuits of an existing review set (reference figures
 * already there), drawn with AUTO_RAILS=off (before) and the given mode (after).
 * Usage: node tools/rails-renders.mjs --from gabarit-ota-2,review-2 [--n 6] [--mode rail] [--batch rails-1]
 */
import fs from 'node:fs';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { compare } from '../lib/lvs.js';
import { exportDocument } from '../lib/render.js';
import { qualityGate } from '../lib/quality.js';
import { sealedStatus } from '../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = arg('--from', 'gabarit-ota-2,review-2').split(','), N = Number(arg('--n', 6)), MODE = arg('--mode', 'rail'), BATCH = arg('--batch', `rails-${MODE}`);
const ROOT = process.env.REVIEW_ROOT || '/AI/datasets/judge/review', OUT = `${ROOT}/${BATCH}`;
const B = '/AI/datasets/netlists/bank';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(`${OUT}/img`, { recursive: true });
const jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
const lect = new Map();
for (const d of ['/AI/datasets/judge/lectures-hors-file/lectures-3']) if (fs.existsSync(`${d}/items.jsonl`)) for (const x of jsonl(`${d}/items.jsonl`)) lect.set(`lecture/${x.key}`, x.netlist);
const index = { batch: BATCH, created: new Date().toISOString(), note: `rails « ${MODE} » — avant / après pour Eric (lecture seule)`, items: [] };
let k = 0;
for (const src of FROM) {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/${src}/index.json`, 'utf8'));
  for (const it of j.items) {
    if (k >= N) break;
    const text = lect.get(it.id) ?? (man.has(it.id) ? fs.readFileSync(man.get(it.id), 'utf8') : null);
    if (!text || sealedStatus(text)) continue;
    const p = parseSpice(/\.end\b/i.test(text) ? text : text + '\n.end');
    const draw = async (mode) => { process.env.AUTO_RAILS = mode; const r = await autoPlace(p), m = getPage(r.doc); return { r, m, q: qualityGate(m, p), lvs: compare(extractNetlist(m), p).match }; };
    const a = await draw('off'), b = await draw(MODE);
    k++;
    fs.copyFileSync(`${ROOT}/${src}/${it.ref}`, `${OUT}/img/${k}-ref.png`);
    fs.writeFileSync(`${OUT}/img/${k}-before.png`, (await exportDocument(a.r.doc, a.m, { format: 'png', scale: 1.6 })).buffer);
    fs.writeFileSync(`${OUT}/img/${k}-drawio.png`, (await exportDocument(b.r.doc, b.m, { format: 'png', scale: 1.6 })).buffer);
    index.items.push({ n: k, id: it.id, family: it.family, parts: it.parts, refSource: it.refSource, ref: `img/${k}-ref.png`, before: `img/${k}-before.png`, drawio: `img/${k}-drawio.png`,
      engine: b.r.label, engineBefore: a.r.label + ' (rails non redessinés)', quality: b.q, qualityBefore: a.q, lvs: b.lvs, metrics: {}, motifs: [], crossX: { pairs: 0, drawn: 0, refused: {} } });
    console.error(`${k} ${it.id} lvs ${a.lvs}/${b.lvs}`);
  }
}
fs.writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
console.log(`${index.items.length} rendus -> ${OUT}`);
process.exit(0);
