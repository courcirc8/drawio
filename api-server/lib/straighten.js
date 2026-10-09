/**
 * straighten.js — post-placement straightening (Eric 2026-10-09, on an iPhone
 * capture of a reading drawn by drawio: "rien que sur ce zoom, il y a 5 coudes
 * à 90° évitables" — a tail transistor not under its node, a ground symbol
 * beside its pin, a port below its gate, refdes labels far from their parts).
 *
 * AVOIDABLE BEND: a bend of a wire whose two pins are almost aligned — offset
 * on one axis of at most one STEP (half the median part size) — so a shift of
 * one part or symbol by at most one step would make the wire straight.
 *
 * straighten(model): greedy; each round tries, for every wire with avoidable
 * bends, to shift ONE of its two ends (supply / ground symbol or port first,
 * then a two-terminal part, then a transistor) by exactly the offset, so its
 * pins fall on the wire's axis. A move is kept when it lowers the number of
 * misaligned wires of the page (nearly aligned but not aligned) and overlaps no
 * other body. Then every wire is rerouted (route.js, geometry only: the LVS
 * fingerprint is checked there) and each refdes label is glued to its part.
 * Pure geometry: nothing is connected or disconnected.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
const require_spawn = (c, a) => spawnSync(c, a, { encoding: 'utf8' }).stdout;
import { allCells, cellInfo, updateCell, addVertex, serialize } from './model.js';
import { classify, activePins } from './components.js';
import { routePage, pinAbs, rotatedAabb } from './route.js';
import { checkDocument } from './check.js';
import { rebuildLocalDots } from './generic-refinement.js';

// GUARD: the bench's checker (tools/check.py, as auto's referee); check.js, a
// partial port, missed the wires the reroute pushed through a body
const CHECK_PY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tools', 'check.py');
let tmpSeq = 0;
function errorCount(m) {
  return new Promise((resolve) => {
    const f = path.join(os.tmpdir(), `straighten-${process.pid}-${tmpSeq++}.drawio`);
    try { fs.writeFileSync(f, serialize(m)); } catch { resolve(null); return; }
    execFile('python3', [CHECK_PY, f, '--json'], { timeout: 120000, maxBuffer: 64 << 20 }, (err, out) => {
      fs.rm(f, { force: true }, () => {});
      try { const j = JSON.parse(out); resolve({ n: j.errors, v: (j.violations || []).filter((x) => x.severity === 'error') }); } catch { resolve(null); }
    });
  });
}
/** Contact dots where the checker finds a 3-/4-way branch without one, none on
 *  a 2-way bend (lib/refinement-audit.js reconcileContactDots, at model level). */
