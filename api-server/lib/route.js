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
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { allCells, cellInfo, setEdgePoints, updateCell } from './model.js';
import { getShape } from './stencils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(HERE, '../../src/main/webapp/js/libavoid-js');

let helpersLoaded = false;
function loadHelpers() {
  // seuls les helpers géométriques purs (constraintForPoint…) sont requis en
  // thread principal ; le module Avoid vit dans le worker
  if (!helpersLoaded) {
    vm.runInThisContext(fs.readFileSync(path.join(LIB_DIR, 'libavoid-routing.js'), 'utf8'),
      { filename: 'libavoid-routing.js' });
    helpersLoaded = true;
  }
}

// ---- worker de routage avec timeout (un solve pathologique est tué/relancé)
let worker = null;
let seq = 0;
const pending = new Map();
const ROUTE_TIMEOUT_MS = 6000;

let idleTimer = null;
function armIdleKill() {
  if (idleTimer != null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (pending.size === 0) killWorker(); }, 2500);
  idleTimer.unref();
}

function getWorker() {
  if (worker == null) {
    worker = new Worker(new URL('./route-worker.js', import.meta.url));
    worker.unref();
    if (worker.stdout) worker.stdout.unref?.();
    if (worker.stderr) worker.stderr.unref?.();
    worker.on('message', (msg) => {
      const p = pending.get(msg.id);
      if (p != null) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
      if (msg.error != null) {
        // un abort Emscripten laisse le module MORT pour la session du
        // worker (cf. docs/claude/libavoid-routing.md) : on relance
        killWorker();
      } else {
        armIdleKill();
      }
    });
    worker.on('error', () => { killWorker(); });
  }
  return worker;
}
function killWorker() {
  const w = worker;
  worker = null;
  for (const [, p] of pending) { clearTimeout(p.timer); p.resolve({ error: 'worker-restart' }); }
  pending.clear();
  if (w != null) w.terminate().catch(() => {});
}

function computeRoutesSafe(vertices, edges, opts) {
  return new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      killWorker();
      resolve({ error: 'route-timeout' });
    }, ROUTE_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    getWorker().postMessage({ id, vertices, edges, opts });
  });
}

/**
 * Absolute position of a relative (0..1) anchor on a possibly-rotated shape.
 * mxGraph rotates shapes around their centre in ABSOLUTE space, so relative
 * coordinates cannot simply be rotated in the unit square (wrong for w≠h).
 */
function pinAbsOf(cell, relX, relY) {
  if (cell.flipH) relX = 1 - relX;
  if (cell.flipV) relY = 1 - relY;
  const t = ((cell.rotation || 0) * Math.PI) / 180;
  const cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2;
  const px = cell.x + relX * cell.w, py = cell.y + relY * cell.h;
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * Math.cos(t) - dy * Math.sin(t), y: cy + dx * Math.sin(t) + dy * Math.cos(t) };
}

/** Axis-aligned bounding box of a rotated cell (the obstacle libavoid sees). */
function rotatedAabb(cell) {
  const t = ((cell.rotation || 0) * Math.PI) / 180;
  const w = Math.abs(cell.w * Math.cos(t)) + Math.abs(cell.h * Math.sin(t));
  const h = Math.abs(cell.w * Math.sin(t)) + Math.abs(cell.h * Math.cos(t));
  return { x: cell.x + cell.w / 2 - w / 2, y: cell.y + cell.h / 2 - h / 2, w, h };
}

function anchorConstraint(styleMap, prefix, cell, aabb) {
  const x = styleMap.get(prefix + 'X');
  const y = styleMap.get(prefix + 'Y');
  if (x == null || y == null) return null;
  const p = pinAbsOf(cell, parseFloat(x), parseFloat(y));
  return globalThis.AvoidRouting.constraintForPoint(
    AvoidRouting.clamp01((p.x - aabb.x) / (aabb.w || 1)),
    AvoidRouting.clamp01((p.y - aabb.y) / (aabb.h || 1)));
}

/**
 * Route all (or the given) wires of a page. Mutates edge waypoints.
 * @returns {ids: routedEdgeIds}
 */
export async function routePage(model, edgeIds, opts) {
  loadHelpers();
  const cells = allCells(model).map(cellInfo);
  const vertices = cells.filter((c) => c.kind === 'vertex' && c.x != null)
    .map((c) => { const b = rotatedAabb(c); return { id: c.id, x: b.x, y: b.y, w: b.w, h: b.h }; });
  const byId = new Map(cells.map((c) => [c.id, c]));
  const wanted = edgeIds != null ? new Set(edgeIds.map(String)) : null;
  const edges = [];
  for (const c of cells) {
    if (c.kind !== 'edge') continue;
    if (wanted != null && !wanted.has(c.id)) continue;
    if (c.source == null || c.target == null) continue;
    if (c.source === c.target) continue;
    if (c.style.map.get('edgeStyle') === 'none') continue; // diagonale volontaire
    const src = byId.get(c.source), tgt = byId.get(c.target);
    if (src == null || tgt == null) continue;
    edges.push({
      id: c.id, source: c.source, target: c.target,
      sourceConstraint: anchorConstraint(c.style.map, 'exit', src, rotatedAabb(src)),
      targetConstraint: anchorConstraint(c.style.map, 'entry', tgt, rotatedAabb(tgt)),
      sourceJetty: 10, targetJetty: 10,
    });
  }
  const resp = await computeRoutesSafe(vertices, edges, opts || {});
  if (resp.error != null) return { ids: [], failed: resp.error };
  const routes = resp.routes;
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
  return pinAbsOf(cell, pin.x, pin.y);
}
