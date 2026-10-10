/**
 * template-attach.js — the passives AROUND a template, each attached to the
 * node it serves (Eric 2026-10-10, after the OTA renders: "le cœur est bien
 * placé, mais R de rétroaction, C1 / C2, source de courant mal placés").
 *
 * For every 2-terminal part outside the template (R, C, L, I, V) whose nets
 * reach the template:
 *   - node to rail (a load capacitor, a bias resistor): upright, in a free
 *     column right of its node (or of the template), hanging from the node's
 *     height towards its rail (ground below, supply above);
 *   - node to node (a feedback resistor, a Miller or coupling capacitor):
 *     upright between the two nodes' heights, in the free column closest to
 *     them — inside the template between its two columns first, then right
 *     of it.
 * The part moves with its satellites (rail symbol, a port wired to it alone)
 * and label; its wires are routed again by the caller. Parts with no net on
 * the template, or with no free spot, keep place-sa's position.
 */
import { allCells, cellInfo, updateCell, getCell, freshId, deleteCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs } from './route.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
const GND = /^(0|gnd\w*|vss\w*|vee\w*|avss|dvss)$/i;

/**
 * @param model   the page
 * @param parsed  the netlist
 * @param tpl     refs of the template's parts (already placed)
 * @param opts.across  parts to lay HORIZONTALLY in a chain between two nodes
 *                      far apart (a Miller capacitor, with its series resistor)
 * @returns {attached: [refs]}
 */
