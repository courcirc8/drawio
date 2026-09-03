/**
 * rewire.js — re-wire an ALREADY-PLACED schematic from a SPICE netlist, using
 * the junction dots already present in the model as the ONLY intermediate
 * routing nodes. Never moves a cell: placement (component/ground/port/dot
 * geometry) is the user's and is untouched.
 *
 * Origin: a hand-placed drawio file (BOM_2446(1).drawio) had its wires
 * deleted except for a handful of junction dots the user positioned
 * deliberately to mark bus/branch points. This module puts the wires back
 * through those dots, under a hard constraint: every drawn segment is
 * strictly horizontal or vertical (checked by tools/check.py's `diagonal`
 * rule, severity error).
 *
 * ALGORITHM (do not improvise a different one — this is the agreed spec):
 *  1. Parse the netlist (netlist.js parseSpice) and resolve each device's
 *     pins to absolute points via components.js classify()/activePins() and
 *     route.js pinAbs() (rotation/flipH-aware).
 *  2. Collect the model's junction dots (style has drawioApiJunction) as
 *     candidate Steiner nodes, plus ground and port cells' own terminals.
 *  3. Build an undirected graph over {pins} ∪ {dots}: an edge exists between
 *     two nodes only if they share an X or a Y within TOL px AND the
 *     straight segment between them does not cross any component body AABB
 *     (excluding the two endpoints' own cells). Edge weight = Manhattan
 *     length.
 *  4. Per net, compute a minimum spanning tree over that net's terminals,
 *     allowing dots as Steiner points, then prune degree-1 dot leaves (they
 *     added no connectivity). A dot may serve only one net.
 *  5. Emit one drawio edge per tree edge with explicit exit/entry anchors and
 *     waypoints forming an exactly-H-or-V polyline.
 *
 * GROUND is handled separately from ordinary nets: netlist.js's own
 * connectivity() treats every ground symbol as independently "0" without
 * requiring wires between ground symbols (real schematics don't wire grounds
 * to each other). So net "0" is not spanned as one shared tree; instead each
 * grounded device pin is paired 1:1 with the nearest reachable, still-
 * unclaimed ground symbol (see wireGroundNet()).
 *
 * DOT CONTENTION: dots are a shared, finite resource. Nets are processed in
 * decreasing terminal-count order (bus nets first) so a small net does not
 * accidentally steal a dot a bus net structurally needs. Before committing a
 * net's constrained (claimed-dots-excluded) solve, an UNCONSTRAINED
 * (all-dots-available) tentative solve is also computed purely to detect
 * whether this net would have wanted a dot another net already claimed —
 * if so that is reported as a `dot-contention` warning (never resolved
 * silently), in addition to whatever the constrained solve actually managed.
 *
 * KNOWN UNSPANNABLE CASE, confirmed against the real 2446 file: a port glyph
 * is a real obstacle (24x24, above OBSTACLE_MIN) like any component, and its
 * own W/E pin sits at the LEFT/RIGHT edge of that box — a wire leaving W/E
 * horizontally toward the rest of the net travels straight through the box's
 * own interior. tools/check.py's `through` rule (its own `through_pin_slack`
 * of 8px, independently checked against this exact case) would flag that
 * penetration (measured 22px here) as an error if it were drawn, so
 * segmentBlocked() is right to refuse it — not an over-strict bug to relax.
 * When a port's N/S pins also fail to align (by X) with any dot, and its
 * only historically-working path ran THROUGH a component pin now correctly
 * capped at degree 1 (see buildForest's degree-cap note), the port has no
 * valid single-bend path under this algorithm and is reported unreachable —
 * an honest structural limit of the placement, not a solver defect.
 */
import { allCells, cellInfo, addWire, deleteCell, updateCell } from './model.js';
import { classify, activePins, pinOrderFor, identityOf, isJunctionCell } from './components.js';
import { pinAbs, rotatedAabb, offsetEdgeLabels } from './route.js';
import { parseSpice } from './netlist.js';
import { connectivityFingerprint, assertGeometryOnly } from './invariant.js';

const DEFAULT_TOL = 8;      // px: "share an X or a Y" tolerance
const SNAP_EPS = 0.6;       // below this, treat as exactly aligned (check.py's own epsilon)
const OBSTACLE_MIN = 12;    // px: cells smaller than this (dots) are never obstacles

/** Axis-aligned obstacle rectangles: every real (non-dot) vertex cell. */
export function obstaclesOf(cells) {
  const out = [];
  for (const c of cells) {
    if (c.kind !== 'vertex' || c.x == null) continue;
    if (isJunctionCell(c)) continue; // dots (ours or a user waypoint) are never obstacles
    if (c.style.map.has('apiAnnotation')) continue;      // decorative text, not a body
    const b = rotatedAabb(c);
    if (b.w < OBSTACLE_MIN && b.h < OBSTACLE_MIN) continue;
    out.push({ ...b, ownerId: c.id });
  }
  return out;
}

/**
 * True if the closed segment p-q crosses a component body it has no business
 * being in.
 *
 * DEFECT (found running the real 2446 file): the first version excluded an
 * obstacle from the check ENTIRELY whenever it belonged to one of the
 * segment's own endpoint cells — so a wire leaving C6's "in" pin (on the
 * FLIPPED side, per flipH) was free to run the full 100px width of C6's own
 * body to reach a dot on the far side, because "it's C6's own body" was
 * treated as always safe. tools/check.py caught it as `through` +
 * `wrap-around` + two wires overlapping across all of C6's width (`22`,
 * `22-contact`, `pin-clearance`) — a real short-looking overlap, not a
 * diagonal. route.js's own `clear()`/`okSeg()` (used for exactly this
 * problem elsewhere in this codebase) has the fix: the endpoint's OWN body
 * is only safe to graze NEAR that endpoint's own point (<=8px away, clamped
 * into the box) — beyond that it blocks like any other obstacle. Mirrored
 * here instead of re-deriving it differently.
 *
 * `own` maps a cellId to the ONE absolute point that cellId is allowed to
 * approach its own body from (undefined for a dot/corner — no immunity).
 */
function segmentBlocked(p, q, obstacles, own) {
  const eps = 1.5;
  for (const o of obstacles) {
    const hit = Math.max(p.x, q.x) > o.x + eps && Math.min(p.x, q.x) < o.x + o.w - eps &&
      Math.max(p.y, q.y) > o.y + eps && Math.min(p.y, q.y) < o.y + o.h - eps;
    if (!hit) continue;
    const anchor = own.get(o.ownerId);
    if (anchor == null) return true; // unrelated body: always blocking
    const clampX = (x) => Math.max(o.x + eps, Math.min(o.x + o.w - eps, x));
    const clampY = (y) => Math.max(o.y + eps, Math.min(o.y + o.h - eps, y));
    const far = Math.max(
      Math.hypot(clampX(p.x) - anchor.x, clampY(p.y) - anchor.y),
      Math.hypot(clampX(q.x) - anchor.x, clampY(q.y) - anchor.y));
    if (far > 8) return true; // strayed past the immediate pin neighbourhood
  }
  return false;
}

