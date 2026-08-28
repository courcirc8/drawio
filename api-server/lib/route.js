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
import { allCells, cellInfo, setEdgePoints, updateCell, mergeStyle } from './model.js';
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
  const vertsById = new Map(vertices.map((v) => [v.id, v]));
  const endAbs = (c, pref, cell) => {
    const X = c.style.map.get(pref + 'X'), Y = c.style.map.get(pref + 'Y');
    if (X != null && Y != null) return pinAbsOf(cell, parseFloat(X), parseFloat(Y));
    const b = rotatedAabb(cell);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; // attache flottante : centre
  };
  for (const e of edges) {
    const pts = routes[e.id];
    if (pts == null) continue;
    const cellEl = allCells(model).find((el) => el.getAttribute('id') === e.id);
    const cInfo = cellInfo(cellEl);
    const src = byId.get(e.source), tgt = byId.get(e.target);
    let out = pts;
    // fil vers/depuis une JONCTION : L canonique si le chemin est libre
    const isJct = (cc) => cc != null && cc.style.map.has('drawioApiJunction');
    const jTarget = isJct(tgt), jSource = isJct(src);
    if ((jTarget || jSource) && !(jTarget && jSource)) {
      const a = endAbs(cInfo, 'exit', src), b = endAbs(cInfo, 'entry', tgt);
      const pinEnd = jTarget ? a : b;
      const jEnd = jTarget ? b : a;
      const ex = cInfo.style.map.get(jTarget ? 'exitX' : 'entryX');
      const ey = cInfo.style.map.get(jTarget ? 'exitY' : 'entryY');
      const vertFirst = ey === '0' || ey === '1' || (ex !== '0' && ex !== '1');
      const corner = vertFirst ? { x: pinEnd.x, y: jEnd.y } : { x: jEnd.x, y: pinEnd.y };
      const clear = (p, q) => !vertices.some((v) =>
        v.id !== e.source && v.id !== e.target &&
        Math.max(p.x, q.x) > v.x + 3 && Math.min(p.x, q.x) < v.x + v.w - 3 &&
        Math.max(p.y, q.y) > v.y + 3 && Math.min(p.y, q.y) < v.y + v.h - 3);
      if (clear(pinEnd, corner) && clear(corner, jEnd)) {
        out = (Math.abs(pinEnd.x - jEnd.x) < 1 || Math.abs(pinEnd.y - jEnd.y) < 1) ? [] : [corner];
        setEdgePoints(cellEl, out);
        // le jetty auto du renderer fabrique des marches sur ces fils courts :
        // sortie de pin directe
        cellEl.setAttribute('style', mergeStyle(cellEl.getAttribute('style'), { jettySize: 0 }));
        routed.push(e.id);
        continue;
      }
    }
    if (pts.length === 0) {
      // libavoid dit « droit » : si les extrémités ne sont PAS alignées, on
      // synthétise l'équerre nous-mêmes (jamais le routeur implicite de drawio)
      const a = endAbs(cInfo, 'exit', src), b = endAbs(cInfo, 'entry', tgt);
      if (Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1) {
        const ex = cInfo.style.map.get('exitX'), ey = cInfo.style.map.get('exitY');
        const vertFirst = ey === '0' || ey === '1' || (ex !== '0' && ex !== '1');
        out = [vertFirst ? { x: a.x, y: b.y } : { x: b.x, y: a.y }];
      }
    }
    setEdgePoints(cellEl, out);
    routed.push(e.id);
  }
  // ---- polish : collapse des micro-jogs (artefacts de nudge / évitements)
  polishJogs(model, vertices, 22);
  return { ids: routed };
}

