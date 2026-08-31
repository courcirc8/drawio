/**
 * place3.js — placement for SOURCE-LESS passive networks (RF matching: pure
 * R/L/C between differential port pairs and an antenna). place2.js places by
 * VERTICAL CONDUCTION STACKS (VDD -> ground DFS): that model has nothing to
 * grab onto here — there is no supply rail, no transistor, no bias current —
 * so every element of a matching network falls through place2 into its
 * "passifs flottants" path, which has NO collision avoidance at all. That is
 * the measured dominant cause of the 915/2446 overlaps (see AGENTS/task brief).
 *
 * Model implemented here (how an RF engineer reads a matching network):
 *   - a HORIZONTAL SIGNAL CHAIN is the primary axis: source port -> series
 *     elements -> antenna/output, left to right;
 *   - SHUNT elements (single element, dead-end) hang PERPENDICULAR to the
 *     axis: down to a local ground stub, or up if they end on a named net;
 *   - a SECONDARY CHAIN (more than one element deep) hanging off an axis
 *     node is drawn as its OWN horizontal row, offset vertically, joined to
 *     the shared node by a wire + junction dot;
 *   - a component that closes a LOOP back onto an already-placed node (a
 *     bridge/cross-tie, e.g. a Pi-network's cross-cap) is drawn as a small
 *     arc above the segment it bridges.
 *
 * DERIVATION (graph-based, not pattern-matched to any specific netlist):
 *  1. Build the net graph with GROUND ('0') removed: nodes = nets, edges =
 *     2-terminal components. Components whose OTHER end is ground are kept
 *     separately as "ground shunts" (drawn wherever their net ends up).
 *  2. Pick a START net. Ports are not reliably "degree-1 nets" in a network
 *     that contains bridges/loops (matching_2446.cir's Bp/Bn/Up form a
 *     triangle — none of Bp, Bn is degree-1, yet they are exactly the
 *     differential input the axis must start from). So: find NAME-based
 *     differential port pairs (a net ending in p/n or +/- sharing a common
 *     base with another net of the opposite side) among ALL non-ground
 *     nets; the PRIMARY pair is whichever pair's first member is touched by
 *     the earliest component in netlist declaration order (a TX pair
 *     declared first outranks an RX pair declared later — this is the
 *     generic form of "rx_ is secondary", it does not hardcode that prefix).
 *     No pair found -> fall back to the first non-ground net in the netlist.
 *  3. BFS the graph from START. Every first-visit edge is a TREE edge (and
 *     defines the BFS parent of the net it reaches); every edge whose far
 *     end is already visited is a BACK edge (a bridge/cross-tie, handled in
 *     a second pass once both its ends have positions).
 *  4. The axis is the tree path from START to whichever reached net is
 *     FARTHEST (BFS distance, ties broken toward a true graph leaf then
 *     alphabetically, for determinism).
 *  5. Walking the tree from each axis (and later, row) net: a net with
 *     exactly one further tree child continues the same spine; a net with
 *     MORE than one additional tree child keeps the heaviest subtree (by
 *     node count) as the spine and turns every other child into either a
 *     SHUNT (subtree of size 1) or a new SECONDARY ROW (subtree of size >1),
 *     recursively — so a row can itself carry shunts/sub-rows.
 *  6. Ground shunts are attached to whichever net position results, at
 *     whichever level (axis/shunt/row) it was placed at.
 *  7. Back edges (bridges) are placed last, once both endpoints have real
 *     positions: if they close a loop across exactly one axis step (a
 *     Pi/T "cross-tie", e.g. matching_2446.cir's Bn between Bp and Up) they
 *     are drawn as a small arc straddling that segment; otherwise as a
 *     generic bump at the mid-point of their two endpoints.
 *
 * COLLISION AVOIDANCE: every element placed by this engine — axis, shunt,
 * row, bridge, port, ground stub, junction — is checked with rotatedAabb()
 * against everything already placed and nudged (in a category-appropriate
 * direction) until clear. This is the "real fix" the task calls out: place2
 * only retries for ports/junctions, never for the floating-passive path.
 */
import { addVertex, addWire, httpError, mxCellPart } from './model.js';
import { SPICE_MAP, formatComponentValue } from './components.js';
import { getShape, getPin } from './stencils.js';
import { pinAbs, rotatedAabb } from './route.js';

const JCT = 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;';
// DEFECT (2026-08-28, api-hardening): was 'equipotential', a filled triangle
// indistinguishable from ground's filled triangle at reading size. 'port' is
// a SYNTHETIC shape key (lib/stencils.js SYNTHETIC_SHAPES), not a
// `mxgraph.*` stencil — see the identical fix/comment in place2.js and
// components.js PORT_SHAPES/shapeKeyOf().
const PORT = 'port';
const GROUND_SHAPE = 'mxgraph.electrical.signal_sources.signal_ground';
const GROUND_PIN = 'N';
const GROUND_NET = '0';