/**
 * A candidate edge between two graph nodes, or null if they don't qualify.
 * Nodes are {id, x, y} (id = owning cell id; dots and pins share this shape).
 * Returns {weight, waypoints:[{x,y}...]} — waypoints EXCLUDE the two
 * endpoints themselves (same convention as addWire's `points`).
 */
function tryEdge(u, v, obstacles, tol) {
  if (u.id === v.id) return null;
  const dx = Math.abs(u.x - v.x), dy = Math.abs(u.y - v.y);
  // Map each endpoint's OWNING cell to its own anchor point (see
  // segmentBlocked's defect note) — not the graph-node id, which for a
  // device terminal is `cellId#net`, never obstaclesOf()'s ownerId.
  const own = new Map([[u.cellId, u], [v.cellId, v]]);
  if (dx < SNAP_EPS && dy < SNAP_EPS) return null; // coincident, not a useful edge
  if (dy <= tol && dx >= SNAP_EPS) {
    // horizontal-ish: run at u.y, short vertical jog at v.x to land on v.y
    if (dy < SNAP_EPS) {
      if (segmentBlocked(u, v, obstacles, own)) return null;
      return { weight: dx, waypoints: [] };
    }
    const corner = { x: v.x, y: u.y };
    if (segmentBlocked(u, corner, obstacles, own) || segmentBlocked(corner, v, obstacles, own)) return null;
    return { weight: dx + dy, waypoints: [corner] };
  }
  if (dx <= tol && dy >= SNAP_EPS) {
    // vertical-ish: run at u.x, short horizontal jog at v.y to land on v.x
    const corner = { x: u.x, y: v.y };
    if (segmentBlocked(u, corner, obstacles, own) || segmentBlocked(corner, v, obstacles, own)) return null;
    return { weight: dx + dy, waypoints: [corner] };
  }
  return null; // neither X nor Y shared within tolerance: not a graph edge (spec, not a bug)
}

/** Kruskal MST over `nodes` using only edges `tryEdge` accepts. Returns
 * {edges:[{a,b,edge}], components:Map<nodeId,rootId>} — edges only span
 * nodes within the same resulting spanning-forest component; a net whose
 * terminals land in >1 component could not be fully spanned.
 *
 * BUG FOUND running the real gate (3rd instance): plain Kruskal has no
 * notion that a non-dot terminal (a component pin, port, or ground symbol)
 * is a real electrical lead with exactly ONE wire attaching to it — only a
 * drawn junction dot may be a multi-way branch. On the real file the
 * cheapest tree for net Bp routed straight THROUGH C1's own pin (degree 2:
 * one leg to DOT2, one leg to port P_Bp) because that pin happened to sit on
 * the shortest path between them. check.py's `30` rule correctly flagged
 * this as ">=3 directions with no contact dot" at C1's own pin (the wire
 * legs plus the component's own lead = 3 directions).
 *
 * FIRST FIX ATTEMPT (capping non-dot degree at 1 DURING the greedy Kruskal
 * pass, i.e. skip an edge outright the moment it would over-use a terminal)
 * was wrong in a different way: plain greedy has no lookahead, so skipping
 * an edge can strand its FAR endpoint with no alternative at all, even
 * though a perfectly good rerouting exists. Measured regression: 39 wires
 * with 2 unreachable became 33 wires with 6 unreachable (four legitimate
 * ports newly stranded) on the very next gate run. Replaced with a
 * build-then-REPAIR pass: build the plain (uncapped) MST first, then for
 * every non-dot node left with degree>1, keep its cheapest edge and for
 * each excess edge, physically detach it and re-attach the now-orphaned
 * side to the surviving tree via the cheapest still-valid edge that does
 * not itself violate any node's degree cap. Only a side that truly has no
 * such edge becomes unreachable — an honest "no valid path exists", not an
 * artifact of Kruskal's lack of backtracking.
 */
function buildForest(nodes, obstacles, tol) {
  const isDotId = new Set(nodes.filter((n) => n.isDot).map((n) => n.id));
  const nodeIds = nodes.map((n) => n.id);
  const candidates = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const e = tryEdge(nodes[i], nodes[j], obstacles, tol);
      if (e != null) candidates.push({ a: nodes[i], b: nodes[j], ...e });
    }
  }
  candidates.sort((x, y) => x.weight - y.weight);

  // ---- plain Kruskal (no degree cap) ----
  const parent0 = new Map(nodeIds.map((id) => [id, id]));
  const find0 = (k) => { while (parent0.get(k) !== k) k = parent0.get(k); return k; };
  let treeEdges = [];
  for (const c of candidates) {
    if (find0(c.a.id) === find0(c.b.id)) continue;
    parent0.set(find0(c.a.id), find0(c.b.id));
    treeEdges.push(c);
  }

  // ---- repair: no non-dot node may end up with degree > 1 ----
  const adj = new Map(nodeIds.map((id) => [id, []]));
  for (const e of treeEdges) { adj.get(e.a.id).push(e); adj.get(e.b.id).push(e); }
  const otherEnd = (e, id) => (e.a.id === id ? e.b.id : e.a.id);
  const removeFromAdj = (e) => {
    adj.set(e.a.id, adj.get(e.a.id).filter((x) => x !== e));
    adj.set(e.b.id, adj.get(e.b.id).filter((x) => x !== e));
  };
  const componentOf = (startId) => {
    const seen = new Set([startId]);
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of adj.get(cur)) {
        const o = otherEnd(e, cur);
        if (!seen.has(o)) { seen.add(o); stack.push(o); }
      }
    }
    return seen;
  };
  const edgeKey = (e) => (e.a.id < e.b.id ? e.a.id + '|' + e.b.id : e.b.id + '|' + e.a.id);
  const capOk = (id) => isDotId.has(id) || adj.get(id).length === 0;

  for (const id of nodeIds) {
    if (isDotId.has(id)) continue;
    // re-read adj.get(id) fresh each loop turn: earlier repairs in this same
    // pass may have already changed this node's incident edges.
    while (adj.get(id).length > 1) {
      const incident = adj.get(id).slice().sort((x, y) => x.weight - y.weight);
      const drop = incident[incident.length - 1]; // priciest edge, cheapest ones kept
      removeFromAdj(drop);
      treeEdges = treeEdges.filter((e) => e !== drop);
      const farId = otherEnd(drop, id);
      const farComp = componentOf(farId);
      const usedKeys = new Set(treeEdges.map(edgeKey));
      let best = null;
      for (const c of candidates) {
        const aIn = farComp.has(c.a.id), bIn = farComp.has(c.b.id);
        if (aIn === bIn) continue; // not a bridge between the split halves
        if (usedKeys.has(edgeKey(c))) continue;
        if (!capOk(c.a.id) || !capOk(c.b.id)) continue;
        if (best == null || c.weight < best.weight) best = c;
      }
      if (best != null) {
        adj.get(best.a.id).push(best);
        adj.get(best.b.id).push(best);
        treeEdges.push(best);
      }
      // no valid reconnect: farComp's nodes stay split off and will surface
      // as unreachable via the roots computed below — never left dangling
      // with a forbidden multi-way pin, and never silently redrawn diagonal.
    }
  }

  const parent = new Map(nodeIds.map((id) => [id, id]));
  const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  for (const e of treeEdges) parent.set(find(e.a.id), find(e.b.id));
  const roots = new Map(nodeIds.map((id) => [id, find(id)]));
  return { edges: treeEdges, roots };
}

