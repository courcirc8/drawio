#!/usr/bin/env node
/**
 * dump-pins.js — parse every electrical stencil library of the fork and save
 * the exact terminal (pin) coordinates of each shape as JSON.
 *
 * Usage: node tools/dump-pins.js [output.json]   (default: data/electrical-pins.json)
 *
 * Output format:
 * {
 *   "generated": "<iso date>",
 *   "source": "src/main/webapp/stencils/electrical",
 *   "count": N,
 *   "shapes": {
 *     "<style key mxgraph.electrical.lib.name>": {
 *       "name": "...", "library": "...", "w": 100, "h": 60, "aspect": "variable",
 *       "pins": [ {"name": "in", "x": 0, "y": 0.5, "absX": 0, "absY": 30}, … ]
 *     }, …
 *   }
 * }
 * x/y are relative (0..1) to the shape box — what exitX/exitY expect;
 * absX/absY are pixels at the shape's native w×h.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, STENCIL_DIR } from '../lib/stencils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.resolve(HERE, '../data/electrical-pins.json');

const shapes = {};
for (const s of loadCatalog().values()) {
  shapes[s.key] = {
    name: s.name, library: s.library, w: s.w, h: s.h, aspect: s.aspect,
    pins: s.pins.map((p) => ({
      name: p.name, x: p.x, y: p.y,
      absX: Math.round(p.x * s.w * 100) / 100,
      absY: Math.round(p.y * s.h * 100) / 100,
    })),
  };
}
const doc = {
  generated: new Date().toISOString(),
  source: path.relative(path.resolve(HERE, '../..'), STENCIL_DIR),
  count: Object.keys(shapes).length,
  shapes,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n');
console.log(`${doc.count} shapes -> ${out}`);
