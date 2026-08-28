/**
 * beauty.js — bridge to tools/beauty.py (XML geometry + OpenCV visual metrics).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize, allCells, cellInfo } from './model.js';
import { exportDocument } from './render.js';
import { extractNetlist } from './netlist.js';
import { detectStructures, isPmosLike } from './patterns.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../tools/beauty.py');

/**
 * Métriques structurelles « lisibilité humaine » :
 *  - flow_ok    : les chaînes de conduction (drain→source série) vont bien du
 *                 haut vers le bas ET restent alignées en x (piles verticales) ;
 *  - rails_ok   : masses toutes en bas, taps VDD tous en haut ;
 *  - pair_sym   : membres d'une paire diff/cross-couplée à la même hauteur ;
 *  - mirror_row : membres d'un miroir alignés sur la rangée de leur diode.
 */
function structuralMetrics(model) {
  const extracted = extractNetlist(model);
  const comps = extracted.components;
  const cells = new Map(allCells(model).map((c) => [c.getAttribute('id'), cellInfo(c)]));
  const pos = (ref) => {
    const c = cells.get(ref);
    return c == null || c.x == null ? null : { x: c.x + c.w / 2, y: c.y + c.h / 2 };
  };
  const m = {};
  // chaînes série : net partagé par exactement 2 terminaux « haut/bas »
  const ends = (c) => {
    if (c.prefix === 'M' || c.prefix === 'Q') {
      const p = isPmosLike({ prefix: c.prefix, model: c.value });
      return { top: p ? c.nodes[2] : c.nodes[0], bot: p ? c.nodes[0] : c.nodes[2] };
    }
    if ('RCLVID'.includes(c.prefix)) return { top: c.nodes[0], bot: c.nodes[1] };
    return null;
  };
  const netDeg = new Map();
  for (const c of comps) for (const n of c.nodes) netDeg.set(n, (netDeg.get(n) || 0) + 1);
  let series = 0, flowOk = 0;
  for (const a of comps) {
    const ea = ends(a);
    if (ea == null) continue;
    for (const b of comps) {
      if (a === b) continue;
      const eb = ends(b);
      if (eb == null || ea.bot !== eb.top || (netDeg.get(ea.bot) || 0) !== 2) continue;
      // les chaînes purement passives (tank L/2+L/2, diviseurs) sont
      // conventionnellement horizontales : seules les piles à transistor
      // doivent couler du haut vers le bas
      const hasMos = 'MQ'.includes(a.prefix) || 'MQ'.includes(b.prefix);
      if (!hasMos) continue;
      const pa = pos(a.ref), pb = pos(b.ref);
      if (pa == null || pb == null) continue;
      series++;
      if (pa.y < pb.y - 15 && Math.abs(pa.x - pb.x) < 45) flowOk++;
    }
  }
  m.series_links = series;
  m.flow_ok = series ? Math.round((flowOk / series) * 1000) / 1000 : 1;
  // rails
  const comps_pos = comps.map((c) => pos(c.ref)).filter(Boolean);
  const maxY = Math.max(...comps_pos.map((p) => p.y), 0);
  const minY = Math.min(...comps_pos.map((p) => p.y), 1e9);
  let rails = 0, railsOk = 0;
  for (const [id, c] of cells) {
    const key = (c.style && c.style.map.get('shape')) || '';
    if (/signal_ground|protective_earth/.test(key)) { rails++; if (c.y + c.h / 2 > maxY) railsOk++; }
    if (/\.vss2$|\.vdd$/.test(key)) { rails++; if (c.y + c.h / 2 < minY) railsOk++; }
  }
  m.rails_ok = rails ? Math.round((railsOk / rails) * 1000) / 1000 : 1;
  // symétrie des paires + rangées de miroirs
  const structures = detectStructures({ components: comps.map((c) => ({ ...c, model: c.value })) });
  const pairs = [...structures.diffPairs, ...structures.crossCoupled];
  const tailOf = new Map();
  for (const t of structures.tails) tailOf.set(t.pair.join('/'), t.ref);
  let pOk = 0;
  for (const p of pairs) {
    const [a, b] = p.refs.map(pos);
    if (a == null || b == null) continue;
    let s = Math.abs(a.y - b.y) < 14 ? 0.5 : 0;
    const tref = tailOf.get(p.refs.join('/')) || tailOf.get([...p.refs].reverse().join('/'));
    const tp = tref != null ? pos(tref) : null;
    if (tp != null) {
      // symétrie exacte : centre de la paire sur l'axe de la queue
      if (Math.abs((a.x + b.x) / 2 - tp.x) < 18) s += 0.5;
    } else {
      s += 0.5; // pas de queue : la même hauteur suffit
    }
    pOk += s;
  }
  m.pair_sym = pairs.length ? Math.round((pOk / pairs.length) * 1000) / 1000 : 1;
  let mTot = 0, mOk = 0;
  for (const mir of structures.mirrors) {
    const dp = pos(mir.diode);
    if (dp == null) continue;
    for (const r of mir.outputs) {
      const q = pos(r);
      if (q == null) continue;
      mTot++;
      if (Math.abs(q.y - dp.y) < 14) mOk++;
    }
  }
  m.mirror_row = mTot ? Math.round((mOk / mTot) * 1000) / 1000 : 1;
  return m;
}

export async function scoreDocument(doc, model, { reference } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beauty-'));
  try {
    const xmlPath = path.join(tmp, 'doc.xml');
    const pngPath = path.join(tmp, 'doc.png');
    fs.writeFileSync(xmlPath, serialize(doc));
    const { buffer } = await exportDocument(doc, model, { format: 'png', scale: 2 });
    fs.writeFileSync(pngPath, buffer);
    const structPath = path.join(tmp, 'struct.json');
    fs.writeFileSync(structPath, JSON.stringify(structuralMetrics(model)));
    const args = [SCRIPT, xmlPath, pngPath, reference != null ? path.resolve(reference) : '-', structPath];
    const out = await new Promise((resolve, reject) => {
      const p = spawn('python3', args);
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => stdout += d);
      p.stderr.on('data', (d) => stderr += d);
      p.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error('beauty.py: ' + stderr.slice(0, 400))));
    });
    return JSON.parse(out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