/** Prune degree-1 dot leaves from a tree edge list (they add no connectivity;
 * only real terminals must survive as leaves). Iterates to a fixed point. */
function pruneDotLeaves(edges, isDot) {
  let cur = edges.slice();
  let changed = true;
  while (changed) {
    changed = false;
    const degree = new Map();
    const bump = (id) => degree.set(id, (degree.get(id) || 0) + 1);
    for (const e of cur) { bump(e.a.id); bump(e.b.id); }
    cur = cur.filter((e) => {
      const leafA = degree.get(e.a.id) === 1 && isDot(e.a.id);
      const leafB = degree.get(e.b.id) === 1 && isDot(e.b.id);
      if (leafA || leafB) { changed = true; return false; }
      return true;
    });
  }
  return cur;
}

/**
 * tools/check.py's `dot-2way`/`30` rules require every VISIBLE junction dot
 * to carry exactly 3+ distinct wire directions (a real branch point) — a
 * pass-through or a simple bend is forbidden to have a dot glyph at all.
 *
 * BUG FOUND running the real gate: pruneDotLeaves() above only removes
 * degree-1 dot leaves. A degree-2 dot (straight pass-through OR a 90° bend
 * with just two wires) survives that pruning but still fails `dot-2way`
 * (needs >=3 directions, not >=2 edges) — 4 such errors plus one `30`
 * (a real 3-way branch that had no dot at all) showed up on the first full
 * gate run. route.js already solves exactly this for its own routed edges,
 * via `hideDegenerateJunctions()` (not exported — it re-derives directions
 * from routed polyline geometry because IT doesn't control the wires it's
 * hiding dots for). rewire.js DOES control every wire it emits, so the
 * direction count can be read directly off the solved graph edges instead of
 * re-parsing polylines back out of cell XML: this is simpler, not a
 * reimplementation of the same problem a different way.
 *
 * Sets style key `apiJunctionHidden=1` (glyph suppressed, geometry
 * untouched — mergeStyle only ever touches the style STRING, never x/y/w/h)
 * on any used dot with <3 directions; CLEARS that key on a dot that already
 * carried it in the source file (e.g. J_Bp) but now legitimately has a
 * 3-way branch, so it draws as intended rather than staying hidden from an
 * earlier, unrelated processing pass.
 *
 * BUG FOUND running the real gate (2nd pass): tryEdge()'s "vertical-ish"
 * branch (dx<=tol, dy>=SNAP_EPS) always inserts a corner {u.x, v.y} even
 * when dx happens to already be ~0 — i.e. u and v were already aligned in X
 * within SNAP_EPS, so that corner sits within SNAP_EPS of v itself, a
 * genuinely zero-length trailing leg (harmless for check.py's diagonal rule,
 * which only cares about non-zero segments). But `touch()` originally read
 * ONLY the single nearest waypoint (or the far endpoint) as "next", so for
 * such an edge it measured hub->corner with dx,dy both ~0 and dirOf()
 * correctly returned null — silently dropping a real, valid incident
 * direction and undercounting the dot's degree (surfaced as a spurious `30`
 * on dot 4EIFNcnvX...-17: 2 of its 3 true directions were miscounted as 0).
 * Fixed by walking the FULL polyline (src, waypoints…, tgt) from the hub
 * outward, skipping any leading points within SNAP_EPS of the hub, instead
 * of trusting the immediately-adjacent point.
 *
 * SECOND instance of the same class of bug, found on the very next gate run:
 * SNAP_EPS (0.6px) is right for "is this an exact alignment", but too tight
 * for "is this waypoint far enough from the hub to define a real direction"
 * — corner elbows commonly land 1-2px from a dot's rounded centre (dot size
 * 6x6, centre = x+3/y+3, vs. an elbow computed from an unrelated cell's
 * exact pin coordinate), which is noise, not a second direction. Using
 * SNAP_EPS there measured a spurious 'W' out of a ~1px offset and, combined
 * with a real direction from the SAME edge's other end, undercounted a
 * genuine 3-way branch (dot -20) down to <3 kept directions — the dot got
 * hidden, and check.py correctly flagged the resulting bare 3-way branch as
 * rule `30` ("no contact dot"). Widening the "too close to count" threshold
 * to 4.5px (route.js's own hideDegenerateJunctions() neighbourhood) fixed
 * that case — but then broke the OPPOSITE direction on the very next gate
 * run: check.py's actual rule does NOT discard a short segment as noise.
 * Its `distToSeg`-based walk (ported verbatim below) counts a direction from
 * ANY segment whose CLOSER end sits within 4.5px of the hub, using that
 * segment's own direction regardless of its length — a genuine ~1px stub
 * (itself an artifact of tryEdge's corner placement, see above) still reads
 * as one more distinct compass direction to check.py. My "skip anything
 * within X px" heuristic could never match this: check.py doesn't skip
 * short segments, it reads them. So this function no longer approximates
 * check.py's rule — it reimplements the SAME distToSeg walk over each
 * emitted polyline, which is the only way to agree with the gate on every
 * input, including a hub that ends up 1px off a segment endpoint by
 * construction.
 */
