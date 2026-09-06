/**
 * Fingerprint of the inputs consumed by documentary netlist extraction.
 * Geometry-only passes preserve endpoint identities AND anchor coordinates,
 * stencil identity, effective SPICE values, hidden-terminal metadata and net labels.
 * This complements strict LVS; it does not prove that the rendered paths have
 * unambiguous visible connectivity. Use vector checks and PNG review separately.
 */
import { allCells, cellInfo } from './model.js';
import { identityOf, classify } from './components.js';

/** Persisted endpoint coordinates matter when a named anchor becomes stale. */
function edgeKey(c) {
  return JSON.stringify(['E', c.source, c.target, c.value,
    ...['exitName','entryName','exitX','exitY','entryX','entryY'].map(k => c.style.map.get(k) ?? '')]);
}

/** Decorative junctions have no component card; their visible role is audited separately. */
function vertexKey(c) {
  const role = classify(c).role;
  if (role === 'junction' || role === 'other') return null;
  return JSON.stringify(['V', c.id, identityOf(c), classify(c).role,
    c.style.map.get('shape'), c.style.map.get('apiShape'),
    c.attrs?.spice_value ?? c.value, c.attrs?.spice_hidden_nodes ?? '',
    ['power','port','ground'].includes(role) ? c.value : '']);
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
