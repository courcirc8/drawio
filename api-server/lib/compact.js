/**
 * compact.js — S3 v2 : compaction par ALIGNEMENT DE PINS CONNECTÉES.
 * Pour chaque fil presque droit (|dx| ou |dy| petit mais non nul), on propose
 * de translater l'un des deux composants pour rendre le fil parfaitement
 * colinéaire. Chaque mouvement est testé individuellement : re-routage +
 * score géométrique rapide (beauty.py sans OpenCV) ; on ne garde que les
 * mouvements qui améliorent (recherche locale gloutonne, LVS invariant car
 * seules les positions changent).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allCells, cellInfo, updateCell, serialize } from './model.js';
import { routePage, pinAbs } from './route.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../tools/beauty.py');

export async function fastScore(model) {
  const tmp = path.join(os.tmpdir(), 'compact-' + process.pid + '-' + Date.now() + '.xml');
  fs.writeFileSync(tmp, serialize(model.ownerDocument));
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn('python3', [SCRIPT, tmp, '-']);
      let so = '', se = '';
      p.stdout.on('data', (d) => so += d);
      p.stderr.on('data', (d) => se += d);
      p.on('close', (c) => c === 0 ? resolve(so) : reject(new Error(se.slice(0, 200))));
    });
    return JSON.parse(out).score;
  } finally { fs.unlinkSync(tmp); }
}

function pinOf(styleMap, cell, pref) {
  const x = styleMap.get(pref + 'X'), y = styleMap.get(pref + 'Y');
  if (x == null || y == null) return null;
  return pinAbs(cell, { x: parseFloat(x), y: parseFloat(y) });
}

/** Mouvements candidats : delta pour coliniariser chaque fil presque droit. */
function candidates(model, tol) {
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const moves = [];
  for (const e of cells) {
    if (e.kind !== 'edge' || e.source == null || e.target == null) continue;
    const s = byId.get(e.source), t = byId.get(e.target);
    if (s == null || t == null || s.x == null || t.x == null) continue;
    const pa = pinOf(e.style.map, s, 'exit') || { x: s.x + s.w / 2, y: s.y + s.h / 2 };
    const pb = pinOf(e.style.map, t, 'entry') || { x: t.x + t.w / 2, y: t.y + t.h / 2 };
    const dx = pa.x - pb.x, dy = pa.y - pb.y;
    if (Math.abs(dx) > 0.5 && Math.abs(dx) <= tol) {
      moves.push({ ref: e.target, axis: 'x', delta: dx });
      moves.push({ ref: e.source, axis: 'x', delta: -dx });
    }
    if (Math.abs(dy) > 0.5 && Math.abs(dy) <= tol) {
      moves.push({ ref: e.target, axis: 'y', delta: dy });
      moves.push({ ref: e.source, axis: 'y', delta: -dy });
    }
  }
  return moves;
}

export async function compactPage(model, { tol = 30, maxMoves = 24 } = {}) {
  let score = await fastScore(model);
  let applied = 0;
  const tried = new Set();
  for (let round = 0; round < 3; round++) {
    let progress = false;
    for (const mv of candidates(model, tol)) {
      if (applied >= maxMoves) break;
      const key = mv.ref + mv.axis + Math.round(mv.delta);
      if (tried.has(key)) continue;
      tried.add(key);
      const cell = allCells(model).map(cellInfo).find((c) => c.id === mv.ref);
      if (cell == null) continue;
      const patch = mv.axis === 'x' ? { dx: mv.delta } : { dy: mv.delta };
      updateCell(model, mv.ref, patch);
      await routePage(model, null, {});
      const s2 = await fastScore(model);
      if (s2 > score) { score = s2; applied++; progress = true; }
      else {
        updateCell(model, mv.ref, mv.axis === 'x' ? { dx: -mv.delta } : { dy: -mv.delta });
      }
    }
    if (!progress) break;
  }
  await routePage(model, null, {});
  return { moved: applied, score };
}