function fixDotVisibility(model, solvedEdges) {
  const dirOf = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) return null;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');
  };
  const opposite = { E: 'W', W: 'E', N: 'S', S: 'N' };
  const distToSeg = (p, a, b) => {
    const vx = b.x - a.x, vy = b.y - a.y;
    const L2 = vx * vx + vy * vy;
    let t = L2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  };
  const polylines = solvedEdges.map(({ e }) => [e.a, ...e.waypoints, e.b]);
  const dirsByDot = new Map(); // dotId -> Set<'N'|'E'|'S'|'W'>
  const dotNode = new Map();
  for (const { e } of solvedEdges) {
    if (e.a.isDot) dotNode.set(e.a.id, e.a);
    if (e.b.isDot) dotNode.set(e.b.id, e.b);
  }
  for (const [dotId, hub] of dotNode) {
    const dirs = new Set();
    for (const pl of polylines) {
      for (let k = 0; k + 1 < pl.length; k++) {
        const a = pl[k], b = pl[k + 1];
        if (distToSeg(hub, a, b) >= 4.5) continue;
        const da = Math.hypot(hub.x - a.x, hub.y - a.y);
        const db = Math.hypot(hub.x - b.x, hub.y - b.y);
        const d = dirOf(a, b);
        if (d == null) continue;
        if (da > 4 && db > 4) { dirs.add(d); dirs.add(opposite[d]); } // hub strictly inside the segment
        else if (da <= 4) dirs.add(d);
        else if (db <= 4) dirs.add(opposite[d]);
      }
    }
    dirsByDot.set(dotId, dirs);
  }
  for (const [dotId, dirs] of dirsByDot) {
    // dot graph nodes are built with `id === cellId` (see dotNodes below) —
    // no separate lookup needed.
    if (dirs.size < 3) {
      updateCell(model, dotId, { style: { apiJunctionHidden: 1 } });
    } else {
      updateCell(model, dotId, { style: { apiJunctionHidden: null } });
    }
  }
}

/**
 * Solve one net: connect `terms` (>=1 nodes) through `availableDots`.
 * Returns {edges, usedDots:Set<id>, unreachable:[termId,...]}.
 */
function solveNet(terms, availableDots, obstacles, tol) {
  if (terms.length <= 1) return { edges: [], usedDots: new Set(), unreachable: [] };
  const nodes = [...terms, ...availableDots];
  const { edges, roots } = buildForest(nodes, obstacles, tol);
  // majority component among the TERMINALS (not dots) wins; the rest are unreachable
  const counts = new Map();
  for (const t of terms) counts.set(roots.get(t.id), (counts.get(roots.get(t.id)) || 0) + 1);
  let bestRoot = null, bestCount = -1;
  for (const [r, n] of counts) if (n > bestCount) { bestCount = n; bestRoot = r; }
  const reachable = new Set(terms.filter((t) => roots.get(t.id) === bestRoot).map((t) => t.id));
  const unreachable = terms.filter((t) => !reachable.has(t.id)).map((t) => t.id);
  const dotIds = new Set(availableDots.map((d) => d.id));
  const keptEdges = edges.filter((e) => roots.get(e.a.id) === bestRoot);
  const pruned = pruneDotLeaves(keptEdges, (id) => dotIds.has(id));
  const usedDots = new Set();
  for (const e of pruned) {
    if (dotIds.has(e.a.id)) usedDots.add(e.a.id);
    if (dotIds.has(e.b.id)) usedDots.add(e.b.id);
  }
  return { edges: pruned, usedDots, unreachable };
}

/**
 * Ground pairing: each grounded device pin connects 1:1 to the nearest
 * still-unclaimed ground symbol (direct edge, or via one unclaimed dot if a
 * direct edge is blocked/unaligned). See module docstring for why ground is
 * not a shared Steiner tree like other nets.
 */
function wireGroundNet(groundTerms, groundPins, availableDots, obstacles, tol) {
  const usedGrounds = new Set();
  const usedDots = new Set();
  const results = []; // {term, path:[node,node,...]}
  const unreachable = [];
  const freeDots = () => availableDots.filter((d) => !usedDots.has(d.id));
  for (const t of groundTerms) {
    let best = null; // {weight, path:[t,...,g]}
    for (const g of groundPins) {
      if (usedGrounds.has(g.id)) continue;
      const direct = tryEdge(t, g, obstacles, tol);
      if (direct != null && (best == null || direct.weight < best.weight)) {
        best = { weight: direct.weight, path: [t, g], edges: [{ a: t, b: g, ...direct }] };
      }
      for (const d of freeDots()) {
        const e1 = tryEdge(t, d, obstacles, tol);
        if (e1 == null) continue;
        const e2 = tryEdge(d, g, obstacles, tol);
        if (e2 == null) continue;
        const w = e1.weight + e2.weight;
        if (best == null || w < best.weight) {
          best = { weight: w, path: [t, d, g], edges: [{ a: t, b: d, ...e1 }, { a: d, b: g, ...e2 }] };
        }
      }
    }
    if (best == null) { unreachable.push(t.id); continue; }
    usedGrounds.add(best.path[best.path.length - 1].id);
    for (const n of best.path) if (n.isDot) usedDots.add(n.id);
    results.push(...best.edges);
  }
  return { edges: results, unreachable };
}

/** 2-pin prefixes for which a mirror (flipH) is electrically a no-op — see
 * rewire()'s allowFlip pass below. Anything polarized (D, V, I, …) or with
 * more than 2 pins (Q, M, G) is deliberately excluded. */
const FLIPPABLE_PREFIXES = new Set(['R', 'L', 'C']);

/**
 * Rewire `model` (already placed) from SPICE netlist text `netlistText`.
 * Deletes every existing edge cell first (partial/broken/diagonal leftovers
 * are not trusted), then re-derives full wiring from the netlist + the
 * model's own junction dots. Never moves/resizes/reshapes a vertex, UNLESS
 * `opts.allowFlip` is truthy — see the allowFlip pass below, which is the
 * one documented exception and is opt-in, off by default.
 *
 * @returns {wires:[id,...], warnings:[string,...], unreachable:[{net,terminal}], flipped:[refdes,...]}
 */
