#!/usr/bin/env node
/**
 * ref-bends.mjs — bends of the REFERENCE drawing (a human LTspice schematic,
 * exact wire coordinates) against the bends of drawio's drawing of the same
 * netlist (Eric 2026-10-09: "une routine qui compte les coudes du schéma de
 * référence et une qui compte ceux de drawio ; flagger les différences
 * importantes, puis analyser les règles ou passes manquantes").
 *
 *   reference: LTspice wires are horizontal / vertical segments; a bend is a
 *   point where exactly two wire ends meet at a right angle (two collinear
 *   pieces of one straight wire are not a bend).
 *   drawio: direction changes along every drawn wire (pin, waypoints, pin).
 * Both per part. Flag: drawio > 1.5 × reference AND at least 3 more bends.
 * Netlists from tools/asc2spice.mjs (fully supported circuits, 3-25 parts).
 * The corpus (mick001/Circuits-LTSpice, no licence) is used for measurement
 * only, on the station; nothing of it goes to git.
 * Usage: node tools/ref-bends.mjs --corpus DIR [--out FILE.jsonl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseAsc, ascToSpice, readAsc } from './asc2spice.mjs';
import { parseSpice } from '../lib/netlist.js';
import { getPage, allCells, cellInfo } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { pinAbs } from '../lib/route.js';
import { avoidableBends } from '../lib/straighten.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const CORPUS = arg('--corpus'), OUT = arg('--out', '/AI/datasets/netlists/runs/refbends.jsonl');
const walk = (d, o = []) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p, o); else if (f.name.endsWith('.asc')) o.push(p); } return o; };

function refBends(wires) {
  const ends = new Map();
  for (const [x1, y1, x2, y2] of wires) {
    const dir = x1 === x2 ? 'v' : y1 === y2 ? 'h' : 'd';
    for (const k of [`${x1},${y1}`, `${x2},${y2}`]) { if (!ends.has(k)) ends.set(k, []); ends.get(k).push(dir); }
  }
  // a point lying INSIDE another wire is a tee, not a bend
  const inside = (x, y) => wires.some(([x1, y1, x2, y2]) => (x1 === x2 && x === x1 && y > Math.min(y1, y2) && y < Math.max(y1, y2)) || (y1 === y2 && y === y1 && x > Math.min(x1, x2) && x < Math.max(x1, x2)));
  let n = 0;
  for (const [k, ds] of ends) {
    if (ds.length !== 2 || ds[0] === ds[1] || ds.includes('d')) continue;
    const [x, y] = k.split(',').map(Number);
    if (!inside(x, y)) n++;
  }
  return n;
}
function drawBends(m) {
  const cells = allCells(m).map(cellInfo), byId = new Map(cells.map((c) => [c.id, c]));
  let n = 0, segs = [];
  for (const e of cells.filter((c) => c.kind === 'edge' && byId.has(c.source) && byId.has(c.target))) {
    const pin = (c, pre) => pinAbs(c, { x: Number(e.style.map.get(pre + 'X') ?? 0.5), y: Number(e.style.map.get(pre + 'Y') ?? 0.5) });
    const pts = [pin(byId.get(e.source), 'exit'), ...e.points, pin(byId.get(e.target), 'entry')];
    for (let i = 1; i < pts.length - 1; i++) {
      const h1 = Math.abs(pts[i].y - pts[i - 1].y) < 0.5, h2 = Math.abs(pts[i + 1].y - pts[i].y) < 0.5;
      if (h1 !== h2) n++;
    }
    for (let i = 1; i < pts.length; i++) segs.push([e.id, pts[i - 1], pts[i]]);
  }
  // crossings: a horizontal and a vertical segment of two wires crossing inside both
  let x = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const [ea, a1, a2] = segs[i], [eb, b1, b2] = segs[j];
    if (ea === eb) continue;
    const ha = Math.abs(a1.y - a2.y) < 0.5, hb = Math.abs(b1.y - b2.y) < 0.5;
    if (ha === hb) continue;
    const [H1, H2, V1, V2] = ha ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
    if (V1.x > Math.min(H1.x, H2.x) + 0.5 && V1.x < Math.max(H1.x, H2.x) - 0.5 && H1.y > Math.min(V1.y, V2.y) + 0.5 && H1.y < Math.max(V1.y, V2.y) - 0.5) x++;
  }
  return { bends: n, crossings: x };
}

const rows = [];
for (const f of walk(CORPUS)) {
  const text = readAsc(f);
  let conv; try { conv = ascToSpice(text, { name: path.basename(f) }); } catch { continue; }
  if (conv.manifest && conv.manifest.supported === false) continue;
  let p; try { p = parseSpice(conv.spice); } catch { continue; }
  const n = p.components.length;
  if (n < 3 || n > 25) continue;
  const { wires } = parseAsc(text);
  const rb = refBends(wires);
  let r; try { r = await autoPlace(p); } catch { continue; }
  const m = getPage(r.doc), d = drawBends(m);
  rows.push({ id: path.relative(CORPUS, f), parts: n, ref: rb, drawio: d.bends, crossings: d.crossings, avoidable: avoidableBends(m).bends, chosen: r.label,
    flag: d.bends > 1.5 * rb && d.bends - rb >= 3 });
}
fs.writeFileSync(OUT, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
const sum = (k) => rows.reduce((s, x) => s + x[k], 0), parts = sum('parts');
console.log(`${rows.length} circuits — coudes par composant : référence ${(sum('ref') / parts).toFixed(2)}, drawio ${(sum('drawio') / parts).toFixed(2)} ; signalés ${rows.filter((x) => x.flag).length}`);
for (const x of rows.filter((x) => x.flag).sort((a, b) => (b.drawio - b.ref) - (a.drawio - a.ref)).slice(0, 15)) console.log(`  ${x.id}  ${x.parts} comp.  réf ${x.ref}  drawio ${x.drawio}  (évitables ${x.avoidable}, croisements ${x.crossings}, ${x.chosen})`);
process.exit(0);
