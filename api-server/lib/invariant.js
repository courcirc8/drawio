/**
 * invariant.js — connectivity fingerprint that makes LVS preservation a
 * STRUCTURAL invariant of the geometry-only pipeline stages, instead of an
 * external gate someone has to remember to run.
 *
 * WHY A FINGERPRINT INSTEAD OF RE-RUNNING LVS: lib/lvs.js's compare() is a
 * function of connectivity ALONE — which pins are joined into which net, and
 * which component sits on which node (see netlist.js connectivity()) — never
 * of x/y/width/height/rotation/waypoints, and never of style beyond the two
 * anchor NAMES (exitName/entryName, written by model.js addWire) that decide
 * which pin a wire end actually binds to. A transformation that provably
 * leaves that connectivity untouched therefore CANNOT change the LVS
 * verdict — this is an impossibility proof, not a re-test. Unlike calling
 * compare() again after the fact, it cannot be fooled by two compensating
 * errors that happen to cancel out in the extracted netlist (e.g. a wire
 * rebound from pin A to pin B on the SAME net elsewhere would still read
 * back as `match: true`), and it is O(n) over the cell list with no netlist
 * parsing at all.
 *
 * Diagnosed defect this closes: lib/optimize.js already gates every
 * candidate through compare() (an LVS re-test, not a fingerprint — that
 * stage IS safe, just by a different, heavier mechanism) but lib/rewire.js's
 * geometry-only sub-passes, lib/compact.js and lib/route.js have no
 * connectivity check of their own at all. Chaining /rewire after an
 * /optimize run has been observed to produce 13 "terminal unreachable"
 * warnings and LVS `false` with nothing in the pipeline objecting — because
 * nothing between those two stages ever asked.
 *
 * Scope: wrap a SUB-PASS that is geometry-only by construction (moves/
 * restyles cells without ever touching a wire's source/target/exit/entry
 * name, or a vertex's id/refdes/value) — never the whole of rewire()/
 * rewireOnce(), which legitimately deletes and re-adds every edge and, under
 * allowFlip, legitimately mirrors a cell. Wrapping the whole function would
 * make the invariant fire on every ordinary call.
 */
import { allCells, cellInfo } from './model.js';
import { identityOf, classify } from './components.js';

/** LVS-relevant identity of one edge: which two pins it joins. Never x/y,
 * waypoints, or style beyond the two anchor names netlist.js actually reads
 * to resolve a pin (see connectivity()'s endpointKey — it prefers the NAME
 * over exitX/exitY whenever the name still resolves). Included regardless of
 * what kind of cell either endpoint is: an edge ending on a junction dot is
 * still identified by that dot's (stable) cell id, so a rebind onto a
 * DIFFERENT dot or component is still caught even though dot vertices
 * themselves are excluded from vertexKey below. */
function edgeKey(c) {
  return `E|${c.source ?? ''}|${c.target ?? ''}|${c.style.map.get('exitName') ?? ''}|${c.style.map.get('entryName') ?? ''}`;
}

/**
 * LVS-relevant identity of one vertex: its id (what a wire's source/target
 * references), its refdes (the emitted SPICE ref — see identityOf()) and its
 * value (spice_value/label — see netlist.js extractNetlist's T4 note: the
 * wrapping <object>'s spice_value attribute is authoritative when present).
 * Never x/y/width/height/rotation/flipH/flipV.
 *
 * Returns null for a cell whose role is 'junction' or 'other' (classify(),
 * same predicate netlist.js's connectivity()/extractNetlist() use) — a
 * junction dot or a decorative annotation is NEVER emitted as a SPICE
 * component and never named in a net by itself, so it carries no LVS
 * identity of its own to track.
 *
 * EMPIRICAL FINDING (route.js): routePage()'s addContactDots() purges every
 * existing `contactDot=1` vertex and recreates fresh ones (new id encoding
 * rounded x/y, see route.js:1171) on EVERY call — a purely decorative
 * recomputation of where a 3-way branch glyph should sit, never wired as any
 * edge's source/target. Treating dots as ordinary vertices here would make
 * routePage() fail its own geometry-only assertion on every single call for
 * a change that cannot possibly move an LVS verdict (dots are excluded from
 * extractNetlist's component list, see netlist.js connectivity()). Filtering
 * by role, rather than by an id/style heuristic aimed at this one call site,
 * is what makes the exclusion correct for every future caller too — it says
 * "not LVS-relevant", not "route.js's specific dot-naming scheme".
 */
function vertexKey(c) {
  const role = classify(c).role;
  if (role === 'junction' || role === 'other') return null;
  return `V|${c.id}|${identityOf(c) ?? ''}|${c.value ?? ''}`;
}

/**
 * connectivityFingerprint(model) -> a single comparable string over the
 * SORTED multiset of every edge's (source, target, exitName, entryName) and
 * every vertex's (id, refdes, value). Sorted so cell insertion/deletion
 * order — which a purely geometric pass is free to disturb (rewire.js
 * deletes and re-adds every edge even in its geometry-only sub-passes'
 * surrounding call) — is invisible to the comparison.
 *
 * Deliberately a plain sorted-and-joined string rather than a cryptographic
 * digest: equality is all `assertGeometryOnly` needs, and keeping the raw
 * entries around (instead of compressing them through a hash function) is
 * what lets it name the actual differing entry instead of just "something
 * changed, somewhere".
 */
export function connectivityFingerprint(model) {
  const cells = allCells(model).map(cellInfo);
  const keys = [];
  for (const c of cells) {
    if (c.kind === 'edge') keys.push(edgeKey(c));
    else if (c.kind === 'vertex') {
      const k = vertexKey(c);
      if (k != null) keys.push(k);
    }
  }
  keys.sort();
  return keys.join('\n');
}

/** Thrown by assertGeometryOnly. `opName` names the offending sub-pass so a
 * caller doesn't have to bisect the pipeline to find which stage lied about
 * being geometry-only. */
export class GeometryOnlyViolation extends Error {
  constructor(opName, detail) {
    super(`assertGeometryOnly(${opName}): connectivity changed — ${detail}`);
    this.name = 'GeometryOnlyViolation';
    this.opName = opName;
  }
}

/**
 * assertGeometryOnly(before, after, opName) -> throws GeometryOnlyViolation
 * naming `opName` and the first differing fingerprint entry when `before`
 * !== `after` (both are connectivityFingerprint() strings). No-op when they
 * match.
 *
 * Usage around a sub-pass that must never touch connectivity:
 *   const f0 = connectivityFingerprint(model);
 *   somePass(model);
 *   assertGeometryOnly(f0, connectivityFingerprint(model), 'somePass');
 */
export function assertGeometryOnly(before, after, opName) {
  if (before === after) return;
  const a = before.split('\n');
  const b = after.split('\n');
  const bSet = new Set(b);
  const aSet = new Set(a);
  const removed = a.find((k) => !bSet.has(k));
  const added = b.find((k) => !aSet.has(k));
  const detail = removed != null ? `lost ${removed}` : `gained ${added}`;
  throw new GeometryOnlyViolation(opName, detail);
}