export function rewire(model, netlistText, opts = {}) {
  const allowFlip = !!opts.allowFlip;
  let result = rewireOnce(model, netlistText, opts);
  result.flipped = [];
  if (!allowFlip || result.unreachable.length === 0) return result;

  // ---- OPT-IN allowFlip pass -------------------------------------------
  // The module docstring's contract is "never re-places — component/ground/
  // port/dot geometry byte-identical". This pass is the one documented
  // exception: for a 2-pin R/L/C component (a mirror is electrically
  // identical for those — swapping which end is "in" vs "out" changes
  // nothing about the network), when ITS OWN terminal(s) came back
  // unreachable from the plain solve above, try flipping just that cell's
  // flipH and re-solving the WHOLE netlist from scratch (dot-claiming order,
  // obstacle interactions and other nets can all shift). Keep the flip only
  // if it actually helps: the specific terminal(s) that were unreachable for
  // this cell must now be reachable, AND the total unreachable count must
  // not have grown (a flip must not silently trade one broken net for
  // another). Every flip actually performed is reported in `flipped` and as
  // a warning — never silent, per the module contract above.
  //
  // MEASURED CASE (2446 hand-placed file): C6 (flipH=1, in=(529,600) right,
  // out=(429,600) left) needs out->Up (dot column at x=600, to the RIGHT)
  // and in->rx_Bp (dot/port at x=401, to the LEFT) — both pins are already
  // y-aligned with their required dots, only the sides are swapped. Clearing
  // flipH swaps which side "in"/"out" land on and makes both routable.
  //
  // Candidate selection is by NET, not by which terminal string happens to
  // be reported unreachable. solveNet() only ever reports the LOSING side of
  // a broken net (see solveNet's "majority component wins" comment) — when a
  // net has exactly two 1-pin-per-net terminals and no edge exists between
  // them at all, either one could end up as the arbitrarily-kept "reachable"
  // singleton and the other as `unreachable`. A flip candidate must therefore
  // be found by walking the NETLIST's own component list for any 2-pin R/L/C
  // part sitting on a net that shows up anywhere in `result.unreachable`,
  // not by pattern-matching the unreachable terminal's cell id (which may
  // legitimately name the OTHER end of the same broken net instead).
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const refToCellId = new Map();
  for (const c of cells) {
    if (c.kind !== 'vertex') continue;
    const cls = classify(c);
    if (cls.role === 'component') refToCellId.set(identityOf(c), c.id);
  }
  const parsedForFlip = parseSpice(netlistText);
  const brokenNets = new Set(result.unreachable.map((u) => u.net));
  const candidateIds = new Set();
  for (const comp of parsedForFlip.components) {
    if (!FLIPPABLE_PREFIXES.has(comp.prefix)) continue;
    if (comp.nodes.length !== 2) continue;
    if (!comp.nodes.some((n) => brokenNets.has(n))) continue;
    const cellId = refToCellId.get(comp.ref);
    if (cellId != null) candidateIds.add(cellId);
  }

  const nodesOfCell = new Map(parsedForFlip.components
    .filter((comp) => refToCellId.has(comp.ref))
    .map((comp) => [refToCellId.get(comp.ref), comp.nodes]));

  for (const cellId of candidateIds) {
    // re-read fresh each turn: an earlier accepted flip in this same loop
    // may already have resolved this candidate's net (e.g. via a shared dot
    // freed up by the previous flip), in which case leave it alone.
    const stillBroken = new Set(result.unreachable.map((u) => u.net));
    const nodes = nodesOfCell.get(cellId) || [];
    if (!nodes.some((n) => stillBroken.has(n))) continue;
    const c = byId.get(cellId);
    const curFlip = !!c.flipH;
    updateCell(model, cellId, { style: { flipH: curFlip ? null : 1 } });
    const trial = rewireOnce(model, netlistText, opts);
    const trialNets = new Set(trial.unreachable.map((u) => u.net));
    const resolved = nodes.every((n) => !trialNets.has(n));
    const improved = resolved && trial.unreachable.length <= result.unreachable.length;
    if (improved) {
      const refdes = identityOf(c);
      trial.flipped = [...result.flipped, refdes];
      trial.warnings = [...trial.warnings,
        `allowFlip: mirrored ${refdes} (flipH) — its terminal(s) were unroutable as placed and are routable mirrored`];
      result = trial;
    } else {
      updateCell(model, cellId, { style: { flipH: curFlip ? 1 : null } }); // revert, byte-identical to before this trial
    }
  }
  return result;
}

