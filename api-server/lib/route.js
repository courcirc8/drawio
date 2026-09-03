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


/** RÈGLE UTILISATEUR : un segment vertical collé au flanc d'un transistor
 * (là où sont dessinés le canal et les leads) est interdit — on sort du
 * nœud horizontalement, quitte à prendre deux coudes. */
function hugsMosFlank(p, q, vertices) {
  if (Math.abs(p.x - q.x) >= 0.6) return false;
  const lo = Math.min(p.y, q.y), hi = Math.max(p.y, q.y);
  return vertices.some((v) => v.isMos &&
    (Math.abs(p.x - v.x) < 2.5 || Math.abs(p.x - (v.x + v.w)) < 2.5) &&
    Math.min(hi, v.y + v.h) - Math.max(lo, v.y) > 12);
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
    .map((c) => {
      const b = rotatedAabb(c);
      const isMos = /nmos|pmos|mosfet/.test(c.style.map.get('shape') || '');
      return { id: c.id, x: b.x, y: b.y, w: b.w, h: b.h, isMos };
    });
  const byId = new Map(cells.map((c) => [c.id, c]));
  const wanted = edgeIds != null ? new Set(edgeIds.map(String)) : null;
  const edges = [];
  for (const c of cells) {
    if (c.kind !== 'edge') continue;
    if (wanted != null && !wanted.has(c.id)) continue;
    if (c.source == null || c.target == null) continue;
    if (c.source === c.target) continue;
    if (c.style.map.get('edgeStyle') === 'none') continue; // diagonale volontaire
    if (c.style.map.has('drawioApiFixedRoute')) continue; // tracé figé par le placeur
    const src = byId.get(c.source), tgt = byId.get(c.target);
    if (src == null || tgt == null) continue;
    edges.push({
      id: c.id, source: c.source, target: c.target,
      sourceConstraint: anchorConstraint(c.style.map, 'exit', src, rotatedAabb(src)),
      targetConstraint: anchorConstraint(c.style.map, 'entry', tgt, rotatedAabb(tgt)),
      sourceJetty: 10, targetJetty: 10,
    });
  }
  // pré-passe : self-edges (liaisons diode gate->drain) = cadre EXTÉRIEUR
  // au corps (règle 24) — jamais une diagonale à travers le transistor
  for (const c of cells) {
    if (c.kind !== 'edge' || c.source == null || c.source !== c.target) continue;
    const body0 = byId.get(c.source);
    if (body0 == null || body0.x == null) continue;
    const bb = rotatedAabb(body0);
    const aX = c.style.map.get('exitX'), aY = c.style.map.get('exitY');
    const bX = c.style.map.get('entryX'), bY = c.style.map.get('entryY');
    if (aX == null || bX == null) continue;
    const a = pinAbsOf(body0, parseFloat(aX), parseFloat(aY));
    const b = pinAbsOf(body0, parseFloat(bX), parseFloat(bY));
    // règle 32 : le pin haut/bas est le drain (la gate est sur le flanc) —
    // la boucle gate-drain passe du CÔTÉ DRAIN (bas pour un PMOS source en
    // haut, haut pour un NMOS drain en haut), jamais du côté source
    const aIsDrain = Math.abs(parseFloat(aY) - 0.5) > 0.25;
    const g = aIsDrain ? b : a, d = aIsDrain ? a : b;
    const left = g.x <= bb.x + bb.w / 2;
    const oy = d.y <= bb.y + bb.h / 2 ? bb.y - 14 : bb.y + bb.h + 14;
    // écart du montant vertical choisi selon la PLACE : un voisin à 14 px
    // (diode accolée) faisait passer le cadre dans son corps
    let ox = left ? bb.x - 16 : bb.x + bb.w + 16;
    for (const cand of (left ? [bb.x - 16, bb.x - 26, bb.x + bb.w + 16, bb.x + bb.w + 26]
                             : [bb.x + bb.w + 16, bb.x + bb.w + 26, bb.x - 16, bb.x - 26])) {
      const lo = Math.min(g.y, oy), hi = Math.max(g.y, oy);
      const hit = vertices.some((v) => v.id !== c.source &&
        cand > v.x + 1.5 && cand < v.x + v.w - 1.5 &&
        hi > v.y + 1.5 && lo < v.y + v.h - 1.5) ||
        hugsMosFlank({ x: cand, y: lo }, { x: cand, y: hi }, vertices.filter((v) => v.id !== c.source));
      if (!hit) { ox = cand; break; }
    }
    const el = allCells(model).find((x) => x.getAttribute('id') === c.id);
    const path = [{ x: ox, y: g.y }, { x: ox, y: oy }, { x: d.x, y: oy }];
    setEdgePoints(el, aIsDrain ? path.slice().reverse() : path);
    el.setAttribute('style', mergeStyle(el.getAttribute('style'), { jettySize: 0 }));
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
  // pins de tous les fils (nets étrangers = interdits de survol pour les
  // tracés déterministes : un L qui pose son coin sur le pin d'un autre net
  // fabrique une superposition électrique — règle 22, vu sur le Gilbert)
  const edgeNetAll = netGroups(cells);
  const pinPts = [];
  for (const c of cells) {
    if (c.kind !== 'edge' || c.source == null || c.target == null) continue;
    const s = byId.get(c.source), t = byId.get(c.target);
    if (s == null || t == null || s.x == null || t.x == null) continue;
    pinPts.push({ p: endAbs(c, 'exit', s), net: edgeNetAll.get(c.id) });
    pinPts.push({ p: endAbs(c, 'entry', t), net: edgeNetAll.get(c.id) });
  }
  const distPS = (pt, p, q) => {
    const dx = q.x - p.x, dy = q.y - p.y, L2 = dx * dx + dy * dy;
    const tt = L2 ? Math.max(0, Math.min(1, ((pt.x - p.x) * dx + (pt.y - p.y) * dy) / L2)) : 0;
    return Math.hypot(pt.x - (p.x + tt * dx), pt.y - (p.y + tt * dy));
  };
  for (const e of edges) {
    const pts = routes[e.id];
    if (pts == null) continue;
    const cellEl = allCells(model).find((el) => el.getAttribute('id') === e.id);
    const cInfo = cellInfo(cellEl);
    const src = byId.get(e.source), tgt = byId.get(e.target);
    let out = pts;
    // PLANIFICATION DÉTERMINISTE D'ABORD (règle 31b) : les coordonnées des
    // pins sont connues — droit si aligné et libre, L canonique si le L est
    // libre (deux coins essayés), libavoid seulement en dernier recours
    {
      const a = endAbs(cInfo, 'exit', src), b = endAbs(cInfo, 'entry', tgt);
      const myNet = edgeNetAll.get(e.id);
      const clearPins = (p, q) => !pinPts.some((pp) =>
        pp.net !== myNet && distPS(pp.p, p, q) < 5);
      // un corps TERMINAL n'est pas exempt : le fil ne peut y pénétrer qu'au
      // voisinage immédiat de son propre pin (jamais le traverser pour
      // atteindre le pin du côté opposé — vu : bus de gates à travers M8)
      const clear = (p, q) => clearPins(p, q) && !hugsMosFlank(p, q, vertices) && !vertices.some((v) => {
        const hit = Math.max(p.x, q.x) > v.x + 1.5 && Math.min(p.x, q.x) < v.x + v.w - 1.5 &&
          Math.max(p.y, q.y) > v.y + 1.5 && Math.min(p.y, q.y) < v.y + v.h - 1.5;
        if (!hit) return false;
        if (v.id !== e.source && v.id !== e.target) return true;
        const own = v.id === e.source ? a : b;
        const cx = (x2) => Math.max(v.x + 1.5, Math.min(v.x + v.w - 1.5, x2));
        const cy = (y2) => Math.max(v.y + 1.5, Math.min(v.y + v.h - 1.5, y2));
        const far = Math.max(
          Math.hypot(cx(p.x) - own.x, cy(p.y) - own.y),
          Math.hypot(cx(q.x) - own.x, cy(q.y) - own.y));
        return far > 8;
      });
      const aligned = Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1;
      if (aligned && clear(a, b)) {
        setEdgePoints(cellEl, []);
        cellEl.setAttribute('style', mergeStyle(cellEl.getAttribute('style'), { jettySize: 0 }));
        routed.push(e.id);
        continue;
      }
      const ex = cInfo.style.map.get('exitX'), ey = cInfo.style.map.get('exitY');
      const vertFirst = ey === '0' || ey === '1' || (ex !== '0' && ex !== '1');
      const c1 = vertFirst ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
      const c2 = vertFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
      let corner = null;
      if (clear(a, c1) && clear(c1, b)) corner = c1;
      else if (clear(a, c2) && clear(c2, b)) corner = c2;
      if (corner != null) {
        setEdgePoints(cellEl, [corner]);
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
    // VALIDATION FINALE : ni le tracé droit ni libavoid ne garantissent
    // l'absence de traversée de corps (y compris le SIEN, au-delà du pin)
    // ou de survol de pin étranger — on re-valide et on synthétise un
    // détour U/Z sur une lane libre si le chemin est fautif
    {
      const a = endAbs(cInfo, 'exit', src), b = endAbs(cInfo, 'entry', tgt);
      const myNet = edgeNetAll.get(e.id);
      const clearPins2 = (p, q) => !pinPts.some((pp) =>
        pp.net !== myNet && distPS(pp.p, p, q) < 5);
      const segOk = (p, q) => {
        if (process.env.DEBUG_FIX === '1' && e.id === process.env.DEBUG_FIX_ID) {
          const r1 = clearPins2(p, q), r2 = !hugsMosFlank(p, q, vertices);
          if (!r1 || !r2) console.error(`   segKO (${p.x},${p.y})-(${q.x},${q.y}) pins=${r1} flank=${r2}`);
        }
        return clearPins2(p, q) && !hugsMosFlank(p, q, vertices) && !vertices.some((v) => {
        const hit = Math.max(p.x, q.x) > v.x + 1.5 && Math.min(p.x, q.x) < v.x + v.w - 1.5 &&
          Math.max(p.y, q.y) > v.y + 1.5 && Math.min(p.y, q.y) < v.y + v.h - 1.5;
        if (!hit) return false;
        if (v.id !== e.source && v.id !== e.target) return true;
        const own = v.id === e.source ? a : b;
        const cx2 = (x2) => Math.max(v.x + 1.5, Math.min(v.x + v.w - 1.5, x2));
        const cy2 = (y2) => Math.max(v.y + 1.5, Math.min(v.y + v.h - 1.5, y2));
        const bad = Math.max(
          Math.hypot(cx2(p.x) - own.x, cy2(p.y) - own.y),
          Math.hypot(cx2(q.x) - own.x, cy2(q.y) - own.y)) > 8;
        if (bad && process.env.DEBUG_FIX === '1' && e.id === process.env.DEBUG_FIX_ID) {
          console.error(`   segKO (${p.x},${p.y})-(${q.x},${q.y}) corps=${v.id}`);
        }
        return bad;
      });
      };
      const pathOk = (wp) => {
        const pl2 = [a, ...wp, b];
        for (let k = 0; k + 1 < pl2.length; k++) if (!segOk(pl2[k], pl2[k + 1])) return false;
        return true;
      };
      if (process.env.DEBUG_FIX === '1' && e.id === process.env.DEBUG_FIX_ID) {
        console.error(`[fix] ${e.id} a=(${a.x},${a.y}) b=(${b.x},${b.y}) out=${JSON.stringify(out)} pathOk=${pathOk(out)}`);
      }
      if (!pathOk(out)) {
        let fixed = null;
        // échappée horizontale d'un pin posé sur un flanc (gate) : on sort
        // du corps AVANT de plonger — règle utilisateur « sortir du nœud
        // horizontalement, quitte à avoir deux coudes »
        const escOf = (pt, cid) => {
          const v = vertsById.get(cid);
          if (v == null) return 0;
          if (Math.abs(pt.x - v.x) < 2.5) return -14;
          if (Math.abs(pt.x - (v.x + v.w)) < 2.5) return 14;
          return 0;
        };
        const eA = escOf(a, e.source), eB = escOf(b, e.target);
        const cands = [];
        for (let k = 1; k <= 6 && fixed == null; k++) {
          for (const lane of [Math.min(a.y, b.y) - k * 14, Math.max(a.y, b.y) + k * 14]) {
            cands.push([{ x: a.x, y: lane }, { x: b.x, y: lane }]);
            if (eA !== 0 || eB !== 0) {
              cands.push([{ x: a.x + eA, y: a.y }, { x: a.x + eA, y: lane },
                          { x: b.x + eB, y: lane }, { x: b.x + eB, y: b.y }]);
            }
          }
          for (const lane of [Math.min(a.x, b.x) - k * 14, Math.max(a.x, b.x) + k * 14]) {
            cands.push([{ x: lane, y: a.y }, { x: lane, y: b.y }]);
          }
        }
        for (const wp of cands) { if (pathOk(wp)) { fixed = wp; break; } }
        if (process.env.DEBUG_FIX === '1' && e.id === process.env.DEBUG_FIX_ID) {
          console.error(`[fix] ${e.id} eA=${eA} eB=${eB} cands=${cands.length} fixed=${JSON.stringify(fixed)}`);
          for (const wp of cands.slice(0, 6)) console.error('   cand', JSON.stringify(wp), pathOk(wp));
        }
        if (fixed != null) {
          out = fixed;
          cellEl.setAttribute('style', mergeStyle(cellEl.getAttribute('style'), { jettySize: 0 }));
        }
      }
    }
    setEdgePoints(cellEl, out);
    routed.push(e.id);
  }
  // ---- polish : collapse des micro-jogs (artefacts de nudge / évitements)
  polishJogs(model, vertices, 22);
  // ---- fusion : deux conducteurs du MÊME net qui se longent se rejoignent
  if (process.env.DISABLE_MERGE !== '1') mergeSameNet(model, vertices);
  // ---- séparation : deux nets différents ne se superposent JAMAIS
  separateNets(model, vertices);
  // ---- fusion, 2e passe : la séparation crée elle-même des parallèles de
  // même net (elle décale des lanes) que la 1re fusion n'a jamais vus
  if (process.env.DISABLE_MERGE !== '1') mergeSameNet(model, vertices);
  // ---- simplification finale : un fil en Z/U redevient droit ou L canonique
  // si la géométrie FINALE le permet (corps, pins étrangers, lanes étrangères)
  simplifyBends(model, vertices);
  // ---- répartition des tés : sur un tronc (H ou V), les dérivations se
  // placent aux fractions équitables de la portée (règle utilisateur :
  // « répartis les espaces pour les nœuds verticaux »)
  distributeTees(model, vertices);
  // ---- fusion finale : le simplificateur déplace des lanes (échappées,
  // té-swaps) APRÈS la 2e fusion — une dernière passe rattrape les
  // parallèles même-net qu'il vient de créer
  if (process.env.DISABLE_MERGE !== '1') mergeSameNet(model, vertices);
  // ---- garde ultime : AUCUN fil à travers son PROPRE corps au-delà de
  // 8 px du pin — certaines réparations (fusion, redressements) exemptent
  // le corps propre et recréaient la faute après la validation finale
  fixOwnBodyThrough(model, vertices);
  // ---- nettoyage : points dupliqués et pointes A->B->A laissés par les réparations
  cleanupDegeneratePoints(model);
  // ---- points de contact sur les branches >=3 terminaux (après géométrie finale)
  if (process.env.DISABLE_DOTS !== '1') addContactDots(model);
  return { ids: routed };
}

/** Groupes de nets par union-find (jonctions = cellule, pins = cellule+ancre). */
function netGroups(cells) {
  const byId2 = new Map(cells.map((c) => [c.id, c]));
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  const uni = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };
  const endKey = (c, which) => {
    const cid = which === 'src' ? c.source : c.target;
    const cell = byId2.get(cid);
    if (cell != null && cell.style.map.has('drawioApiJunction')) return 'J:' + cid;
    const X = c.style.map.get(which === 'src' ? 'exitX' : 'entryX');
    const Y = c.style.map.get(which === 'src' ? 'exitY' : 'entryY');
    // clé par position ABSOLUE arrondie : deux ancres relatives différentes
    // qui atterrissent sur le même pin physique sont le même nœud (le cadre
    // de diode et le fil de gate se rataient et passaient pour deux nets)
    if (X != null && Y != null && cell != null && cell.x != null) {
      const p = pinAbsOf(cell, parseFloat(X), parseFloat(Y));
      return cid + '@' + Math.round(p.x / 3) + ',' + Math.round(p.y / 3);
    }
    return cid + ':' + X + ',' + Y;
  };
  const edgeNet = new Map();
  for (const c of cells) {
    if (c.kind !== 'edge' || c.source == null || c.target == null) continue;
    uni(endKey(c, 'src'), endKey(c, 'tgt'));
  }
  for (const c of cells) {
    if (c.kind !== 'edge' || c.source == null || c.target == null) continue;
    edgeNet.set(c.id, find(endKey(c, 'src')));
  }
  return edgeNet;
}

function polylineOf(c, byId2) {
  const src = byId2.get(c.source), tgt = byId2.get(c.target);
  if (src == null || tgt == null || src.x == null || tgt.x == null) return null;
  const anchor = (pref, cell) => {
    const X = c.style.map.get(pref + 'X'), Y = c.style.map.get(pref + 'Y');
    if (X != null && Y != null) return pinAbsOf(cell, parseFloat(X), parseFloat(Y));
    const bb = rotatedAabb(cell);
    return { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
  };
  return [anchor('exit', src), ...(c.points || []), anchor('entry', tgt)];
}

function mergeSameNet(model, obstacles) {
  for (let repairs = 0; repairs < 20; repairs++) {
    const cells = allCells(model).map(cellInfo);
    const byId2 = new Map(cells.map((c) => [c.id, c]));
    const edgeNet = netGroups(cells);
    const wires = cells.filter((c) => c.kind === 'edge' && c.source != null && c.target != null &&
      c.style.map.get('edgeStyle') !== 'none');
    let repaired = false;
    for (let i = 0; i < wires.length && !repaired; i++) {
      for (let j = i + 1; j < wires.length && !repaired; j++) {
        const A = wires[i], Bv = wires[j];
        if (edgeNet.get(A.id) !== edgeNet.get(Bv.id)) continue;
        const plA = polylineOf(A, byId2), plB = polylineOf(Bv, byId2);
        if (plA == null || plB == null) continue;
        const segs = (pl) => {
          const out = [];
          for (let k = 0; k + 1 < pl.length; k++) {
            const p = pl[k], q = pl[k + 1];
            if (Math.abs(p.y - q.y) < 0.6 && Math.abs(p.x - q.x) >= 0.6) out.push({ axis: 'h', lane: p.y, a: Math.min(p.x, q.x), b: Math.max(p.x, q.x), i: k });
            else if (Math.abs(p.x - q.x) < 0.6 && Math.abs(p.y - q.y) >= 0.6) out.push({ axis: 'v', lane: p.x, a: Math.min(p.y, q.y), b: Math.max(p.y, q.y), i: k });
          }
          return out;
        };
        // lanes occupées par les AUTRES nets (une fusion ne doit pas y atterrir)
        const foreign = [];
        for (const W of wires) {
          if (edgeNet.get(W.id) === edgeNet.get(A.id)) continue;
          const plW = polylineOf(W, byId2);
          if (plW == null) continue;
          for (let k = 0; k + 1 < plW.length; k++) {
            const p = plW[k], q = plW[k + 1];
            if (Math.abs(p.y - q.y) < 0.6) foreign.push({ axis: 'h', lane: p.y, a: Math.min(p.x, q.x), b: Math.max(p.x, q.x) });
            else if (Math.abs(p.x - q.x) < 0.6) foreign.push({ axis: 'v', lane: p.x, a: Math.min(p.y, q.y), b: Math.max(p.y, q.y) });
          }
        }
        const laneFree = (axis, lane, a, b) => !foreign.some((f) =>
          f.axis === axis && Math.abs(f.lane - lane) < 6 && Math.min(f.b, b) - Math.max(f.a, a) > 8);
        for (const sa of segs(plA)) {
          for (const sb of segs(plB)) {
            if (sa.axis !== sb.axis) continue;
            const d = Math.abs(sa.lane - sb.lane);
            if (d < 1 || d > 16) continue;
            if (Math.min(sa.b, sb.b) - Math.max(sa.a, sb.a) < 20) continue;
            if (!laneFree(sa.axis, sb.lane, sa.a, sa.b) && !laneFree(sa.axis, sa.lane, sb.a, sb.b)) continue;
            // MERGE : le segment intérieur mobile rejoint la lane de l'autre
            const shiftTo = (ei, seg, lane) => {
              if (ei.style.map.has('drawioApiFixedRoute')) return false;
              const npts = ei.points || [];
              if (!(seg.i >= 1 && seg.i <= npts.length - 1)) return false;
              // la lane de fusion ne doit pas longer un canal de MOS
              if (seg.axis === 'v' && hugsMosFlank({ x: lane, y: seg.a }, { x: lane, y: seg.b }, obstacles)) return false;
              const p = npts[seg.i - 1], q = npts[seg.i];
              if (seg.axis === 'h') { p.y = lane; q.y = lane; } else { p.x = lane; q.x = lane; }
              const el = allCells(model).find((x) => x.getAttribute('id') === ei.id);
              setEdgePoints(el, npts);
              return true;
            };
            if (laneFree(sa.axis, sb.lane, sa.a, sa.b) && shiftTo(A, sa, sb.lane)) { repaired = true; }
            else if (laneFree(sa.axis, sa.lane, sb.a, sb.b) && shiftTo(Bv, sb, sa.lane)) { repaired = true; }
            if (repaired) break;
          }
          if (repaired) break;
        }
      }
    }
    if (!repaired) break;
  }
}

/** Re-tente droit/L pour chaque fil à >=2 coudes, avec la connaissance
 * GLOBALE finale : jamais à travers un corps (le sien : 8 px autour du pin),
 * jamais sur un pin étranger, jamais à <10 px d'une lane étrangère (les
 * séparations ne doivent pas être défaites). */
function simplifyBends(model, obstacles) {
  // les dots (6x6) ne sont pas des obstacles : un point de contact du même
  // net posé sur le trajet du L canonique le bloquerait à tort
  obstacles = obstacles.filter((v) => v.w >= 12 || v.h >= 12);
  const dps = (pt, p, q) => {
    const dx = q.x - p.x, dy = q.y - p.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((pt.x - p.x) * dx + (pt.y - p.y) * dy) / L2)) : 0;
    return Math.hypot(pt.x - (p.x + t * dx), pt.y - (p.y + t * dy));
  };
  for (let round = 0; round < 3; round++) {
    const cells = allCells(model).map(cellInfo);
    const byId2 = new Map(cells.map((c) => [c.id, c]));
    const edgeNet = netGroups(cells);
    const infos = [];
    for (const c of cells) {
      if (c.kind !== 'edge' || c.source == null || c.target == null) continue;
      if (c.source === c.target || c.style.map.get('edgeStyle') === 'none') continue;
      const pl = polylineOf(c, byId2);
      if (pl == null) continue;
      infos.push({ c, pl, net: edgeNet.get(c.id) });
    }
    const pinPts = infos.flatMap((i) => [{ p: i.pl[0], net: i.net }, { p: i.pl[i.pl.length - 1], net: i.net }]);
    const segsOf = (pl) => {
      const out = [];
      for (let k = 0; k + 1 < pl.length; k++) {
        const p = pl[k], q = pl[k + 1];
        if (Math.abs(p.y - q.y) < 0.6 && Math.abs(p.x - q.x) >= 0.6) out.push({ axis: 'h', lane: p.y, a: Math.min(p.x, q.x), b: Math.max(p.x, q.x) });
        else if (Math.abs(p.x - q.x) < 0.6 && Math.abs(p.y - q.y) >= 0.6) out.push({ axis: 'v', lane: p.x, a: Math.min(p.y, q.y), b: Math.max(p.y, q.y) });
      }
      return out;
    };
    let changed = false;
    for (const it of infos) {
      if (it.c.style.map.has('drawioApiFixedRoute')) continue;
      if ((it.c.points || []).length < 1) continue; // 1 coude : éligible au té-swap
      const a = it.pl[0], b = it.pl[it.pl.length - 1];
      const okSeg = (p, q) => {
        if (hugsMosFlank(p, q, obstacles)) return false;
        if (obstacles.some((v) => {
          const hit = Math.max(p.x, q.x) > v.x + 1.5 && Math.min(p.x, q.x) < v.x + v.w - 1.5 &&
            Math.max(p.y, q.y) > v.y + 1.5 && Math.min(p.y, q.y) < v.y + v.h - 1.5;
          if (!hit) return false;
          if (v.id !== it.c.source && v.id !== it.c.target) return true;
          const own = v.id === it.c.source ? a : b;
          const cx = (x2) => Math.max(v.x + 1.5, Math.min(v.x + v.w - 1.5, x2));
          const cy = (y2) => Math.max(v.y + 1.5, Math.min(v.y + v.h - 1.5, y2));
          return Math.max(Math.hypot(cx(p.x) - own.x, cy(p.y) - own.y),
            Math.hypot(cx(q.x) - own.x, cy(q.y) - own.y)) > 8;
        })) return false;
        if (pinPts.some((pp) => pp.net !== it.net && dps(pp.p, p, q) < 5)) return false;
        const cs = segsOf([p, q]);
        if (cs.length === 0) return true;
        const sc = cs[0];
        for (const o of infos) {
          if (o === it || o.net === it.net) continue;
          for (const so of segsOf(o.pl)) {
            if (so.axis !== sc.axis) continue;
            if (Math.abs(so.lane - sc.lane) < 10 && Math.min(so.b, sc.b) - Math.max(so.a, sc.a) > 6) return false;
          }
        }
        return true;
      };
      const aligned = Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1;
      const cands = [];
      if (aligned) cands.push([]);
      cands.push([{ x: a.x, y: b.y }], [{ x: b.x, y: a.y }]);
      // U/Z à 2 coudes : lane médiane puis écarts croissants jusqu'à ±98
      // (la lane libre d'un bus de gates peut être à 70 px de la rangée)
      const my = (a.y + b.y) / 2, mx = (a.x + b.x) / 2;
      for (let k = 0; k <= 7; k++) {
        for (const d of k === 0 ? [0] : [-14 * k, 14 * k]) {
          cands.push([{ x: a.x, y: my + d }, { x: b.x, y: my + d }]);
          cands.push([{ x: mx + d, y: a.y }, { x: mx + d, y: b.y }]);
        }
      }
      // un L « fait té » si un de ses segments se superpose à un tronc du
      // même net : la dérivation plonge sur le fil au lieu de rejoindre le
      // pin par un décroché (préférence humaine, remarque Cm/Lb1)
      const makesTee = (pl3) => {
        for (let k = 0; k + 1 < pl3.length; k++) {
          const cs = segsOf([pl3[k], pl3[k + 1]]);
          if (cs.length === 0) continue;
          const sc = cs[0];
          for (const o of infos) {
            if (o === it || o.net !== it.net) continue;
            for (const so of segsOf(o.pl)) {
              if (so.axis === sc.axis && Math.abs(so.lane - sc.lane) < 0.6 &&
                  Math.min(so.b, sc.b) - Math.max(so.a, sc.a) > 10) return true;
            }
          }
        }
        return false;
      };
      for (const wp of cands) {
        const cur = it.c.points || [];
        const better = wp.length < cur.length;
        let teeSwap = false;
        if (!better && wp.length === 1 && cur.length === 1) {
          teeSwap = makesTee([a, ...wp, b]) &&
            !makesTee([a, ...cur.map((p) => ({ x: p.x, y: p.y })), b]);
        }
        if (!better && !teeSwap) continue;
        const pl2 = [a, ...wp, b];
        let ok = true;
        for (let k = 0; k + 1 < pl2.length; k++) { if (!okSeg(pl2[k], pl2[k + 1])) { ok = false; break; } }
        if (!ok) continue;
        const el = allCells(model).find((x) => x.getAttribute('id') === it.c.id);
        setEdgePoints(el, wp);
        el.setAttribute('style', mergeStyle(el.getAttribute('style'), { jettySize: 0 }));
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
}

/** Répartit les tés le long des troncs : une dérivation qui se branche sur
 * un fil (vertical ou horizontal) se place à sa fraction équitable de la
 * portée, comme dans un dessin humain — au lieu de s'agglutiner près des
 * pins. Déplacement = shift du segment d'approche perpendiculaire, validé
 * (corps, pins étrangers, lanes étrangères, flancs de MOS). */
export function distributeTees(model, obstacles) {
  const cells = allCells(model).map(cellInfo);
  const byId2 = new Map(cells.map((c) => [c.id, c]));
  const edgeNet = netGroups(cells);
  const infos = [];
  for (const c of cells) {
    if (c.kind !== 'edge' || c.source == null || c.target == null) continue;
    if (c.style.map.get('edgeStyle') === 'none') continue;
    const pl = polylineOf(c, byId2);
    if (pl == null) continue;
    infos.push({ c, pl, net: edgeNet.get(c.id) });
  }
  const pinPts = infos.flatMap((i) => [{ p: i.pl[0], net: i.net }, { p: i.pl[i.pl.length - 1], net: i.net }]);
  const dps = (pt, p, q) => {
    const dx = q.x - p.x, dy = q.y - p.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((pt.x - p.x) * dx + (pt.y - p.y) * dy) / L2)) : 0;
    return Math.hypot(pt.x - (p.x + t * dx), pt.y - (p.y + t * dy));
  };
  const segOk2 = (it, p, q) => {
    if (hugsMosFlank(p, q, obstacles)) return false;
    if (obstacles.some((v) => {
      if (v.w < 12 && v.h < 12) return false;
      const hit = Math.max(p.x, q.x) > v.x + 1.5 && Math.min(p.x, q.x) < v.x + v.w - 1.5 &&
        Math.max(p.y, q.y) > v.y + 1.5 && Math.min(p.y, q.y) < v.y + v.h - 1.5;
      if (!hit) return false;
      if (v.id !== it.c.source && v.id !== it.c.target) return true;
      // corps PROPRE : pénétration tolérée seulement à 8 px du pin (le té
      // du beta-multiplier se redressait À TRAVERS son transistor)
      const own = v.id === it.c.source ? it.pl[0] : it.pl[it.pl.length - 1];
      const cx3 = (x3) => Math.max(v.x + 1.5, Math.min(v.x + v.w - 1.5, x3));
      const cy3 = (y3) => Math.max(v.y + 1.5, Math.min(v.y + v.h - 1.5, y3));
      return Math.max(Math.hypot(cx3(p.x) - own.x, cy3(p.y) - own.y),
        Math.hypot(cx3(q.x) - own.x, cy3(q.y) - own.y)) > 8;
    })) return false;
    if (pinPts.some((pp) => pp.net !== it.net && dps(pp.p, p, q) < 5)) return false;
    for (const o of infos) {
      if (o === it || o.net === it.net) continue;
      for (let k = 0; k + 1 < o.pl.length; k++) {
        const b1 = o.pl[k], b2 = o.pl[k + 1];
        const horiz = Math.abs(p.y - q.y) < 0.6;
        if (horiz && Math.abs(b1.y - b2.y) < 0.6 && Math.abs(b1.y - p.y) < 10 &&
            Math.min(Math.max(b1.x, b2.x), Math.max(p.x, q.x)) - Math.max(Math.min(b1.x, b2.x), Math.min(p.x, q.x)) > 6) return false;
        if (!horiz && Math.abs(b1.x - b2.x) < 0.6 && Math.abs(b1.x - p.x) < 10 &&
            Math.min(Math.max(b1.y, b2.y), Math.max(p.y, q.y)) - Math.max(Math.min(b1.y, b2.y), Math.min(p.y, q.y)) > 6) return false;
      }
    }
    return true;
  };
  for (const T of infos) {
    for (let si = 0; si + 1 < T.pl.length; si++) {
      const p = T.pl[si], q = T.pl[si + 1];
      const vert = Math.abs(p.x - q.x) < 0.6 && Math.abs(p.y - q.y) >= 50;
      const horz = Math.abs(p.y - q.y) < 0.6 && Math.abs(p.x - q.x) >= 50;
      if (!vert && !horz) continue;
      if (process.env.DEBUG_TEES === '1') {
        const lane0 = vert ? p.x : p.y;
        const others = [];
        for (const W of infos) {
          if (W === T || W.net !== T.net) continue;
          for (const pt of (W.c.points || [])) {
            const perp0 = vert ? pt.x : pt.y;
            if (Math.abs(perp0 - lane0) < 6) others.push(`${W.c.id}(${pt.x.toFixed(0)},${pt.y.toFixed(0)})`);
          }
        }
        console.error(`[tronc] ${T.c.id} ${vert ? 'V' : 'H'} lane=${lane0.toFixed(0)} span=${Math.abs(vert ? q.y - p.y : q.x - p.x).toFixed(0)} corners~lane: ${others.join(' ') || '-'}`);
      }
      const lane = vert ? p.x : p.y;
      const lo = (vert ? Math.min(p.y, q.y) : Math.min(p.x, q.x)) + 14;
      const hi = (vert ? Math.max(p.y, q.y) : Math.max(p.x, q.x)) - 14;
      if (hi - lo < 40) continue;
      // dérivations : coins d'autres fils du même net posés sur le tronc
      const branches = [];
      for (const W of infos) {
        if (W === T || W.net !== T.net) continue;
        if (W.c.style.map.has('drawioApiFixedRoute')) continue;
        const npts = W.c.points || [];
        for (let j = 0; j < npts.length; j++) {
          const pt = npts[j];
          const along = vert ? pt.y : pt.x, perp = vert ? pt.x : pt.y;
          if (Math.abs(perp - lane) >= 2.5 || along <= lo || along >= hi) continue;
          // partenaire : voisin formant le segment d approche perpendiculaire
          for (const dj of [-1, 1]) {
            const nb = npts[j + dj];
            if (nb == null) continue;
            const straightPerp = vert ? Math.abs(nb.y - pt.y) < 0.6 : Math.abs(nb.x - pt.x) < 0.6;
            if (!straightPerp) continue;
            // le partenaire ne doit pas être collé à une ancre alignée
            const anchorIdx = dj === -1 ? j - 2 : j + 2;
            const beyond = anchorIdx < 0 ? W.pl[0] : (anchorIdx >= npts.length ? W.pl[W.pl.length - 1] : null);
            if (beyond != null) {
              const alignedToAnchor = vert ? Math.abs(beyond.y - pt.y) < 0.6 : Math.abs(beyond.x - pt.x) < 0.6;
              if (alignedToAnchor) continue;
            }
            branches.push({ W, j, dj, along });
            break;
          }
          break;
        }
      }
      if (process.env.DEBUG_TEES === '1' && branches.length > 0) {
        console.error(`[tees] tronc ${T.c.id} ${vert ? 'V' : 'H'} lane=${lane.toFixed(0)} [${lo.toFixed(0)},${hi.toFixed(0)}] branches=${branches.map((b2) => b2.W.c.id + '@' + b2.along.toFixed(0)).join(' ')}`);
      }
      if (branches.length === 0) continue;
      branches.sort((u, v2) => u.along - v2.along);
      const n = branches.length;
      branches.forEach((br, k) => {
        const target = lo + ((k + 1) * (hi - lo)) / (n + 1);
        if (process.env.DEBUG_TEES === '1') console.error(`[tees]   ${br.W.c.id}: ${br.along.toFixed(0)} -> ${target.toFixed(0)} ${Math.abs(target - br.along) < 10 ? 'proche' : (segOk2(br.W, vert ? { x: br.W.c.points[br.j].x, y: target } : { x: target, y: br.W.c.points[br.j].y }, vert ? { x: br.W.c.points[br.j + br.dj].x, y: target } : { x: target, y: br.W.c.points[br.j + br.dj].y }) ? 'OK' : 'segOk2-REFUS')}`);
        if (Math.abs(target - br.along) < 10) return;
        const npts = br.W.c.points.map((pp) => ({ ...pp }));
        const a2 = npts[br.j], b2 = npts[br.j + br.dj];
        const cand1 = vert ? { x: a2.x, y: target } : { x: target, y: a2.y };
        const cand2 = vert ? { x: b2.x, y: target } : { x: target, y: b2.y };
        if (!segOk2(br.W, cand1, cand2)) return;
        if (vert) { a2.y = target; b2.y = target; } else { a2.x = target; b2.x = target; }
        const el = allCells(model).find((x) => x.getAttribute('id') === br.W.c.id);
        setEdgePoints(el, npts);
        br.W.c.points = npts;
        br.W.pl = polylineOf(br.W.c, byId2);
      });
    }
  }
}

/** Répartit

/** Retire des waypoints les doublons consécutifs et les pointes A->B->A. */
/** Garde ultime contre le fil qui traverse son PROPRE corps (au-delà de
 * 8 px de son pin) : reroute en U par une échappée ±14 px du pin puis une
 * lane claire au-dessus/en dessous. Les tracés figés sont laissés. */
function fixOwnBodyThrough(model, vertices) {
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const ownFar = (seg0, seg1, v, own) => {
    const bx = { x: v.x + 1.5, y: v.y + 1.5, w: v.w - 3, h: v.h - 3 };
    const hit = Math.max(seg0.x, seg1.x) > bx.x && Math.min(seg0.x, seg1.x) < bx.x + bx.w &&
      Math.max(seg0.y, seg1.y) > bx.y && Math.min(seg0.y, seg1.y) < bx.y + bx.h;
    if (!hit) return 0;
    const cx2 = (x3) => Math.max(bx.x, Math.min(bx.x + bx.w, x3));
    const cy2 = (y3) => Math.max(bx.y, Math.min(bx.y + bx.h, y3));
    return Math.max(Math.hypot(cx2(seg0.x) - own.x, cy2(seg0.y) - own.y),
      Math.hypot(cx2(seg1.x) - own.x, cy2(seg1.y) - own.y));
  };
  for (const c of cells) {
    if (c.kind !== 'edge' || c.source == null || c.target == null || c.source === c.target) continue;
    if (c.style.map.has('drawioApiFixedRoute') || c.style.map.get('edgeStyle') === 'none') continue;
    const src = byId.get(c.source), tgt = byId.get(c.target);
    if (src == null || tgt == null || src.x == null || tgt.x == null) continue;
    const a = pinAbs(src, { x: parseFloat(c.style.map.get('exitX')), y: parseFloat(c.style.map.get('exitY')) });
    const b = pinAbs(tgt, { x: parseFloat(c.style.map.get('entryX')), y: parseFloat(c.style.map.get('entryY')) });
    if ([a.x, a.y, b.x, b.y].some(Number.isNaN)) continue;
    const pl = [a, ...(c.points || []), b];
    let bad = false;
    for (let i = 0; i + 1 < pl.length && !bad; i++) {
      for (const [vid, own] of [[c.source, a], [c.target, b]]) {
        const v = byId.get(vid);
        // TRANSISTORS seulement : sur les dipôles, la trace longe le corps
        // par construction et le reroute en U cascade (cherry 30 -> 2)
        if (!/nmos|pmos|mosfet|transistor/.test(v.style.map.get('shape') || '')) continue;
        if (ownFar(pl[i], pl[i + 1], v, own) > 8) { bad = true; break; }
      }
    }
    if (!bad) continue;
    // candidats U : échappée horizontale ±14 du pin source, lane au-dessus
    // ou en dessous des deux corps, descente sur le pin cible
    const clearSeg2 = (p, q) => !vertices.some((v) => {
      const hit = Math.max(p.x, q.x) > v.x + 1.5 && Math.min(p.x, q.x) < v.x + v.w - 1.5 &&
        Math.max(p.y, q.y) > v.y + 1.5 && Math.min(p.y, q.y) < v.y + v.h - 1.5;
      if (!hit) return false;
      if (v.id !== c.source && v.id !== c.target) return true;
      return ownFar(p, q, v, v.id === c.source ? a : b) > 8;
    });
    const yTop = Math.min(src.y, tgt.y), yBot = Math.max(src.y + src.h, tgt.y + tgt.h);
    let done = false;
    for (let k = 0; k < 5 && !done; k++) {
      for (const lane of [yTop - 24 - k * 14, yBot + 24 + k * 14]) {
        for (const esc of [-14, 14]) {
          for (const escB of [0, -14, 14]) {
          const wp = escB === 0
            ? [{ x: a.x + esc, y: a.y }, { x: a.x + esc, y: lane }, { x: b.x, y: lane }]
            : [{ x: a.x + esc, y: a.y }, { x: a.x + esc, y: lane },
               { x: b.x + escB, y: lane }, { x: b.x + escB, y: b.y }];
          const full = [a, ...wp, b];
          let ok2 = true;
          for (let i = 0; i + 1 < full.length && ok2; i++) {
            if (!clearSeg2(full[i], full[i + 1]) || hugsMosFlank(full[i], full[i + 1], vertices)) ok2 = false;
          }
          if (ok2) {
            const cellEl2 = allCells(model).find((el) => el.getAttribute('id') === c.id);
            if (cellEl2 != null) setEdgePoints(cellEl2, wp);
            done = true;
            break;
          }
          }
          if (done) break;
        }
        if (done) break;
      }
    }
  }
}

function cleanupDegeneratePoints(model) {
  for (const el of allCells(model)) {
    const c = cellInfo(el);
    if (c.kind !== 'edge' || !(c.points || []).length) continue;
    let pts = c.points.slice(), changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i + 1 < pts.length; i++) {
        if (Math.hypot(pts[i].x - pts[i + 1].x, pts[i].y - pts[i + 1].y) < 0.6) {
          pts.splice(i + 1, 1); changed = true; break;
        }
      }
      if (changed) continue;
      for (let i = 0; i + 2 < pts.length; i++) {
        if (Math.hypot(pts[i].x - pts[i + 2].x, pts[i].y - pts[i + 2].y) < 0.6) {
          pts.splice(i + 1, 2); changed = true; break; // pointe aller-retour
        }
      }
    }
    if (pts.length !== c.points.length) setEdgePoints(el, pts);
  }
}

