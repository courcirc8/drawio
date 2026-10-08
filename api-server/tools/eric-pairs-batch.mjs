#!/usr/bin/env node
/**
 * eric-pairs-batch.mjs — blind batch for /compare (served as /eric-paires):
 * "auto d'avant" (no sa, check.js referee) against "auto d'aujourd'hui", on the
 * circuits where Ornith hesitated in the pairwise judgement (judge-pairs.mjs
 * runs /AI/datasets/judge/pairs3-*: order-inconsistent answers): small RF
 * (oscillator / VCO, filter, LNA) and large power / regulator circuits. Never a sealed
 * circuit or a variant (lib/sealed.js, strict form), never a circuit already
 * shown in an earlier batch; sides shuffled; only pairs drawn by a different
 * engine or mode (not a mere spacing change).
 * Usage: node tools/eric-pairs-batch.mjs --batch eric-paires [--seed 8]
 *        [--quota oscillator:2,filter:2,lna:2,power:2,regulator:2]
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getPage } from '../lib/model.js';
import { parseSpice } from '../lib/netlist.js';
import { autoPlace } from '../lib/auto.js';
import { exportDocument } from '../lib/render.js';
import { assertNotSealed, bankExclusions } from '../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BATCH = arg('--batch', 'eric-paires');
const QUOTA = Object.fromEntries(arg('--quota', 'oscillator:2,filter:2,lna:2,power:2,regulator:2').split(',').map((q) => { const [f, n] = q.split(':'); return [f, Number(n)]; }));
let seed = Number(arg('--seed', 8));
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const BANK = '/AI/datasets/netlists/bank', JUDGE = '/AI/datasets/judge';
const ROOT = process.env.COMPARE_ROOT || `${JUDGE}/compare`, OUT = `${ROOT}/${BATCH}`;
if (fs.existsSync(OUT)) { console.error(`${OUT} exists: refusing to overwrite a batch`); process.exit(1); }

const jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const man = new Map(fs.readdirSync(BANK).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${BANK}/${f}`)).map((r) => [r.id, r]));
const shown = new Set(fs.readdirSync(ROOT).flatMap((d) => (fs.existsSync(`${ROOT}/${d}/items.jsonl`) ? jsonl(`${ROOT}/${d}/items.jsonl`).map((x) => x.id) : [])));
const ex = bankExclusions(BANK);
const judged = fs.readdirSync(JUDGE).filter((f) => /^pairs3-.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${JUDGE}/${f}`));
// hesitation first (order-inconsistent), then the circuits Ornith decided (a
// family short of hesitations: VCO, filter); large circuits first for power / regulator
const big = new Set(['power', 'regulator']);
const tier = (r) => (r.prefers === 'inconsistent' ? 0 : 1);
// REFERENCE FIGURE (Eric 2026-10-08): the figure each netlist was read from is
// shown first — DVD readings: the figure cropped from the IEEE page by the RAG
// (rag.extract.figures crop) with the article's citation; AnalogGenie / AMSNet:
// the source image of the textbook schematic. Only circuits WITH a reference are
// kept (--need-ref 0 to allow none). A DVD reading must look like a circuit
// (5+ parts, 2+ transistors): some readings are not real circuits.
const NEED_REF = arg('--need-ref', '1') !== '0';
const RAG = `${process.env.HOME}/ClaudeCode/local_AI/rag`;
const NATIF = '/AI/datasets/IEEE/derived/schemas-natif-2026-10-08.jsonl';
const natif = new Map();
if (fs.existsSync(NATIF)) for (const r of jsonl(NATIF)) natif.set('dvd-natif/' + `${r.paper_id}_p${r.page}_r${r.rang}`.replace(/[^A-Za-z0-9]+/g, '_'), r);
function refOf(id) {
  const [src, key] = [id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)];
  if (src === 'dvd-natif' && natif.has(id)) { const r = natif.get(id); return { kind: 'ieee', paper_id: r.paper_id, page: r.page, rang: r.rang, legende: r.legende || '' }; }
  if (src === 'analoggenie') {
    const f = `/AI/datasets/netlists/AnalogGenie/Dataset/${key}/Book${key}.png`;
    if (!fs.existsSync(f)) return null;
    let pg = ''; try { pg = fs.readFileSync(`/AI/datasets/netlists/AnalogGenie/Dataset/${key}/Pagenumber${key}.txt`, 'utf8').trim(); } catch { /* none */ }
    return { kind: 'livre', file: f, cite: analogGenieCite(pg) };
  }
  if (src === 'amsnet') {
    const f = `/AI/datasets/netlists/ams.net.github.io/x/amsnet_1.0/${key}/${key}.jpg`;
    return fs.existsSync(f) ? { kind: 'livre', file: f, cite: `Figure d'origine du jeu AMSNet n° ${key} (schéma de manuel) — pas d'article de référence.` } : null;
  }
  return null;
}
// AnalogGenie's Pagenumber<n>.txt holds a textbook page number OR the article's
// full citation (keywords dropped here)
export function analogGenieCite(pg) {
  if (!pg) return "Figure d'origine du jeu AnalogGenie (source non indiquée).";
  if (/^\d+$/.test(pg)) return `Figure d'origine du jeu AnalogGenie : schéma de manuel, page ${pg} (pas d'article de référence).`;
  return `${pg.replace(/\s*keywords:.*$/s, '').replace(/,\s*$/, '')} — figure d'origine du jeu AnalogGenie.`;
}
const looksReal = (r) => !r.id.startsWith('dvd-natif/') || (r.parts >= 5 && (fs.readFileSync(man.get(r.id).file, 'utf8').match(/^[MQ]/gim) || []).length >= 2);
const pool = judged.filter((r) => QUOTA[r.family] && ['inconsistent', 'auto', 'auto-old'].includes(r.prefers) && man.has(r.id) && !shown.has(r.id) && !ex.has(r.id)
  && (!NEED_REF || refOf(r.id)) && looksReal(r))
  .sort((a, b) => tier(a) - tier(b) || ((refOf(b.id) || {}).kind === 'ieee') - ((refOf(a.id) || {}).kind === 'ieee') || (big.has(a.family) ? b.parts - a.parts : a.id < b.id ? -1 : 1));