function rewireOnce(model, netlistText, opts = {}) {
  const tol = opts.tolerance != null ? opts.tolerance : DEFAULT_TOL;
  const parsed = parseSpice(netlistText);
  const warnings = [...parsed.warnings];

  // ---- delete every existing edge: an already-placed, partially-wired file
  // may carry dangling/incomplete wires from before; we rebuild wiring from
  // scratch and never trust leftovers to still be correct.
  for (const el of allCells(model)) {
    const c = cellInfo(el);
    if (c.kind === 'edge') deleteCell(model, c.id);
  }

  const cells = allCells(model).map(cellInfo);
  const obstacles = obstaclesOf(cells);

  // ---- classify every vertex once
  const byRefdes = new Map();      // identityOf -> cell
  const groundCells = [];          // {cell, cls}
  const tapCells = [];             // power/port {cell, cls}
  const dotCells = [];             // junction dots (Steiner candidates)
  for (const c of cells) {
    if (c.kind !== 'vertex') continue;
    const cls = classify(c);
    if (cls.role === 'junction') { dotCells.push(c); continue; }
    if (cls.role === 'ground') { groundCells.push({ cell: c, cls }); continue; }
    if (cls.role === 'power' || cls.role === 'port') { tapCells.push({ cell: c, cls }); continue; }
    if (cls.role === 'component') byRefdes.set(identityOf(c), { cell: c, cls });
  }

  const dotNodes = dotCells.map((c) => {
    const b = rotatedAabb(c);
    return { id: c.id, cellId: c.id, x: b.x + b.w / 2, y: b.y + b.h / 2, isDot: true };
  });

  // ---- build terminals per net: netName -> [{id,x,y}]  (id = owning cell id;
  // for a device pin the graph node id IS the device cell id — one wire per
  // net-edge attaches to the cell, with an explicit pin anchor)
  const netTerms = new Map();   // netName -> [{id,x,y,cellId,pinName,relX,relY}]
  const addTerm = (net, cellId, x, y, pinName, relX, relY) => {
    if (!netTerms.has(net)) netTerms.set(net, []);
    const key = cellId + '#' + net; // a cell can appear on >1 net only via >1 pin
    netTerms.get(net).push({ id: key, x, y, cellId, pinName, relX, relY });
  };

  const groundTerms = []; // {id,x,y,cellId,pinName,relX,relY}
  for (const [ref, entry] of byRefdes) {
    const netComp = parsed.components.find((c) => c.ref === ref);
    if (netComp == null) { warnings.push(`refdes ${ref} present in schematic but not in netlist`); continue; }
    const cls = entry.cls;
    if (cls.mapping == null) { warnings.push(`component ${ref}: no SPICE mapping, cannot wire`); continue; }
    const pins = activePins(cls);
    const names = pinOrderFor(cls);
    for (let i = 0; i < names.length && i < netComp.nodes.length; i++) {
      const pin = pins[i];
      if (pin == null) continue;
      const abs = pinAbs(entry.cell, pin);
      const node = netComp.nodes[i];
      if (node === '0') {
        groundTerms.push({ id: entry.cell.id + '#0#' + pin.name, x: abs.x, y: abs.y,
          cellId: entry.cell.id, pinName: pin.name, relX: pin.x, relY: pin.y });
      } else {
        addTerm(node, entry.cell.id, abs.x, abs.y, pin.name, pin.x, pin.y);
      }
    }
  }
  // used-netlist refs not present in schematic
  for (const c of parsed.components) if (!byRefdes.has(c.ref)) warnings.push(`netlist ref ${c.ref} has no matching schematic component (refdes)`);

  // ---- ports/power taps: each contributes one terminal, named by its own net.
  // A port glyph can expose several pins (N canonical, S/E/W as alternates —
  // components.js activePins() offers all four precisely so the wire can
  // leave from whichever side actually faces the rest of the net); a power
  // tap has exactly one. Pick the pin whose absolute point already shares an
  // X or Y (within tol) with either an already-known terminal of this SAME
  // net or a dot — i.e. the one that can actually be wired — falling back to
  // the canonical pin (unchanged behaviour) when none of them align yet.
  //
  // BUG FOUND running the real gate (4th instance): the first version tried
  // pins in canonical order (N,S,W,E) and took the FIRST one that aligned
  // with ANYTHING — a same-net component pin OR a dot, whichever came first
  // in pin order. On the real file, P_Bp's canonical 'S' pin (312,198)
  // happened to land exactly at the tol=8 boundary of C1's OWN pin
  // (401,206), so 'S' was chosen — but C1's pin is a non-dot terminal, and
  // by the degree-cap fix above it can carry only ONE wire; C1 already needs
  // that one wire for its own cheaper connection to DOT2. Pin 'W' (300,186)
  // would have aligned just as well with THREE separate dots (diff 1-3px,
  // all comfortably inside tol) that have no such capacity limit, but 'W'
  // was never reached because 'S' matched first. Fixed by trying every pin
  // against DOTS first (unlimited Steiner capacity) across the whole pin
  // list, and only falling back to a same-net terminal match if no pin
  // aligns with any dot — dots are the resource this whole algorithm is
  // built to route through; a same-net component pin is not a router.
  //
  // BUG FOUND running the real 2446 hand-placed file (5th instance, same
  // selector): "aligns with a dot" is necessary but not sufficient — it says
  // nothing about whether a wire could actually be DRAWN there. P_Bp exposes
  // W=(300,186) and E=(324,186) — both a 24x24 port body — and BOTH align
  // (same y) with the dot at (401,189) within tol. The alignment-only rule
  // picked W because it iterates N,S,W,E and W came first, but W sits on the
  // port's OWN LEFT edge while the dot is to the RIGHT: a wire leaving W
  // toward the dot runs straight through the port's own 24px body (measured
  // 22px penetration), which segmentBlocked() CORRECTLY refuses (tools/
  // check.py's `through` rule, its own 8px slack independently checked
  // against this exact case, would flag exactly that penetration as an
  // error) — so P_Bp came out unreachable even though its E pin routes
  // cleanly to the very same dot. Same mechanism on P_Bn (W=(300,319) blocked,
  // E=(324,319) clean, dot at (401,319)) and P_rx_Bn (W=(295,738) blocked,
  // E=(319,738) clean, dot at (401,738)). segmentBlocked() is NOT the thing
  // to relax here — its refusal is exactly what keeps a wire from crossing a
  // component's own body, which check.py enforces independently; the defect
  // is in THIS selector stopping at the first ALIGNED pin instead of the
  // first ROUTABLE one. Fixed by re-using tryEdge() (which already calls
  // segmentBlocked() under the hood) as the actual admission test against
  // every dot, instead of the cheaper same-axis-within-tol proxy — a pin only
  // qualifies if a real edge to at least one dot exists. Alignment-only is
  // kept as the fallback for the (should now be rarer) case where no pin
  // routes to any dot at all, so nothing that used to work regresses.
  // A port glyph's net is its PRINTED LABEL (components.js:152,
  // `value.trim() || id`). That is right when the label IS a netlist net
  // name, and it silently strands the port when it is not.
  //
  // MEASURED CASE (915, 2026-08-31): the antenna port is `<mxCell id="P_n_c6"
  // value="ANT">`. `matching_915.cir` has no net called `ANT` — its antenna
  // node is the auto-named `n_c6` (`C8 n_l3 n_c6` / `C6 n_c6 0`), because the
  // frozen netlist never gave that terminal a readable name. So the port
  // contributed a terminal to a net with no other member, no wire was ever
  // emitted for it, and the glyph rendered as a floating `ANT` marker two
  // pixels from the conductor it names. LVS still passed — the port is not a
  // component — and only ERC's `floating-tap` caught it.
  //
  // Fallback, applied ONLY when the label matches no netlist net: if the
  // cell id has the file's own `P_<net>` form and `<net>` IS a netlist net,
  // use that and keep the label for display. This does not let a typo through
  // quietly — an id that also fails to resolve leaves the port on its label's
  // net exactly as before, and either way a warning names the port. The
  // alternative (renaming the printed label to `n_c6`) would put the
  // netlist's placeholder on a sign-off figure instead of "ANT".
  const netlistNets = new Set();
  for (const c of parsed.components) for (const n of c.nodes) netlistNets.add(n);
  for (const t of tapCells) {
    if (netlistNets.has(t.cls.net)) continue;
    const m = /^P_(.+)$/.exec(String(t.cell.id || ''));
    if (m == null || !netlistNets.has(m[1])) {
      warnings.push(`port ${t.cell.id} labelled "${t.cls.net}" matches no net in the netlist`);
      continue;
    }
    warnings.push(`port ${t.cell.id}: label "${t.cls.net}" is not a netlist net; bound to "${m[1]}" from its id`);
    t.cls = { ...t.cls, net: m[1] };
  }

  const netNamesWithPort = new Set();
  for (const { cell, cls } of tapCells) {
    const pins = activePins(cls);
    if (pins.length === 0) continue;
    const alignsAny = (abs, cands) => cands.some((o) => Math.abs(o.x - abs.x) <= tol || Math.abs(o.y - abs.y) <= tol);
    let chosen = pins[0];
    let found = false;
    // Pass 1 (the actual fix): prefer a pin that is not just aligned with a
    // dot but genuinely ROUTABLE to one — tryEdge() re-derives this via
    // segmentBlocked(), so a pin whose only aligned dot lies across the
    // pin's own component body is correctly skipped in favour of one that
    // isn't.
    for (const p of pins) {
      const abs = pinAbs(cell, p);
      const node = { id: cell.id, cellId: cell.id, x: abs.x, y: abs.y };
      if (dotNodes.some((d) => tryEdge(node, d, obstacles, tol) != null)) { chosen = p; found = true; break; }
    }
    // Pass 2 (unchanged previous behaviour): alignment-only against dots,
    // for the case where no pin has a genuinely routable dot leg at all.
    if (!found) {
      for (const p of pins) {
        if (alignsAny(pinAbs(cell, p), dotNodes)) { chosen = p; found = true; break; }
      }
    }
    if (!found) {
      const terms = netTerms.get(cls.net) || [];
      for (const p of pins) {
        if (alignsAny(pinAbs(cell, p), terms)) { chosen = p; break; }
      }
    }
    const abs = pinAbs(cell, chosen);
    addTerm(cls.net, cell.id, abs.x, abs.y, chosen.name, chosen.x, chosen.y);
    netNamesWithPort.add(cls.net);
  }

  // ---- ground symbols: one candidate pin each
  const groundPins = groundCells.map(({ cell, cls }) => {
    const pins = activePins(cls);
    const pin = pins[0];
    const abs = pinAbs(cell, pin);
    return { id: cell.id, x: abs.x, y: abs.y, cellId: cell.id,
      pinName: pin ? pin.name : undefined, relX: pin ? pin.x : 0.5, relY: pin ? pin.y : 0.5 };
  });

  // ---- wire ground first (independent of dot claiming order below, but
  // still competes for the same dot pool)
  const claimedDots = new Set();
  const emitted = [];
  const solvedEdges = []; // {e, net} — kept alongside `emitted` so fixDotVisibility()
                           // can read direction counts straight off the graph edges
                           // (absolute points + waypoints) instead of re-parsing them
                           // back out of cell XML after addWire().
  const unreachableReport = [];

  {
    const avail = dotNodes.filter((d) => !claimedDots.has(d.id));
    const { edges, unreachable } = wireGroundNet(groundTerms, groundPins, avail, obstacles, tol);
    for (const e of edges) {
      emitted.push(mkEdge(e, null)); // ground: never labeled (matches the file's own w751-755 convention)
      solvedEdges.push({ e });
      if (e.a.isDot) claimedDots.add(e.a.id);
      if (e.b.isDot) claimedDots.add(e.b.id);
    }
    for (const termId of unreachable) {
      const t = groundTerms.find((x) => x.id === termId);
      warnings.push(`net 0: terminal ${t.cellId}:${t.pinName} has no reachable ground symbol`);
      unreachableReport.push({ net: '0', terminal: `${t.cellId}:${t.pinName}` });
    }
  }

  // ---- ordinary nets: process bus nets (most terminals) first so they get
  // first claim on the dots they structurally need.
  const netOrder = [...netTerms.keys()].sort((a, b) => netTerms.get(b).length - netTerms.get(a).length);
  for (const net of netOrder) {
    const terms = netTerms.get(net);
    if (terms.length < 2) continue; // a single-terminal net has nothing to wire

    // Unconstrained tentative solve (all dots available) — used ONLY to
    // detect and report dot contention against nets already committed.
    const tentative = solveNet(terms, dotNodes, obstacles, tol);
    for (const dotId of tentative.usedDots) {
      if (claimedDots.has(dotId)) {
        warnings.push(`dot-contention: dot ${dotId} would also help net "${net}" but is already claimed by an earlier (larger) net; net "${net}" is routed without it`);
      }
    }

    const avail = dotNodes.filter((d) => !claimedDots.has(d.id));
    const { edges, usedDots, unreachable } = solveNet(terms, avail, obstacles, tol);
    for (const d of usedDots) claimedDots.add(d);
    // Label only the first edge, and only when no port glyph already names
    // this net (place3.js's dedupNetLabel convention: a repeated name reads
    // as drawn twice on the same net, review-flagged before as duplicate ink).
    let labelled = netNamesWithPort.has(net);
    for (const e of edges) {
      emitted.push(mkEdge(e, labelled ? null : net));
      solvedEdges.push({ e });
      labelled = true;
    }
    for (const termId of unreachable) {
      const t = terms.find((x) => x.id === termId);
      warnings.push(`net ${net}: terminal ${t.cellId}:${t.pinName} could not be reached through the available dots`);
      unreachableReport.push({ net, terminal: `${t.cellId}:${t.pinName}` });
    }
  }

  // ---- fix dot glyph visibility to match check.py's dot-2way/30 rules
  // (>=3 directions to keep the glyph shown) BEFORE emitting wires, so the
  // updateCell() style patch and the addWire() calls land on the same model
  // pass; order between the two doesn't matter (disjoint attributes) but
  // doing it here keeps all wiring-graph-derived model writes together.
  fixDotVisibility(model, solvedEdges);

  // ---- emit
  const wires = [];
  for (const spec of emitted) {
    const cell = addWire(model, spec);
    wires.push(cell.getAttribute('id'));
  }

  // DEFECT (2026-08-31, found while fixing DEFECT B / net-name-over-dot):
  // this endpoint never went through route.js::routePage(), so
  // offsetEdgeLabels() -- the ONLY place a wire's net-name label gets moved
  // clear of the conductor it names, see that function's own docstring for
  // the labelBackgroundColor-halo history -- had never run on a rewired
  // document at all. Every net-name label here (not just ones landing on a
  // junction dot) was left at mxGraph's raw 50%-of-arc-length default, which
  // is exactly ON the wire. Call it explicitly, same as routePage() does at
  // the end of its own pipeline; it only ever writes a label's <mxPoint
  // as="offset"> geometry, so it cannot change wire count, source/target,
  // exit/entry anchors or waypoints -- none of tools/check.py's structural
  // rules (lvs, diagonal, dot-*) read it.
  // ---- geometry-only sub-passes: wrapped individually (not the whole of
  // rewireOnce, whose whole PURPOSE is to change connectivity by design) so
  // a violation names the actual offending pass. See invariant.js's
  // module docstring for why a fingerprint catches this and a re-run of
  // compare() would not (it cannot be fooled by two compensating errors).
  let f0 = connectivityFingerprint(model);
  offsetEdgeLabels(model);
  assertGeometryOnly(f0, connectivityFingerprint(model), 'offsetEdgeLabels');

  f0 = connectivityFingerprint(model);
  const straightened = straightenAlignedEdges(model);
  assertGeometryOnly(f0, connectivityFingerprint(model), 'straightenAlignedEdges');

  return { wires, warnings, unreachable: unreachableReport, straightened };
}

