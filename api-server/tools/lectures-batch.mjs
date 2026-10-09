#!/usr/bin/env node
/**
 * lectures-batch.mjs — builds a batch for /eric-lectures (lib/verify.js): Eric
 * checks readings of IEEE DVD figures (Eric 2026-10-09: readings made by
 * Claude for the RAG session). For each reading: the figure cropped by the
 * RAG (rag.extract.figures crop) with its citation, the drawing drawio makes
 * from the netlist read (engine auto as served, LVS reported), the netlist
 * text. The readings stay OUT of every measurement until Eric's verdict (they
 * are not in the bank); a netlist matching a sealed circuit is refused.
 *
 * Input: JSONL, one reading per line, with paper_id, page (from 1), rang (from
 * 0) and the netlist as SPICE text in `netlist` (or `spice`); optional legende.
 * Usage: node tools/lectures-batch.mjs --src FILE.jsonl [--batch lectures-1]
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getPage } from '../lib/model.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { exportDocument } from '../lib/render.js';
import { sealedStatus } from '../lib/sealed.js';
import { straighten, avoidableBends, checkerErrors, fixDots } from '../lib/straighten.js';
import { crossCoupledX } from '../lib/crossx.js';

/** auto + straightening pass (Eric 2026-10-09: no avoidable bend) on a reading. */
async function drawReading(netlist) {
  const seen = new Map();
  const text = netlist.split('\n').map((l0) => {
    const t = l0.trim().split(/\s+/);
    const model = (t[t.length - 1] || '').toLowerCase();
    if (/^[a-z]/i.test(t[0] || '') && !/^\./.test(t[0])) {
      if (/^(n|p)(mos|fet|ch)/.test(model) && !/^M/i.test(t[0])) t[0] = 'M' + t[0];
      if (/^(npn|pnp)/.test(model) && !/^Q/i.test(t[0])) t[0] = 'Q' + t[0];
      const k = t[0].toUpperCase(), c = (seen.get(k) || 0) + 1; seen.set(k, c);
      if (c > 1) t[0] = `${t[0]}_${c}`;
    }
    if (/^D/i.test(t[0] || '') && t.length === 3) t.push('D');
    if (/^[VI]/i.test(t[0] || '') && t.length === 3) t.push('DC', '0');
    return t.join(' ');
  }).join('\n');
  try {
    const p = parseSpice(/\.end\b/i.test(text) ? text : text + '\n.end');
    const res = await autoPlace(p), m = getPage(res.doc);
    const before = avoidableBends(m).bends;
    await crossCoupledX(m, p, { errorCount: checkerErrors, fixDots });   // the symmetric X of a cross-coupled pair (Eric)
    await straighten(m);
    const after = avoidableBends(m).bends;
    return { lvs: compare(extractNetlist(m), p).match, png: (await exportDocument(res.doc, m, { format: 'png', scale: 1.5 })).buffer, straighten: { before, after } };
  } catch (e) { return { lvs: null, error: String(e.message || e) }; }
}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SRC = arg('--src'), BATCH = arg('--batch', 'lectures-1');
// --redraw DIR: redraw an existing batch (auto + straightening pass), the old
// drawings kept as img/<n>-draw-v<k>.png; verdicts and items untouched but lvs/note
const REDRAW = arg('--redraw');
// --with DIR: each reading is shown NEXT TO the reading of the same figure in
// another batch (Eric 2026-10-09: Gemma beside Claude), with the verdict Eric gave it
const WITH = arg('--with');
// (a reading refused as unreadable — empty netlist — has nothing to check: skipped and listed)
if (!SRC && !REDRAW) { console.error('usage: --src FILE.jsonl [--batch lectures-1] | --redraw BATCH_DIR'); process.exit(1); }
if (REDRAW) {
  const items = fs.readFileSync(`${REDRAW}/items.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const it of items) {
    let k = 1; while (fs.existsSync(`${REDRAW}/img/${it.n}-draw-v${k}.png`)) k++;
    fs.copyFileSync(`${REDRAW}/img/${it.n}-draw.png`, `${REDRAW}/img/${it.n}-draw-v${k}.png`);
    const d = await drawReading(it.netlist);
    if (d.png) fs.writeFileSync(`${REDRAW}/img/${it.n}-draw.png`, d.png);
    it.lvs = d.lvs; it.straighten = d.straighten;
    console.error(`${it.n} ${it.key} lvs=${d.lvs} coudes évitables ${d.straighten?.before} -> ${d.straighten?.after}`);
  }
  fs.writeFileSync(`${REDRAW}/items.jsonl`, items.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${items.length} redrawn in ${REDRAW}`);
  process.exit(0);
}
const OUT = `${process.env.VERIFY_ROOT || '/AI/datasets/judge/lectures'}/${BATCH}`;
if (fs.existsSync(OUT)) { console.error(`${OUT} exists: refusing to overwrite a batch`); process.exit(1); }
const RAG = `${process.env.HOME}/ClaudeCode/local_AI/rag`;
fs.mkdirSync(`${OUT}/img`, { recursive: true });

