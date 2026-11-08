/**
 * rails.js — how supply and ground are drawn (Eric 2026-10-10: "deux modes,
 * réglables ; pas de double label VDD"):
 *
 *   'rail'   (DEFAULT, Eric's preference): ONE horizontal line per supply
 *            above the circuit, with ONE label (VDD) at its left end, every
 *            branch rising to it; the same for ground, one line below with
 *            one ground symbol;
 *   'branch' one symbol per pin, straight over (supply) or under (ground) it.
 *
 * Mode: opts.mode, else process.env.AUTO_RAILS ('rail' | 'branch' | 'off' = as the placer drew them).
 * In 'rail' mode a pin joins the line by a straight vertical wire when the
 * way up (down) is free of parts; otherwise its wire is routed to the line's
 * symbol. A rail is redrawn even when tools/check.py counts more errors
 * (Eric 08.11: the rail is the rule), with a warning. Connectivity unchanged:
 * the same pins on the same rail net.
 */
import { allCells, cellInfo, updateCell, addWire, deleteCell, getCell, freshId } from './model.js';
import { classify } from './components.js';
import { pinAbs, routePage, netGroups, polylineOf, rotatedAabb } from './route.js';
import { wiresOnBody } from './quality.js';

const STR = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;drawioApiTemplate=1;';

export async function drawRails(model, { mode = process.env.AUTO_RAILS || 'rail', errorCount, fixDots } = {}) {
  if (mode === 'off') return { mode, rails: 0, redrawn: 0 };   // as the placer drew them
  const groups = railGroups(model);
  let errs = errorCount ? await errorCount(model) : null, done = 0;
  const warnings = [];
  for (const g of groups) {
    const snap = Array.from(model.childNodes).map((n) => n.cloneNode(true));
    const undo = () => { while (model.firstChild) model.removeChild(model.firstChild); for (const n of snap) model.appendChild(n); };
    const ok = mode === 'branch' ? await perBranch(model, g) : await oneRail(model, g);
    if (!ok) { undo(); warnings.push(`rail ${g.name || g.kind}: not redrawn (no line fits its pins), drawn as the placer left it`); continue; }
    // a rail wire through a part's body is a real defect, not a checker count: that rail stays as the placer drew it
    const before = new Set(snap.map((n) => n.getAttribute && n.getAttribute('id')));
    const fresh = new Set(allCells(model).map(cellInfo).filter((c) => c.kind === 'edge' && !before.has(c.id)).map((c) => c.id));
    const onBody = wiresOnBody(model, fresh);
    if (onBody.length) { undo(); warnings.push(`rail ${g.name || g.kind}: not redrawn (its wire would cross ${onBody.map((x) => x.split(' / ')[1]).join(', ')}), drawn as the placer left it`); continue; }
    if (fixDots) await fixDots(model);
    // Eric 08.11: the rail is the rule. A checker that counts more errors does not undo it; it is reported.
    if (errorCount) {
      const e2 = await errorCount(model);
      if (errs != null && e2 != null && e2 > errs) warnings.push(`rail ${g.name || g.kind}: drawn as a rail although the checker counts ${e2 - errs} more error(s)`);
      if (e2 != null) errs = e2;
    }
    done++;
  }
  return { mode, rails: groups.length, redrawn: done, ...(warnings.length ? { warnings } : {}) };
}

/** Rails: {kind: 'power'|'ground', name, symbols: [ids], pins: [{part, rel, at, edges}]}
 *  — every wire of the rail's NET (also a wire joining two parts' rail pins
 *  directly, the comparator's two loads) and every component pin on it. */
function railGroups(model) {
  const cs = allCells(model).map(cellInfo), byId = new Map(cs.map((c) => [c.id, c])), edges = cs.filter((c) => c.kind === 'edge');
  const net = netGroups(cs);
  const out = new Map();
  for (const v of cs.filter((c) => c.kind === 'vertex' && ['power', 'ground'].includes(classify(c).role))) {
    const kind = classify(v).role, key = kind === 'ground' ? 'ground' : 'power:' + String(v.value || '').trim().toUpperCase();
    if (!out.has(key)) out.set(key, { kind, name: String(v.value || '').trim(), symbols: [], nets: new Set(), pins: [], edges: new Set() });
    const g = out.get(key); g.symbols.push(v.id);
    for (const e of edges.filter((x) => x.source === v.id || x.target === v.id)) g.nets.add(net.get(e.id));
  }
  for (const g of out.values()) {
    const seen = new Set();
    for (const e of edges.filter((x) => g.nets.has(net.get(x.id)))) {
      g.edges.add(e.id);
      for (const [pid, end] of [[e.source, 'exit'], [e.target, 'entry']]) {
        const part = byId.get(pid);
        if (!part || classify(part).role !== 'component') continue;
        const rel = { x: Number(e.style.map.get(end + 'X') ?? 0.5), y: Number(e.style.map.get(end + 'Y') ?? 0.5) };
        const k = `${pid}|${rel.x}|${rel.y}`; if (seen.has(k)) continue; seen.add(k);
        g.pins.push({ part: pid, rel, at: pinAbs(part, rel) });
      }
    }
  }
  // a net shared by two rails' symbols (vdd and VDD written apart) is left alone
  return [...out.values()].filter((g) => g.pins.length);
}

