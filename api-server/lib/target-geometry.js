/**
 * target-geometry.js — while auto draws for a target tool (xschem, KiCad…),
 * the stencils of the profiled parts get the size and pin positions of that
 * tool's symbols (docs/export-multi-outils.md: placement in the target's
 * geometry). One run at a time: the stencil catalog is shared.
 */
import { getShape } from './stencils.js';

/** Stencil geometry from symbol pins already in the target's units and in the
 *  orientation matching the stencil's native one: {w, h, pins (relative)}. */
export function stencilFromPins(pts, { thick = 20, pad = [0, 0, 0, 0] } = {}) {
  const xs = Object.values(pts).map((p) => p[0]), ys = Object.values(pts).map((p) => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // a two-pin part has no width across its pins: give it its body's thickness
  if (x1 - x0 < 1) { x0 -= thick / 2; x1 += thick / 2; }
  if (y1 - y0 < 1) { y0 -= thick / 2; y1 += thick / 2; }
  // room for the text the tool writes beside the symbol (left, top, right, bottom)
  x0 -= pad[0]; y0 -= pad[1]; x1 += pad[2]; y1 += pad[3];
  const w = x1 - x0, h = y1 - y0;
  return { w, h, pins: Object.entries(pts).map(([name, p]) => ({ name, x: (p[0] - x0) / w, y: (p[1] - y0) / h })) };
}

let lock = Promise.resolve();
/** Run fn with the stencils in `geom` ({stencilKey: {w, h, pins}}) swapped in. */
export function withStencilGeometry(geom, fn) {
  const run = lock.then(async () => {
    const saved = [];
    try {
      for (const [key, g] of Object.entries(geom)) {
        const s = getShape(key); if (!s) continue;
        saved.push([s, { w: s.w, h: s.h, pins: s.pins }]);
        Object.assign(s, g);
      }
      return await fn();
    } finally { for (const [s, g] of saved) Object.assign(s, g); }
  });
  lock = run.catch(() => {});
  return run;
}

/** The orientation (among `orients`, each a function pin → position) placing
 *  every symbol pin on its drawn pin: {orient, at} or null. */
export function fitOrientation(symPins, drawn, orients) {
  const names = Object.keys(drawn);
  for (const o of orients) {
    const [n0] = names, t0 = o.f(symPins[n0]), at = [drawn[n0][0] - t0[0], drawn[n0][1] - t0[1]];
    if (names.every((n) => { const t = o.f(symPins[n]); return Math.abs(at[0] + t[0] - drawn[n][0]) < 0.6 && Math.abs(at[1] + t[1] - drawn[n][1]) < 0.6; })) return { orient: o, at };
  }
  return null;
}