const rows = fs.readFileSync(SRC, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const items = [];
for (const r of rows) {
  const n = items.length + 1;
  const key = `${r.paper_id} p${r.page} r${r.rang}`;
  // lecture-2 (RAG, 2026-10-09): {lecture: {netlist: [lines], notes, level}}
  const L = r.lecture || r;   // lecture-2 nested, or the flat drawio file (level, notes at the top)
  let netlist = String((Array.isArray(L.netlist) ? L.netlist.join('\n') : null) ?? r.netlist ?? r.spice ?? '').trim();
  if (!netlist) { console.error(`${key}: no netlist text, skipped`); continue; }
  if (!netlist.replace(/^\s*\.end\s*$/gim, '').trim()) { console.error(`${key}: empty netlist (reading refused as unreadable), skipped`); continue; }
  if (!/\.end\b/i.test(netlist)) netlist += '\n.end';
  if (sealedStatus(netlist)) { console.error(`${key}: matches a sealed circuit, refused`); continue; }
  // the figure, cropped by the RAG, and its citation
  // the figure: the crop the RAG rendered (r.image), else cropped here
  if (r.image && fs.existsSync(r.image)) fs.copyFileSync(r.image, `${OUT}/img/${n}-ref.png`);
  else execFileSync(`${RAG}/.venv/bin/python`, ['-m', 'rag.extract.figures', 'crop', r.paper_id, String(r.page), String(r.rang), `${OUT}/img/${n}-ref.png`], { cwd: RAG, stdio: 'ignore', timeout: 120000 });
  const a = await (await fetch(`http://127.0.0.1:8790/api/article?id=${encodeURIComponent(r.paper_id)}`)).json();
  const ref = { paper_id: r.paper_id, page: Number(r.page), rang: Number(r.rang), legende: r.legende || '', title: a.title, venue: a.venue, year: a.year, authors: a.authors };
  // the drawing drawio makes from the reading (auto, as served)
  let lvs = null, note = L.notes ? `Notes du lecteur : ${L.notes}` : '';
  // for the DRAWING only (the page shows the netlist as read): a passive or a
  // source written without a value gets a placeholder (a missing value is not
  // a connectivity fault); what drawio cannot draw is said on the page
  // (also: refs that are not SPICE — PFET1, P10, N7 for a MOS — get the M / Q
  // letter, and a duplicate ref a suffix)
  const seenRef = new Map();
  const forDrawing = netlist.split('\n').map((l0) => {
    let l = l0;
    let t = l.trim().split(/\s+/);
    const model = (t[t.length - 1] || '').toLowerCase();
    if (/^[a-z]/i.test(t[0]) && !/^\./.test(t[0])) {
      if (/^(n|p)(mos|fet|ch)/.test(model) && !/^M/i.test(t[0])) t[0] = 'M' + t[0];
      if (/^(npn|pnp)/.test(model) && !/^Q/i.test(t[0])) t[0] = 'Q' + t[0];
      const k = t[0].toUpperCase(), c = (seenRef.get(k) || 0) + 1; seenRef.set(k, c);
      if (c > 1) t[0] = `${t[0]}_${c}`;
      l = t.join(' ');
    }
    if (/^D/i.test(t[0]) && t.length === 3) return `${l} D`;
    if (/^[VI]/i.test(t[0]) && t.length === 3) return `${l} DC 0`;
    return l;
  }).join('\n');
  try {
    const p = parseSpice(forDrawing);
    const lost = (p.warnings || []).filter((w) => /unsupported|malformed|skipped/i.test(w));
    if (lost.length) note = (note ? note + ' — ' : '') + `Non dessiné par drawio : ${lost.map((w) => w.replace(/^.*?:\s*/, '')).join(' ; ')}`;
    const res = await autoPlace(p);
    lvs = compare(extractNetlist(getPage(res.doc)), p).match;
    fs.writeFileSync(`${OUT}/img/${n}-draw.png`, (await exportDocument(res.doc, getPage(res.doc), { format: 'png', scale: 1.5 })).buffer);
  } catch (e) {
    note = (note ? note + ' — ' : '') + `drawio n'a pas pu dessiner cette netlist (${String(e.message || e).slice(0, 120)})`;
    execFileSync('python3', ['-c', 'import sys;from PIL import Image,ImageDraw;im=Image.new("RGB",(600,120),"white");ImageDraw.Draw(im).text((10,50),"dessin impossible",fill="black");im.save(sys.argv[1])', `${OUT}/img/${n}-draw.png`]);
  }
  let other = null;
  if (WITH) {
    const its = fs.readFileSync(`${WITH}/items.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const ans = fs.existsSync(`${WITH}/answers.jsonl`) ? fs.readFileSync(`${WITH}/answers.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const o = its.find((x) => x.key === key);
    if (o) {
      fs.copyFileSync(`${WITH}/img/${o.n}-draw.png`, `${OUT}/img/${n}-draw2.png`);
      const a = ans.find((x) => x.n === o.n);
      other = { reader: o.version || o.source || 'lecture précédente', netlist: o.netlist, verdict: a?.verdict || null, comment: a?.comment || '' };
    }
  }
  items.push({ n, key, ref, netlist, lvs, note, level: L.level || null, version: r.lecture_version || r.lecteur || null, source: r.source || r.lecteur || null, other });
  console.error(`${n} ${key} lvs=${lvs}`);
}
fs.writeFileSync(`${OUT}/items.jsonl`, items.map((x) => JSON.stringify(x)).join('\n') + '\n');
console.log(`${items.length} readings -> ${OUT}`);
process.exit(0);
