/**
 * crossings.js — number of wire crossings in a drawing: proper intersections
 * (a single point interior to both segments) between wires of DIFFERENT nets.
 * Touching at an end, T-junctions and same-net contacts do not count.
 *
 * Idea taken from layered graph drawing (ELK / Sugiyama: crossing minimisation
 * is a first-class objective) and from the benchmark of the placement engines
 * (drawio-placement, 300 circuits), where `auto` chose drawings with more
 * crossings than another candidate it had already drawn. Written from scratch;
 * no code copied from ELK (EPL-2.0).
 */
import { allCells, cellInfo } from './model.js';
import { polylineOf, netGroups } from './route.js';

const EPS = 1e-9;

function properCross(a0, a1, b0, b1) {
  const d1x = a1.x - a0.x, d1y = a1.y - a0.y, d2x = b1.x - b0.x, d2y = b1.y - b0.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) <= EPS) return false;              // parallel or collinear
  const ex = b0.x - a0.x, ey = b0.y - a0.y;
  const t = (ex * d2y - ey * d2x) / den, u = (ex * d1y - ey * d1x) / den;
  return t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS;
}

/** Crossings between wires of different nets of a drawing model. */
export function crossingCount(model) {
  const cells = allCells(model).map(cellInfo), byId = new Map(cells.map((c) => [c.id, c]));
  const net = netGroups(cells), segs = [];
  for (const e of cells) {
    if (e.kind !== 'edge') continue;
    const pl = polylineOf(e, byId);
    if (!pl) continue;
    for (let i = 1; i < pl.length; i++) segs.push({ net: net.get(e.id), a: pl[i - 1], b: pl[i] });
  }
  let n = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    if (segs[i].net === segs[j].net) continue;
    if (properCross(segs[i].a, segs[i].b, segs[j].a, segs[j].b)) n++;
  }
  return n;
}