/**
 * Emit a STRAIGHT edge wherever the two endpoints already share an X or a Y.
 *
 * Requested by the design owner (2026-08-31) after a rendered 915 figure showed
 * a rectangular staircase detour under L2 between two points that were exactly
 * aligned: "utiliser le type de route straight pour eviter les coudes inutiles".
 *
 * WHY THE DETOUR EXISTS AT ALL. Every wire we emit carries
 * `edgeStyle=orthogonalEdgeStyle`, and mxGraph's orthogonal router is free to
 * insert a jetty (a step out, along, and back) when the exit and entry
 * DIRECTIONS implied by the two anchors disagree -- even when the two points
 * are collinear and a single segment would do. The extra bends are the
 * router's, not the solver's: our own graph edge for that pair has no
 * intermediate waypoint at all.
 *
 * WHY THIS IS SAFE AGAINST THE H/V-ONLY CONSTRAINT (the owner's other hard
 * rule, and what tools/check.py's `diagonal` gate enforces): a straight line
 * between two points that share an X is vertical, and between two that share a
 * Y is horizontal. There is no third case -- the alignment test IS the
 * no-diagonal proof. Anything not aligned keeps the orthogonal router.
 *
 * GUARDS, each of which suppresses the rewrite rather than risking a defect:
 *  - intermediate waypoints: the solver asked for a specific path, honour it;
 *  - not aligned within SNAP_EPS: a straight edge there would be a diagonal;
 *  - the direct segment crosses a component body: the orthogonal router may
 *    have been detouring for a REASON. Reuses segmentBlocked()/obstaclesOf()
 *    rather than a second collision test, including their rule that an
 *    endpoint's own body is only safe to graze within 8 px of that endpoint.
 *
 * Returns the ids it rewrote, so a caller can report the count instead of the
 * change being invisible.
 */
