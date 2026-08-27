/**
 * route.js — headless libavoid autorouting using the fork's canonical core.
 * Loads src/main/webapp/js/libavoid-js/{libavoid.min.js,libavoid-routing.js}
 * once via vm.runInThisContext (the harness pattern documented in
 * docs/claude/libavoid-routing.md) and applies AvoidRouting.computeRoutes
 * results back into the edges' mxGeometry waypoints.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { allCells, cellInfo, setEdgePoints, updateCell } from './model.js';
import { getShape } from './stencils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(HERE, '../../src/main/webapp/js/libavoid-js');

let avoidPromise = null;

function loadAvoid() {
  if (avoidPromise == null) {
    vm.runInThisContext(fs.readFileSync(path.join(LIB_DIR, 'libavoid.min.js'), 'utf8'),
      { filename: 'libavoid.min.js' });
    vm.runInThisContext(fs.readFileSync(path.join(LIB_DIR, 'libavoid-routing.js'), 'utf8'),
      { filename: 'libavoid-routing.js' });
    avoidPromise = Promise.resolve(globalThis.__libavoidReady).then(() => {
      if (globalThis.Avoid == null) throw new Error('libavoid failed to initialize');
      return globalThis.Avoid;
    });
  }
  return avoidPromise;
}

/** Rotate a relative (0..1) anchor around the shape centre by rotation degrees. */
function rotateRel(x, y, rotation) {
  const t = ((rotation || 0) * Math.PI) / 180;
  const cx = x - 0.5, cy = y - 0.5;
  return {
    x: 0.5 + cx * Math.cos(t) - cy * Math.sin(t),
    y: 0.5 + cx * Math.sin(t) + cy * Math.cos(t),
  };
}

function anchorConstraint(styleMap, prefix, rotation) {
  const x = styleMap.get(prefix + 'X');
  const y = styleMap.get(prefix + 'Y');
  if (x == null || y == null) return null;
  const r = rotateRel(parseFloat(x), parseFloat(y), rotation);
  return globalThis.AvoidRouting.constraintForPoint(r.x, r.y);
}

/**
 * Route all (or the given) wires of a page. Mutates edge waypoints.
 * @returns {ids: routedEdgeIds}
 */
export async function routePage(model, edgeIds, opts) {
  const Avoid = await loadAvoid();
  const cells = allCells(model).map(cellInfo);
  const vertices = cells.filter((c) => c.kind === 'vertex' && c.x != null)
    .map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w || 0, h: c.h || 0 }));
  const byId = new Map(cells.map((c) => [c.id, c]));
  const wanted = edgeIds != null ? new Set(edgeIds.map(String)) : null;
  const edges = [];
  for (const c of cells) {
    if (c.kind !== 'edge') continue;
    if (wanted != null && !wanted.has(c.id)) continue;
    if (c.source == null || c.target == null) continue;
    if (c.source === c.target) continue;
    const src = byId.get(c.source), tgt = byId.get(c.target);
    if (src == null || tgt == null) continue;
    edges.push({
      id: c.id, source: c.source, target: c.target,
      sourceConstraint: anchorConstraint(c.style.map, 'exit', src.rotation),
      targetConstraint: anchorConstraint(c.style.map, 'entry', tgt.rotation),
      sourceJetty: 10, targetJetty: 10,
    });
  }
  const routes = globalThis.AvoidRouting.computeRoutes(Avoid, vertices, edges, opts || {});
  const routed = [];
  for (const e of edges) {
    const pts = routes[e.id];
    if (pts != null) {
      const cellEl = allCells(model).find((el) => el.getAttribute('id') === e.id);
      setEdgePoints(cellEl, pts);
      routed.push(e.id);
    }
  }
  return { ids: routed };
}

/** Absolute position of a shape pin, rotation-aware. Used by netlist wiring/extraction. */
export function pinAbs(cell, pin) {
  const r = rotateRel(pin.x, pin.y, cell.rotation);
  return { x: cell.x + r.x * cell.w, y: cell.y + r.y * cell.h };
}

export { rotateRel };
