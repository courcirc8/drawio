#!/usr/bin/env node
/**
 * ground-renders.mjs — a ground spelled vss / gnd drawn as ground
 * (lib/ground-alias.js), before / after, for Eric (orchestrator 2026-10-10).
 *   1. every bank circuit (3-25 parts, exclusions, sealed refused) whose deck
 *      has a single ground alias and no `0` is drawn by auto with AUTO_GND=0
 *      (as written) and with the alias: quality gate and LVS before / after;
 *   2. N of them with a clean reference figure (same rules as
 *      tools/template-renders.mjs), smallest first, among those the alias
 *      leaves no worse: reference, before and after PNG (/review/?batch=<out>).
 * Usage: node tools/ground-renders.mjs [--n 4] [--batch masse-vss] [--ids a,b]
 *        [--max 400]  (circuits measured, smallest first; 0 = all)
 *        [--allow-noref]  circuits without a reference figure too (the
 *        ground aliases are almost all openpdk decks, which have none)
 * REVIEW_ROOT=/tmp/... to measure without touching the review page.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { compare } from '../lib/lvs.js';
import { exportDocument } from '../lib/render.js';
import { bankExclusions, sealedStatus } from '../lib/sealed.js';
import { qualityGate } from '../lib/quality.js';
import { groundAlias } from '../lib/ground-alias.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const NOREF = argv.includes('--allow-noref');
const IDS = arg('--ids') ? new Set(arg('--ids').split(',')) : null;
const N = Number(arg('--n', 4)), BATCH = arg('--batch', 'masse-vss'), MAX = Number(arg('--max', 400));
const ROOT = process.env.REVIEW_ROOT || '/AI/datasets/judge/review', OUT = `${ROOT}/${BATCH}`;
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(`${OUT}/img`, { recursive: true });
const B = '/AI/datasets/netlists/bank';
const jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
// ---- reference figures (same rules as tools/template-renders.mjs) ----------
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
let AG = null;
const agCount = () => {
  if (AG) return AG; AG = new Map();
  const D = '/AI/datasets/netlists/AnalogGenie/Dataset';
  for (const d of fs.readdirSync(D)) { const f = `${D}/${d}/Book${d}.png`; if (fs.existsSync(f)) { const h = md5(f); AG.set(h, (AG.get(h) || 0) + 1); } }
  return AG;
};
const dupRefs = (cir) => { const r = fs.readFileSync(cir, 'utf8').split('\n').filter((l) => /^[MQRCLDX]/i.test(l)).map((l) => l.split(/\s+/)[0].toUpperCase()); return new Set(r).size !== r.length; };
const AMS_ZIP = '/AI/datasets/netlists/ams.net.github.io/amsnet_1.0-20240412T024532Z-001.zip';
let AMS = null;
const amsZip = () => (AMS ??= fs.existsSync(AMS_ZIP) ? execFileSync('python3', ['-c', 'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', AMS_ZIP], { maxBuffer: 64 << 20 }).toString().split('\n') : []);
function refOf(id) {
  const src = id.slice(0, id.indexOf('/')), key = id.slice(id.indexOf('/') + 1);
  if (src === 'analoggenie') {
    const f = `/AI/datasets/netlists/AnalogGenie/Dataset/${key}/Book${key}.png`;
    if (!fs.existsSync(f) || agCount().get(md5(f)) > 1 || dupRefs(`/AI/datasets/netlists/AnalogGenie/Dataset/${key}/${key}.cir`)) return null;
    return { file: f, source: 'AnalogGenie' };
  }
  if (src === 'amsnet') {
    const name = amsZip().find((n) => n === `amsnet_1.0/${key}/${key}.jpg` || n === `amsnet_1.0/${key}/${key}.png`);
    return name ? { zip: name, source: 'AMSNet' } : null;
  }
  return null;
}
const toPng = (pyExpr, ...a) => execFileSync('python3', ['-c', `import sys,io,zipfile;from PIL import Image;b=io.BytesIO();${pyExpr}.convert("RGB").save(b,"PNG");sys.stdout.buffer.write(b.getvalue())`, ...a], { maxBuffer: 64 << 20 });
function writeRef(ref, out) {
  if (ref.zip) fs.writeFileSync(out, toPng('Image.open(io.BytesIO(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2])))', AMS_ZIP, ref.zip));
  else fs.writeFileSync(out, ref.file.endsWith('.png') ? fs.readFileSync(ref.file) : toPng('Image.open(sys.argv[1])', ref.file));
}

// ---- the circuits with a lone ground alias ---------------------------------
const ex = bankExclusions(B);
const man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
const inv = jsonl(`${B}/inventory.jsonl`).filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && r.parts >= 3 && r.parts <= 25 && (!IDS || IDS.has(r.id)))
  .sort((u, v) => u.parts - v.parts || (u.id < v.id ? -1 : 1));
const fails = (q) => Object.values(q.checks).filter((c) => !c.ok).length;
const draw = async (p, on) => {
  process.env.AUTO_GND = on ? '1' : '0';
  const r = await autoPlace(p), m = getPage(r.doc);
  return { r, m, q: qualityGate(m, p), lvs: compare(extractNetlist(m), p).match };
};
const rows = [];
for (const r of inv) {
  if (MAX && rows.length >= MAX) break;
  let text; try { text = fs.readFileSync(man.get(r.id), 'utf8'); } catch { continue; }
  if (sealedStatus(text)) continue;
  let p; try { p = parseSpice(/\.end\b/i.test(text) ? text : text + '\n.end'); } catch { continue; }
  const alias = groundAlias(p.components.flatMap((c) => c.fullNodes || c.nodes || []));
  if (alias == null) continue;
  try {
    const a = await draw(p, false), b = await draw(p, true);
    rows.push({ id: r.id, family: r.family, parts: r.parts, alias, a, b });
  } catch (e) { console.error(r.id, e.message); }
}
const count = (f) => rows.filter(f).length;
const summary = {
  circuits: rows.length,
  gateBefore: count((x) => x.a.q.pass), gateAfter: count((x) => x.b.q.pass),
  lvsBefore: count((x) => x.a.lvs), lvsAfter: count((x) => x.b.lvs),
  failsBefore: rows.reduce((n, x) => n + fails(x.a.q), 0), failsAfter: rows.reduce((n, x) => n + fails(x.b.q), 0),
  better: count((x) => fails(x.b.q) < fails(x.a.q)), worse: count((x) => fails(x.b.q) > fails(x.a.q)),
  aliases: rows.reduce((o, x) => ((o[x.alias.toLowerCase()] = (o[x.alias.toLowerCase()] || 0) + 1), o), {}),
};
fs.writeFileSync(`${OUT}/rows.jsonl`, rows.map((x) => JSON.stringify({ id: x.id, parts: x.parts, alias: x.alias, before: { pass: x.a.q.pass, fails: fails(x.a.q), lvs: x.a.lvs, engine: x.a.r.label }, after: { pass: x.b.q.pass, fails: fails(x.b.q), lvs: x.b.lvs, engine: x.b.r.label } })).join('\n') + '\n');
// ---- renders for Eric: clean reference, the alias no worse, smallest first
const index = { batch: BATCH, created: new Date().toISOString(), note: 'masse vss/gnd dessinée comme masse — rendus avant / après pour Eric (lecture seule)', summary, items: [] };
let k = 0;
// those the alias brings through the gate first, then the smallest
for (const x of rows.filter((x) => IDS || (fails(x.b.q) <= fails(x.a.q) && x.b.lvs)).sort((u, v) => (v.b.q.pass - v.a.q.pass) - (u.b.q.pass - u.a.q.pass) || u.parts - v.parts)) {
  if (k >= N) break;
  const ref = refOf(x.id); if (!ref && !NOREF) continue;
  k++;
  if (ref) writeRef(ref, `${OUT}/img/${k}-ref.png`);
  for (const [tag, d] of [['before', x.a], ['drawio', x.b]]) fs.writeFileSync(`${OUT}/img/${k}-${tag}.png`, (await exportDocument(d.r.doc, d.m, { format: 'png', scale: 1.6 })).buffer);
  index.items.push({ n: k, id: x.id, family: x.family, parts: x.parts, refSource: ref ? ref.source : 'pas de figure de référence', ref: ref ? `img/${k}-ref.png` : null, before: `img/${k}-before.png`, drawio: `img/${k}-drawio.png`,
    engine: x.b.r.label, engineBefore: x.a.r.label, quality: x.b.q, qualityBefore: x.a.q, metrics: {}, motifs: ['masse'], crossX: { pairs: 0, drawn: 0, refused: {} } });
}
fs.writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
console.log(JSON.stringify(summary), `; ${index.items.length} rendus -> ${OUT}`);
process.exit(0);