export function attachPassives(model, parsed, tpl, opts = {}) {
  const cells = () => allCells(model).map(cellInfo);
  const byRef = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const comp = new Map(parsed.components.map((c) => [c.ref, c]));
  const tplSet = new Set(tpl);
  // every pin of a placed template part, with its net
  const anchors = [];
  for (const r of tpl) {
    const c = byRef(r), pc = comp.get(r); if (!c || !pc) continue;
    activePins(classify(c)).forEach((p, k) => { if (pc.nodes[k] != null) { const at = pinAbs(c, p); anchors.push({ ref: r, net: pc.nodes[k], at, side: Math.abs(at.x - c.x) < 2 ? -1 : Math.abs(at.x - (c.x + c.w)) < 2 && Math.abs(at.y - c.y) >= 2 && Math.abs(at.y - (c.y + c.h)) >= 2 ? 1 : 0 }); } });
  }
  const tplCells = tpl.map(byRef).filter(Boolean);
  if (!tplCells.length) return { attached: [] };
  const box = { x0: Math.min(...tplCells.map((c) => c.x)), x1: Math.max(...tplCells.map((c) => c.x + c.w)), y0: Math.min(...tplCells.map((c) => c.y)), y1: Math.max(...tplCells.map((c) => c.y + c.h)) };
  const attached = [];
  let colX = box.x1 + 70;
  // satellites: rail symbols / ports wired to this part alone, and its label
  const groupOf = (me) => {
    const cs = cells(), edges = cs.filter((c) => c.kind === 'edge'), g = [me.id];
    for (const v of cs.filter((c) => c.kind === 'vertex' && ['power', 'ground', 'port'].includes(classify(c).role))) {
      const peers = new Set(edges.filter((e) => e.source === v.id || e.target === v.id).map((e) => (e.source === v.id ? e.target : e.source)));
      if (peers.size === 1 && peers.has(me.id)) g.push(v.id);
    }
    for (const c of cs) if (c.kind === 'vertex' && (String(c.id) === 'LBL_' + me.refdes || String(c.id) === 'LBL_' + me.id)) g.push(c.id);
    return g;
  };
  // the drawn (rotated) box of a part centred at (cx, cy), upright
  const upright = (c) => ({ w: Math.min(c.w, c.h), h: Math.max(c.w, c.h) });
  const free = (me, cx, cy, sz) => !cells().some((o) => o.kind === 'vertex' && o.id !== me.id && o.x != null && !String(o.id).startsWith('LBL_')
    && o.style.map.get('contactDot') !== '1' && !groupOf(me).includes(o.id)
    && o.x < cx + sz.w / 2 + 14 && o.x + o.w > cx - sz.w / 2 - 14 && o.y < cy + sz.h / 2 + 14 && o.y + o.h > cy - sz.h / 2 - 14);
  // upright, the end on net `upNet` on top (rotation 90 or 270 for a part
  // drawn lying — a resistor 100 x 20 —, flipV for one drawn standing)
  const place = (me, cx, cy, pc, upNet) => {
    const k = pc.nodes.indexOf(upNet);
    const lying = me.w > me.h;
    for (const rot of lying ? [90, 270] : [0, 'flip']) {
      updateCell(model, me.id, { style: rot === 'flip' ? { flipV: 1 } : lying ? { rotation: rot } : { flipV: null } });
      const c = byRef(String(me.refdes)), ps = activePins(classify(c)).map((q) => pinAbs(c, q));
      if (k < 0 || ps.length < 2 || ps[k].y <= ps[1 - k].y) break;
    }
    const now = byRef(String(me.refdes));
    const dx = Math.round(cx - (now.x + now.w / 2)), dy = Math.round(cy - (now.y + now.h / 2));
    for (const id of groupOf(now)) updateCell(model, id, { dx, dy });
  };
  // a ground / supply symbol SHARED with a part outside the template is split:
  // that part gets its own symbol (one wire), which then moves with it — a
  // shared symbol tied the attached parts' rail ends across the drawing
  splitRails(model, new Set(tpl.map((r) => byRef(r)?.id).filter(Boolean)));
  // ACROSS: a chain lying between two template nodes, at the height of the
  // first node's line (a Miller capacitor between the two stage outputs)
  if (opts.across?.length) {
    const parts = opts.across.map((r) => comp.get(r)).filter(Boolean);
    const nets = parts.flatMap((c) => c.nodes.slice(0, 2));
    const ends = [...new Set(nets)].filter((n) => nets.filter((x) => x === n).length === 1 && anchors.some((a) => a.net === n));
    if (ends.length === 2) {
      const xOf = (n) => anchors.filter((a) => a.net === n && a.side === 0);
      let [L, R] = ends.map((n) => ({ n, as: xOf(n).length ? xOf(n) : anchors.filter((a) => a.net === n) }));
      if (Math.max(...L.as.map((a) => a.at.x)) > Math.max(...R.as.map((a) => a.at.x))) [L, R] = [R, L];
      // between the left node's line and the left edge of the right node's parts
      const xa = Math.max(...L.as.map((a) => a.at.x)) + 40, xb = Math.min(...R.as.map((a) => { const c = byRef(a.ref); return c ? Math.min(a.at.x, c.x) - 20 : a.at.x; }));
      const y = opts.acrossY ?? L.as.reduce((t, a) => t + a.at.y, 0) / L.as.length;
      // order the chain from the left node
      const chain = []; let cur = L.n; const left = [...parts];
      while (left.length) { const k = left.findIndex((c) => c.nodes.slice(0, 2).includes(cur)); if (k < 0) break; const c = left.splice(k, 1)[0]; chain.push([c, cur]); cur = c.nodes.slice(0, 2).find((n) => n !== cur); }
      if (chain.length === parts.length && xb - xa > 60 * chain.length) {
        chain.forEach(([c, inNet], i) => {
          const me = byRef(c.ref); if (!me) return;
          // lying, its end on `inNet` on the left
          const k = c.nodes.indexOf(inNet);
          for (const rot of me.w >= me.h ? [0, 180] : [90, 270]) {
            updateCell(model, me.id, { style: { rotation: rot || null } });
            const cc = byRef(c.ref), ps = activePins(classify(cc)).map((q) => pinAbs(cc, q));
            if (k < 0 || ps.length < 2 || ps[k].x <= ps[1 - k].x) break;
          }
          const now = byRef(c.ref), cx = xa + (xb - xa) * (i + 1) / (chain.length + 1);
          const dx = Math.round(cx - (now.x + now.w / 2)), dy = Math.round(y - (now.y + now.h / 2));
          for (const id of groupOf(now)) updateCell(model, id, { dx, dy });
          attached.push(c.ref); tplSet.add(c.ref);
        });
      }
    }
  }
  for (const pc of parsed.components) {
    if (tplSet.has(pc.ref) || !['R', 'C', 'L', 'I', 'V'].includes(pc.prefix) || pc.nodes.length < 2) continue;
    const me = byRef(pc.ref); if (!me) continue;
    const [n1, n2] = pc.nodes;
    const a1 = anchors.filter((a) => a.net === n1), a2 = anchors.filter((a) => a.net === n2);
    const sz = upright(me);
    let spot = null;
    if ((a1.length && RAIL.test(n2)) || (a2.length && RAIL.test(n1))) {
      // node to rail: hang from the node towards the rail
      const [as, rail] = a1.length && RAIL.test(n2) ? [a1, n2] : [a2, n1];
      const A = as.reduce((u, v) => (v.at.x > u.at.x ? v : u));   // its rightmost pin: room to the right
      const s = GND.test(rail) ? 1 : -1;
      const cy = A.at.y + s * (sz.h / 2 + 14);
      for (const cx of [A.at.x + (A.side === 1 ? 70 : 60), colX, colX + 80, colX + 160]) if (free(me, cx, cy, sz)) { spot = [cx, cy, s > 0 ? A.net : rail]; break; }
    } else if (a1.length && a2.length) {
      // node to node: between the two heights, in the closest free column
      let best = null;
      for (const p of a1) for (const q of a2) { const d = Math.abs(p.at.x - q.at.x) + Math.abs(p.at.y - q.at.y); if (!best || d < best.d) best = { p, q, d }; }
      const cy = (best.p.at.y + best.q.at.y) / 2;
      // inside the template only between two internal nodes; a part on a
      // pin that faces outwards (an input gate) goes on that side, outside
      const out = [best.p, best.q].find((a) => a.side === 1 && a.at.x > (box.x0 + box.x1) / 2);
      const xs = out ? [out.at.x + 70, Math.max(out.at.x + 70, colX), colX + 80, colX + 160]
        : [(box.x0 + box.x1) / 2, Math.max(best.p.at.x, best.q.at.x) + 60, colX, colX + 80, colX + 160];
      // on an outward pin the part ENDS at that pin's height (a divider: the
      // upper part from the output down to the gate, the lower one below it)
      let cy2 = cy;
      if (out) { const other = out === best.p ? best.q : best.p; cy2 = out.at.y + (other.at.y < out.at.y ? -1 : 1) * (sz.h / 2 + 14); }
      const upper = best.p.at.y <= best.q.at.y ? best.p.net : best.q.net;
      for (const cx of xs) if (free(me, cx, cy2, sz)) { spot = [cx, cy2, upper]; break; }
    }
    if (!spot) continue;
    place(me, spot[0], spot[1], pc, spot[2]);
    if (spot[0] >= colX - 1) colX = spot[0] + 80;
    attached.push(pc.ref);
  }
  return { attached };
}