/** The drawn box of a cell (a part rotated by 90° keeps its unrotated geometry). */
const drawn = (c) => {
  const r = ((Number(c.style.map.get('rotation') || 0) % 180) + 180) % 180;
  if (r !== 90) return c;
  return { ...c, x: c.x + c.w / 2 - c.h / 2, y: c.y + c.h / 2 - c.w / 2, w: c.h, h: c.w };
};

/** One line, one symbol. */
async function oneRail(model, g) {
  const cs = allCells(model).map(cellInfo), byId = new Map(cs.map((c) => [c.id, c]));
  const parts = cs.filter((c) => c.kind === 'vertex' && c.x != null && !g.symbols.includes(c.id) && !String(c.id).startsWith('LBL_') && c.style.map.get('contactDot') !== '1').map(drawn);
  if (!parts.length) return false;
  const down = g.kind === 'ground';
  // the line just beyond every part, on the rail's side
  let y = Math.round(down ? Math.max(...parts.map((c) => c.y + c.h)) + 30 : Math.min(...parts.map((c) => c.y)) - 30);
  const symId = g.symbols[0], sym = byId.get(symId);
  const sRel = down ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };
  const sp = pinAbs(sym, sRel);
  // every old rail wire and every other symbol go
  for (const id of g.edges) if (getCell(model, id)) deleteCell(model, id);
  for (const id of g.symbols.slice(1)) if (getCell(model, id)) deleteCell(model, id);
  for (const e of allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && (e.source === symId || e.target === symId))) deleteCell(model, e.id);
  // the label at the line's left end, over (under) the leftmost pin: that pin's wire is straight; the next pin
  // to the right when another wire runs through the symbol there (the ring's feedback under the row, 08.11)
  const left = allCells(model).map(cellInfo), byId2 = new Map(left.map((c) => [c.id, c]));
  const segs = left.filter((c) => c.kind === 'edge').map((e) => polylineOf(e, byId2)).filter(Boolean)
    .flatMap((pl) => pl.slice(1).map((q, i) => [pl[i], q]));
  const box = rotatedAabb(sym);
  const freeAt = (x) => {
    const dx = x - sp.x, dy = y - sp.y, b = { x: box.x + dx - 2, y: box.y + dy - 2, w: box.w + 4, h: box.h + 4 };
    return !segs.some(([a, c]) => Math.max(a.x, c.x) > b.x && Math.min(a.x, c.x) < b.x + b.w && Math.max(a.y, c.y) > b.y && Math.min(a.y, c.y) < b.y + b.h);
  };
  const xs = [...new Set(g.pins.map((p) => Math.round(p.at.x)))].sort((a, b) => a - b);
  // nowhere free at that height (a wire runs along it): the rail one step further out, up to 8 steps
  for (let k = 0; k < 8 && !xs.some(freeAt); k++) y += down ? 20 : -20;
  const xL = xs.find(freeAt) ?? xs[0];
  updateCell(model, symId, { dx: Math.round(xL - sp.x), dy: Math.round(y - sp.y) });
  // each pin: straight to the line when the way is free, else routed to the symbol
  const routed = [];
  // its own part too: a pin that is not on the rail side of its part would run through its own body (bench41)
  const blocked = (p) => parts.some((c) => c.x < p.at.x + 2 && c.x + c.w > p.at.x - 2
    && (down ? c.y + c.h > p.at.y + 1 && c.y < y : c.y < p.at.y - 1 && c.y + c.h > y));
  const seen = new Set();
  for (const p of g.pins) {
    const k = `${p.part}|${p.rel.x}|${p.rel.y}`; if (seen.has(k)) continue; seen.add(k);
    const straight = !blocked(p) && (down ? p.at.y <= y : p.at.y >= y);
    const w = addWire(model, { source: p.part, target: symId, sourcePin: p.rel, targetPin: sRel,
      style: straight ? STR : 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;',
      points: straight ? [{ x: Math.round(p.at.x), y }, { x: xL, y }] : [] });
    if (!straight) routed.push(w.getAttribute('id'));
  }
  if (routed.length) await routePage(model, routed, {});
  return true;
}

/** One symbol per pin, straight over / under it. */
async function perBranch(model, g) {
  const down = g.kind === 'ground', sRel = down ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };
  const proto = getCell(model, g.symbols[0]).cloneNode(true), parent = getCell(model, g.symbols[0]).parentNode;
  for (const id of g.edges) if (getCell(model, id)) deleteCell(model, id);
  for (const id of g.symbols) if (getCell(model, id)) deleteCell(model, id);
  for (const p of g.pins) {
    const copy = proto.cloneNode(true), id = freshId(model, down ? 'GNDB' : 'VDDB');
    copy.setAttribute('id', id); parent.appendChild(copy);
    const c = allCells(model).map(cellInfo).find((x) => x.id === id), sp = pinAbs(c, sRel);
    updateCell(model, id, { dx: Math.round(p.at.x - sp.x), dy: Math.round(p.at.y + (down ? 24 : -24) - sp.y) });
    addWire(model, { source: p.part, target: id, sourcePin: p.rel, targetPin: sRel, style: STR, points: [] });
  }
  return true;
}
