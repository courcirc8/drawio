#!/usr/bin/env node
/**
 * gen-yolo-dataset.mjs — clean vector schematics + exact YOLO labels, for
 * the dgx-osr detector (courcirc8/dgx-osr, src/dgx_osr/config.py CLASS_NAMES).
 *
 * WHY: dgx-osr's detector was trained on hand-drawn/synthetic strokes and
 * recognises 1 component in 10 on a clean vector drawing (its own CLAUDE.md,
 * invariant 2). This generator knows every stencil's exact bounding box, so
 * labels are free and exact — the missing distribution, at zero annotation
 * cost. Class indices 0-8 are FROZEN in dgx-osr; we emit its order verbatim.
 *
 * Usage:
 *   CHROME_PATH=… node tools/gen-yolo-dataset.mjs <netlist-dir|file.cir…> <out-dir> [--scale 2] [--engine v2|v1] [--optimize N] [--debug]
 * Output: <out>/images/<name>.png, <out>/labels/<name>.txt (class cx cy w h,
 * normalised), <out>/classes.txt, <out>/data.yaml, <out>/manifest.json.
 * --debug also writes <out>/debug/<name>.png with the boxes drawn (needs
 * python3 + Pillow) so the pixel mapping can be checked by eye.
 *
 * Pixel mapping = the exact view transform recorded by lib/render.js during
 * the export (`mapping`: px = (x + tx) * scale - clip.x) — NOT a content
 * origin recomputed from cell geometry, which ignores label extents and was
 * measured 6 x 20 diagram units off. Stroke width adds ~1 px outside the
 * box; boxes are padded by PAD px to cover it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { newDocument, getPage, normalizeOrigin, allCells, cellInfo } from '../lib/model.js';
import { parseSpice } from '../lib/netlist.js';
import { importNetlist2 } from '../lib/place2.js';
import { importNetlist } from '../lib/place.js';
import { routePage, rotatedAabb } from '../lib/route.js';
import { optimizeNetlist } from '../lib/optimize.js';
import { exportDocument, closeBrowser } from '../lib/render.js';
import { classify } from '../lib/components.js';

// dgx-osr CLASS_NAMES, indices frozen (0-8), append-only beyond
export const CLASSES = ['nmos', 'pmos', 'resistor', 'capacitor', 'npn', 'pnp', 'gnd', 'vdd', 'vss',
  'inductor', 'current_source', 'voltage_source', 'diode'];
const PAD = 2;

/** dgx-osr class for a classified cell, or null (ports, dots, labels, op-amps…). */
export function classOf(ci, cls) {
  const key = cls.shape ? cls.shape.key : '';
  if (cls.role === 'ground') return 'gnd';
  if (cls.role === 'power') {
    const n = String(cls.net || '').toUpperCase();
    return /VSS|VEE|VNEG/.test(n) ? 'vss' : 'vdd';
  }
  if (cls.role !== 'component') return null;
  switch (cls.prefix) {
    case 'M': return /\.pmos/.test(key) ? 'pmos' : 'nmos';
    case 'Q': return /pnp/.test(key) ? 'pnp' : 'npn';
    case 'R': return 'resistor';
    case 'C': return 'capacitor';
    case 'L': return 'inductor';
    case 'I': return 'current_source';
    case 'V': return 'voltage_source';
    case 'D': return 'diode';
    default: return null;
  }
}

/** Labels for a drawn model: [{cls, x, y, w, h}] in PNG pixels, using the
 *  exact view transform recorded by lib/render.js (`mapping`). */
export function pixelBoxes(model, mapping) {
  const { scale, tx, ty, clipX, clipY } = mapping;
  const out = [];
  for (const raw of allCells(model)) {
    const ci = cellInfo(raw);
    if (ci.kind !== 'vertex' || ci.x == null) continue;
    const cls = classify(ci);
    const name = classOf(ci, cls);
    if (name == null) continue;
    const b = rotatedAabb(ci);
    out.push({ cls: name, id: ci.id,
      x: (b.x + tx) * scale - clipX - PAD, y: (b.y + ty) * scale - clipY - PAD,
      w: b.w * scale + 2 * PAD, h: b.h * scale + 2 * PAD });
  }
  return out;
}

