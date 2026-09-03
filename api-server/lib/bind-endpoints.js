/**
 * bind-endpoints.js — repair pass (task C, 2026-08-31): bind a free
 * (unattached) wire endpoint to a junction cell ONLY when the endpoint's raw
 * point coincides with that junction's centre within a TIGHT tolerance
 * (default 2 px).
 *
 * Why tight, and why report rather than silently fix: AGENTS.md domain
 * correction #1 is "map ports BY NAME, never by position" — binding an
 * endpoint to whatever junction happens to be NEAREST is exactly that same
 * positional-proximity mistake wearing a different hat (a pin gets silently
 * reassigned to the wrong node). A 0.2 px coincidence is overwhelmingly a
 * "the user meant this dot, the wire just never got attached" slip; a 32 px
 * or 49 px gap is a different, real editing gap (a wire that was never
 * finished) and must NOT be papered over by treating "nearest" as "correct".
 * So this pass only acts inside the tolerance, and always reports what it did
 * NOT act on, with the measured distance, never silently.
 *
 * Binding convention (mirrors model.js addWire's pin-pinned anchors and the
 * "recent hidden-junction fix"): exit/entryX=0.5, exit/entryY=0.5,
 * exit/entryDx=0, exit/entryDy=0, exit/entryPerimeter=0 — pinned dead centre
 * on the junction cell, independent of its perimeter shape.
 *
 * OUT OF SCOPE (deliberately, see the caller / AGENTS.md task brief): the
 * `floating-endpoint` ERC class (a wire attached to a component id but with
 * no exit/entry pin anchor, pin guessed by proximity in netlist.js) is a
 * DIFFERENT defect at a DIFFERENT stage (attached-but-unanchored, vs. this
 * module's attached-to-nothing) and is left exactly as-is.
 */
import { allCells, cellInfo, mxCellPart, updateCell } from './model.js';
import { isJunctionCell } from './components.js';

const DEFAULT_TOLERANCE = 2; // px

/** Raw (relative-to-page) point of an edge's free source/targetPoint, or null
 *  if the edge has no such point recorded (e.g. it was never dragged there). */
function rawFreePoint(edgeNode, which) {
  const mx = mxCellPart(edgeNode);
  if (mx == null) return null;
  let geom = null;
  for (let c = mx.firstChild; c != null; c = c.nextSibling) {
    if (c.nodeType === 1 && c.nodeName === 'mxGeometry') { geom = c; break; }
  }
  if (geom == null) return null;
  for (const p of Array.from(geom.childNodes)) {
    if (p.nodeType === 1 && p.nodeName === 'mxPoint' && p.getAttribute('as') === which) {
      const x = parseFloat(p.getAttribute('x'));
      const y = parseFloat(p.getAttribute('y'));
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }
  }
  return null;
}

/** Remove the now-redundant sourcePoint/targetPoint mxPoint once an endpoint
 *  is bound to a real cell (mxGraph ignores it once `source`/`target` is set,
 *  but a stale coordinate left behind is a trap for the next reader/tool). */
function clearRawFreePoint(edgeNode, which) {
  const mx = mxCellPart(edgeNode);
  if (mx == null) return;
  let geom = null;
  for (let c = mx.firstChild; c != null; c = c.nextSibling) {
    if (c.nodeType === 1 && c.nodeName === 'mxGeometry') { geom = c; break; }
  }
  if (geom == null) return;
  for (const p of Array.from(geom.childNodes)) {
    if (p.nodeType === 1 && p.nodeName === 'mxPoint' && p.getAttribute('as') === which) geom.removeChild(p);
  }
}

/**
 * bindEndpoints(model, {tolerance}) — scans every edge for a free (unbound)
 * source or target end, and binds it to the nearest junction cell when that
 * junction's centre is within `tolerance` px of the recorded free point.
 *
 * Returns {bound:[{edge,end,junction,distance}], unresolved:[{edge,end,
 * distance,nearestJunction}]} — every free endpoint examined lands in
 * exactly one of the two lists, never silently dropped.
 */
export function bindEndpoints(model, opts = {}) {
  const tolerance = opts.tolerance != null ? Number(opts.tolerance) : DEFAULT_TOLERANCE;
  const nodes = allCells(model);
  const infos = nodes.map(cellInfo);
  const byId = new Map();
  nodes.forEach((n, i) => byId.set(infos[i].id, { node: n, info: infos[i] }));

  const junctions = infos.filter((c) => c.kind === 'vertex' && isJunctionCell(c) && c.x != null)
    .map((c) => ({ id: c.id, x: c.x + c.w / 2, y: c.y + c.h / 2 }));

  const bound = [];
  const unresolved = [];

  nodes.forEach((edgeNode, i) => {
    const e = infos[i];
    if (e.kind !== 'edge') return;
    for (const [which, end] of [['sourcePoint', 'source'], ['targetPoint', 'target']]) {
      const boundId = end === 'source' ? e.source : e.target;
      if (boundId != null) continue; // already attached to a real cell — not this pass's concern
      const pt = rawFreePoint(edgeNode, which);
      if (pt == null) continue; // no recorded free point either (degenerate edge) — nothing to bind
      let best = null, bd = Infinity;
      for (const j of junctions) {
        const d = Math.hypot(j.x - pt.x, j.y - pt.y);
        if (d < bd) { bd = d; best = j; }
      }
      if (best == null) {
        unresolved.push({ edge: e.id, end, distance: null, nearestJunction: null });
        continue;
      }
      if (bd <= tolerance) {
        updateCell(model, e.id, {
          [end]: best.id,
          style: {
            [end === 'source' ? 'exitX' : 'entryX']: 0.5,
            [end === 'source' ? 'exitY' : 'entryY']: 0.5,
            [end === 'source' ? 'exitDx' : 'entryDx']: 0,
            [end === 'source' ? 'exitDy' : 'entryDy']: 0,
            [end === 'source' ? 'exitPerimeter' : 'entryPerimeter']: 0,
          },
        });
        clearRawFreePoint(edgeNode, which);
        bound.push({ edge: e.id, end, junction: best.id, distance: Math.round(bd * 100) / 100 });
      } else {
        unresolved.push({ edge: e.id, end, distance: Math.round(bd * 100) / 100, nearestJunction: best.id });
      }
    }
  });

  return { bound, unresolved, tolerance };
}
