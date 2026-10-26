/**
 * place-cascode.js — engine "cascode": the TELESCOPIC and FOLDED-CASCODE OTAs
 * drawn as textbooks draw them (Eric's list, 2026-10-12, second batch):
 * two symmetric columns, each a stack of devices from the supply to the
 * ground, the devices of one row side by side.
 *
 *     telescopic                         folded
 *    ┤M7 ──── M8├   (load)                    ┤M9 ──── M10├
 *    ┤M5 ─VB─ M6├   (cascodes)                ┤M7 ─VB─ M8├
 *     X        Y ── OUT                        X        Y
 *    ┤M3 ─VB─ M4├                         ┤M3 ─VB─ M4├
 * IN─┤M1      M2├─IN            M1   M2      ┤      ├
 *        tail                     ╲  ╱ ────── F1  F2   (fold nodes)
 *                                 tail       ┤M5 ─VB─ M6├
 *
 * The column devices face each other: one gate line per row between the
 * columns (Razavi draws it through the left device: a wire through a part
 * here); a bias with no other connection gets its port on a stem off that
 * line; a mirror's diode link drops from its column node into the middle
 * onto its line. The input pair is the bottom (top) row of the columns
 * (telescopic) or stands left of them, its drains taken across to the fold
 * nodes (folded). Common-source stages driven by a column node (two-stage
 * versions) stand outside the columns, their gate on the node's height.
 * Positions imposed exactly (as lib/place-ota.js); AUTO_CASCODE=0 disables.
 */
import { detectStructures, isPmosLike } from './patterns.js';
import { importNetlistSA } from './place-sa.js';
import { allCells, cellInfo, updateCell, addWire, deleteCell } from './model.js';
import { classify, activePins } from './components.js';
import { pinAbs, routePage } from './route.js';
import { rebuildLocalDots } from './generic-refinement.js';
import { alignPorts } from './align-ports.js';
import { attachPassives } from './template-attach.js';
import { teeNet, alignRails, dropAmong, STF, relPin, atPin } from './place-ota.js';

