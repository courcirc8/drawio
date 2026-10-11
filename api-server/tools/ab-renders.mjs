#!/usr/bin/env node
/**
 * ab-renders.mjs — before / after renders of an auto SWITCH on chosen bank
 * circuits, for Eric's review page: "before" with <VAR>=0, "after" with the
 * default (the switch on). Reference figure when the bank has a clean one.
 * Usage: node tools/ab-renders.mjs --env AUTO_CS --on 1 --ids a,b,c --batch gabarit-cs [--note "…"]
 *        (--on V: "after" with <VAR>=V, for a switch off by default)
 * REVIEW_ROOT=/tmp/... to look first without touching the review page.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { compare } from '../lib/lvs.js';
import { exportDocument } from '../lib/render.js';
import { sealedStatus } from '../lib/sealed.js';
import { qualityGate } from '../lib/quality.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const VAR = arg('--env'), ON = arg('--on', null), IDS = (arg('--ids') || '').split(',').filter(Boolean), BATCH = arg('--batch', 'ab'), NOTE = arg('--note', '');
if (!VAR || !IDS.length) { console.error('usage: --env VAR --ids a,b'); process.exit(1); }
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

// ---- the circuits ------------------------------------------------------------
const man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
const fam = new Map(jsonl(`${B}/inventory.jsonl`).map((r) => [r.id, r]));
const draw = async (p, on) => {
  if (!on) process.env[VAR] = '0'; else if (ON != null) process.env[VAR] = ON; else delete process.env[VAR];
  const r = await autoPlace(p), m = getPage(r.doc);
  return { r, m, q: qualityGate(m, p), lvs: compare(extractNetlist(m), p).match };
};
const index = { batch: BATCH, created: new Date().toISOString(), note: NOTE || `${VAR} — avant / après (lecture seule)`, items: [] };
let k = 0;
for (const id of IDS) {
  const text = fs.readFileSync(man.get(id), 'utf8');
  if (sealedStatus(text)) { console.error('sealed, refused:', id); continue; }
  const p = parseSpice(/\.end\b/i.test(text) ? text : text + '\n.end');
  const a = await draw(p, false), b = await draw(p, true);
  k++;
  const ref = refOf(id);
  if (ref) writeRef(ref, `${OUT}/img/${k}-ref.png`);
  for (const [tag, d] of [['before', a], ['drawio', b]]) fs.writeFileSync(`${OUT}/img/${k}-${tag}.png`, (await exportDocument(d.r.doc, d.m, { format: 'png', scale: 1.6 })).buffer);
  const inv = fam.get(id) || {};
  index.items.push({ n: k, id, family: inv.family || '?', parts: inv.parts || p.components.length, refSource: ref ? ref.source : 'pas de figure de référence', ref: ref ? `img/${k}-ref.png` : null,
    before: `img/${k}-before.png`, drawio: `img/${k}-drawio.png`, engine: b.r.label, engineBefore: a.r.label, quality: b.q, qualityBefore: a.q, lvs: b.lvs, lvsBefore: a.lvs, metrics: {}, motifs: [], crossX: { pairs: 0, drawn: 0, refused: {} } });
  console.log(k, id, a.r.label, '->', b.r.label);
}
fs.writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
process.exit(0);