/** Clone a rail symbol for every wire it has to a part outside the template
 *  (the first wire keeps the original). */
export function splitRails(model, tplIds) {
  const cs = allCells(model).map(cellInfo), edges = cs.filter((c) => c.kind === 'edge');
  for (const v of cs.filter((c) => c.kind === 'vertex' && ['power', 'ground'].includes(classify(c).role))) {
    const es = edges.filter((e) => e.source === v.id || e.target === v.id);
    if (es.length < 2) continue;
    // keep the template's wires (and one wire if there are none) on the original
    const keep = es.some((e) => tplIds.has(e.source === v.id ? e.target : e.source)) ? (e) => tplIds.has(e.source === v.id ? e.target : e.source) : (e) => e === es[0];
    const byId = new Map(cs.map((c) => [c.id, c]));
    const outsider = (x) => { const o = byId.get(x.source === v.id ? x.target : x.source); return o && classify(o).role === 'component' && !tplIds.has(o.id); };
    for (const e of es.filter((x) => !keep(x) && outsider(x))) {
      const el = getCell(model, v.id), copy = el.cloneNode(true), id = freshId(model, 'RS');
      copy.setAttribute('id', id);
      el.parentNode.appendChild(copy);
      updateCell(model, e.id, e.source === v.id ? { source: id, points: [] } : { target: id, points: [] });
    }
  }
  // one symbol per pin and rail: a part wired to two symbols of the same rail
  // on the same pin kept both, moving together on top of each other
  const cs2 = allCells(model).map(cellInfo), byId2 = new Map(cs2.map((c) => [c.id, c])), edges2 = cs2.filter((c) => c.kind === 'edge');
  const seen = new Map();
  for (const e of edges2) {
    const ends = [[e.source, 'exit', e.target, 'entry'], [e.target, 'entry', e.source, 'exit']];
    for (const [vid, , pid, pe] of ends) {
      const v = byId2.get(vid), part = byId2.get(pid);
      if (!v || !part || !['power', 'ground'].includes(classify(v).role) || classify(part).role !== 'component') continue;
      if (edges2.filter((x) => x.source === vid || x.target === vid).length !== 1) continue;   // only a symbol serving this one wire
      const key = `${pid}|${e.style.map.get(pe + 'X')}|${e.style.map.get(pe + 'Y')}|${String(v.value || '').toUpperCase()}`;
      if (!seen.has(key)) { seen.set(key, vid); continue; }
      deleteCell(model, vid);   // the symbol and its wire
    }
  }
}