const RAIL = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss|power(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?|ground(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?)$/i;
const GNDN = /^(0|gnd\w*|vss\w*|vee\w*|avss|dvss|ground(?:_(?!(?:down|dn|pd|good|pg|ok|on|off|en|enable|sense|sns|fail|fault|up|rst|reset|sel|det|detect|valid|ready|rdy|sw|ctrl|ctl|req|ack|mon|level)(?:_|$))\w+)?)$/i;
const D = (c) => c.nodes[0], G = (c) => c.nodes[1], S = (c) => c.nodes[2];
const isMos = (c) => c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'J';

/** The reading, or null: {kind, pmosIn, colA, colB (refs, top → bottom),
 *  iA, iB, tail, bias, ref, side: [{col, k, m, load}], used}. */
export function cascodeReading(parsed) {
  let st; try { st = detectStructures(parsed); } catch { return null; }
  const comps = parsed.components, byRef = new Map(comps.map((c) => [c.ref, c]));
  for (const dp of st.diffPairs) {
    const [p, q] = dp.refs.map((r) => byRef.get(r));
    if (!p || !q || st.crossCoupled.some((cc) => cc.refs.includes(p.ref) || cc.refs.includes(q.ref))) continue;
    const pIn = isPmosLike(p), tailNode = S(p);
    if (S(q) !== tailNode) continue;
    // walk a drain-source chain from a node, away from `prev`, until a rail,
    // a branch, or the pair's source node
    const walk = (n, skip) => {
      const out = [];
      for (;;) {
        const cs = comps.filter((c) => isMos(c) && !skip.has(c.ref) && !out.includes(c) && (D(c) === n || S(c) === n) && D(c) !== S(c));
        if (cs.length !== 1) return { devs: out, end: n, ok: false };
        const c = cs[0], next = D(c) === n ? S(c) : D(c);
        out.push(c);
        if (RAIL.test(next)) return { devs: out, end: next, ok: true };
        if (next === tailNode) return { devs: out, end: next, ok: false };
        n = next;
      }
    };
    const column = (x, other) => {
      const skip = new Set([x.ref, other.ref]);
      const at = comps.filter((c) => isMos(c) && !skip.has(c.ref) && (D(c) === D(x) || S(c) === D(x)));
      if (at.length === 1) {
        // telescopic: the chain above the pair device, the pair device at its end
        const w = walk(D(x), skip);
        if (!w.ok || w.devs.length < 2) return null;
        return { kind: 'telescopic', devs: [...w.devs].reverse().concat([x]), rail: w.end };   // rail end first
      }
      if (at.length === 2) {
        // folded: a sink / source from the fold node to a rail, a cascode the other way
        const [u, v] = at, ends = [u, v].map((c) => (D(c) === D(x) ? S(c) : D(c)));
        const k = RAIL.test(ends[0]) ? 0 : RAIL.test(ends[1]) ? 1 : -1;
        if (k < 0 || RAIL.test(ends[1 - k]) || isPmosLike(at[k]) === pIn) return null;
        const up = walk(D(x), new Set([...skip, at[k].ref]));
        if (!up.ok || up.devs.length < 2) return null;
        return { kind: 'folded', devs: [...up.devs].reverse().concat([at[k]]), rail: up.end, foldAt: up.devs.length };   // fold node below devs[foldAt-1]
      }
      return null;
    };
    const cp = column(p, q), cq = column(q, p);
    if (!cp || !cq || cp.kind !== cq.kind || cp.devs.length !== cq.devs.length) continue;
    if (cp.devs.some((c, i) => isPmosLike(c) !== isPmosLike(cq.devs[i]))) continue;
    if (cp.devs.some((c) => cq.devs.includes(c))) continue;
    // a cascode in the column (both ends off the rails, not the pair)
    const isCasc = (c) => c !== p && c !== q && !RAIL.test(D(c)) && !RAIL.test(S(c));
    if (!cp.devs.some(isCasc)) continue;
    // top → bottom: the supply end on top
    const flip = (col) => {
      const top = col.kind === 'telescopic' ? !GNDN.test(col.rail) : !GNDN.test(col.rail);
      return top ? col.devs : [...col.devs].reverse();
    };
    let colA = flip(cp), colB = flip(cq), iA = p, iB = q;
    // the mirror's diode (if any) on the left column
    const nodeOf = (col) => new Set(col.flatMap((c) => [D(c), S(c)]).filter((n) => !RAIL.test(n)));
    const gA = new Set(colA.map(G)), nB = nodeOf(colB);
    if ([...gA].some((g) => nB.has(g))) { [colA, colB, iA, iB] = [colB, colA, q, p]; }
    const used = new Set([...colA, ...colB, p, q].map((c) => c.ref));
    // tail, its bias diode and reference (as lib/place-ota.js)
    const tail = comps.find((c) => !used.has(c.ref) && (isMos(c) ? D(c) === tailNode
      : ['I', 'R'].includes(c.prefix) && c.nodes.includes(tailNode) && c.nodes.some((n) => n !== tailNode && RAIL.test(n))));
    if (tail) used.add(tail.ref);
    const bias = tail && isMos(tail) ? comps.find((c) => !used.has(c.ref) && isMos(c) && G(c) === G(tail) && D(c) === G(c) && isPmosLike(c) === isPmosLike(tail)) : null;
    if (bias) used.add(bias.ref);
    const ref = bias ? comps.find((c) => !used.has(c.ref) && ['I', 'R'].includes(c.prefix) && c.nodes.includes(D(bias)) && c.nodes.some((n) => n !== D(bias) && RAIL.test(n))) : null;
    if (ref) used.add(ref.ref);
    // side stages: a common-source device on a column node, outside the column
    const side = [];
    const kind = cp.kind;
    for (const [col, name] of [[colA, 'A'], [colB, 'B']]) {
      if (kind === 'folded' && name === 'A') continue;   // the input pair stands there
      for (let k = 0; k + 1 < col.length; k++) {
        const n = [D(col[k]), S(col[k])].find((x) => x === D(col[k + 1]) || x === S(col[k + 1]));
        const m = comps.find((c) => !used.has(c.ref) && isMos(c) && G(c) === n && RAIL.test(S(c)));
        if (!m) continue;
        used.add(m.ref);
        const load = comps.find((c) => !used.has(c.ref) && isMos(c) && D(c) === D(m) && RAIL.test(S(c)) && S(c) !== S(m))
          || comps.find((c) => !used.has(c.ref) && ['R', 'I'].includes(c.prefix) && c.nodes.includes(D(m)) && c.nodes.some((x) => x !== D(m) && RAIL.test(x) && x !== S(m)));
        if (load) used.add(load.ref);
        side.push({ col: name, k, node: n, m: m.ref, load: load?.ref, loadPin: load && !isMos(load) ? load.nodes.indexOf(D(m)) : 0 });
      }
    }
    const fold = kind === 'folded' ? { A: D(iA), B: D(iB) } : null;
    return {
      kind, pmosIn: pIn, colA: colA.map((c) => c.ref), colB: colB.map((c) => c.ref), iA: iA.ref, iB: iB.ref,
      tail: tail?.ref, tailK: tail ? tail.nodes.indexOf(tailNode) : null, bias: bias?.ref, ref: ref?.ref, side, fold, used,
    };
  }
  return null;
}

/** place-sa's start (units of the median part size). */
export function cascodeLayout(parsed, R) {
  const pos = new Map(), put = (r, x, y) => { if (r) pos.set(r, { x, y }); };
  const x0 = R.kind === 'folded' ? 4 : 0;
  R.colA.forEach((r, k) => put(r, x0, 1.8 * k)); R.colB.forEach((r, k) => put(r, x0 + 2.5, 1.8 * k));
  if (R.kind === 'folded') { put(R.iA, 0, 1.8 * (R.colA.length - 2)); put(R.iB, 2, 1.8 * (R.colA.length - 2)); }
  let n = 0;
  for (const c of parsed.components) if (!pos.has(c.ref)) pos.set(c.ref, { x: x0 + 5 + 2 * n++, y: 0 });
  return pos;
}

export async function importNetlistCascode(model, parsed, opts = {}) {
  const R = cascodeReading(parsed);
  if (!R) throw new Error('cascode: no telescopic / folded-cascode OTA');
  const placed = await importNetlistSA(model, parsed, { ...opts, saInit: cascodeLayout(parsed, R), saT0: opts.saT0 ?? 0.01, saIters: opts.saIters ?? 1 });
  await impose(model, parsed, R);
  return placed;
}

async function impose(model, parsed, R) {
  const comp = new Map(parsed.components.map((c) => [c.ref, c]));
  const cells = () => allCells(model).map(cellInfo);
  const find = (ref) => cells().find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref);
  const pinsOf = (r) => { const c = find(r); return activePins(classify(c)).map((p) => pinAbs(c, p)); };
  const pin = (r, k) => pinsOf(r)[k];
  const ctr = (r) => { const c = find(r); return { x: c.x + c.w / 2, y: c.y + c.h / 2 }; };
  const move = (ref, dx, dy = 0) => {
    dx = Math.round(dx); dy = Math.round(dy); if (!ref || (!dx && !dy)) return;
    const cs = cells(), me = cs.find((c) => c.kind === 'vertex' && String(c.refdes || '') === ref); if (!me) return;
    const edges = cs.filter((c) => c.kind === 'edge'), group = [me.id];
    for (const v of cs.filter((c) => c.kind === 'vertex' && ['power', 'ground', 'port'].includes(classify(c).role))) {
      const peers = new Set(edges.filter((e) => e.source === v.id || e.target === v.id).map((e) => (e.source === v.id ? e.target : e.source)));
      if (peers.size === 1 && peers.has(me.id)) group.push(v.id);
    }
    for (const c of cs) if (c.kind === 'vertex' && (String(c.id) === 'LBL_' + ref || String(c.id) === 'LBL_' + me.id)) group.push(c.id);
    for (const id of group) updateCell(model, id, { dx, dy });
  };
  const face = (ref, side) => {
    if (!ref) return;
    const c = find(ref), g = pin(ref, 1), mid = c.x + c.w / 2;
    if ((side === 'left') !== (g.x < mid)) updateCell(model, c.id, { style: { flipH: String(c.style.map.get('flipH') || '0') === '1' ? null : 1 } });
  };
  const tele = R.kind === 'telescopic', n = R.colA.length;
  // the pair: outward in the columns (telescopic), outward beside them (folded)
  face(R.iA, 'left'); face(R.iB, 'right');
  R.colA.forEach((r) => { if (r !== R.iA) face(r, 'right'); });
  R.colB.forEach((r) => { if (r !== R.iB) face(r, 'left'); });
  for (const s of R.side) { face(s.m, s.col === 'A' ? 'right' : 'left'); if (s.load && isMos(comp.get(s.load))) face(s.load, s.col === 'A' ? 'right' : 'left'); }
  if (R.bias) { face(R.bias, 'right'); face(R.tail, 'left'); }
  const all = [...R.colA, ...R.colB];
  const H = Math.max(...all.map((r) => find(r).h)), W = Math.max(...all.map((r) => find(r).w));
  const ROW = Math.round(1.7 * H);
  // the gate nets between the columns: what each needs in the middle (a
  // diode link, a stem port) gives the columns' spacing
  const gateRows = [];
  for (let k = 0; k < n; k++) {
    const a = comp.get(R.colA[k]), b = comp.get(R.colB[k]);
    if (tele && (a.ref === R.iA)) continue;
    gateRows.push({ k, a: a.ref, b: b.ref, same: G(a) === G(b), net: G(a) });
  }
  const colNode = (col, k) => { const u = comp.get(col[k]), v = comp.get(col[k + 1]); return [D(u), S(u)].find((x) => x === D(v) || x === S(v)); };
  const nodesA = R.colA.slice(0, -1).map((_, k) => colNode(R.colA, k)), nodesB = R.colB.slice(0, -1).map((_, k) => colNode(R.colB, k));
  for (const g of gateRows) {
    g.diodeA = g.same ? nodesA.indexOf(g.net) : -1;
    g.diodeB = g.same && g.diodeA < 0 ? nodesB.indexOf(g.net) : -1;
  }
  const slots = gateRows.filter((g) => g.same).length;
  const SP = Math.max(3 * W + 140, 2 * W + 120 + 46 * slots, 260);
  // columns: drains on one vertical line per column, one row per device
  const a0 = ctr(R.colA[0]), xA = pin(R.colA[0], 0).x, xB = xA + SP;
  for (let k = 0; k < n; k++) {
    for (const [col, x] of [[R.colA, xA], [R.colB, xB]]) {
      const r = col[k], c = ctr(r);
      move(r, x - pin(r, 0).x, a0.y + k * ROW - c.y);
    }
  }
  // the node between rows k and k+1 of a column: its height
  const nodeY = (col, k) => {
    const u = comp.get(col[k]), v = comp.get(col[k + 1]), nn = colNode(col, k);
    return Math.round((pin(col[k], u.nodes.indexOf(nn)).y + pin(col[k + 1], v.nodes.indexOf(nn)).y) / 2);
  };
  // the tail and the folded pair
  const s = tele ? (GNDN.test(S(comp.get(R.colA[0]))) ? -1 : 1) : (R.pmosIn ? -1 : 1);   // +1: the tail below the pair
  if (!tele) {
    // the pair left of column A, its drains just above (below) the fold nodes
    const kf = R.colA.findIndex((r) => [D(comp.get(r)), S(comp.get(r))].includes(R.fold.A));
    const kAbove = R.colA.findIndex((r, k) => k + 1 < n && colNode(R.colA, k) === R.fold.A);
    const yF = nodeY(R.colA, kAbove >= 0 ? kAbove : Math.max(0, kf - 1));
    const colLeft = Math.min(...R.colA.map((r) => find(r).x));
    move(R.iB, colLeft - 200 - (find(R.iB).x + find(R.iB).w), 0);
    const dyB = (yF + s * 70) - pin(R.iB, 0).y;   // drains 70 px from the fold line, away from it
    move(R.iB, 0, dyB);
    const a = ctr(R.iA), bb = ctr(R.iB);
    move(R.iA, bb.x - Math.max(3 * W + 80, 170) - a.x, bb.y - a.y);
  }
  if (R.tail) {
    const t = ctr(R.tail), mid = (pin(R.iA, 2).x + pin(R.iB, 2).x) / 2, yp = ctr(R.iA).y;
    move(R.tail, mid - pinsOf(R.tail)[R.tailK].x, yp + s * ROW - t.y);
    if (R.bias) {
      const bb = ctr(R.bias), want = Math.min(pin(R.tail, 1).x - Math.max(1.6 * W, 110), pin(R.iA, 1).x - 150 - (pin(R.bias, 1).x - pin(R.bias, 0).x));
      move(R.bias, want - pin(R.bias, 1).x, yp + s * ROW - bb.y);
      if (R.ref) {
        const F = find(R.ref), ps = activePins(classify(F)).map((q) => pinAbs(F, q));
        const near = ps.reduce((v, w) => (s * w.y > s * v.y ? w : v));
        move(R.ref, pin(R.bias, 0).x - near.x, (pin(R.bias, 0).y - s * 40) - near.y);
      }
    }
  }
  // side stages: outside their column, gate on the node's height, the load
  // straight over (under) the drain
  for (const sd of R.side) {
    const col = sd.col === 'A' ? R.colA : R.colB, y = nodeY(col, sd.k);
    const edge = sd.col === 'A' ? Math.min(...col.map((r) => find(r).x)) - 70 : Math.max(...col.map((r) => find(r).x + find(r).w)) + 70;
    const g = pin(sd.m, 1);
    move(sd.m, edge - g.x, y - g.y);
    if (sd.load) {
      const L = comp.get(sd.load), k = isMos(L) ? 0 : sd.loadPin, dm = pin(sd.m, 0), sm = pin(sd.m, 2);
      const away = dm.y < sm.y ? -1 : 1;   // the drain's side
      if (isMos(L)) { const c = ctr(sd.load); move(sd.load, dm.x - pin(sd.load, 0).x, dm.y + away * (ROW - H / 2) - c.y + away * 0); }
      else {
        const ps = pinsOf(sd.load);
        if (ps.length === 2 && Math.abs(ps[0].x - ps[1].x) < 1) move(sd.load, dm.x - ps[k].x, dm.y + away * 50 - ps[k].y);
      }
    }
  }
  const tplRefs = [...R.used];
  const att = new Set(attachPassives(model, parsed, tplRefs).attached);
  // parts outside the template now overlapping it go to its right
  {
    const tpl = tplRefs.map(find).filter(Boolean);
    const box = { x0: Math.min(...tpl.map((c) => c.x)) - 60, x1: Math.max(...tpl.map((c) => c.x + c.w)) + 60, y0: Math.min(...tpl.map((c) => c.y)) - 30, y1: Math.max(...tpl.map((c) => c.y + c.h)) + 30 };
    let x = box.x1 + 60;
    const others = cells().filter((c) => c.kind === 'vertex' && classify(c).role === 'component' && !R.used.has(String(c.refdes || '')) && !att.has(String(c.refdes || ''))).sort((p, q) => p.x - q.x);
    for (const c0 of others) {
      const c = find(String(c0.refdes));
      if (!(c.x < box.x1 && c.x + c.w > box.x0 && c.y < box.y1 && c.y + c.h > box.y0)) continue;
      const free = (xx) => !cells().some((o) => o.kind === 'vertex' && o.id !== c.id && classify(o).role === 'component' && o.x < xx + c.w + 30 && o.x + o.w + 30 > xx && o.y < c.y + c.h && o.y + o.h > c.y);
      while (!free(x)) x += 40;
      move(String(c.refdes), x - c.x, 0);
      x += c.w + 60;
    }
  }
  // every wire routed again, then the template's nets drawn on purpose
  const ids = cells().filter((c) => c.kind === 'edge').map((e) => e.id);
  for (const id of ids) updateCell(model, id, { style: { edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: null }, points: [] });
  await routePage(model, ids, {});
  const F = (r) => find(r);
  const P = (r, k) => [F(r), relPin(F(r), k)];
  const reroute = [];
  // the gate lines; a stem port for a bare bias; a diode link from its node
  const mid0 = pin(R.colA[0], 1).x, mid1 = pin(R.colB[0], 1).x;
  let slotL = 0, slotR = 0;
  for (const g of gateRows) {
    if (!g.same) continue;
    const pa = P(g.a, 1), pb = P(g.b, 1), ya = pin(g.a, 1).y;
    const terms = parsed.components.flatMap((c) => c.nodes.map((x, i) => ({ c, i, x })).filter((t) => t.x === g.net));
    // the net's ports wired to these gates alone (place-sa gives one per pin): one kept
    const ports = netPorts(model, g.net, [pa, pb]), port = ports[0] || null;
    for (const o of ports) for (const e of cells().filter((e) => e.kind === 'edge' && (e.source === o.id || e.target === o.id))) deleteCell(model, e.id);
    for (const o of ports.slice(1)) deleteCell(model, o.id);
    reroute.push(...moveWires(model, pb[0], pb[1], pa[0], pa[1]));
    dropAmong(model, [pa, pb]);
    addWire(model, { source: pb[0].id, target: pa[0].id, sourcePin: pb[1], targetPin: pa[1], style: STF, points: [] });
    if (g.diodeA >= 0 || g.diodeB >= 0) {
      const onA = g.diodeA >= 0, col = onA ? R.colA : R.colB, kk = onA ? g.diodeA : g.diodeB;
      const u = comp.get(col[kk]), pu = P(col[kk], u.nodes.indexOf(g.net)), yn = nodeY(col, kk);
      const xm = onA ? Math.round(mid0 + 30 + 40 * slotL++) : Math.round(mid1 - 30 - 40 * slotR++);
      const pp = pinAbs(pu[0], pu[1]), v = comp.get(col[kk + 1]), pv = P(col[kk + 1], v.nodes.indexOf(g.net));
      dropAmong(model, [pa, pb, pu, pv]);   // the router's links between the node and the gates
      addWire(model, { source: pb[0].id, target: pa[0].id, sourcePin: pb[1], targetPin: pa[1], style: STF, points: [] });
      addWire(model, { source: pv[0].id, target: pu[0].id, sourcePin: pv[1], targetPin: pu[1], style: STF, points: [] });
      addWire(model, { source: pu[0].id, target: pa[0].id, sourcePin: pu[1], targetPin: pa[1], style: STF, points: [{ x: pp.x, y: yn }, { x: xm, y: yn }, { x: xm, y: ya }] });
    } else if (port && terms.length === 2) {
      const xs = Math.round(mid1 - 40 - 40 * slotR++ - port.w / 2);
      stemPort(model, port, [pa, pb], xs, ya, 1);
    } else if (port) {
      stemPort(model, port, [pa, pb], Math.round(mid1 - 40 - 40 * slotR++ - port.w / 2), ya, 1);
    }
  }
  // the column nodes: straight between the two devices; whatever else the
  // node's wires reached is joined to the upper device's pin
  for (const col of [R.colA, R.colB]) {
    for (let k = 0; k + 1 < n; k++) {
      const nn = colNode(col, k), u = comp.get(col[k]), v = comp.get(col[k + 1]);
      const pu = P(col[k], u.nodes.indexOf(nn)), pv = P(col[k + 1], v.nodes.indexOf(nn));
      reroute.push(...moveWires(model, pv[0], pv[1], pu[0], pu[1]));
      dropAmong(model, [pu, pv]);
      addWire(model, { source: pv[0].id, target: pu[0].id, sourcePin: pv[1], targetPin: pu[1], style: STF, points: [] });
    }
  }
  // the folded pair: each drain across to its fold node (B's line nearer the pair)
  if (!tele) {
    const kA = nodesA.indexOf(R.fold.A), kB = nodesB.indexOf(R.fold.B);
    if (kA >= 0 && kB >= 0) {
      const top = (col, k) => { const u = comp.get(col[k]); return pin(col[k], u.nodes.indexOf(col === R.colA ? R.fold.A : R.fold.B)); };
      const bot = (col, k) => { const v = comp.get(col[k + 1]); return pin(col[k + 1], v.nodes.indexOf(col === R.colA ? R.fold.A : R.fold.B)); };
      const lineY = (col, k, f) => Math.round(top(col, k).y + (bot(col, k).y - top(col, k).y) * f);
      // the line nearer the pair goes to the far column (it then passes column A between its rows)
      const near = s > 0 ? 0.65 : 0.35, far = s > 0 ? 0.35 : 0.65;
      for (const [i, col, k, f] of [[R.iB, R.colB, kB, -s > 0 ? far : near], [R.iA, R.colA, kA, -s > 0 ? near : far]]) {
        const u = comp.get(col[k]), fn = col === R.colA ? R.fold.A : R.fold.B, pu = P(col[k], u.nodes.indexOf(fn));
        const pi = P(i, 0), y = lineY(col, k, f === near ? near : far), di = pinAbs(pi[0], pi[1]);
        reroute.push(...moveWires(model, pi[0], pi[1], pu[0], pu[1]));
        addWire(model, { source: pi[0].id, target: pu[0].id, sourcePin: pi[1], targetPin: pu[1], style: STF, points: [{ x: di.x, y }, { x: pinAbs(pu[0], pu[1]).x, y }] });
      }
    }
  }
  if (R.tail) teeNet(model, F(R.iA), F(R.iB), F(R.tail), s, R.tailK);
  // an input fed back from a column node (unity-gain buffer): out of the gate,
  // then along the node's height into the column
  for (const [i, out] of [[R.iA, -1], [R.iB, 1]]) {
    const g = G(comp.get(i));
    for (const [col, nodes] of [[R.colA, nodesA], [R.colB, nodesB]]) {
      const k = nodes.indexOf(g); if (k < 0) continue;
      const u = comp.get(col[k]), pu = P(col[k], u.nodes.indexOf(g)), pg = P(i, 1), gp = pinAbs(pg[0], pg[1]), y = nodeY(col, k) + 14;   // off the other column's node at that height
      reroute.push(...moveWires(model, pg[0], pg[1], pu[0], pu[1]));
      const x1 = Math.round(gp.x + out * 30);
      addWire(model, { source: pg[0].id, target: pu[0].id, sourcePin: pg[1], targetPin: pu[1], style: STF, points: [{ x: x1, y: gp.y }, { x: x1, y }, { x: pinAbs(pu[0], pu[1]).x, y }] });
      break;
    }
  }
  // side stages: the gate straight from the column node; the load on the drain
  for (const sd of R.side) {
    const col = sd.col === 'A' ? R.colA : R.colB, u = comp.get(col[sd.k]), pu = P(col[sd.k], u.nodes.indexOf(sd.node));
    const pg = P(sd.m, 1), y = pin(sd.m, 1).y, pp = pinAbs(pu[0], pu[1]);
    reroute.push(...moveWires(model, pg[0], pg[1], pu[0], pu[1]));
    addWire(model, { source: pg[0].id, target: pu[0].id, sourcePin: pg[1], targetPin: pu[1], style: STF, points: [{ x: pp.x, y }] });
    if (sd.load) {
      const L = F(sd.load), lrel = activePins(classify(L))[sd.loadPin], pd = P(sd.m, 0);
      if (Math.abs(pinAbs(L, lrel).x - pinAbs(pd[0], pd[1]).x) < 0.5) {
        reroute.push(...moveWires(model, L, lrel, pd[0], pd[1]));
        addWire(model, { source: L.id, target: pd[0].id, sourcePin: lrel, targetPin: pd[1], style: STF, points: [] });
      }
    }
  }
  // the two side stages' loads on one bias: one line between their gates
  // (across the columns), its port on a stem in the middle
  {
    const loads = R.side.filter((sd) => sd.load && isMos(comp.get(sd.load)));
    const lA = loads.find((sd) => sd.col === 'A'), lB = loads.find((sd) => sd.col === 'B');
    if (lA && lB && G(comp.get(lA.load)) === G(comp.get(lB.load)) && Math.abs(pin(lA.load, 1).y - pin(lB.load, 1).y) < 0.5) {
      const net = G(comp.get(lA.load)), pa = P(lA.load, 1), pb = P(lB.load, 1), y = pin(lA.load, 1).y;
      const ports = netPorts(model, net, [pa, pb]);
      for (const o of ports) for (const e of cells().filter((e) => e.kind === 'edge' && (e.source === o.id || e.target === o.id))) deleteCell(model, e.id);
      for (const o of ports.slice(1)) deleteCell(model, o.id);
      reroute.push(...moveWires(model, pb[0], pb[1], pa[0], pa[1]));
      dropAmong(model, [pa, pb]);
      addWire(model, { source: pb[0].id, target: pa[0].id, sourcePin: pb[1], targetPin: pa[1], style: STF, points: [] });
      if (ports[0]) stemPort(model, ports[0], [pa, pb], Math.round((pin(R.colA[0], 1).x + pin(R.colB[0], 1).x) / 2 - ports[0].w / 2), y, 1);
    }
  }
  if (reroute.length) await routePage(model, reroute, {});
  await alignPorts(model);
  alignRails(model);
  for (const v of cells().filter((c) => c.kind === 'vertex' && c.style.map.get('drawioApiTemplatePort') === '1')) updateCell(model, v.id, { style: { drawioApiPinned: 1 } });
  for (const r of R.used) { const c = find(r); if (c) updateCell(model, c.id, { style: { drawioApiPinned: 1 } }); }
  rebuildLocalDots(model);
}

