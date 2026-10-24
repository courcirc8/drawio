/**
 * geo-lvs.js — GEOMETRIC LVS: the connectivity a reader SEES, checked against
 * the connectivity the document DECLARES (edge source/target).
 *
 * Why (schemas-lisibles, 2026-10-24): the LVS (lib/lvs.js) is topological; a
 * drawing could show wires ending in the void, T joins without a dot, or a
 * wire running over a foreign pin and still pass. The orchestrator made this
 * check mandatory for engine "manuel" ("fils dans le vide = échec").
 *
 * Only edges drawn as polylines (edgeStyle=none, or an explicit
 * drawioApiFixedRoute) are judged: their rendered path is exactly
 * pin -> waypoints -> pin. Errors:
 *  - dangling       an edge without source or target, a junction with < 2 wires,
 *                   a visible dot joining only 2 wires (a dot that means nothing)
 *  - tee-no-dot     a wire end on the inside of another wire, no junction there
 *  - over-pin       a wire passing over a pin it is not attached to
 *  - through-body   a wire crossing the body of a component
 *  - overlap        two wires running on top of each other
 *  - oblique        a non-orthogonal segment
 */
import { allCells, cellInfo } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, rotatedAabb } from './route.js';

const EPS = 0.6;

function edgePath(e, byId) {
  const a = byId.get(e.source), b = byId.get(e.target);
  if (!a || !b) return null;
  const end = (c, pre) => {
    const x = e.style.map.get(pre + 'X'), y = e.style.map.get(pre + 'Y');
    if (x == null || y == null) return { x: c.x + c.w / 2, y: c.y + c.h / 2 };
    return pinOn(c, { x: Number(x), y: Number(y) });
  };
  return [end(a, 'exit'), ...e.points, end(b, 'entry')];
}
/** a pin as drawn: drawio turns the anchors of a shape with direction=west
 *  (or north / south) with the shape; pinAbs only knows rotation and flips */
function pinOn(c, rel) {
  const d = c.style.map.get('direction');
  let { x, y } = rel;
  if (d === 'west') { x = 1 - x; y = 1 - y; }
  else if (d === 'north') [x, y] = [y, 1 - x];
  else if (d === 'south') [x, y] = [1 - y, x];
  return pinAbs(c, { x, y });
}
const onSegInterior = (p, a, b) => {
  if (Math.abs(a.x - b.x) < EPS) return Math.abs(p.x - a.x) < EPS && p.y > Math.min(a.y, b.y) + EPS && p.y < Math.max(a.y, b.y) - EPS;
  if (Math.abs(a.y - b.y) < EPS) return Math.abs(p.y - a.y) < EPS && p.x > Math.min(a.x, b.x) + EPS && p.x < Math.max(a.x, b.x) - EPS;
  return false;
};
const same = (p, q) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;