function addContactDots(model) {
  const JDOT = 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;contactDot=1;';
  const dirOf = (from, to) => {
    const dx = to.x - from.x, dy = to.y - from.y;
    if (Math.hypot(dx, dy) < 0.5) return null;
    return ((Math.round((Math.atan2(dy, dx) / Math.PI) * 4) % 8) + 8) % 8;
  };
  // les dots sont une DÉCORATION recalculée : purge d'abord ceux des passes
  // précédentes (sinon ils survivent aux déplacements de l'optimiseur et
  // flottent en l'air à des coordonnées périmées)
  for (const el of allCells(model)) {
    if (el.getAttribute('vertex') === '1' && /contactDot=1/.test(el.getAttribute('style') || '')) {
      el.parentNode.removeChild(el);
    }
  }
  const cells = allCells(model).map(cellInfo);
  const byId2 = new Map(cells.map((c) => [c.id, c]));
  const edgeNet = netGroups(cells);
  const wires = cells.filter((c) => c.kind === 'edge' && c.source != null && c.target != null && c.source !== c.target);
  const existingDots = cells.filter((c) => c.kind === 'vertex' && c.style.map.has('drawioApiJunction'))
    .map((c) => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 }));
  const newDots = [];
  const onSeg = (pt, p, q) => {
    if (Math.abs(p.y - q.y) < 0.6) return Math.abs(pt.y - p.y) <= 2.5 && pt.x > Math.min(p.x, q.x) + 4 && pt.x < Math.max(p.x, q.x) - 4;
    if (Math.abs(p.x - q.x) < 0.6) return Math.abs(pt.x - p.x) <= 2.5 && pt.y > Math.min(p.y, q.y) + 4 && pt.y < Math.max(p.y, q.y) - 4;
    return false;
  };
  const selfWires0 = cells.filter((c) => c.kind === 'edge' && c.source != null && c.source === c.target);
  for (const A of wires.concat(selfWires0)) {
    const plA = polylineOf(A, byId2);
    if (plA == null) continue;
    for (const Bv of wires.concat(selfWires0)) {
      if (A === Bv || edgeNet.get(A.id) !== edgeNet.get(Bv.id)) continue;
      const plB = polylineOf(Bv, byId2);
      if (plB == null) continue;
      // TOUS les sommets (extrémités ET coins) : un coin posé sur le segment
      // d'un autre fil du même net est aussi une branche (té) à pointer —
      // SAUF si toutes ses directions incidentes sont colinéaires au segment
      // hôte (recouvrement, pas une branche : règle utilisateur du 2-voies)
      for (let pi = 0; pi < plA.length; pi++) {
        const pt = plA[pi];
        const inc = [];
        if (pi > 0) { const d = dirOf(pt, plA[pi - 1]); if (d != null) inc.push(d); }
        if (pi < plA.length - 1) { const d = dirOf(pt, plA[pi + 1]); if (d != null) inc.push(d); }
        for (let k = 0; k + 1 < plB.length; k++) {
          if (!onSeg(pt, plB[k], plB[k + 1])) continue;
          const horiz = Math.abs(plB[k].y - plB[k + 1].y) < 0.6;
          const axisDirs = horiz ? [0, 4] : [2, 6];
          if (inc.length > 0 && inc.every((d) => axisDirs.includes(d))) continue;
          if (existingDots.some((dd) => Math.hypot(dd.x - pt.x, dd.y - pt.y) < 5)) continue;
          if (newDots.some((dd) => Math.hypot(dd.x - pt.x, dd.y - pt.y) < 5)) continue;
          newDots.push({ x: pt.x, y: pt.y });
        }
      }
    }
  }
  // règle 30 (suite) : deux fils aboutissant au même PIN d'un composant font,
  // avec la broche elle-même, une branche à 3 voies -> point de contact ;
  // sur une cellule de jonction il faut >=3 fils (2 = simple traversée).
  // Clustering par DISTANCE réelle (pas de grille : une frontière de bucket
  // faisait rater des points de contact)
  const meet = [];
  for (const A of wires.concat(selfWires0)) {
    const plA = polylineOf(A, byId2);
    if (plA == null) continue;
    // fil quasi nul (tap collé sur le pin) : ses deux extrémités confondues
    // feraient un faux cluster à 2 voies -> dot fantôme dans le vide
    if (Math.hypot(plA[plA.length - 1].x - plA[0].x, plA[plA.length - 1].y - plA[0].y) < 3) continue;
    for (const [pt, cid, nb] of [[plA[0], A.source, plA[1]], [plA[plA.length - 1], A.target, plA[plA.length - 2]]]) {
      const c0 = meet.find((m) => Math.hypot(m.pt.x - pt.x, m.pt.y - pt.y) < 4);
      const d = nb != null ? dirOf(pt, nb) : null;
      if (c0 != null) { c0.cids.add(cid); if (d != null) c0.dirs.add(d); }
      else meet.push({ pt, cids: new Set([cid]), dirs: new Set(d != null ? [d] : []) });
    }
  }
  // RÈGLE UTILISATEUR : un point au milieu d'une ligne (2 directions de
  // cuivre) est INTERDIT — le dot n'existe qu'à >=3 directions distinctes
  // (la broche du composant compte comme une direction, vers son corps)
  for (const { pt, cids, dirs } of meet) {
    const all = new Set(dirs);
    for (const cid of cids) {
      const cell = byId2.get(cid);
      if (cell == null || cell.style.map.has('drawioApiJunction') || cell.x == null) continue;
      const d = dirOf(pt, { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 });
      if (d != null) all.add(d);
    }
    if (all.size < 3) continue;
    if (existingDots.some((dd) => Math.hypot(dd.x - pt.x, dd.y - pt.y) < 5)) continue;
    if (newDots.some((dd) => Math.hypot(dd.x - pt.x, dd.y - pt.y) < 5)) continue;
    newDots.push({ x: pt.x, y: pt.y });
  }
  let dseq = 0;
  for (const dd of newDots) {
    const doc = model.ownerDocument;
    const cell = doc.createElement('mxCell');
    cell.setAttribute('id', 'DOT' + (++dseq) + '_' + Math.round(dd.x) + '_' + Math.round(dd.y));
    cell.setAttribute('style', JDOT);
    cell.setAttribute('vertex', '1');
    cell.setAttribute('parent', '1');
    const g = doc.createElement('mxGeometry');
    g.setAttribute('x', String(dd.x - 3));
    g.setAttribute('y', String(dd.y - 3));
    g.setAttribute('width', '6');
    g.setAttribute('height', '6');
    g.setAttribute('as', 'geometry');
    cell.appendChild(g);
    model.getElementsByTagName('root')[0].appendChild(cell);
  }
}

