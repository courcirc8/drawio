/**
 * quality.js — the AUTOMATIC quality gate a drawing must pass before it is
 * shown to Eric (orchestrator 2026-10-09, after Eric refused the CICC 2007
 * comparator: "plein de coudes inutiles, la règle des 45° … pas reconnue").
 *
 *   avoidable  0 avoidable bend (lib/straighten.js: pins of one net within
 *              one step of a straight line)
 *   crossX     every cross-coupled pair (gate on the partner's drain) drawn
 *              with its X (lib/crossx.js)
 *   pairRow    every differential pair on one row (check.py rule 14)
 *   symmetry   every differential pair mirrored: one device flipped, the
 *              part feeding its source centred under it (±¼ part)
 *   uWires     no detour: a wire longer than the Manhattan distance of its
 *              ends by more than 1.5 median part sizes (long U loops)
 *
 * Returns { pass, checks: {name: {ok, n, detail}} }. Geometry only.
 */
import { allCells, cellInfo } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, polylineOf } from './route.js';
import { detectStructures } from './patterns.js';
import { avoidableBends } from './straighten.js';

export function qualityGate(model, parsed) {
  const cs = allCells(model).map(cellInfo), byId = new Map(cs.map((c) => [c.id, c]));
  const verts = cs.filter((c) => c.kind === 'vertex'), edges = cs.filter((c) => c.kind === 'edge');
  const dev = (ref) => verts.find((c) => String(c.refdes || '') === ref);
  let st = { crossCoupled: [], diffPairs: [], tails: [] };
  try { st = detectStructures(parsed); } catch { /* none */ }
  const checks = {};

  const av = avoidableBends(model).bends;
  checks.avoidable = { ok: av === 0, n: av };

  // X on every cross-coupled pair: two crossX wires between its devices
  const xMissing = [];
  for (const cc of st.crossCoupled) {
    const [a, b] = cc.refs.map(dev);
    if (!a || !b) continue;
    const xs = edges.filter((e) => e.style.map.get('drawioApiCrossX') === '1' && [a.id, b.id].includes(e.source) && [a.id, b.id].includes(e.target));
    if (xs.length < 2) xMissing.push(cc.refs.join('/'));
  }
  checks.crossX = { ok: !xMissing.length, n: xMissing.length, detail: xMissing };

  // pairs on one row; mirrored; source feeder centred
  const offRow = [], unsym = [];
  const pins = (c) => activePins(classify(c)).map((p) => pinAbs(c, p));
  for (const dp of st.diffPairs) {
    const [a, b] = dp.refs.map(dev);
    if (!a || !b) continue;
    if (Math.abs((a.y + a.h / 2) - (b.y + b.h / 2)) > 2) { offRow.push(dp.refs.join('/')); continue; }
    const fa = String(a.style.map.get('flipH') || '0') === '1', fb = String(b.style.map.get('flipH') || '0') === '1';
    const tail = st.tails.find((t) => t.pair && t.pair.join() === dp.refs.join());
    let centred = true;
    const t = tail && dev(tail.ref);
    if (t) {
      const sa = pins(a)[2], sb = pins(b)[2], d = pins(t)[0];
      centred = Math.abs(d.x - (sa.x + sb.x) / 2) <= Math.max(a.w, b.w) / 4;
    }
    if (fa === fb || !centred) unsym.push(dp.refs.join('/') + (fa === fb ? ' (pas en miroir)' : ' (source non centrée)'));
  }
  checks.pairRow = { ok: !offRow.length, n: offRow.length, detail: offRow };
  checks.symmetry = { ok: !unsym.length, n: unsym.length, detail: unsym };

  // detours: a wire much longer than the Manhattan distance of its ends
  // (the long U of the refused comparator); a pair's source line or a bus
  // over two drains stays within the margin
  const sizes = verts.filter((c) => classify(c).role === 'component').map((c) => Math.max(c.w, c.h)).sort((x, y) => x - y);
  const u = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 80;
  const us = [];
  for (const e of edges) {
    if (e.style.map.get('drawioApiCrossX') === '1') continue;
    const p = polylineOf(e, byId); if (!p || p.length < 3) continue;
    let len = 0; for (let i = 1; i < p.length; i++) len += Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y);
    const man = Math.abs(p.at(-1).x - p[0].x) + Math.abs(p.at(-1).y - p[0].y);
    if (len - man > 1.5 * u) us.push(e.id);
  }
  checks.uWires = { ok: !us.length, n: us.length, detail: us };

  return { pass: Object.values(checks).every((c) => c.ok), checks };
}