function reconcileDots(model) {
  const vs = checkDocument(model).violations.filter((v) => (v.rule === '30' || v.rule === 'dot-2way') && Array.isArray(v.at));
  let seq = 0;
  const same = (c, at) => c.kind === 'vertex' && c.style.map.get('contactDot') === '1' && Math.hypot(c.x + c.w / 2 - at[0], c.y + c.h / 2 - at[1]) < 0.5;
  for (const v of vs) {
    const cells = allCells(model);
    if (v.rule === 'dot-2way') { for (const el of cells) if (same(cellInfo(el), v.at)) el.parentNode.removeChild(el); continue; }
    if (cells.some((el) => same(cellInfo(el), v.at))) continue;
    while (cells.some((el) => el.getAttribute('id') === 'ST_DOT_' + seq)) seq++;
    addVertex(model, { id: 'ST_DOT_' + seq++, x: v.at[0] - 3, y: v.at[1] - 3, w: 6, h: 6, style: 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;contactDot=1;' });
  }
}

const pinOf = (cell, e, end) => pinAbs(cell, {
  x: Number(e.style.map.get(end + 'X') ?? 0.5), y: Number(e.style.map.get(end + 'Y') ?? 0.5),
});

function snapshot(model) {
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const verts = cells.filter((c) => c.kind === 'vertex' && c.x != null);
  const parts = verts.filter((c) => classify(c).role === 'component');
  const sizes = parts.map((c) => Math.max(c.w, c.h)).sort((a, b) => a - b);
  const u = sizes[Math.floor(sizes.length / 2)] || 60;
  const edges = cells.filter((c) => c.kind === 'edge' && byId.has(c.source) && byId.has(c.target) && c.source !== c.target);
  return { cells, byId, verts, parts, u, edges };
}

/** Wires with avoidable bends and the number of those bends. */
export function avoidableBends(model) {
  const { byId, u, edges } = snapshot(model);
  const STEP = u / 2;
  let wires = 0, bends = 0;
  for (const e of edges) {
    const a = pinOf(byId.get(e.source), e, 'exit'), b = pinOf(byId.get(e.target), e, 'entry');
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    // bends of the drawn path: direction changes along pin -> waypoints -> pin
    const pts = [a, ...e.points, b];
    let k = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const h1 = Math.abs(pts[i].y - pts[i - 1].y) < 0.5, h2 = Math.abs(pts[i + 1].y - pts[i].y) < 0.5;
      if (h1 !== h2) k++;
    }
    if (k === 0) continue;
    const near = (dx > 0.5 && dx <= STEP) || (dy > 0.5 && dy <= STEP);
    if (near) { wires++; bends += k; }
  }
  return { wires, bends, step: STEP };
}

export async function straighten(model, opts = {}) {
  const ROUNDS = opts.rounds ?? 40;
  let { byId, verts, u, edges } = snapshot(model);
  const STEP = u / 2;
  // owner of each refdes label (LBL_<ref> or LBL_<id>), to move it with its part
  const labelsOf = new Map();
  for (const c of verts) {
    if (!String(c.id).startsWith('LBL_')) continue;
    const ref = String(c.id).slice(4);
    const owner = verts.find((p) => p.id === ref || String(p.refdes || '') === ref);
    if (owner) { if (!labelsOf.has(owner.id)) labelsOf.set(owner.id, []); labelsOf.get(owner.id).push(c.id); }
  }
  const role = (c) => classify(c).role;
  const rank = (c) => (['power', 'ground', 'port'].includes(role(c)) ? 0 : role(c) === 'component' && !/nmos|pmos|npn|pnp|transistor|mos/i.test(c.style.map.get('shape') || '') ? 1 : 2);
  // NETS AT PIN LEVEL: the pins joined by wires (a jog can sit between two
  // pins of one net that no single wire joins: tail drain under a node)
  const relOf = (e, end) => ({ x: Number(e.style.map.get(end + 'X') ?? 0.5), y: Number(e.style.map.get(end + 'Y') ?? 0.5) });
  const pinGroups = () => {
    const key = (v, r) => `${v}|${r.x.toFixed(3)},${r.y.toFixed(3)}`;
    const par = new Map(), info = new Map();
    const find = (k) => { while (par.get(k) !== k) { par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
    for (const e of edges) {
      const a = key(e.source, relOf(e, 'exit')), b = key(e.target, relOf(e, 'entry'));
      for (const [k, v, r] of [[a, e.source, relOf(e, 'exit')], [b, e.target, relOf(e, 'entry')]]) if (!par.has(k)) { par.set(k, k); info.set(k, { v, r }); }
      par.set(find(a), find(b));
    }
    const g = new Map();
    for (const k of par.keys()) { const r = find(k); if (!g.has(r)) g.set(r, []); g.get(r).push(info.get(k)); }
    return [...g.values()].filter((l) => l.length > 1);
  };
  let groups = pinGroups();
  const posOf = (pin) => pinAbs(byId.get(pin.v), pin.r);
  const nearPairs = () => {
    const out = [];
    for (const g of groups) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      if (g[i].v === g[j].v) continue;
      const a = posOf(g[i]), b = posOf(g[j]), dx = b.x - a.x, dy = b.y - a.y;
      if ((Math.abs(dx) > 0.5 && Math.abs(dx) <= STEP && Math.abs(dy) > 0.5) || (Math.abs(dy) > 0.5 && Math.abs(dy) <= STEP && Math.abs(dx) > 0.5)) out.push({ p: g[i], q: g[j], dx, dy });
    }
    return out;
  };
  const misaligned = () => nearPairs().length;
  // pin pairs of a net exactly on one line (a straight wire is possible)
  const alignedPins = () => {
    let n = 0;
    for (const g of groups) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      if (g[i].v === g[j].v) continue;
      const a = posOf(g[i]), b = posOf(g[j]);
      if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) n++;
    }
    return n;
  };
  // rows / columns of transistors (pairs, mirrors, stacks) are never broken
  const isDevice = (c) => role(c) === 'component' && /nmos|pmos|npn|pnp|mos|bjt|transistor/i.test((c.style.map.get('shape') || '') + (c.style.map.get('apiShape') || ''));
  // (only between devices sharing a net: an incidental alignment with an
  // unrelated device is not a structure)
  const related = () => { const r = new Set(); for (const g of groups) for (const a of g) for (const b of g) if (a.v < b.v) r.add(a.v + '|' + b.v); return r; };
  let rel = related();
  const aligned = () => {
    const ds = verts.filter(isDevice).map((c) => ({ id: c.id, cx: c.x + c.w / 2, cy: c.y + c.h / 2 }));
    let n = 0;
    for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
      const k = ds[i].id < ds[j].id ? ds[i].id + '|' + ds[j].id : ds[j].id + '|' + ds[i].id;
      if (rel.has(k) && (Math.abs(ds[i].cy - ds[j].cy) < 0.5 || Math.abs(ds[i].cx - ds[j].cx) < 0.5)) { n++; if (opts.debug === 2) console.error('  aligned', ds[i].id, ds[j].id); }
    }
    return n;
  };
  const movable = (c) => c.kind === 'vertex' && ['power', 'ground', 'port', 'component'].includes(role(c));
  const overlaps = (c) => {
    const b = rotatedAabb(c), m = 2;
    return verts.some((o) => o.id !== c.id && !String(o.id).startsWith('LBL_') && role(o) !== 'junction' && role(o) !== 'other' && (() => {
      const q = rotatedAabb(o);
      return b.x < q.x + q.w - m && q.x < b.x + b.w - m && b.y < q.y + q.h - m && q.y < b.y + b.h - m;
    })());
  };
  // a part moves with its SATELLITES: supply / ground symbols and ports wired
  // to it alone (a tail transistor moved without its ground symbol would
  // trade one jog for another)
  const satellites = (id) => {
    const out = [];
    for (const v of verts) {
      if (!['power', 'ground', 'port'].includes(role(v))) continue;
      const peers = new Set(edges.filter((e) => e.source === v.id || e.target === v.id).map((e) => (e.source === v.id ? e.target : e.source)));
      if (peers.size === 1 && peers.has(id)) out.push(v.id);
    }
    return out;
  };
  const moved = new Set();
  // moves are whole pixels, and undone by restoring the saved coordinates (a
  // fractional shift and its inverse left 1e-13 px: a straight wire then read
  // as a diagonal). shift() returns its group with the exact positions to restore.
  const shift = (id, dx, dy, withSat = true) => {
    dx = Math.round(dx); dy = Math.round(dy);
    const group = [id, ...(withSat && role(byId.get(id)) === 'component' ? satellites(id) : [])];
    group.saved = [];
    for (const g of group) {
      for (const c of [g, ...(labelsOf.get(g) || [])]) {
        const v = byId.get(c);
        if (v) group.saved.push([c, { x: v.x, y: v.y }]);
        updateCell(model, c, { dx, dy });
      }
    }
    return group;
  };
  const refresh = () => { ({ byId, verts, u, edges } = snapshot(model)); groups = pinGroups(); rel = related(); };
  let moves = 0;
  // candidate single moves from the near pairs
  const candidates = () => {
    const out = [];
    for (const { p, q, dx, dy } of nearPairs()) {
      const s0 = byId.get(p.v), t = byId.get(q.v);
      if (Math.abs(dx) > 0.5 && Math.abs(dx) <= STEP) out.push([t, -dx, 0], [s0, dx, 0]);
      if (Math.abs(dy) > 0.5 && Math.abs(dy) <= STEP) out.push([t, 0, -dy], [s0, 0, dy]);
    }
    return out.filter(([v]) => movable(v));
  };
  // FLIP: a transistor stacked under a mirrored one has its drain-source lead
  // on the other side (a jog with centres aligned); flipping it — its
  // satellites (gate port, rail symbols) mirrored across its centre — puts
  // the leads on one line
  const flip = (id) => {   // -> a record that unflip() restores exactly
    const c = byId.get(id), cx = c.x + c.w / 2;
    const rec = { id, flipH: c.style.map.get('flipH') ?? null, sats: satellites(id).map((sid) => [sid, { x: byId.get(sid).x, y: byId.get(sid).y }]) };
    const on = String(rec.flipH || '0') === '1';
    updateCell(model, id, { style: { flipH: on ? null : 1 } });
    for (const [sid] of rec.sats) { const sv = byId.get(sid); updateCell(model, sid, { x: Math.round(2 * cx - sv.x - sv.w) }); }
    refresh();
    return rec;
  };
  const unflip = (rec) => { updateCell(model, rec.id, { style: { flipH: rec.flipH } }); for (const [sid, p0] of rec.sats) updateCell(model, sid, p0); refresh(); };
  const undo = (grp) => { for (const [c, p0] of grp.saved || []) updateCell(model, c, p0); refresh(); };
  const tryMove = (v, mx, my, al0) => {   // -> {grp, after, ok} (left applied)
    const grp = shift(v.id, mx, my); refresh();
    const ok = !grp.some((g) => overlaps(byId.get(g))) && aligned() >= al0;
    return { grp, after: misaligned(), ok };
  };
  // each step is COMMITTED on its own: wires of the moved parts released and
  // rerouted, contact dots rebuilt, the bench checker run; a step that adds
  // checker errors is undone and banned, the next best one is tried
  const r0 = await errorCount(model);
  let errs = r0?.n ?? null;
  // never trade errors: none of these may grow, whatever the total does
  const SEVERE = ['diagonal', 'through', '22-contact', 'comp-overlap'];
  const sev = (r) => Object.fromEntries(SEVERE.map((k) => [k, (r?.v || []).filter((x) => x.rule === k).length]));
  let sev0 = sev(r0);
  const banned = new Set();
  const commit = async (opt) => {
    const snap = Array.from(model.childNodes).map((n) => n.cloneNode(true));
    const now = new Set();
    if (opt.flip) { flip(opt.flip); now.add(opt.flip); for (const g of satellites(opt.flip)) now.add(g); }
    else for (const [id, mx, my] of opt.steps) for (const g of shift(id, mx, my)) now.add(g);
    refresh();
    const touched = edges.filter((e) => now.has(e.source) || now.has(e.target));
    const toRoute = [];
    for (const e of touched) {
      // pins now on one line: the wire is drawn STRAIGHT and kept so (the
      // point of the move); the others are released to the router
      const a = pinOf(byId.get(e.source), e, 'exit'), b = pinOf(byId.get(e.target), e, 'entry');
      if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) {
        updateCell(model, e.id, { style: { edgeStyle: 'none', drawioApiFixedRoute: 1, drawioApiGridRoute: null }, points: [] });
        continue;
      }
      if (e.style.map.has('drawioApiFixedRoute') || e.style.map.get('edgeStyle') === 'none')
        updateCell(model, e.id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null, drawioApiGridRoute: null }, points: [] });
      toRoute.push(e.id);
    }
    if (toRoute.length) await routePage(model, toRoute, {});
    try { rebuildLocalDots(model); reconcileDots(model); } catch { /* the checker judges the dots */ }
    let r2 = await errorCount(model);
    // contact dots exactly where the bench checker finds a branch without one
    // (rule 30), then checked again
    const miss = (r2?.v || []).filter((x) => x.rule === '30' && Array.isArray(x.at));
    if (miss.length) {
      let k = 0;
      for (const x of miss) { while (allCells(model).some((el) => el.getAttribute('id') === 'ST_DOT_' + k)) k++; addVertex(model, { id: 'ST_DOT_' + k++, x: x.at[0] - 3, y: x.at[1] - 3, w: 6, h: 6, style: 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;contactDot=1;' }); }
      r2 = await errorCount(model);
    }
    const e2 = r2?.n ?? null, sev2 = sev(r2);
    const worse = SEVERE.some((k) => sev2[k] > sev0[k]);
    if (opts.debug) { console.error('commit', keyOf(opt), 'errors', errs, '->', e2); if (e2 > errs) { const f = path.join(os.tmpdir(), 'dbg-st.drawio'); fs.writeFileSync(f, serialize(model)); const out = require_spawn('python3', [CHECK_PY, f, '--json']); try { for (const v of JSON.parse(out).violations.filter((v) => v.severity === 'error')) console.error('   ', v.rule, String(v.msg || v.message || '').slice(0, 90)); } catch {} } }
    if (errs == null || e2 == null || e2 > errs || worse) {
      while (model.firstChild) model.removeChild(model.firstChild);
      for (const n of snap) model.appendChild(n);
      refresh();
      return false;
    }
    errs = e2; sev0 = sev2; refresh(); return true;
  };
  const keyOf = (opt) => (opt.flip ? 'flip:' + opt.flip : opt.steps.map((x) => x.join(',')).join(';'));
  for (let round = 0; round < ROUNDS; round++) {
    const cur = misaligned();
    const al0 = aligned();
    const opts2 = [];
    for (const [v, mx, my] of candidates()) {
      const m1 = tryMove(v, mx, my, al0);
      if (m1.ok && m1.after < cur) opts2.push({ steps: [[v.id, mx, my]], score: cur - m1.after - rank(v) * 0.01 });
      else if (m1.ok && m1.after === cur) {
        // depth 2: a neutral move that makes room for an improving one
        for (const [w, nx, ny] of candidates()) {
          if (w.id === v.id) continue;
          const m2 = tryMove(w, nx, ny, al0);
          if (m2.ok && m2.after < cur) opts2.push({ steps: [[v.id, mx, my], [w.id, nx, ny]], score: cur - m2.after - 0.5 });
          undo(m2.grp);
        }
      }
      undo(m1.grp);
    }
    // a flip (it moves no centre) is judged by the pin pairs it puts on one
    // line, without making any pair nearly-aligned
    const ap0 = alignedPins();
    for (const v of verts.filter(isDevice)) {
      const rec = flip(v.id);
      const after = misaligned(), ap = alignedPins(), ok = !overlaps(byId.get(v.id)) && !satellites(v.id).some((g) => overlaps(byId.get(g)));
      unflip(rec);
      if (ok && after <= cur && ap > ap0) opts2.push({ flip: v.id, steps: [], score: (cur - after) + 0.5 * (ap - ap0) - 0.2 });
    }
    const seenK = new Set();
    const ranked = opts2.filter((o) => !banned.has(keyOf(o))).sort((x, y) => y.score - x.score).filter((o) => { const k = keyOf(o); if (seenK.has(k)) return false; seenK.add(k); return true; });
    let done = false;
    for (const o of ranked.slice(0, opts.tries ?? 8)) {
      if (await commit(o)) { moves += o.flip ? 1 : o.steps.length; done = true; break; }
      banned.add(keyOf(o));
    }
    if (!done) break;
  }
  glueLabels(model);
  return { moves };
}

/** Each refdes label touches its part (keeps the side it was on). */
export function glueLabels(model, gap = 3) {
  const verts = allCells(model).map(cellInfo).filter((c) => c.kind === 'vertex' && c.x != null);
  for (const l of verts.filter((c) => String(c.id).startsWith('LBL_'))) {
    const ref = String(l.id).slice(4);
    const p = verts.find((c) => c.id === ref || String(c.refdes || '') === ref);
    if (!p) continue;
    // a transistor: its box is much larger than the symbol drawn (leads,
    // margins); the label goes beside the drain-source lead, at mid-height, on
    // the side away from the gate (textbook habit)
    const cls = classify(p), pins = activePins(cls).map((q) => pinAbs(p, q));
    if (cls.role === 'component' && pins.length >= 3 && /^[MQJ]/i.test(String(p.refdes || ref))) {
      const [d, g, s0] = pins, leadX = (d.x + s0.x) / 2, midY = (d.y + s0.y) / 2;
      const side = leadX >= g.x ? 1 : -1;
      updateCell(model, l.id, { x: Math.round(side > 0 ? leadX + gap + 2 : leadX - gap - 2 - l.w), y: Math.round(midY - l.h / 2) });
      continue;
    }
    const b = rotatedAabb(p);
    const lx = l.x + l.w / 2, ly = l.y + l.h / 2, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    // side of the label relative to the part: the axis of the larger gap
    const gx = Math.max(b.x - (l.x + l.w), l.x - (b.x + b.w)), gy = Math.max(b.y - (l.y + l.h), l.y - (b.y + b.h));
    if (Math.max(gx, gy) <= gap + 1) continue;   // already touching
    let x = l.x, y = l.y;
    if (gy >= gx) { y = ly > cy ? b.y + b.h + gap : b.y - l.h - gap; x = cx - l.w / 2; }
    else { x = lx > cx ? b.x + b.w + gap : b.x - l.w - gap; y = cy - l.h / 2; }
    updateCell(model, l.id, { x: Math.round(x), y: Math.round(y) });
  }
}