// Duplicated from place2.js on PURPOSE, not imported: place2.js's behaviour
// must not change (task rule), and importing a shared module would mean
// editing place2.js's imports to match, which risks exactly that. The
// constant is small (inductor_3's native w=100 h=8 axis becomes ~1.7x too
// long once rescaled for a vertical placement — see place2.js's own comment
// on the same bug) so duplication is cheaper than the refactor risk here.
const INDUCTOR_3 = 'mxgraph.electrical.inductors.inductor_3';
const VERTICAL_INDUCTOR_LEN = 60, VERTICAL_INDUCTOR_THICK = 5;
function sizeFor(shapeKey, w, h, rotated) {
  if (rotated && shapeKey === INDUCTOR_3) return { w: VERTICAL_INDUCTOR_LEN, h: VERTICAL_INDUCTOR_THICK };
  return { w, h };
}

const DEF = { colW: 190, rowH: 190, x0: 160, y0: 260, flip: {}, flipPairs: [], rowOffset: {}, shuntDx: {} };

/** {base, side:'p'|'n'} for a net ending in p/n or +/- ; else null. */
function pairKey(name) {
  let m = /^(.*)(p)$/i.exec(name);
  if (m && m[1] !== '') return { base: m[1].toLowerCase(), side: 'p' };
  m = /^(.*)(n)$/i.exec(name);
  if (m && m[1] !== '') return { base: m[1].toLowerCase(), side: 'n' };
  m = /^(.*)\+$/.exec(name);
  if (m && m[1] !== '') return { base: m[1].toLowerCase(), side: 'p' };
  m = /^(.*)-$/.exec(name);
  if (m && m[1] !== '') return { base: m[1].toLowerCase(), side: 'n' };
  return null;
}

/** Generic 2-terminal classification (R/C/L/V/I/D/…): {shapeKey, po:[a,b], a, b}. */
function twoTermInfo(c) {
  const map = SPICE_MAP[c.prefix];
  if (map == null || c.nodes.length !== 2) return null;
  return { shapeKey: map.shape, po: map.pinOrder, a: c.nodes[0], b: c.nodes[1] };
}