/**
 * Interdit la superposition colinéaire de segments appartenant à des nets
 * différents (lecture électrique fausse). Réparation : décalage de lane du
 * segment mobile (waypoints intérieurs), sinon insertion d'un dog-leg.
 */
function separateNets(model, obstacles) {
  // les gros composants (transistors…) portent leur étiquette sous le corps :
  // la bande de 18 px sous eux est interdite aux lanes de réparation
  const zones = obstacles.flatMap((v) => v.h >= 80
    ? [v, { x: v.x, y: v.y + v.h, w: v.w, h: 18 }] : [v]);
  const blocked = (x1, y1, x2, y2) =>
    hugsMosFlank({ x: x1, y: y1 }, { x: x2, y: y2 }, obstacles) ||
    zones.some((v) =>
      Math.max(x1, x2) > v.x + 3 && Math.min(x1, x2) < v.x + v.w - 3 &&
      Math.max(y1, y2) > v.y + 3 && Math.min(y1, y2) < v.y + v.h - 3);
  const done = new Set();
  for (let repairs = 0; repairs < 30; repairs++) {
    const cells = allCells(model).map(cellInfo);
    const byId2 = new Map(cells.map((c) => [c.id, c]));
    const parent = new Map();
    const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
    const uni = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };
    const endKey = (c, which) => {
      const cid = which === 'src' ? c.source : c.target;
      const cell = byId2.get(cid);
      if (cell != null && cell.style.map.has('drawioApiJunction')) return 'J:' + cid;
      const X = c.style.map.get(which === 'src' ? 'exitX' : 'entryX');
      const Y = c.style.map.get(which === 'src' ? 'exitY' : 'entryY');
      return cid + ':' + X + ',' + Y;
    };
    const anchor = (c, pref, cell) => {
      const X = c.style.map.get(pref + 'X'), Y = c.style.map.get(pref + 'Y');
      if (X != null && Y != null) return pinAbsOf(cell, parseFloat(X), parseFloat(Y));
      const bb = rotatedAabb(cell);
      return { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
    };
    const edgesInfo = [];
    for (const c of cells) {
      if (c.kind !== 'edge' || c.source == null || c.target == null) continue;
      if (c.style.map.get('edgeStyle') === 'none') continue;
      const a = endKey(c, 'src'), b = endKey(c, 'tgt');
      uni(a, b);
      const src = byId2.get(c.source), tgt = byId2.get(c.target);
      if (src == null || tgt == null || src.x == null || tgt.x == null) continue;
      const pl = [anchor(c, 'exit', src), ...(c.points || []), anchor(c, 'entry', tgt)];
      const segs = [];
      for (let i = 0; i + 1 < pl.length; i++) {
        const p = pl[i], q = pl[i + 1];
        if (Math.abs(p.y - q.y) < 0.6 && Math.abs(p.x - q.x) >= 0.6) segs.push({ axis: 'h', lane: p.y, a: Math.min(p.x, q.x), b: Math.max(p.x, q.x), i });
        else if (Math.abs(p.x - q.x) < 0.6 && Math.abs(p.y - q.y) >= 0.6) segs.push({ axis: 'v', lane: p.x, a: Math.min(p.y, q.y), b: Math.max(p.y, q.y), i });
      }
      edgesInfo.push({ c, a, b, segs, pl, nPl: pl.length,
        fixed: c.style.map.has('drawioApiFixedRoute') });
    }
    let repaired = false;
    const delta = 14;
    // une lane cible est INTERDITE si un net étranger y possède déjà un
    // segment colinéaire recouvrant (sinon : ping-pong de shifts qui recrée
    // le recouvrement initial, vu sur le Gilbert)
    const laneOccupied = (ei, axis, lane2, l2, h2) => edgesInfo.some((other) =>
      other !== ei && find(other.a) !== find(ei.a) &&
      other.segs.some((s2) => s2.axis === axis && Math.abs(s2.lane - lane2) < 6 &&
        Math.min(s2.b, h2) - Math.max(s2.a, l2) > 10));
    // décaler un segment INTÉRIEUR (2 waypoints)
    const shift = (ei, seg, d) => {
      if (ei.fixed) return false; // tracé figé : c'est l'AUTRE fil qui bouge
      const npts = ei.c.points || [];
      if (!(seg.i >= 1 && seg.i <= npts.length - 1)) return false;
      if (laneOccupied(ei, seg.axis, seg.lane + d, seg.a, seg.b)) return false;
      const p = npts[seg.i - 1], q = npts[seg.i];
      if (seg.axis === 'h') {
        if (blocked(seg.a, seg.lane + d, seg.b, seg.lane + d)) return false;
        p.y += d; q.y += d;
      } else {
        if (blocked(seg.lane + d, seg.a, seg.lane + d, seg.b)) return false;
        p.x += d; q.x += d;
      }
      const el = allCells(model).find((x) => x.getAttribute('id') === ei.c.id);
      setEdgePoints(el, npts);
      return true;
    };
    // fil DROIT pin-à-pin (0 waypoint) : on le transforme en U sur une lane
    // libre — un segment unique entre deux ancres est sinon immobile
    const straighten = (ei, seg, d) => {
      if (ei.fixed) return false;
      if ((ei.c.points || []).length || ei.segs.length !== 1) return false;
      if (laneOccupied(ei, seg.axis, seg.lane + d, seg.a, seg.b)) return false;
      if (seg.axis === 'h' ? blocked(seg.a, seg.lane + d, seg.b, seg.lane + d)
                           : blocked(seg.lane + d, seg.a, seg.lane + d, seg.b)) return false;
      const el2 = allCells(model).find((x) => x.getAttribute('id') === ei.c.id);
      const p0 = ei.pl[0], p1 = ei.pl[ei.pl.length - 1];
      setEdgePoints(el2, seg.axis === 'h'
        ? [{ x: p0.x, y: seg.lane + d }, { x: p1.x, y: seg.lane + d }]
        : [{ x: seg.lane + d, y: p0.y }, { x: seg.lane + d, y: p1.y }]);
      return true;
    };
    outer:
    for (let i = 0; i < edgesInfo.length && !repaired; i++) {
      for (let j = i + 1; j < edgesInfo.length && !repaired; j++) {
        const A = edgesInfo[i], Bv = edgesInfo[j];
        if (find(A.a) === find(Bv.a)) continue;
        for (const sa of A.segs) {
          for (const sb of Bv.segs) {
            if (sa.axis !== sb.axis || Math.abs(sa.lane - sb.lane) > 5) continue;
            const lo = Math.max(sa.a, sb.a), hi = Math.min(sa.b, sb.b);
            if (hi - lo < 10) continue;
            const pairKey = [A.c.id, Bv.c.id, sa.axis, Math.round(lo), Math.round(hi)].join('|');
            if (done.has(pairKey)) {
              if (process.env.DEBUG_SEP === '1') console.error(`[sep] SKIP done ${A.c.source}->${A.c.target} vs ${Bv.c.source}->${Bv.c.target} ${sa.axis} lane=${sa.lane} [${lo},${hi}]`);
              continue;
            }
            done.add(pairKey);
            if (process.env.DEBUG_SEP === '1') console.error(`[sep] repair#${repairs} ${A.c.source}->${A.c.target} vs ${Bv.c.source}->${Bv.c.target} ${sa.axis} lane=${sa.lane} [${lo},${hi}]`);
            for (const d of [-delta, delta, -2 * delta, 2 * delta, -3 * delta, 3 * delta, -4 * delta, 4 * delta]) {
              if (shift(A, sa, d) || shift(Bv, sb, d) || straighten(A, sa, d) || straighten(Bv, sb, d)) {
                repaired = true; break outer;
              }
            }
            // 2) dog-leg sur le chevauchement du fil NON FIGÉ de la paire
            if (A.fixed && Bv.fixed) continue;
            const [Adl, sadl] = A.fixed ? [Bv, sb] : [A, sa];
            const el = allCells(model).find((x) => x.getAttribute('id') === Adl.c.id);
            const laneFreeFor = (d) =>
              !laneOccupied(Adl, sadl.axis, sadl.lane + d, lo, hi) &&
              !blocked(sadl.axis === 'h' ? lo : sadl.lane + d, sadl.axis === 'h' ? sadl.lane + d : lo,
                       sadl.axis === 'h' ? hi : sadl.lane + d, sadl.axis === 'h' ? sadl.lane + d : hi);
            let dgn = null;
            for (const d of [-delta, delta, -2 * delta, 2 * delta, -3 * delta, 3 * delta, -4 * delta, 4 * delta]) { if (laneFreeFor(d)) { dgn = d; break; } }
            if (dgn == null) {
              if (process.env.DEBUG_SEP === '1') console.error(`[sep] IRRÉPARABLE ${A.c.source}->${A.c.target} vs ${Bv.c.source}->${Bv.c.target} ${sa.axis} lane=${sa.lane} [${lo},${hi}]`);
              continue; // pas de lane libre : ne pas insérer un dog-leg qui recrée un conflit
            }
            const pts = Adl.c.points ? Adl.c.points.map((p) => ({ ...p })) : [];
            let jog = sadl.axis === 'h'
              ? [{ x: lo, y: sadl.lane }, { x: lo, y: sadl.lane + dgn }, { x: hi, y: sadl.lane + dgn }, { x: hi, y: sadl.lane }]
              : [{ x: sadl.lane, y: lo }, { x: sadl.lane + dgn, y: lo }, { x: sadl.lane + dgn, y: hi }, { x: sadl.lane, y: hi }];
            // ORDRE = direction réelle du segment (un segment tracé du max
            // vers le min recevait le jog à l'envers -> boucle dégénérée que
            // le nettoyage effaçait, conflit marqué réparé à tort)
            const segA = Adl.pl[sadl.i], segB2 = Adl.pl[sadl.i + 1];
            if ((sadl.axis === 'h' && segA.x > segB2.x) || (sadl.axis === 'v' && segA.y > segB2.y)) jog = jog.reverse();
            pts.splice(sadl.i, 0, ...jog);
            setEdgePoints(el, pts);
            repaired = true; break outer;
          }
        }
      }
    }
    if (!repaired) {
      // phase 2 : un segment qui frôle (<6 px) le PIN d'un autre net doit
      // s'écarter — ni libavoid ni un tracé droit ne connaissent les pins
      // (vu : la barre de sources du Gilbert posée sur le pin de M5)
      const dps = (pt, p, q) => {
        const dx = q.x - p.x, dy = q.y - p.y, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((pt.x - p.x) * dx + (pt.y - p.y) * dy) / L2)) : 0;
        return Math.hypot(pt.x - (p.x + t * dx), pt.y - (p.y + t * dy));
      };
      const pinsAll = [];
      for (const ei of edgesInfo) {
        pinsAll.push({ pt: ei.pl[0], root: find(ei.a) });
        pinsAll.push({ pt: ei.pl[ei.pl.length - 1], root: find(ei.a) });
      }
      outer2:
      for (const A of edgesInfo) {
        if (A.fixed) continue;
        for (const seg of A.segs) {
          const sp = seg.axis === 'h'
            ? [{ x: seg.a, y: seg.lane }, { x: seg.b, y: seg.lane }]
            : [{ x: seg.lane, y: seg.a }, { x: seg.lane, y: seg.b }];
          for (const P of pinsAll) {
            if (P.root === find(A.a)) continue;
            if (dps(P.pt, sp[0], sp[1]) >= 6) continue;
            // pin collé à une extrémité ancrée du fil : indéplaçable
            if (Math.min(...A.pl.map((pp) => Math.hypot(pp.x - P.pt.x, pp.y - P.pt.y))) < 1 &&
                seg.i !== 0 && seg.i !== A.nPl - 2) { /* coin exactement sur pin : réparable */ }
            const key = ['pin', A.c.id, Math.round(P.pt.x), Math.round(P.pt.y)].join('|');
            if (done.has(key)) continue;
            done.add(key);
            if (process.env.DEBUG_SEP === '1') console.error(`[sep] pin-frôlé ${A.c.source}->${A.c.target} près de (${Math.round(P.pt.x)},${Math.round(P.pt.y)})`);
            for (const d of [-delta, delta, -2 * delta, 2 * delta, -3 * delta, 3 * delta]) {
              if (shift(A, seg, d) || straighten(A, seg, d)) { repaired = true; break outer2; }
            }
            // dog-leg local : contourner le pin sur une lane libre
            const c0 = seg.axis === 'h' ? P.pt.x : P.pt.y;
            const lo2 = Math.max(seg.a, c0 - 14), hi2 = Math.min(seg.b, c0 + 14);
            if (hi2 - lo2 < 6) continue;
            let dgn2 = null;
            for (const d of [-delta, delta, -2 * delta, 2 * delta]) {
              const free = !laneOccupied(A, seg.axis, seg.lane + d, lo2, hi2) &&
                !blocked(seg.axis === 'h' ? lo2 : seg.lane + d, seg.axis === 'h' ? seg.lane + d : lo2,
                         seg.axis === 'h' ? hi2 : seg.lane + d, seg.axis === 'h' ? seg.lane + d : hi2);
              if (free) { dgn2 = d; break; }
            }
            if (dgn2 == null) continue;
            const el3 = allCells(model).find((x) => x.getAttribute('id') === A.c.id);
            const pts3 = A.c.points ? A.c.points.map((pp) => ({ ...pp })) : [];
            let jog2 = seg.axis === 'h'
              ? [{ x: lo2, y: seg.lane }, { x: lo2, y: seg.lane + dgn2 }, { x: hi2, y: seg.lane + dgn2 }, { x: hi2, y: seg.lane }]
              : [{ x: seg.lane, y: lo2 }, { x: seg.lane + dgn2, y: lo2 }, { x: seg.lane + dgn2, y: hi2 }, { x: seg.lane, y: hi2 }];
            const sgA = A.pl[seg.i], sgB = A.pl[seg.i + 1];
            if ((seg.axis === 'h' && sgA.x > sgB.x) || (seg.axis === 'v' && sgA.y > sgB.y)) jog2 = jog2.reverse();
            pts3.splice(seg.i, 0, ...jog2);
            setEdgePoints(el3, pts3);
            repaired = true; break outer2;
          }
        }
      }
    }
    if (!repaired) break;
  }
}

/** Aplatis les motifs H-V-H / V-H-V dont le segment central est court. */
function polishJogs(model, obstacles, tol) {
  const cells = allCells(model).map(cellInfo);
  const byId2 = new Map(cells.map((c) => [c.id, c]));
  const boxes = obstacles.map((v) => ({ x: v.x + 3, y: v.y + 3, w: v.w - 6, h: v.h - 6, id: v.id }));
  // le lissage ne doit pas recoller un fil sur un canal de MOS (il écrasait
  // les échappées de 14 px, plus petites que sa tolérance)
  const blocked = (x1, y1, x2, y2, skip) => hugsMosFlank({ x: x1, y: y1 }, { x: x2, y: y2 }, obstacles) ||
    boxes.some((b) => !skip.has(b.id) &&
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