/** Delete the wires on one pin; whatever else they reached is joined to
 *  another pin of the same net by a new routable wire (ids returned). */
function moveWires(model, C, rel, T, trel) {
  const out = [];
  for (const e of allCells(model).map(cellInfo).filter((e) => e.kind === 'edge' && (atPin(e, 'exit', C, rel) || atPin(e, 'entry', C, rel)))) {
    const [oid, oend] = atPin(e, 'exit', C, rel) ? [e.target, 'entry'] : [e.source, 'exit'];
    const orel = { x: Number(e.style.map.get(oend + 'X') ?? 0.5), y: Number(e.style.map.get(oend + 'Y') ?? 0.5) };
    deleteCell(model, e.id);
    // (a wire to another pin of the same part — a diode's gate to its drain —
    // is kept, moved too; only the wire to the target itself goes)
    if ((oid === T.id && Math.abs(orel.x - trel.x) < 0.02 && Math.abs(orel.y - trel.y) < 0.02) || (oid === C.id && Math.abs(orel.x - rel.x) < 0.02 && Math.abs(orel.y - rel.y) < 0.02)) continue;
    out.push(addWire(model, { source: oid, target: T.id, sourcePin: orel, targetPin: trel, style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;' }).getAttribute('id'));
  }
  return out;
}

/** The ports of a net whose wires all end on these pins or on each other
 *  (place-sa gives a bias one label per pin, the labels wired together). */
function netPorts(model, net, pins) {
  const cs = allCells(model).map(cellInfo), edges = cs.filter((e) => e.kind === 'edge');
  const mine = cs.filter((v) => v.kind === 'vertex' && classify(v).role === 'port' && String(classify(v).net || v.value || '').trim().toLowerCase() === String(net).toLowerCase());
  const ids = new Set(mine.map((v) => v.id));
  const on = (e) => pins.some(([c, r]) => atPin(e, 'exit', c, r) || atPin(e, 'entry', c, r)) || (ids.has(e.source) && ids.has(e.target));
  return mine.every((v) => edges.filter((e) => e.source === v.id || e.target === v.id).every(on)) ? mine : [];
}

/** The ports whose wires all end on these pins. */
function soloPorts(model, pins) {
  const cs = allCells(model).map(cellInfo), edges = cs.filter((e) => e.kind === 'edge');
  const on = (e) => pins.some(([c, r]) => atPin(e, 'exit', c, r) || atPin(e, 'entry', c, r));
  return cs.filter((v) => v.kind === 'vertex' && classify(v).role === 'port' && (() => { const es = edges.filter((e) => e.source === v.id || e.target === v.id); return es.length && es.every(on); })());
}

/** A port on a stem off a horizontal line at height y (dir +1: under it). */
function stemPort(model, port, pins, x, y, dir) {
  const ys = Math.round(y + dir * 40);
  updateCell(model, port.id, { x: Math.round(x), y: Math.round(ys - port.h / 2), style: { flipH: null, rotation: null, drawioApiTemplatePort: 1 } });
  const Pc = allCells(model).map(cellInfo).find((c) => c.id === port.id);
  const end = { x: 0.5, y: dir > 0 ? 0 : 1 }, tip = pinAbs(Pc, end);
  for (const [c, r] of pins) addWire(model, { source: port.id, target: c.id, sourcePin: end, targetPin: r, style: STF, points: [{ x: tip.x, y }] });
}
