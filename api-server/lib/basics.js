/**
 * basics.js — the basic drawing rules a human reader expects, as hard
 * per-instance checks (Eric's blind review 2026-10-05: all 15 auto drawings
 * "between bad and very bad", while check.py found 0 to 2 errors on them and
 * conventions.js scored them 1.0 — its checks are averages over the page).
 *
 *   mos-upside-down   a MOS whose source pin is on the wrong side of its drain:
 *                     PMOS source must be ABOVE its drain (supply on top), NMOS
 *                     source BELOW its drain
 *   pmos-below-nmos   a PMOS and an NMOS sharing a drain net (one branch), the
 *                     PMOS drawn below the NMOS
 *   pair-not-mirrored a differential pair whose two devices are not on one row,
 *                     or whose gates do not face outwards (mirror image)
 *   input-bends       a wire from an input port with more than one bend
 *   isolated          a part far from every part it is wired to (nearest part
 *                     sharing a non-rail net > 3x the median of that distance
 *                     over the page, and > 4 part heights): alone in a corner,
 *                     joined to its circuit only by net labels
 * Pure geometry: never moves anything. Returns {count, byRule, items}.
 */
import { allCells, cellInfo } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, polylineOf } from './route.js';
import { detectStructures, isPmosLike } from './patterns.js';
import { netRoles } from './function.js';

const median = (a) => { const s = [...a].sort((p, q) => p - q); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

export function basicsReport(model, parsed) {
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const byRef = new Map();
  for (const c of cells) {
    if (c.kind !== 'vertex' || c.x == null) continue;
    const cls = classify(c);
    if (cls.role !== 'component') continue;
    const ref = c.refdes || c.id;
    const pins = activePins(cls).map((p) => pinAbs(c, p));
    byRef.set(String(ref), { cell: c, cls, pins, cx: c.x + c.w / 2, cy: c.y + c.h / 2 });
  }
  const items = [];
  const add = (rule, refs, detail) => items.push({ rule, refs, detail });
  const comps = new Map(parsed.components.map((c) => [String(c.ref), c]));
  const mos = parsed.components.filter((c) => c.prefix === 'M' && byRef.has(String(c.ref)));

  // MOS orientation: pins are [D, G, S] in SPICE order (components.js pinOrder)
  for (const c of mos) {
    const g = byRef.get(String(c.ref)); const [d, , s] = g.pins;
    if (!d || !s) continue;
    const p = isPmosLike(c);
    if (p ? s.y > d.y + 1 : s.y < d.y - 1) add('mos-upside-down', [c.ref], p ? 'PMOS source below drain' : 'NMOS source above drain');
  }
  // one branch: PMOS above NMOS when they share a drain net
  for (const a of mos) for (const b of mos) {
    if (!isPmosLike(a) || isPmosLike(b) || a.nodes[0] !== b.nodes[0]) continue;
    if (byRef.get(String(a.ref)).cy > byRef.get(String(b.ref)).cy + 1) add('pmos-below-nmos', [a.ref, b.ref], `drain net ${a.nodes[0]}`);
  }
  // differential pairs: one row, gates outwards
  for (const pr of detectStructures(parsed).diffPairs) {
    const [A, B] = pr.refs.map((r) => byRef.get(String(r)));
    if (!A || !B) continue;
    const h = Math.max(A.cell.h, B.cell.h);
    if (Math.abs(A.cy - B.cy) > 0.25 * h) { add('pair-not-mirrored', pr.refs, 'not on one row'); continue; }
    const [L, R] = A.cx <= B.cx ? [A, B] : [B, A];
    const gL = L.pins[1], gR = R.pins[1];
    if (!(gL && gR && gL.x < L.cx && gR.x > R.cx)) add('pair-not-mirrored', pr.refs, 'gates not facing outwards');
  }
  // input wires: at most one bend
  const roles = netRoles(parsed);
  for (const e of cells) {
    if (e.kind !== 'edge') continue;
    const ends = [byId.get(e.source), byId.get(e.target)].filter(Boolean);
    const port = ends.find((v) => classify(v).role === 'port');
    if (!port) continue;
    const net = String(port.value || '').trim();
    if (roles[net] !== 'input' && roles[net.toLowerCase()] !== 'input') continue;
    const pl = polylineOf(e, byId);
    if (pl && pl.length - 2 > 1) add('input-bends', [net], `${pl.length - 2} bends`);
  }
  // isolated parts: far from every part they share a (non-rail) net with
  const rails = new Set(['0', ...Object.keys(roles).filter((n) => roles[n] === 'supply' || roles[n] === 'ground')]);
  const isRail = (n) => rails.has(n) || /^(vdd|vcc|vss|gnd|avdd|dvdd|avss|dvss|agnd|dgnd|vpwr|vgnd)$/i.test(n);
  const placed = parsed.components.filter((c) => byRef.has(String(c.ref)));
  const nets = (c) => new Set(c.nodes.filter((n) => !isRail(n)));
  const near = [];
  for (const a of placed) {
    const na = nets(a); const A = byRef.get(String(a.ref));
    const ds = placed.filter((b) => b !== a && [...nets(b)].some((n) => na.has(n)))
      .map((b) => { const B = byRef.get(String(b.ref)); return Math.hypot(A.cx - B.cx, A.cy - B.cy); });
    if (ds.length) near.push([a.ref, Math.min(...ds), A.cell.h]);
  }
  const m = median(near.map((x) => x[1]));
  for (const [ref, d, h] of near) if (m > 0 && d > 3 * m && d > 4 * h) add('isolated', [ref], `nearest wired part ${Math.round(d)} px, median ${Math.round(m)}`);
  const byRule = {};
  for (const it of items) byRule[it.rule] = (byRule[it.rule] || 0) + 1;
  return { count: items.length, byRule, items, comps: comps.size };
}
