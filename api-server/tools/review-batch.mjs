#!/usr/bin/env node
/**
 * review-batch.mjs — a READ-ONLY review set for the orchestrator (Eric
 * 2026-10-09: the orchestrator reviews ~50 drawings himself: missing rules,
 * rules that did not work, missing mechanisms). Nothing is shown to Eric.
 *
 * Circuits of 3-25 parts WITH a clean reference figure, varied families:
 *   - bank: AMSNet (figure in the release zip) and AnalogGenie (figure with a
 *     unique image and no duplicate instance names, as tools/eric-pairs-batch.mjs);
 *   - a few Claude readings of IEEE figures (a readings batch, its ref PNGs),
 *     the CICC 2007 comparator first.
 * Each drawn by auto AS IT IS; per circuit: reference PNG, drawio PNG (≥ 1200 px
 * wide), elected engine, metrics (bends / wire, avoidable bends, crossings,
 * wire per part, aspect, severe errors, check.py rules, motifs and stages read,
 * cross-coupled X drawn or refused and why, quality gate of lib/quality.js).
 * Served by lib/review.js under /review/<batch>/ (index.json + img/).
 * Usage: node tools/review-batch.mjs [--batch review-1] [--n 50] [--readings DIR,DIR]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage, serialize, allCells, cellInfo } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { compare } from '../lib/lvs.js';
import { exportDocument } from '../lib/render.js';
import { bankExclusions, sealedStatus } from '../lib/sealed.js';
import { detectMotifs } from '../lib/motifs.js';
import { analyseStages } from '../lib/stages.js';
import { avoidableBends } from '../lib/straighten.js';
import { qualityGate } from '../lib/quality.js';
import { pinAbs } from '../lib/route.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BATCH = arg('--batch', 'review-1'), N = Number(arg('--n', 50));
const READINGS = arg('--readings', '/AI/datasets/judge/lectures-hors-file/lectures-3').split(',').filter(Boolean);
const NREAD = Number(arg('--n-readings', 4));
const ROOT = process.env.REVIEW_ROOT || '/AI/datasets/judge/review', OUT = `${ROOT}/${BATCH}`;
if (fs.existsSync(OUT)) { console.error(`${OUT} exists: refusing to overwrite`); process.exit(1); }
fs.mkdirSync(`${OUT}/img`, { recursive: true });
const HERE = path.dirname(new URL(import.meta.url).pathname);
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

// ---- the pool --------------------------------------------------------------
// the families asked for, with their quota (bank family labels)
const QUOTA = { comparator: 5, opamp: 6, amplifier: 5, 'mirror-bias': 4, lna: 3, LNA: 1, VCO: 3, oscillator: 2, pll: 3, regulator: 4, reference: 4, filter: 3, mixer: 2, pa: 1 };
const ex = bankExclusions(B);
const man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
const inv = jsonl(`${B}/inventory.jsonl`).filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && r.parts >= 3 && r.parts <= 25 && /^(amsnet|analoggenie)\//.test(r.id) && QUOTA[r.family]);
// deterministic order: a hash of the id
const h = (s) => crypto.createHash('md5').update(s).digest('hex');
inv.sort((a, b) => (h(a.id) < h(b.id) ? -1 : 1));
const picked = [];
// readings first (the CICC 2007 comparator Eric refused, then others drawn LVS-clean)
for (const dir of READINGS) {
  if (!fs.existsSync(`${dir}/items.jsonl`)) continue;
  const its = jsonl(`${dir}/items.jsonl`).filter((x) => x.lvs !== false && fs.existsSync(`${dir}/img/${x.n}-ref.png`));
  its.sort((a, b) => (/0333shei/.test(b.key) ? 1 : 0) - (/0333shei/.test(a.key) ? 1 : 0) || a.n - b.n);
  for (const x of its) {
    if (picked.length >= NREAD) break;
    if (sealedStatus(x.netlist)) continue;
    picked.push({ id: `lecture/${x.key}`, family: 'lecture IEEE', text: x.netlist, ref: { png: `${dir}/img/${x.n}-ref.png`, source: 'lecture Claude (IEEE)' } });
  }
}
const got = {};
for (const r of inv) {
  if (picked.length >= N) break;
  if ((got[r.family] || 0) >= QUOTA[r.family]) continue;
  const ref = refOf(r.id); if (!ref) continue;
  let text; try { text = fs.readFileSync(man.get(r.id), 'utf8'); } catch { continue; }
  if (sealedStatus(text)) continue;
  got[r.family] = (got[r.family] || 0) + 1;
  picked.push({ id: r.id, family: r.family, text, ref });
}

// ---- drawing and metrics ---------------------------------------------------
const check = (doc) => {
  const f = path.join(os.tmpdir(), `review-${process.pid}.drawio`); fs.writeFileSync(f, serialize(doc));
  try { return JSON.parse(spawnSync('python3', [path.join(HERE, 'check.py'), f, '--json'], { encoding: 'utf8', timeout: 120000 }).stdout); } catch { return null; } finally { fs.rmSync(f, { force: true }); }
};
const SEVERE = new Set(['comp-overlap', '22-contact', 'through', '22', 'double-line', '14']);
function geometry(m) {
  const cs = allCells(m).map(cellInfo), byId = new Map(cs.map((c) => [c.id, c]));
  const edges = cs.filter((c) => c.kind === 'edge' && byId.has(c.source) && byId.has(c.target));
  let bends = 0, len = 0;
  for (const e of edges) {
    const pin = (c, pre) => pinAbs(c, { x: Number(e.style.map.get(pre + 'X') ?? 0.5), y: Number(e.style.map.get(pre + 'Y') ?? 0.5) });
    const pts = [pin(byId.get(e.source), 'exit'), ...e.points, pin(byId.get(e.target), 'entry')];
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (e.style.map.get('drawioApiCrossX') === '1') continue;
    for (let i = 1; i < pts.length - 1; i++) { const h1 = Math.abs(pts[i].y - pts[i - 1].y) < 0.5, h2 = Math.abs(pts[i + 1].y - pts[i].y) < 0.5; if (h1 !== h2) bends++; }
  }
  const vs = cs.filter((c) => c.kind === 'vertex' && c.x != null);
  const W = Math.max(...vs.map((c) => c.x + c.w)) - Math.min(...vs.map((c) => c.x)), H = Math.max(...vs.map((c) => c.y + c.h)) - Math.min(...vs.map((c) => c.y));
  return { wires: edges.length, bends, len, aspect: Math.max(W, H) / Math.max(1, Math.min(W, H)), W };
}
const index = { batch: BATCH, created: new Date().toISOString(), note: 'lecture seule — revue de l\'orchestrateur ; rien de ceci n\'est montré à Eric', items: [] };
let k = 0;
for (const it of picked) {
  k++;
  let p; try { p = parseSpice(/\.end\b/i.test(it.text) ? it.text : it.text + '\n.end'); } catch (e) { console.error(`${it.id}: ${e.message}`); continue; }
  const t0 = Date.now();
  let r; try { r = await autoPlace(p); } catch (e) { console.error(`${it.id}: ${e.message}`); continue; }
  const ms = Date.now() - t0, m = getPage(r.doc);
  const g = geometry(m), chk = check(r.doc) || { violations: [] };
  const rules = {}; for (const v of chk.violations || []) if (v.severity === 'error') rules[v.rule] = (rules[v.rule] || 0) + 1;
  let motifs = []; try { motifs = [...new Set(detectMotifs(p).instances.map((i) => i.motif))]; } catch { /* none */ }
  let stages = null; try { const a = analyseStages(p); stages = { n: a.stages.length, coverage: +(a.coverage.partsInStage / Math.max(1, a.coverage.parts)).toFixed(2) }; } catch { /* none */ }
  const q = qualityGate(m, p);
  writeRef(it.ref, `${OUT}/img/${k}-ref.png`);
  const scale = Math.max(1.5, 1250 / Math.max(1, g.W));
  fs.writeFileSync(`${OUT}/img/${k}-drawio.png`, (await exportDocument(r.doc, m, { format: 'png', scale })).buffer);
  const crossCoupled = (() => { try { return detectMotifs(p).instances.filter((i) => i.motif === 'cross-coupled-pair').length; } catch { return 0; } })();
  index.items.push({
    n: k, id: it.id, family: it.family, parts: p.components.length, refSource: it.ref.source,
    ref: `img/${k}-ref.png`, drawio: `img/${k}-drawio.png`,
    engine: r.label, ms, lvs: compare(extractNetlist(m), p).match,
    metrics: {
      bendsPerWire: +(g.bends / Math.max(1, g.wires)).toFixed(2), bends: g.bends, avoidableBends: avoidableBends(m).bends,
      crossings: chk.crossings ?? null, wirePerPart: Math.round(g.len / Math.max(1, p.components.length)), aspect: +g.aspect.toFixed(2),
      checkErrors: chk.errors ?? null, severe: Object.entries(rules).filter(([k2]) => SEVERE.has(k2)).reduce((s, [, v]) => s + v, 0), rules,
    },
    motifs, stages,
    crossX: { pairs: crossCoupled, drawn: r.polish?.crossX?.drawn ?? 0, refused: r.polish?.crossX?.why ?? {} },
    quality: q,
    candidates: Object.fromEntries(Object.entries(r.trials || {}).map(([lab, t]) => [lab, { severe: t.severe, aspect: t.aspect && +t.aspect.toFixed(2), bends: t.bends && +t.bends.toFixed(2), wire: t.wire && Math.round(t.wire), errors: t.errors }])),
  });
  console.error(`${k}/${picked.length} ${it.id} ${it.family} ${p.components.length} comp. -> ${r.label} qualité ${q.pass ? 'OK' : 'non'}`);
}
fs.writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
console.log(`${index.items.length} circuits -> ${OUT}/index.json ; familles ${JSON.stringify(got)} ; porte qualité passée ${index.items.filter((x) => x.quality.pass).length}`);
process.exit(0);
