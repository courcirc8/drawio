#!/usr/bin/env node
/**
 * xschem-renders.mjs — a review batch for Eric: for given bank circuits, the
 * reference figure, the draw.io drawing and xschem's OWN drawing of the
 * exported .sch (PDF without X, then PNG), each export checked by xschem's
 * netlister + LVS first (a failing one is skipped, never shown).
 * Usage: node tools/xschem-renders.mjs --ids a,b,c [--batch export-xschem]
 * REVIEW_ROOT=/tmp/... to look first without touching the review page.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseSpice } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { compare } from '../lib/lvs.js';
import { exportDocument } from '../lib/render.js';
import { sealedStatus } from '../lib/sealed.js';
import { exportXschem } from '../lib/export-xschem.js';
import { xschemNetlist, canonMos } from './xschem-check.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const IDS = (arg('--ids') || '').split(',').filter(Boolean), BATCH = arg('--batch', 'export-xschem');
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


const SIM = process.env.SIM_ROOT || path.join(os.homedir(), 'ClaudeCode/simulation'), PDK = `${SIM}/references/IHP-GmbH_IHP-Open-PDK`;
function xschemPng(sch, png) {
  const pdf = sch.replace(/\.sch$/, '.pdf');
  try { execFileSync(`${SIM}/opt/xschem/bin/xschem`, ['-q', '-x', '--rcfile', `${PDK}/ihp-sg13g2/libs.tech/xschem/xschemrc`, '--pdf', '--plotfile', pdf, sch],
    { env: { ...process.env, PDK_ROOT: PDK, PDK: 'ihp-sg13g2', PWD: path.dirname(sch) }, cwd: path.dirname(sch), stdio: 'pipe', timeout: 60000 }); } catch { /* the pdf decides */ }
  execFileSync('pdftoppm', ['-png', '-r', '110', '-singlefile', pdf, png.replace(/\.png$/, '')]);
}
const man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
const inv = new Map(jsonl(`${B}/inventory.jsonl`).map((r) => [r.id, r]));
const index = { batch: BATCH, created: new Date().toISOString(), note: 'export xschem (kit IHP SG13G2) — référence, dessin draw.io, dessin de xschem lui-même (lecture seule)', items: [] };
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xsr-'));
let k = 0;
for (const id of IDS) {
  const text = fs.readFileSync(man.get(id), 'utf8');
  if (sealedStatus(text)) { console.error('sealed, refused:', id); continue; }
  const p = parseSpice(/\.end\b/i.test(text) ? text : text + '\n.end');
  let x; try { x = await exportXschem(p); } catch (e) { console.error(id, 'not exported:', e.message); continue; }
  const sch = path.join(work, `${id.replace(/[^\w.-]+/g, '_')}.sch`); fs.writeFileSync(sch, x.sch);
  let lvs = false; try { const n = xschemNetlist(sch); lvs = compare({ components: canonMos(n.parsed, p).components, issues: [] }, canonMos(structuredClone(p))).match; } catch (e) { console.error(id, e.message); }
  if (!lvs) { console.error(id, 'xschem LVS failed: not shown'); continue; }
  const d = await autoPlace(p);
  k++;
  const ref = refOf(id); if (ref) writeRef(ref, `${OUT}/img/${k}-ref.png`);
  fs.writeFileSync(`${OUT}/img/${k}-before.png`, (await exportDocument(d.doc, getPage(d.doc), { format: 'png', scale: 1.6 })).buffer);
  xschemPng(sch, `${OUT}/img/${k}-drawio.png`);
  fs.copyFileSync(sch, `${OUT}/img/${k}.sch`);
  const r = inv.get(id) || {};
  index.items.push({ n: k, id, family: r.family || '?', parts: r.parts || p.components.length, refSource: ref ? ref.source : 'pas de figure de référence', ref: ref ? `img/${k}-ref.png` : null,
    before: `img/${k}-before.png`, drawio: `img/${k}-drawio.png`, engine: `xschem (${x.label})`, engineBefore: d.label,
    captionBefore: `draw.io (${d.label})`, captionAfter: `xschem — kit IHP SG13G2 (${x.label}, LVS xschem juste)`, metrics: {}, motifs: [], crossX: { pairs: 0, drawn: 0, refused: {} } });
  console.log(k, id, d.label, '->', x.label);
}
fs.writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
process.exit(0);
