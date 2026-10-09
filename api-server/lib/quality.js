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
 *   ports      every port on the horizontal of the pin it drives, outside,
 *              straight wire (lib/align-ports.js)
 *   labels     no label (estimated text box) on a label, a foreign part or a wire
 *   wireOnBody no wire along / through a part's body over > 6 px
 *   netlist    the parts form ONE group joined by non-rail nets (else the
 *              reading is absurd)
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
import { misalignedPorts } from './align-ports.js';

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

  // labels: the text box estimated from its length (the cell box is a fixed
  // 20 px: "M128" spilled over a capacitor unseen); no label on another
  // label, on a foreign part or across a wire
  const textBox = (c) => {
    const tw = Math.max(c.w, 7 * String(c.value || '').length), al = c.style.map.get('align') || 'center';
    const x = al === 'right' ? c.x + c.w - tw : al === 'left' ? c.x : c.x + c.w / 2 - tw / 2;
    return { id: c.id, x, y: c.y + 1, w: tw, h: c.h - 2 };
  };
  const labels = verts.filter((c) => String(c.id).startsWith('LBL_') && String(c.value || '').trim()).map(textBox);
  // the DRAWN box: a part rotated by 90° / 270° (resistors drawn upright)
  // keeps its unrotated geometry in the file
  const bodies = verts.filter((c) => classify(c).role === 'component' && c.x != null).map((c) => {
    const r = ((Number(c.style.map.get('rotation') || 0) % 180) + 180) % 180;
    if (r !== 90) return c;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    return { ...c, x: cx - c.h / 2, y: cy - c.w / 2, w: c.h, h: c.w };
  });
  const ov = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const lab = [];
  for (const [i, l] of labels.entries()) {
    const owner = l.id.slice(4);
    if (labels.some((o, j) => j > i && ov(l, o))) lab.push(l.id + ' / étiquette');
    if (bodies.some((b) => b.id !== owner && String(b.refdes || '') !== owner && ov(l, b))) lab.push(l.id + ' / composant');
    for (const e of edges) {
      const p = polylineOf(e, byId); if (!p) continue;
      if (p.slice(1).some((b, k) => { const a = p[k];
        return Math.abs(a.x - b.x) < 0.5 ? a.x > l.x + 1 && a.x < l.x + l.w - 1 && Math.max(a.y, b.y) > l.y + 1 && Math.min(a.y, b.y) < l.y + l.h - 1
          : Math.abs(a.y - b.y) < 0.5 && a.y > l.y + 1 && a.y < l.y + l.h - 1 && Math.max(a.x, b.x) > l.x + 1 && Math.min(a.x, b.x) < l.x + l.w - 1; })) { lab.push(l.id + ' / fil'); break; }
    }
  }
  checks.labels = { ok: !lab.length, n: lab.length, detail: lab };

  // a wire running THROUGH a part (its box shrunk by 3 px) or ALONG a
  // transistor's drain-source lead (the only lead drawn on the box edge) for
  // more than 6 px; a stub leaving a pin goes outward and is not counted
  const onBody = [];
  const leadOf = (b) => { const ps = activePins(classify(b)); if (ps.length < 3 || !/mos|fet|npn|pnp|transistor/i.test(b.style.map.get('shape') || '')) return null;
    const d = pinAbs(b, ps[0]), s2 = pinAbs(b, ps[2]); return Math.abs(d.x - s2.x) < 1 ? { x: d.x, y0: Math.min(d.y, s2.y), y1: Math.max(d.y, s2.y) } : null; };
  for (const e of edges) {
    if (e.style.map.get('drawioApiCrossX') === '1') continue;
    const p = polylineOf(e, byId); if (!p) continue;
    for (const b of bodies) {
      const x0 = b.x + 3, x1 = b.x + b.w - 3, y0 = b.y + 3, y1 = b.y + b.h - 3, lead = leadOf(byId.get(b.id) || b);
      const len = p.slice(1).reduce((s2, q, k) => { const a = p[k];
        if (Math.abs(a.x - q.x) < 0.5) {
          const lo = Math.min(a.y, q.y), hi = Math.max(a.y, q.y);
          let l = a.x > x0 && a.x < x1 ? Math.max(0, Math.min(hi, y1) - Math.max(lo, y0)) : 0;
          if (lead && Math.abs(a.x - lead.x) < 1) l = Math.max(l, Math.min(hi, lead.y1) - Math.max(lo, lead.y0));
          return s2 + Math.max(0, l);
        }
        if (Math.abs(a.y - q.y) < 0.5) return s2 + (a.y > y0 && a.y < y1 ? Math.max(0, Math.min(Math.max(a.x, q.x), x1) - Math.max(Math.min(a.x, q.x), x0)) : 0);
        return s2; }, 0);
      if (len > 6) { onBody.push(`${e.id} / ${b.refdes || b.id}`); break; }
    }
  }
  checks.wireOnBody = { ok: !onBody.length, n: onBody.length, detail: onBody };

  // an ABSURD netlist (a reading gone wrong): parts in two or more groups that
  // no non-rail net joins
  const RAILN = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
  const comps = parsed.components.filter((c) => c.nodes?.length);
  const uf = new Map(comps.map((c) => [c.ref, c.ref])), fd = (k) => { while (uf.get(k) !== k) k = uf.get(k); return k; };
  const byNet = new Map();
  for (const c of comps) for (const n of c.nodes) if (!RAILN.test(n)) { if (byNet.has(n)) uf.set(fd(c.ref), fd(byNet.get(n))); else byNet.set(n, c.ref); }
  const groups = new Set(comps.map((c) => fd(c.ref))).size;
  checks.netlist = { ok: groups <= 1, n: groups > 1 ? groups : 0, detail: groups > 1 ? [`${groups} groupes de composants sans net commun (hors rails)`] : [] };

  // ports at the height of their pin, outside, straight wire (Eric)
  const mp = misalignedPorts(model);
  checks.ports = { ok: !mp.length, n: mp.length, detail: mp };

  return { pass: Object.values(checks).every((c) => c.ok), checks };
}