function straightenAlignedEdges(model) {
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.filter((c) => c.kind === 'vertex').map((c) => [c.id, c]));
  const obstacles = obstaclesOf(cells);
  const done = [];
  for (const c of cells) {
    if (c.kind !== 'edge') continue;
    if (c.points && c.points.length) continue;
    const src = byId.get(c.source), tgt = byId.get(c.target);
    if (src == null || tgt == null || src.x == null || tgt.x == null) continue;
    const at = (pref, cell) => {
      const X = c.style.map.get(pref + 'X'), Y = c.style.map.get(pref + 'Y');
      if (X == null || Y == null) return null;   // no explicit anchor -> perimeter, unknown point
      return pinAbs(cell, { x: parseFloat(X), y: parseFloat(Y) });
    };
    const p = at('exit', src), q = at('entry', tgt);
    if (p == null || q == null) continue;
    if (Math.abs(p.x - q.x) > SNAP_EPS && Math.abs(p.y - q.y) > SNAP_EPS) continue;
    const own = new Map([[src.id, p], [tgt.id, q]]);
    if (segmentBlocked(p, q, obstacles, own)) continue;
    updateCell(model, c.id, { style: { edgeStyle: 'none' } });
    done.push(c.id);
  }
  return done;
}

/** Turn one solved graph edge into an addWire() argument object. Non-dot
 * endpoints carry the exact relative pin (x,y,name) already resolved from the
 * stencil catalog when the terminal was built — no inverse trig needed.
 *
 * DEFECT A (2026-08-31, api-hardening): dot endpoints used to get NO explicit
 * anchor at all (`undefined`), on the claim that this "matches place3.js's
 * own convention for component->junction wires". That claim was checked
 * against place3.js (lib/place3.js:688-689, the >2-terminal junction branch:
 * `addWire(model, { source: t.ref, target: id, sourcePin: {...} })` with NO
 * `targetPin`) and against route.js — NEITHER sets an explicit anchor on a
 * junction end either. So this was never a second, diverging convention; it
 * was the SAME latent defect shared by both emitters, just masked in most
 * cases because a junction dot is normally painted opaque
 * (fillColor=#000000) at ~6x6px, small enough that a couple of px of
 * perimeter gap under the glyph is invisible. It stops being masked the
 * moment `hideDegenerateJunctions()` turns the dot transparent
 * (fillColor=none;strokeColor=none;apiJunctionHidden=1) for a genuine 2-way
 * pass-through (route.js:873) — exactly `J_Bp` in the 2446 hand-in file.
 *
 * Root cause: with no exitX/exitY/exitPerimeter in the style, mxGraph treats
 * the connection as "floating" and resolves it via the shape's PERIMETER
 * function (mxPerimeter.EllipsePerimeter for `ellipse;...`), intersecting the
 * ellipse boundary along the direction from the far endpoint — NOT the
 * centre. Two wires arriving from opposite directions at the same dot each
 * land on a different point of that ellipse's rim, `w` px apart (measured:
 * J_Bp x=538 y=186 w=6 h=6 -> wires end at model x=538 and x=544, a 6px /
 * 12px-rendered gap in an otherwise dead-straight conductor — see the PNG
 * evidence at /tmp/hand_rewired.png rows y=85-86, x=640-651).
 * route.js's OWN internal path-planning (route.js:204-208 `endAbs()`) already
 * assumes the OPPOSITE — a floating attach resolves to the target's CENTRE
 * (comment: "attache flottante : centre") — so route.js's waypoints and
 * mxGraph's actual render disagree at every hidden junction; they just
 * happened to agree closely enough, or land under painted ink, everywhere
 * this had been checked before.
 *
 * Fix: pin the junction end explicitly to its centre with the perimeter
 * turned off (x=0.5,y=0.5, which addWire() turns into
 * exitPerimeter=0/entryPerimeter=0 — see model.js addWire doc). Both wires
 * then resolve to the SAME point regardless of approach direction, and it
 * matches what route.js's planner already assumed. This is the same class of
 * false-open as the opaque `labelBackgroundColor` halo documented in
 * model.js addWire (a style choice silently erasing/gapping conductor ink),
 * just triggered by a missing anchor instead of an opaque fill. */
function mkEdge(e, net) {
  const src = e.a, tgt = e.b;
  const sourcePin = src.isDot ? { x: 0.5, y: 0.5 } : { x: src.relX, y: src.relY, name: src.pinName };
  const targetPin = tgt.isDot ? { x: 0.5, y: 0.5 } : { x: tgt.relX, y: tgt.relY, name: tgt.pinName };
  return {
    source: src.isDot ? src.id : src.cellId,
    target: tgt.isDot ? tgt.id : tgt.cellId,
    sourcePin, targetPin,
    points: e.waypoints,
    value: net,
  };
}
