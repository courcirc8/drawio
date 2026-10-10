#!/usr/bin/env node
/**
 * template-renders.mjs — a placement TEMPLATE before Eric switches it on
 * (orchestrator 2026-10-09: "pour chaque gabarit, 3-4 rendus référence +
 * avant + après ; c'est son « oui » qui active").
 *   1. every bank circuit (3-25 parts, exclusions, sealed refused) the template
 *      recognises is drawn by auto WITHOUT and WITH the template: how often the
 *      template is elected, quality gate (lib/quality.js) and LVS before / after;
 *   2. N of them with a clean reference figure (AMSNet / AnalogGenie, as
 *      tools/review-batch.mjs), the smallest first: reference, before and after
 *      PNG, served read-only by lib/review.js (/review/?batch=<out>).
 * Usage: node tools/template-renders.mjs --engine ota [--n 4] [--batch gabarit-ota]
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
import { otaReading } from '../lib/place-ota.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ENGINE = arg('--engine', 'ota'), N = Number(arg('--n', 4)), BATCH = arg('--batch', `gabarit-${ENGINE}`);
const READ = { ota: otaReading }[ENGINE];
const ENV = { ota: 'AUTO_OTA' }[ENGINE];
if (!READ) { console.error('unknown template ' + ENGINE); process.exit(1); }
const ROOT = process.env.REVIEW_ROOT || '/AI/datasets/judge/review', OUT = `${ROOT}/${BATCH}`;
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(`${OUT}/img`, { recursive: true });
const B = '/AI/datasets/netlists/bank';
const jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
// ---- reference figures (same rules as tools/eric-pairs-batch.mjs) ----------
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
  if (ref.png) fs.copyFileSync(ref.png, out);
  else if (ref.zip) fs.writeFileSync(out, toPng('Image.open(io.BytesIO(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2])))', AMS_ZIP, ref.zip));
  else fs.writeFileSync(out, ref.file.endsWith('.png') ? fs.readFileSync(ref.file) : toPng('Image.open(sys.argv[1])', ref.file));
}

// ---- the circuits the template recognises ----------------------------------
const ex = bankExclusions(B);
const man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
const inv = jsonl(`${B}/inventory.jsonl`).filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && r.parts >= 3 && r.parts <= 25);
const draw = async (p, on) => {
  process.env[ENV] = on ? '1' : '0';
  const r = await autoPlace(p), m = getPage(r.doc);
  return { r, m, q: qualityGate(m, p), lvs: compare(extractNetlist(m), p).match };
};
const rows = [];
for (const r of inv) {
  let text; try { text = fs.readFileSync(man.get(r.id), 'utf8'); } catch { continue; }
  if (sealedStatus(text)) continue;
  let p; try { p = parseSpice(/\.end\b/i.test(text) ? text : text + '\n.end'); } catch { continue; }
  if (!READ(p)) continue;
  try {
    const a = await draw(p, false), b = await draw(p, true);
    rows.push({ id: r.id, family: r.family, parts: r.parts, p, a, b, elected: b.r.label === ENGINE });
  } catch (e) { console.error(r.id, e.message); }
}
const count = (f) => rows.filter(f).length;
const summary = {
  circuits: rows.length, elected: count((x) => x.elected),
  gateBefore: count((x) => x.a.q.pass), gateAfter: count((x) => x.b.q.pass),
  lvsBefore: count((x) => x.a.lvs), lvsAfter: count((x) => x.b.lvs),
};
// ---- renders for Eric: clean reference, smallest first, the template elected
const index = { batch: BATCH, created: new Date().toISOString(), note: `gabarit ${ENGINE} — rendus avant / après pour Eric (lecture seule)`, summary, items: [] };
let k = 0;
// those the template improves first (old drawing refused by the gate), then the smallest
for (const x of rows.filter((x) => x.elected && x.b.q.pass).sort((u, v) => (u.a.q.pass - v.a.q.pass) || u.parts - v.parts || (u.id < v.id ? -1 : 1))) {
  if (k >= N) break;
  const ref = refOf(x.id); if (!ref) continue;
  k++;
  writeRef(ref, `${OUT}/img/${k}-ref.png`);
  for (const [tag, d] of [['before', x.a], ['drawio', x.b]]) fs.writeFileSync(`${OUT}/img/${k}-${tag}.png`, (await exportDocument(d.r.doc, d.m, { format: 'png', scale: 1.6 })).buffer);
  index.items.push({ n: k, id: x.id, family: x.family, parts: x.parts, refSource: ref.source, ref: `img/${k}-ref.png`, before: `img/${k}-before.png`, drawio: `img/${k}-drawio.png`,
    engine: x.b.r.label, engineBefore: x.a.r.label, quality: x.b.q, qualityBefore: x.a.q, metrics: {}, motifs: [ENGINE], crossX: { pairs: 0, drawn: 0, refused: {} } });
}
fs.writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
console.log(JSON.stringify(summary), `; ${index.items.length} rendus -> ${OUT}`);
process.exit(0);