export function geoLvs(model) {
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const errors = [], warnings = [];
  const err = (rule, msg, at) => errors.push({ rule, msg, ...(at ? { at: { x: Math.round(at.x), y: Math.round(at.y) } } : {}) });
  const verts = cells.filter((c) => c.kind === 'vertex');
  const role = new Map(verts.map((v) => [v.id, classify(v)]));
  // pins of every electrical vertex
  const pins = [];
  for (const v of verts) {
    const r = role.get(v.id);
    if (!r || r.role === 'other' || r.role === 'junction') continue;
    for (const p of activePins(r)) pins.push({ id: v.id, ...pinOn(v, p) });
  }
  const edges = cells.filter((c) => c.kind === 'edge');
  const judged = [];
  for (const e of edges) {
    if (!e.source || !e.target) { err('dangling', `wire ${e.id} has a free end`); continue; }
    const fixed = e.style.map.get('edgeStyle') === 'none' || e.style.map.get('drawioApiFixedRoute') === '1';
    if (!fixed) continue;
    const path = edgePath(e, byId);
    if (!path) { err('dangling', `wire ${e.id} ends on a missing cell`); continue; }
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      if (Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS) err('oblique', `wire ${e.id} has a slanted segment`, a);
    }
    judged.push({ e, path });
  }
  // junctions: at least 2 wires; a visible dot means 3 or more
  const deg = new Map();
  for (const e of edges) for (const id of [e.source, e.target]) deg.set(id, (deg.get(id) || 0) + 1);
  for (const v of verts) {
    if (role.get(v.id)?.role !== 'junction') continue;
    const d = deg.get(v.id) || 0;
    const at = { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    // a decorative contact dot (route.js addContactDots) sits ON wires without being their end
    const onWire = judged.some(({ path }) => path.some((q, i) => same(q, at) || (i > 0 && onSegInterior(at, path[i - 1], q))));
    if (d < 2 && !(d === 0 && onWire)) err('dangling', `junction ${v.id} joins ${d} wire`, at);
    else if (d === 2 && v.style.map.get('contactDot') === '1' && v.style.map.get('fillColor') !== 'none') warnings.push({ rule: 'dot-2', msg: `dot ${v.id} joins only 2 wires` });
  }
  const dots = verts.filter((v) => role.get(v.id)?.role === 'junction').map((v) => ({ id: v.id, x: v.x + v.w / 2, y: v.y + v.h / 2 }));
  // wire ends on the inside of another wire
  for (const A of judged) {
    for (const end of [A.path[0], A.path[A.path.length - 1]]) {
      for (const B of judged) {
        if (B === A) continue;
        for (let i = 1; i < B.path.length; i++) {
          if (onSegInterior(end, B.path[i - 1], B.path[i]) && !dots.some((d) => same(d, end))) err('tee-no-dot', `wire ${A.e.id} ends on wire ${B.e.id} without a junction`, end);
        }
      }
    }
  }
  // wires over foreign pins and through bodies
  const bodies = verts.filter((v) => ['component'].includes(role.get(v.id)?.role) || (role.get(v.id)?.mapping != null));
  for (const { e, path } of judged) {
    const own = new Set([e.source, e.target]);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      for (const p of pins) {
        if (own.has(p.id) && (same(p, path[0]) || same(p, path[path.length - 1]))) continue;
        if (same(p, a) && i - 1 > 0) err('over-pin', `wire ${e.id} turns on a pin of ${p.id}`, p);
        else if (onSegInterior(p, a, b)) err('over-pin', `wire ${e.id} runs over a pin of ${p.id}`, p);
      }
      for (const v of bodies) {
        const bb = rotatedAabb(v), m = 4;
        const x0 = bb.x + m, x1 = bb.x + bb.w - m, y0 = bb.y + m, y1 = bb.y + bb.h - m;
        if (x1 <= x0 || y1 <= y0) continue;
        const hit = Math.abs(a.x - b.x) < EPS
          ? a.x > x0 && a.x < x1 && Math.max(a.y, b.y) > y0 && Math.min(a.y, b.y) < y1
          : a.y > y0 && a.y < y1 && Math.max(a.x, b.x) > x0 && Math.min(a.x, b.x) < x1;
        if (hit) err('through-body', `wire ${e.id} crosses ${v.id}`, a);
      }
    }
  }
  // two wires on top of each other
  for (let i = 0; i < judged.length; i++) for (let j = i + 1; j < judged.length; j++) {
    const P = judged[i].path, Q = judged[j].path;
    for (let k = 1; k < P.length; k++) for (let l = 1; l < Q.length; l++) {
      const a = P[k - 1], b = P[k], c = Q[l - 1], d = Q[l];
      const vert = Math.abs(a.x - b.x) < EPS && Math.abs(c.x - d.x) < EPS && Math.abs(a.x - c.x) < EPS;
      const hor = Math.abs(a.y - b.y) < EPS && Math.abs(c.y - d.y) < EPS && Math.abs(a.y - c.y) < EPS;
      const ov = vert ? Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y))
        : hor ? Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) : -1;
      if (ov > EPS) err('overlap', `wires ${judged[i].e.id} and ${judged[j].e.id} overlap`, vert ? { x: a.x, y: Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) } : { x: Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)), y: a.y });
    }
  }
  return { ok: errors.length === 0, judged: judged.length, errors, warnings };
}