export function importNetlist3(model, parsed, opts = {}) {
  const P = { ...DEF, ...opts, flip: { ...DEF.flip, ...(opts.flip || {}) },
    rowOffset: { ...DEF.rowOffset, ...(opts.rowOffset || {}) },
    shuntDx: { ...DEF.shuntDx, ...(opts.shuntDx || {}) } };
  // DEFECT (2026-08-28, api-hardening): raw c.value ("4.7e-11") drawn as-is;
  // formatComponentValue (lib/components.js) reformats the LABEL only, to
  // engineering units ("47 pF") — spice_value (set from c.value below,
  // untouched) still carries the original float for LVS/BOM.
  const labelFor = (c) => {
    const disp = formatComponentValue(c.prefix, c.value);
    return disp ? c.ref + '\n' + disp : c.ref;
  };
  const comps = parsed.components;
  if (comps.length === 0) throw httpError(400, 'netlist vide');
  const warnings = [...(parsed.warnings || [])];

  const info = new Map();
  const unsupported = [];
  for (const c of comps) {
    const ci = twoTermInfo(c);
    if (ci == null) unsupported.push(c); else info.set(c.ref, ci);
  }
  if (unsupported.length) {
    warnings.push('place3: ' + unsupported.length + ' non-2-terminal component(s) placed generically: ' +
      unsupported.map((c) => c.ref).join(', '));
  }

  // ---- graph (ground removed) + ground-shunt list per net
  const adj = new Map(); // net -> [{ref, other}]
  const groundShunts = new Map(); // net -> [ref]
  const addAdj = (net, ref, other) => { if (!adj.has(net)) adj.set(net, []); adj.get(net).push({ ref, other }); };
  for (const [ref, ci] of info) {
    const { a, b } = ci;
    if (a === GROUND_NET && b === GROUND_NET) continue; // degenerate, ignore
    if (a === GROUND_NET) { if (!groundShunts.has(b)) groundShunts.set(b, []); groundShunts.get(b).push(ref); }
    else if (b === GROUND_NET) { if (!groundShunts.has(a)) groundShunts.set(a, []); groundShunts.get(a).push(ref); }
    else { addAdj(a, ref, b); addAdj(b, ref, a); }
  }

  // ---- start net: primary differential pair (by declaration order), else
  // the first non-ground net mentioned in the netlist.
  const allNets = new Set();
  for (const ci of info.values()) { allNets.add(ci.a); allNets.add(ci.b); }
  allNets.delete(GROUND_NET);
  const byBase = new Map(); // base -> {p, n}
  for (const n of allNets) {
    const pk = pairKey(n);
    if (pk == null) continue;
    if (!byBase.has(pk.base)) byBase.set(pk.base, {});
    byBase.get(pk.base)[pk.side] = n;
  }
  const pairsFound = [...byBase.values()].filter((e) => e.p != null && e.n != null);
  const firstTouch = (net) => comps.findIndex((c) => c.nodes.includes(net));
  let start = null;
  const pairOfNet = new Map(); // net -> partner net (only for pairs actually used to pick direction)
  for (const pr of pairsFound) { pairOfNet.set(pr.p, pr.n); pairOfNet.set(pr.n, pr.p); }
  if (pairsFound.length) {
    pairsFound.sort((a, b) => Math.min(firstTouch(a.p), firstTouch(a.n)) - Math.min(firstTouch(b.p), firstTouch(b.n)));
    const primary = pairsFound[0];
    start = firstTouch(primary.p) <= firstTouch(primary.n) ? primary.p : primary.n;
  } else {
    const c0 = comps.find((c) => info.has(c.ref));
    if (c0 != null) { const ci = info.get(c0.ref); start = ci.a !== GROUND_NET ? ci.a : ci.b; }
  }

  // ---- BFS spanning forest from `start` (then any leftover unreached net,
  // for a netlist with more than one connected passive block).
  const parent = new Map(); // net -> {net: parentNet, ref}
  const dist = new Map();
  const treeEdgeRefs = new Set();
  const backEdges = []; // {ref, a, b} both ends already visited when found
  const visitedRefs = new Set();
  function bfsFrom(root) {
    dist.set(root, 0);
    const q = [root];
    for (let qi = 0; qi < q.length; qi++) {
      const u = q[qi];
      for (const { ref, other } of (adj.get(u) || [])) {
        if (visitedRefs.has(ref)) continue;
        visitedRefs.add(ref);
        if (!dist.has(other)) {
          dist.set(other, dist.get(u) + 1);
          parent.set(other, { net: u, ref });
          treeEdgeRefs.add(ref);
          q.push(other);
        } else {
          backEdges.push({ ref, a: u, b: other });
        }
      }
    }
  }
  if (start != null) bfsFrom(start);
  // leftover disconnected passive blocks (rare for a real matching network,
  // but a netlist could legitimately carry more than one independent LC leg)
  const extraRoots = [];
  for (const n of allNets) {
    if (!dist.has(n)) { bfsFrom(n); extraRoots.push(n); }
  }

  // farthest reached net from `start` (tie-break: true leaf, then name)
  function farthestFrom(root) {
    let best = root, bestD = 0;
    for (const [n, d] of dist) {
      let r = n;
      while (parent.has(r)) r = parent.get(r).net;
      if (r !== root) continue;
      if (d > bestD || (d === bestD && (adj.get(n) || []).length === 1 && (adj.get(best) || []).length !== 1) ||
          (d === bestD && n < best)) { best = n; bestD = d; }
    }
    return best;
  }
  const axisEnd = start != null ? farthestFrom(start) : null;
  const axisNets = [];
  if (axisEnd != null) {
    let n = axisEnd;
    while (n !== undefined) { axisNets.unshift(n); if (n === start) break; n = parent.has(n) ? parent.get(n).net : undefined; }
  }
  const isAxisNet = new Set(axisNets);
  const axisIndexOf = new Map(axisNets.map((n, i) => [n, i]));

  // children (tree) of each net, excluding the parent edge
  const childrenOf = new Map();
  for (const [child, p] of parent) {
    if (!childrenOf.has(p.net)) childrenOf.set(p.net, []);
    childrenOf.get(p.net).push({ ref: child === p.net ? p.ref : p.ref, child });
  }
  const subtreeSizeCache = new Map();
  function subtreeSize(net) {
    if (subtreeSizeCache.has(net)) return subtreeSizeCache.get(net);
    let sz = 1;
    for (const { child } of (childrenOf.get(net) || [])) sz += subtreeSize(child);
    subtreeSizeCache.set(net, sz);
    return sz;
  }

  // ---- geometry state
  const placed = new Map(); // ref -> {id,x,y,w,h,rotation,flipH}
  const boxes = []; // committed rotatedAabb boxes, for collision avoidance
  const netTerms = new Map();
  const term = (net, ref, pinName, pin) => {
    if (!netTerms.has(net)) netTerms.set(net, []);
    netTerms.get(net).push({ ref, pinName, pin });
  };
  const shuntRefs = []; // exposed as `flippable`
  const secondaryRowIds = []; // exposed as `secondaryRows`
  let rowSeq = 0;

  function overlaps(a, b, margin) {
    return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x &&
           a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
  }
  /** Nudge (cx,cy) along (dx,dy) steps until the wxh(rotation) box at that
   *  centre clears every previously committed box; commit and return the
   *  top-left {x,y}. This is the collision avoidance the floating-passifs
   *  path in place2 never had. */
  function placeAvoiding(cx, cy, w, h, rotation, dx, dy, opts2 = {}) {
    const step = opts2.step ?? 14, maxSteps = opts2.maxSteps ?? 30, margin = opts2.margin ?? 10;
    let x = cx, y = cy;
    for (let i = 0; i < maxSteps; i++) {
      const box = rotatedAabb({ x: x - w / 2, y: y - h / 2, w, h, rotation });
      if (!boxes.some((b) => overlaps(box, b, margin))) { boxes.push(box); return { x: x - w / 2, y: y - h / 2 }; }
      x += dx; y += dy;
    }
    const box = rotatedAabb({ x: x - w / 2, y: y - h / 2, w, h, rotation });
    boxes.push(box);
    return { x: x - w / 2, y: y - h / 2 };
  }

  function commitComponent(ref, shapeKey, x, y, w, h, rotation, c, flipped) {
    const cell = addVertex(model, { id: ref, shape: shapeKey, x, y, w, h, rotation, value: labelFor(c),
      refdes: ref, data: { spice_value: c.value || '' } });
    if (flipped) { const mx = mxCellPart(cell); mx.setAttribute('style', mx.getAttribute('style') + 'flipH=1;'); }
    placed.set(ref, { id: ref, x, y, w, h, rotation, flipH: !!flipped });
  }

  /** Place series component `ref` (net parentNet -> net childNet) horizontally,
   *  growing from (px,py) in direction dir (+1 right, -1 left). Returns the
   *  {x,y} the child net ends up at (the component's own outward pin). */
  function placeSeries(ref, parentNet, childNet, px, py, dir) {
    const c = comps.find((k) => k.ref === ref);
    const ci = info.get(ref);
    const shape = getShape(ci.shapeKey);
    const step = Math.max(shape.w + 40, P.colW);
    const targetCx = px + dir * step / 2;
    const pos = placeAvoiding(targetCx, py, shape.w, shape.h, 0, dir * 14, 0);
    commitComponent(ref, ci.shapeKey, pos.x, pos.y, shape.w, shape.h, 0, c, false);
    const reversed = ci.a !== parentNet;
    const leftPin = getPin(ci.shapeKey, ci.po[0]), rightPin = getPin(ci.shapeKey, ci.po[1]);
    const cellRec = placed.get(ref);
    if (!reversed) { term(ci.a, ref, ci.po[0], leftPin); term(ci.b, ref, ci.po[1], rightPin); }
    else { term(ci.b, ref, ci.po[0], leftPin); term(ci.a, ref, ci.po[1], rightPin); }
    const outward = dir > 0 ? rightPin : leftPin;
    return pinAbs(cellRec, outward);
  }

  /** Place a dead-end (subtree size 1) component perpendicular to its
   *  anchor: down for a ground net, up for a named (real) net — task's own
   *  convention. Also walks that net's ground-shunt(s), if any. */
  function placeShunt(ref, anchorNet, childNet, ax, ay, signOverride) {
    const c = comps.find((k) => k.ref === ref);
    const ci = info.get(ref);
    const toGround = childNet === GROUND_NET;
    let sign = signOverride != null ? signOverride : (toGround ? 1 : -1);
    const dx = P.shuntDx[ref] || 0;
    const rot = sign > 0 ? 90 : -90;
    const raw = getShape(ci.shapeKey);
    const sz = sizeFor(ci.shapeKey, raw.w, raw.h, true);
    const targetCy = ay + sign * (95 + sz.h / 2);
    const pos = placeAvoiding(ax + dx, targetCy, sz.w, sz.h, rot, 0, sign * 14);
    commitComponent(ref, ci.shapeKey, pos.x, pos.y, sz.w, sz.h, rot, c, false);
    const reversed = ci.a !== anchorNet;
    const nearPin = getPin(ci.shapeKey, ci.po[0]), farPin = getPin(ci.shapeKey, ci.po[1]);
    const cellRec = placed.get(ref);
    // rotated +-90: pin index0 ('in', x=0) ends up on the -sign side visually
    // for a +90 rotation, so align "near" (anchor side) explicitly via abs pins
    const abs0 = pinAbs(cellRec, nearPin), abs1 = pinAbs(cellRec, farPin);
    const near = Math.abs(abs0.y - ay) < Math.abs(abs1.y - ay) ? { pin: nearPin, node: 0 } : { pin: farPin, node: 1 };
    const far = near.node === 0 ? { pin: farPin, node: 1 } : { pin: nearPin, node: 0 };
    const nodeAt = (idx) => (idx === 0 ? ci.a : ci.b);
    term(reversed ? nodeAt(1 - near.node) : nodeAt(near.node), ref, ci.po[near.node], near.pin);
    term(reversed ? nodeAt(1 - far.node) : nodeAt(far.node), ref, ci.po[far.node], far.pin);
    shuntRefs.push(ref);
    return pinAbs(cellRec, far.pin);
  }

  function placeGroundStub(net, atX, atY) {
    for (const ref of (groundShunts.get(net) || [])) {
      if (placed.has(ref)) continue;
      // treat exactly like a shunt-to-ground hanging off (atX,atY)
      placeShunt(ref, net, GROUND_NET, atX, atY, 1);
    }
  }

  /** Decide up(+1)/down(-1) or left/right for a branch based on whether its
   *  far net names a differential partner already placed on the axis — if
   *  so, lean toward that partner's side; else alternate deterministically. */
  let altCounter = 0;
  function decideSign(net, anchorIdx) {
    const partner = pairOfNet.get(net);
    if (partner != null && axisIndexOf.has(partner)) {
      return axisIndexOf.get(partner) < anchorIdx ? -1 : 1;
    }
    altCounter++;
    return altCounter % 2 === 0 ? 1 : -1;
  }

  /** Recursively place everything hanging off `net` (already positioned at
   *  x,y): pick the heaviest remaining child as the spine continuation
   *  (same row/axis, same direction+level), turn every other child into a
   *  shunt (leaf) or a new secondary row (subtree size > 1). */
  function placeChildren(net, x, y, dir, rowKey) {
    placeGroundStub(net, x, y);
    const kids = (childrenOf.get(net) || []).filter((k) => !placed.has(k.ref));
    if (!kids.length) return;
    kids.sort((a, b) => subtreeSize(b.child) - subtreeSize(a.child));
    const [mainKid, ...offshoots] = kids;
    // the heaviest child always continues the current spine (axis or row),
    // in the same direction/level — everything else is an offshoot below.
    {
      const p2 = placeSeries(mainKid.ref, net, mainKid.child, x, y, dir);
      placeChildren(mainKid.child, p2.x, p2.y, dir, rowKey);
    }
    for (const off of offshoots) {
      if (subtreeSize(off.child) === 1) {
        const anchorIdx = axisIndexOf.has(net) ? axisIndexOf.get(net) : -1e9;
        const pairKeyStr = pairOfNet.has(off.child) ? [off.child, pairOfNet.get(off.child)].sort().join('/') : null;
        let sign = decideSign(off.child, anchorIdx);
        if (pairKeyStr != null && P.flipPairs.includes(pairKeyStr)) sign = -sign;
        // `flippable` (returned below) lists shunt refs precisely so that
        // optimize.js's existing "flip a flippable" move (perturb() move 1,
        // reused unmodified from place2's opts contract) toggles P.flip[ref]
        // on ONE OF THESE refs — this is where that flag actually takes
        // effect: flip the shunt to the other side of the axis (up<->down).
        if (P.flip[off.ref]) sign = -sign;
        placeShunt(off.ref, net, off.child, x, y, sign);
      } else {
        const anchorIdx = axisIndexOf.has(net) ? axisIndexOf.get(net) : -1e9;
        const leafNet = (function deepest(n) { const cs = childrenOf.get(n) || []; return cs.length ? deepest(cs.sort((a, b) => subtreeSize(b.child) - subtreeSize(a.child))[0].child) : n; })(off.child);
        const pairKeyStr = pairOfNet.has(off.child) ? [off.child, pairOfNet.get(off.child)].sort().join('/') :
          (pairOfNet.has(leafNet) ? [leafNet, pairOfNet.get(leafNet)].sort().join('/') : null);
        let sign = decideSign(pairOfNet.has(off.child) ? off.child : leafNet, anchorIdx);
        if (pairKeyStr != null && P.flipPairs.includes(pairKeyStr)) sign = -sign;
        const rid = rowSeq++;
        secondaryRowIds.push(rid);
        const rowDir = P.flip[off.ref] ? -dir : dir;
        const rowY = y + sign * (P.rowH + (P.rowOffset[rid] || 0));
        const p2 = placeSeries(off.ref, net, off.child, x, rowY, rowDir);
        placeChildren(off.child, p2.x, p2.y, rowDir, rid);
      }
    }
  }

  // ---- place the axis, seeded at (x0,y0), growing rightward
  if (start != null) {
    placeGroundStub(start, P.x0, P.y0);
    placeChildren(start, P.x0, P.y0, 1, null);
  }
  // extra disconnected blocks, stacked further down
  let extraY = P.y0;
  for (const root of extraRoots) {
    extraY += P.rowH * 3;
    placeGroundStub(root, P.x0, extraY);
    placeChildren(root, P.x0, extraY, 1, 'extra' + root);
  }

  // ---- back edges (bridges / cross-ties): both ends are already placed by
  // the tree walk above. A bridge spanning exactly one AXIS step (a Pi/T
  // cross-tie, e.g. matching_2446.cir's Bn between Bp and Up) is drawn as a
  // small arc straddling that segment; anything else gets a generic bump at
  // the mid-point of its two endpoints' pin positions.
  for (const { ref, a, b } of backEdges) {
    if (placed.has(ref)) continue; // safety: shouldn't happen, refs are unique
    const c = comps.find((k) => k.ref === ref);
    const ci = info.get(ref);
    const shape = getShape(ci.shapeKey);
    const ptsFor = (net) => {
      const out = [];
      for (const [r2, ci2] of info) {
        if (!placed.has(r2)) continue;
        if (ci2.a === net) out.push(pinAbs(placed.get(r2), getPin(ci2.shapeKey, ci2.po[0])));
        if (ci2.b === net) out.push(pinAbs(placed.get(r2), getPin(ci2.shapeKey, ci2.po[1])));
      }
      return out;
    };
    const ptsA = ptsFor(a), ptsB = ptsFor(b);
    const avg = (pts, fb) => pts.length ? { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length } : fb;
    const pa = avg(ptsA, { x: P.x0, y: P.y0 }), pb = avg(ptsB, { x: P.x0, y: P.y0 });
    const cx = (pa.x + pb.x) / 2, cy = Math.min(pa.y, pb.y) - 70 - shape.h / 2;
    const pos = placeAvoiding(cx, cy, shape.w, shape.h, 0, 0, -14);
    commitComponent(ref, ci.shapeKey, pos.x, pos.y, shape.w, shape.h, 0, c, false);
    const cellRec = placed.get(ref);
    const leftPin = getPin(ci.shapeKey, ci.po[0]), rightPin = getPin(ci.shapeKey, ci.po[1]);
    // orient left pin toward whichever endpoint is further left, purely cosmetic
    if (pa.x <= pb.x) { term(ci.a, ref, ci.po[0], leftPin); term(ci.b, ref, ci.po[1], rightPin); }
    else { term(ci.b, ref, ci.po[0], leftPin); term(ci.a, ref, ci.po[1], rightPin); }
  }

  // ---- any component this engine could not place at all (should not
  // happen for a fully-connected 2-terminal netlist; guards non-2-terminal
  // input and empty edge cases): generic fallback column, still wired.
  let fallbackCol = 0;
  for (const c of comps) {
    if (placed.has(c.ref)) continue;
    const map = SPICE_MAP[c.prefix];
    if (map == null) continue;
    const shapeKey = map.shape, po = map.pinOrder;
    const shape = getShape(shapeKey);
    const x = P.x0 - 260 - fallbackCol * 160, y = P.y0 + 400;
    fallbackCol++;
    const pos = placeAvoiding(x, y, shape.w, shape.h, 0, 0, 60);
    commitComponent(c.ref, shapeKey, pos.x, pos.y, shape.w, shape.h, 0, c, false);
    const cellRec = placed.get(c.ref);
    for (let i = 0; i < po.length && i < c.nodes.length; i++) term(c.nodes[i], c.ref, po[i], getPin(shapeKey, po[i]));
  }

  // ---- final wiring: ground / ports / direct wires / junctions. Same
  // contract as place2's tail (net with 1 terminal -> port, 2 -> direct
  // wire, >2 -> junction dot), reused because it is generic over how the
  // components got their positions.
  const wires = [];
  const wire = (a, b) => wires.push(addWire(model, a === null ? b : a).getAttribute('id'));
  let seq = 0;

  // DEFECT (2026-08-28, api-hardening round 3): ports were emitted only for
  // `terms.length === 1` nets — a DEGREE heuristic. That happened to work
  // for matching_915.cir (Bp/Bn/rx_Bp are all degree-1 there) but produced
  // ZERO ports for matching_2446.cir, where Bp/Bn/Up form a triangle (see
  // the derivation comment at the top of this file, point 2) so NONE of
  // Bp/Bn/rx_Bp/rx_Bn is degree-1. A port is a net at the BOUNDARY of the
  // circuit, not a net with exactly one internal terminal — a boundary net
  // can have any number of internal terminals (a tap, a bridge leg, ...).
  //
  // Fix: this engine already derives, from the netlist itself (no
  // hardcoded net names):
  //   - every NAMED differential pair (`pairsFound`, computed above from
  //     `pairKey()` — this is how `start` was chosen), and
  //   - the far end of the primary signal-chain AXIS (`axisEnd`, the
  //     BFS-farthest tree node from `start`).
  // Both are boundary nets by construction: a differential pair IS the
  // circuit's named external interface on one side (TX in, RX in, ...);
  // the far end of the axis is where the drawn signal chain leaves the
  // network (matching_2446.cir names it `ANT`; matching_915.cir never
  // introduces a name for it, so it dead-ends at whatever net the SAME
  // derivation reaches — this is intentional, not a fallback to guessing:
  // if this network has no separately-named antenna net, the antenna
  // interface genuinely IS the chain's last node, and reporting that as a
  // port is the honest answer, not an omission).
  const boundaryNets = new Set();
  for (const pr of pairsFound) { boundaryNets.add(pr.p); boundaryNets.add(pr.n); }
  if (axisEnd != null) boundaryNets.add(axisEnd);

  /** Tap a port glyph onto a net that already got its real wiring from the
   *  terms.length===2/>2 branches below (a boundary net can have any number
   *  of internal terminals, so it cannot reuse the terms.length===1 branch's
   *  single-wire shape). `anchor` is either a terminal ({ref,pin}) to attach
   *  to directly, or a plain {x,y} to attach to a cell id (`atId`, e.g. the
   *  junction dot) via mxGraph's own perimeter routing — same convention the
   *  junction branch already uses for its component->junction wires (no
   *  explicit targetPin). */
  // DEFECT (2026-08-28, api-hardening round 4): `addBoundaryPortTap` placed
  // the port's own box collision-free (`placeAvoiding` against every OTHER
  // cell), but only nudged it 70px in a single fixed direction (up) from the
  // anchor and never checked the STUB WIRE in between. Every other cell this
  // engine places (axis, shunt, row, bridge, ground) gets real collision
  // avoidance; the port tap alone did not, and a boundary net's anchor is
  // often mid-cluster (e.g. matching_2446.cir's Bp has 3 internal terminals),
  // so "up 70px" regularly landed the port past another component's body —
  // the port cell itself was clear, but the wire reaching it wasn't.
  // Measured cost: through_component 915 v3+optimize12 1->2,
  // 2446 v3 2->10, 2446 v3+optimize12 0->3 (coordinator's re-run).
  //
  // Fix: search cardinal directions (left/right/up/down) at growing radii;
  // accept the first candidate whose OWN box is collision-free (same
  // `placeAvoiding` contract as everywhere else) AND whose straight stub
  // corridor to the anchor does not overlap any already-placed box
  // (`corridorClear`, a conservative bounding-rect test — it may reject a
  // few actually-clear diagonal paths, but never accepts a blocked one).
  // Direction preference is derived from geometry, not net names: try
  // horizontal first, LEFT if the anchor sits left of the drawing's own
  // centroid else RIGHT (this is what makes a chain-input net exit left and
  // an axis-end net exit right, without special-casing `start`/`axisEnd`),
  // then vertical, then the opposite horizontal side, growing the radius
  // until something is clear. Falls back to the old "nearest collision-free
  // spot" if literally nothing on any side is clear (should not happen on a
  // real netlist; better than leaving the port unplaced).
  function corridorClear(p1, p2, margin) {
    const rx0 = Math.min(p1.x, p2.x) - margin, rx1 = Math.max(p1.x, p2.x) + margin;
    const ry0 = Math.min(p1.y, p2.y) - margin, ry1 = Math.max(p1.y, p2.y) + margin;
    return !boxes.some((b) => !(b.x + b.w < rx0 || b.x > rx1 || b.y + b.h < ry0 || b.y > ry1));
  }
  function addBoundaryPortTap(net, anchor, atId) {
    const id = 'P_' + net.replace(/[^A-Za-z0-9]/g, '_');
    const abs = anchor.ref != null ? pinAbs(placed.get(anchor.ref), anchor.pin) : anchor;
    const w = 24, h = 24;
    let cxAll = 0, cyAll = 0;
    for (const b of boxes) { cxAll += b.x + b.w / 2; cyAll += b.y + b.h / 2; }
    if (boxes.length) { cxAll /= boxes.length; cyAll /= boxes.length; }
    const leftFirst = abs.x <= cxAll;
    const dirs = leftFirst
      ? [{ dx: -1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }]
      : [{ dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }];
    const radii = [70, 120, 180, 250, 330, 420, 520, 650, 800];
    let best = null, bestOverlaps = Infinity;
    for (const rad of radii) {
      for (const d of dirs) {
        const cx = abs.x + d.dx * rad, cy = abs.y + d.dy * rad;
        const box = { x: cx - w / 2, y: cy - h / 2, w, h };
        const nOverlap = boxes.filter((b) => overlaps(box, b, 10)).length;
        if (nOverlap === 0 && corridorClear(abs, { x: cx, y: cy }, 8)) {
          best = { x: box.x, y: box.y }; bestOverlaps = 0; break;
        }
        if (nOverlap < bestOverlaps) { bestOverlaps = nOverlap; best = { x: box.x, y: box.y }; }
      }
      if (bestOverlaps === 0) break;
    }
    const pos = best || placeAvoiding(abs.x, abs.y - 70, w, h, 0, 0, -14);
    boxes.push(rotatedAabb({ x: pos.x, y: pos.y, w, h, rotation: 0 }));
    addVertex(model, { id, shape: PORT, x: pos.x, y: pos.y, w, h, value: net });
    placed.set(id, { id, x: pos.x, y: pos.y, w, h, rotation: 0 });
    if (anchor.ref != null) {
      wire(null, { source: id, target: anchor.ref, sourcePin: { x: 0.5, y: 0 }, targetPin: { x: anchor.pin.x, y: anchor.pin.y, name: anchor.pin.name } });
    } else {
      wire(null, { source: id, target: atId, sourcePin: { x: 0.5, y: 0 } });
    }
  }

  for (const [net, terms] of netTerms) {
    if (net !== GROUND_NET) continue;
    for (const t of terms) {
      const p = placed.get(t.ref);
      const abs = pinAbs(p, t.pin);
      const id = 'GND' + (++seq);
      const gpos = placeAvoiding(abs.x, abs.y + 45, 30, 20, 0, 0, 20);
      addVertex(model, { id, shape: GROUND_SHAPE, x: gpos.x, y: gpos.y, w: 30, h: 20 });
      const gp = getPin(GROUND_SHAPE, GROUND_PIN);
      wire(null, { source: t.ref, target: id, sourcePin: { x: t.pin.x, y: t.pin.y, name: t.pin.name }, targetPin: { x: gp.x, y: gp.y, name: gp.name } });
      placed.set(id, { id, x: gpos.x, y: gpos.y, w: 30, h: 20, rotation: 0 });
    }
  }

  for (const [net, terms] of netTerms) {
    if (net === GROUND_NET) continue;
    if (terms.length === 1) {
      const t = terms[0];
      const p = placed.get(t.ref);
      const abs = pinAbs(p, t.pin);
      const id = 'P_' + net.replace(/[^A-Za-z0-9]/g, '_');
      const leftish = (t.pin.x <= 0.5) !== !!p.flipH;
      const targetX = abs.x + (leftish ? -80 : 56), targetY = abs.y + 36;
      const pos = placeAvoiding(targetX, targetY, 24, 24, 0, leftish ? -20 : 20, 0);
      addVertex(model, { id, shape: PORT, x: pos.x, y: pos.y, w: 24, h: 24, value: net });
      placed.set(id, { id, x: pos.x, y: pos.y, w: 24, h: 24, rotation: 0 });
      wire(null, { source: id, target: t.ref, sourcePin: { x: 0.5, y: 0 }, targetPin: { x: t.pin.x, y: t.pin.y, name: t.pin.name } });
    } else if (terms.length === 2) {
      const [a, b] = terms;
      wire(null, { source: a.ref, target: b.ref, value: net, sourcePin: { x: a.pin.x, y: a.pin.y, name: a.pin.name }, targetPin: { x: b.pin.x, y: b.pin.y, name: b.pin.name } });
      // boundary net (differential-pair member or axis end) with 2 internal
      // terminals, e.g. matching_2446.cir's Bp (C1, L3) or Bn (C1, C2): the
      // real wiring above is unchanged, this only taps on the port glyph.
      if (boundaryNets.has(net)) addBoundaryPortTap(net, a);
    } else {
      const pts = terms.map((t) => pinAbs(placed.get(t.ref), t.pin));
      let cx = 0, cy = 0;
      for (const q of pts) { cx += q.x; cy += q.y; }
      cx /= pts.length; cy /= pts.length;
      let snap = pts.reduce((best, q) => Math.abs(q.x - cx) < Math.abs(best.x - cx) ? q : best, pts[0]);
      const id = 'J_' + net.replace(/[^A-Za-z0-9]/g, '_');
      const pos = placeAvoiding(snap.x, cy, 6, 6, 0, 0, 16);
      addVertex(model, { id, style: JCT, x: pos.x, y: pos.y, w: 6, h: 6 });
      placed.set(id, { id, x: pos.x, y: pos.y, w: 6, h: 6, rotation: 0 });
      let labelled = false;
      for (const t of terms) {
        wire(null, { source: t.ref, target: id, value: labelled ? undefined : net,
          sourcePin: { x: t.pin.x, y: t.pin.y, name: t.pin.name } });
        labelled = true;
      }
      // boundary net with >2 internal terminals: tap the port onto the
      // junction dot that was just placed for the real wiring.
      if (boundaryNets.has(net)) addBoundaryPortTap(net, { x: pos.x + 3, y: pos.y + 3 }, id);
    }
  }

  return { components: comps.map((c) => c.ref), wires, warnings,
    engine: 'place3', params: P, roots: [],
    pairs: pairsFound.map((pr) => [pr.p, pr.n].sort().join('/')),
    flippable: [...new Set(shuntRefs)],
    secondaryRows: [...new Set(secondaryRowIds)] };
}