/** Aplatis les motifs H-V-H / V-H-V dont le segment central est court. */
function polishJogs(model, obstacles, tol) {
  const cells = allCells(model).map(cellInfo);
  const byId2 = new Map(cells.map((c) => [c.id, c]));
  const boxes = obstacles.map((v) => ({ x: v.x + 3, y: v.y + 3, w: v.w - 6, h: v.h - 6, id: v.id }));
  const blocked = (x1, y1, x2, y2, skip) => boxes.some((b) => !skip.has(b.id) &&
    Math.max(x1, x2) > b.x && Math.min(x1, x2) < b.x + b.w &&
    Math.max(y1, y2) > b.y && Math.min(y1, y2) < b.y + b.h);
  for (const c of cells) {
    if (c.kind !== 'edge' || c.points == null || c.points.length === 0) continue;
    if (c.style.map.get('edgeStyle') === 'none') continue;
    const src = byId2.get(c.source), tgt = byId2.get(c.target);
    if (src == null || tgt == null || src.x == null || tgt.x == null) continue;
    const anchor = (pref, cell) => {
      const X = c.style.map.get(pref + 'X'), Y = c.style.map.get(pref + 'Y');
      if (X != null && Y != null) return pinAbsOf(cell, parseFloat(X), parseFloat(Y));
      const b = rotatedAabb(cell);
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    };
    const skip = new Set([c.source, c.target]);
    let pl = [anchor('exit', src), ...c.points.map((p) => ({ ...p })), anchor('entry', tgt)];
    let changed = true, guard = 6;
    while (changed && guard-- > 0) {
      changed = false;
      for (let i = 1; i + 2 < pl.length; i++) {
        const [p0, p1, p2, p3] = [pl[i - 1], pl[i], pl[i + 1], pl[i + 2]];
        const isH = (a, b) => Math.abs(a.y - b.y) < 0.6 && Math.abs(a.x - b.x) >= 0.6;
        const isV = (a, b) => Math.abs(a.x - b.x) < 0.6 && Math.abs(a.y - b.y) >= 0.6;
        if (isH(p0, p1) && isV(p1, p2) && isH(p2, p3) && Math.abs(p1.y - p2.y) <= tol) {
          const fix0 = i - 1 === 0, fix1 = i + 2 === pl.length - 1;
          if (fix0 && fix1) continue;
          const useP0 = fix0 || (!fix1 && Math.abs(p1.x - p0.x) >= Math.abs(p3.x - p2.x));
          const yT = useP0 ? p0.y : p3.y;
          const [qa, qb] = useP0 ? [p2, p3] : [p0, p1];
          if (blocked(Math.min(qa.x, qb.x), yT - 1, Math.max(qa.x, qb.x), yT + 1, skip)) continue;
          p1.y = yT; p2.y = yT;
          changed = true;
        } else if (isV(p0, p1) && isH(p1, p2) && isV(p2, p3) && Math.abs(p1.x - p2.x) <= tol) {
          const fix0 = i - 1 === 0, fix1 = i + 2 === pl.length - 1;
          if (fix0 && fix1) continue;
          const useP0 = fix0 || (!fix1 && Math.abs(p1.y - p0.y) >= Math.abs(p3.y - p2.y));
          const xT = useP0 ? p0.x : p3.x;
          const [qa, qb] = useP0 ? [p2, p3] : [p0, p1];
          if (blocked(xT - 1, Math.min(qa.y, qb.y), xT + 1, Math.max(qa.y, qb.y), skip)) continue;
          p1.x = xT; p2.x = xT;
          changed = true;
        }
      }
      // dédoublonner les points colinéaires/identiques
      pl = pl.filter((p, i) => i === 0 || Math.abs(p.x - pl[i - 1].x) > 0.3 || Math.abs(p.y - pl[i - 1].y) > 0.3);
      for (let i = 1; i + 1 < pl.length; i++) {
        const a = pl[i - 1], b2 = pl[i], c2 = pl[i + 1];
        if ((Math.abs(a.x - b2.x) < 0.6 && Math.abs(b2.x - c2.x) < 0.6) ||
            (Math.abs(a.y - b2.y) < 0.6 && Math.abs(b2.y - c2.y) < 0.6)) {
          pl.splice(i, 1); i--;
        }
      }
    }
    const cellEl = allCells(model).find((el) => el.getAttribute('id') === c.id);
    setEdgePoints(cellEl, pl.slice(1, -1));
  }
}

/** Absolute position of a shape pin, rotation-aware. Used by netlist wiring/extraction. */
export function pinAbs(cell, pin) {
  return pinAbsOf(cell, pin.x, pin.y);
}