async function drawOne(cir, { engine, optimize }) {
  const parsed = parseSpice(cir);
  if (optimize > 0) {
    const { best } = await optimizeNetlist(parsed, { iterations: optimize, engine });
    return { doc: best.doc, model: getPage(best.doc), parsed };
  }
  const doc = newDocument(); const m = getPage(doc);
  const placed = engine === 'v1' ? importNetlist(m, parsed) : importNetlist2(m, parsed);
  await routePage(m, placed.wires, {});
  normalizeOrigin(m);
  return { doc, model: m, parsed };
}

function pngSize(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').match(/^--(scale|engine|optimize)$/));
  const out = pos.pop();
  if (!out || !pos.length) { console.error('usage: gen-yolo-dataset.mjs <netlist-dir|file.cir…> <out-dir> [--scale 2] [--engine v2] [--optimize N] [--debug]'); process.exit(1); }
  const scale = parseFloat(opt('scale', '2')), border = 10;
  const engine = opt('engine', 'v2'), optimize = parseInt(opt('optimize', '0'), 10);
  const files = pos.flatMap((p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.cir')).sort().map((f) => path.join(p, f)) : [p]);
  for (const d of ['images', 'labels', ...(flags.has('--debug') ? ['debug'] : [])]) fs.mkdirSync(path.join(out, d), { recursive: true });
  const manifest = [];
  try {
    for (const f of files) {
      const name = path.basename(f, '.cir');
      const row = { name, source: f };
      try {
        const { doc, model } = await drawOne(fs.readFileSync(f, 'utf8'), { engine, optimize });
        const ex = await exportDocument(doc, model, { format: 'png', scale, border });
        const png = ex.buffer;
        const { w: W, h: H } = pngSize(png);
        const boxes = pixelBoxes(model, ex.mapping);
        const lines = boxes.map((b) => {
          const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(W, b.x + b.w), y1 = Math.min(H, b.y + b.h);
          return `${CLASSES.indexOf(b.cls)} ${((x0 + x1) / 2 / W).toFixed(6)} ${((y0 + y1) / 2 / H).toFixed(6)} ${((x1 - x0) / W).toFixed(6)} ${((y1 - y0) / H).toFixed(6)}`;
        });
        fs.writeFileSync(path.join(out, 'images', name + '.png'), png);
        fs.writeFileSync(path.join(out, 'labels', name + '.txt'), lines.join('\n') + (lines.length ? '\n' : ''));
        row.boxes = boxes.length; row.size = [W, H];
        row.classes = boxes.reduce((h, b) => { h[b.cls] = (h[b.cls] || 0) + 1; return h; }, {});
        if (flags.has('--debug')) {
          const py = `
from PIL import Image, ImageDraw
import json, sys
im = Image.open(sys.argv[1]).convert('RGB'); d = ImageDraw.Draw(im)
for b in json.load(open(sys.argv[2])):
    d.rectangle([b['x'], b['y'], b['x']+b['w'], b['y']+b['h']], outline=(220,0,0), width=2); d.text((b['x']+2, b['y']-12), b['cls'], fill=(220,0,0))
im.save(sys.argv[3])`;
          const bj = path.join(out, 'debug', name + '.json');
          fs.writeFileSync(bj, JSON.stringify(boxes));
          const r = spawnSync(process.env.BEAUTY_PYTHON || 'python3', ['-c', py, path.join(out, 'images', name + '.png'), bj, path.join(out, 'debug', name + '.png')], { encoding: 'utf8' });
          if (r.status !== 0) row.debug_error = (r.stderr || '').slice(-200);
          fs.unlinkSync(bj);
        }
        console.log(`${name.padEnd(36)} ${W}x${H} boxes=${boxes.length}`);
      } catch (e) {
        row.error = String(e.message || e).slice(0, 200);
        console.log(`${name.padEnd(36)} ERROR ${row.error}`);
      }
      manifest.push(row);
    }
    fs.writeFileSync(path.join(out, 'classes.txt'), CLASSES.join('\n') + '\n');
    fs.writeFileSync(path.join(out, 'data.yaml'), `# generated by drawio api-server tools/gen-yolo-dataset.mjs — clean vector schematics, exact boxes\npath: ${path.resolve(out)}\ntrain: images\nval: images\nnames:\n${CLASSES.map((c, i) => `  ${i}: ${c}`).join('\n')}\n`);
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const ok = manifest.filter((m) => !m.error);
    console.log(`${ok.length}/${manifest.length} images, ${ok.reduce((n, m) => n + m.boxes, 0)} boxes -> ${out}`);
  } finally { await closeBrowser(); }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error(e); process.exit(1); });