/** Writes img/<n>-ref.png and returns the citation shown with it (null: no reference). */
async function writeRef(id, out) {
  const ref = refOf(id);
  if (!ref) return null;
  if (ref.kind === 'ieee') {
    execFileSync(`${RAG}/.venv/bin/python`, ['-m', 'rag.extract.figures', 'crop', ref.paper_id, String(ref.page), String(ref.rang), out], { cwd: RAG, stdio: 'ignore', timeout: 120000 });
    const a = await (await fetch(`http://127.0.0.1:8790/api/article?id=${encodeURIComponent(ref.paper_id)}`)).json();
    return { kind: 'ieee', paper_id: ref.paper_id, page: ref.page, rang: ref.rang, legende: ref.legende, title: a.title, venue: a.venue, year: a.year, authors: a.authors, img: true };
  }
  const buf = fs.readFileSync(ref.file);
  fs.writeFileSync(out, ref.file.endsWith('.png') ? buf : await sharpToPng(ref.file));
  return { kind: ref.kind, cite: ref.cite, img: true };
}
async function sharpToPng(f) {   // AMSNet images are JPEG: converted with PIL (always on the station)
  return execFileSync('python3', ['-c', 'import sys,io;from PIL import Image;b=io.BytesIO();Image.open(sys.argv[1]).save(b,"PNG");sys.stdout.buffer.write(b.getvalue())', f], { maxBuffer: 64 << 20 });
}

async function draw(p, old) {
  const keep = [process.env.AUTO_SA, process.env.AUTO_JUDGE];
  if (old) { process.env.AUTO_SA = '0'; process.env.AUTO_JUDGE = 'js'; }
  try { const res = await autoPlace(p); return { label: res.label, png: (await exportDocument(res.doc, getPage(res.doc), { format: 'png', scale: 1.5 })).buffer }; }
  finally { for (const [k, v] of [['AUTO_SA', keep[0]], ['AUTO_JUDGE', keep[1]]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

fs.mkdirSync(`${OUT}/img`, { recursive: true });
const items = [], got = {};
for (const r of pool) {
  if ((got[r.family] || 0) >= QUOTA[r.family]) continue;
  const text = fs.readFileSync(man.get(r.id).file, 'utf8');
  try { assertNotSealed(text, r.id, { family: null }); } catch { continue; }
  const p = parseSpice(text);
  let before, after;
  try { before = await draw(p, true); after = await draw(p, false); } catch { continue; }
  // a pair must differ VISIBLY: another engine (v2 / v4 / sa), or a clearly
  // different sheet shape (aspect ratios 15 % apart), or another v4 mode on a
  // circuit of 20+ parts; a spacing-only change says little to the eye
  const eng = (l) => l.split(/[:@+]/)[0], mode = (l) => l.replace(/@.*$/, '');
  const ar = (png) => png.readUInt32BE(16) / png.readUInt32BE(20);   // PNG IHDR width / height
  const visible = eng(before.label) !== eng(after.label) || Math.abs(Math.log(ar(before.png) / ar(after.png))) > 0.15
    || (mode(before.label) !== mode(after.label) && r.parts >= 20);
  if (Buffer.compare(before.png, after.png) === 0 || !visible) continue;
  const n = items.length + 1, newLeft = rnd() < 0.5;
  let ref = null;
  try { ref = await writeRef(r.id, `${OUT}/img/${n}-ref.png`); } catch { ref = null; }
  if (NEED_REF && !ref) continue;
  fs.writeFileSync(`${OUT}/img/${n}-L.png`, newLeft ? after.png : before.png);
  fs.writeFileSync(`${OUT}/img/${n}-R.png`, newLeft ? before.png : after.png);
  items.push({ n, id: r.id, family: r.family, parts: r.parts, ornith: r.prefers, ref, sides: { L: newLeft ? 'new' : 'base', R: newLeft ? 'base' : 'new' }, labels: { base: before.label, new: after.label } });
  got[r.family] = (got[r.family] || 0) + 1;
}
// interleave families so the page does not show five VCOs in a row
const order = items.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).map(([, x], i) => ({ x, n: i + 1 }));
for (const { x, n } of order) {
  for (const s of ['L', 'R', 'ref']) if (fs.existsSync(`${OUT}/img/${x.n}-${s}.png`)) fs.renameSync(`${OUT}/img/${x.n}-${s}.png`, `${OUT}/img/tmp-${n}-${s}.png`);
}
for (const { n } of order) for (const s of ['L', 'R', 'ref']) if (fs.existsSync(`${OUT}/img/tmp-${n}-${s}.png`)) fs.renameSync(`${OUT}/img/tmp-${n}-${s}.png`, `${OUT}/img/${n}-${s}.png`);
fs.writeFileSync(`${OUT}/items.jsonl`, order.map(({ x, n }) => JSON.stringify({ ...x, n })).join('\n') + '\n');
console.log(`${items.length} pairs -> ${OUT}`, got);
process.exit(0);
