/**
 * place4.js — macro-block placement + hierarchical routing (engine=v4).
 *
 * The "motif -> macro-block -> placement between blocks" generation that the
 * 2026-09-18 survey found in no open-source tool (Hsu & Lin MLCAD'22 and
 * EEschematic place by functional block; SKiDL/Weave place by component):
 *
 *   1. lib/motifs.js partitions the netlist into macro-blocks (quad, latch,
 *      cascade, mirror, diff pair, BJT stage, op-amp stage…) plus ONE "rest"
 *      block holding every component no motif claims — the rest is placed
 *      together, never scattered, so its own structure survives.
 *   2. Each block is placed AND routed in isolation by place2 on its
 *      sub-netlist (all the templates, rules and invariants of place2 apply
 *      unchanged inside a block). A boundary net (one that also touches
 *      another block) gets an ATTACHMENT inside the block: the port place2
 *      drew for it, converted to a junction dot, else a member pin.
 *   3. Blocks are arranged by signal flow: rank = BFS distance from the block
 *      holding the input/source, one column per rank, rows ordered by the
 *      barycentre of their neighbours in the previous column; the channel
 *      between two columns widens with the number of nets crossing it.
 *   4. Block drawings are transplanted (ids of generated cells prefixed by
 *      the block id, geometry translated), then ONLY the inter-block nets
 *      are wired (minimum spanning tree over the attachments, Manhattan) and
 *      routed: intra-block routes are frozen — that is the hierarchical part.
 *
 * Electrical safety is the same as every other engine: refdes and hidden
 * terminals re-persisted on the composed page from the GLOBAL netlist
 * (anchors of a bulk on an outside net are only resolvable there), then the
 * caller's strict LVS gate. Falls back to place2 for single-block netlists.
 */
import { newDocument, getPage, normalizeOrigin, allCells, cellInfo, addWire } from './model.js';
import { importNetlist2 } from './place2.js';
import { routePage, pinAbs } from './route.js';
import { detectMotifs } from './motifs.js';
import { SPICE_MAP, PIN_ORDER_OVERRIDES } from './components.js';
import { getPin } from './stencils.js';
import { preserveElectricalData } from './electrical-data.js';
import { applyPortStyle } from './port-style.js';

const INPUT_RE = /^(in|vin|rf|sig|lo|clk|inp|inm|inn|vip|vim)/i;

function parseStyleMap(style) {
  const m = new Map();
  for (const part of String(style).split(';')) { if (!part) continue; const i = part.indexOf('='); if (i < 0) m.set(part, ''); else m.set(part.slice(0, i), part.slice(i + 1)); }
  return m;
}
function childElement(node, name) {
  for (let c = node.firstChild; c != null; c = c.nextSibling) if (c.nodeType === 1 && c.nodeName === name) return c;
  return null;
}
function rootEl(model) { return childElement(model, 'root'); }
function mxCellOf(node) { return node.nodeName === 'object' ? childElement(node, 'mxCell') : node; }
function geomOf(node) { const c = mxCellOf(node); return c ? childElement(c, 'mxGeometry') : null; }

/** Sub-netlist of a block: its components only, nets untouched. */
function subNetlist(parsed, refs) {
  const set = new Set(refs);
  return { title: null, warnings: [], components: parsed.components.filter((c) => set.has(c.ref)), subckts: {}, couplings: [], directives: [] };
}

/** Nets every block draws LOCALLY (ground symbols, supply taps) and that
 *  therefore need no inter-block wire: exactly the ones place2 recognises as
 *  rails (its vddNet regex + ground). A supply named `n4` by an LTspice deck
 *  is NOT one of them — it stays a boundary net and gets wired. */
function railNets(parsed) {
  const rails = new Set(['0']);
  for (const n of new Set(parsed.components.flatMap((c) => c.nodes))) if (/^a?v(dd|cc)d?$/i.test(n)) rails.add(n);
  return rails;
}

/** Bounding box of every vertex of a page (label cells included). */
function bbox(model) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of allCells(model).map(cellInfo)) {
    if (c.kind === 'vertex' && c.x != null) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); }
    if (c.kind === 'edge') for (const p of c.points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  }
  return isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** Copy every top-level cell of `src` into `dst`, translated by (dx,dy);
 *  generated ids (everything but component refdes) are prefixed with `pfx`. */
function transplant(src, dst, { dx, dy, pfx, keep }) {
  const doc = dst.ownerDocument;
  const root = rootEl(dst);
  const rename = (id) => (id == null || id === '0' || id === '1' || keep.has(id)) ? id : pfx + id;
  const idMap = new Map();
  for (const node of allCells(src)) {
    const srcId = node.getAttribute('id');
    if (srcId === '0' || srcId === '1') continue;   // the layer cells exist once in `dst`
    const clone = doc.importNode(node, true);
    const cell = mxCellOf(clone);
    const oldId = node.getAttribute('id');
    const newId = rename(oldId);
    idMap.set(oldId, newId);
    if (clone.nodeName === 'object') clone.setAttribute('id', newId); else cell.setAttribute('id', newId);
    if (cell.getAttribute('source') != null) cell.setAttribute('source', rename(cell.getAttribute('source')));
    if (cell.getAttribute('target') != null) cell.setAttribute('target', rename(cell.getAttribute('target')));
    const g = geomOf(clone);
    if (g != null) {
      if (cell.getAttribute('vertex') === '1') {
        g.setAttribute('x', String(parseFloat(g.getAttribute('x') || '0') + dx));
        g.setAttribute('y', String(parseFloat(g.getAttribute('y') || '0') + dy));
      }
      for (const pt of Array.from(g.getElementsByTagName('mxPoint'))) {
        if (pt.getAttribute('as') != null) continue;
        pt.setAttribute('x', String(parseFloat(pt.getAttribute('x') || '0') + dx));
        pt.setAttribute('y', String(parseFloat(pt.getAttribute('y') || '0') + dy));
      }
    }
    root.appendChild(clone);
  }
  return idMap;
}

/** Find the pin (name + relative coords) of component `c` on net `net`. */
function pinOnNet(c, net, cellInfoOf) {
  const i = c.nodes.indexOf(net);
  if (i < 0) return null;
  const ci = cellInfoOf(c.ref);
  const shapeKey = ci && ci.style.map.get('shape');
  const order = (shapeKey && PIN_ORDER_OVERRIDES[shapeKey]) || (SPICE_MAP[c.prefix] || {}).pinOrder || [];
  const name = order[i];
  const pin = shapeKey && name ? getPin(shapeKey, name) : null;
  return pin ? { name, x: pin.x, y: pin.y } : null;
}

/**
 * Place a parsed netlist by macro-blocks. Returns the same shape as
 * importNetlist2 plus `blocks` (ids, motifs, boxes) and `interBlockNets`.
 */
export async function importNetlist4(model, parsed, opts = {}) {
  const motifs = detectMotifs(parsed);
  const blocks = motifs.blocks.map((b) => ({ id: b.id, motif: b.motif, refs: [...b.refs] }));
  if (motifs.uncovered.length) blocks.push({ id: 'B' + (blocks.length + 1), motif: 'rest', refs: [...motifs.uncovered] });
  if (blocks.length <= 1) {
    // nothing to compose: place2 is the whole answer (and the reference);
    // route here because v4 callers do not route (the hierarchical routes
    // of a composed page must not be re-routed page-wide)
    const r = importNetlist2(model, parsed, opts);
    const rr = await routePage(model, r.wires, {});
    normalizeOrigin(model);
    return { ...r, engine: 'v4->v2', routed: rr.failed == null, blocks: blocks.map((b) => ({ ...b, box: null })), interBlockNets: [] };
  }
  const rails = railNets(parsed);
  const blockOf = new Map();
  for (const b of blocks) for (const r of b.refs) blockOf.set(r, b.id);
  // nets per block, boundary nets
  const netBlocks = new Map();
  for (const c of parsed.components) for (const n of c.nodes) {
    if (rails.has(n)) continue;
    if (!netBlocks.has(n)) netBlocks.set(n, new Set());
    netBlocks.get(n).add(blockOf.get(c.ref));
  }
  const boundary = [...netBlocks.entries()].filter(([, s]) => s.size > 1).map(([n]) => n);

  // ---- 1. place + route each block in isolation
  for (const b of blocks) {
    const sub = subNetlist(parsed, b.refs);
    const doc = newDocument();
    const m = getPage(doc);
    const placed = importNetlist2(m, sub, { ...opts, _v4block: b.id });
    const r = await routePage(m, placed.wires, {});
    if (r.failed != null) throw new Error(`v4: routing failed inside block ${b.id} (${b.motif}): ${r.failed}`);
    normalizeOrigin(m, 20);
    b.model = m; b.doc = doc; b.placed = placed; b.box = bbox(m);
    // attachments for boundary nets: place2's port cell if any, else a member pin
    b.attach = new Map();
    const cells = allCells(m).map(cellInfo);
    const byId = new Map(cells.map((c) => [c.id, c]));
    const cellInfoOf = (ref) => byId.get(ref) || cells.find((c) => c.refdes === ref) || null;
    for (const net of boundary) {
      if (!b.refs.some((ref) => parsed.components.find((c) => c.ref === ref).nodes.includes(net))) continue;
      // place2 names its ports P_<net> (interface), PN<n> (rail-end ports of
      // a quad, rule 51) or PB_<n>_<ref> (local bias): match by id first,
      // then by the port's label — the net name in upper case
      const portId = 'P_' + net.replace(/[^A-Za-z0-9]/g, '_');
      let port = byId.get(portId);
      if (port == null) port = cells.find((c) => c.kind === 'vertex' && c.style.map.get('apiShape') === 'port' && String(c.value).toUpperCase() === net.toUpperCase());
      if (port != null) {
        // the port NAMES the net (extraction merges same-named ports across
        // the page): it stays a port. Its pin = the side its own wire uses.
        const e = cells.find((c) => c.kind === 'edge' && (c.source === port.id || c.target === port.id));
        const end = e == null ? null : (e.source === port.id ? 'exit' : 'entry');
        const pin = end ? { x: parseFloat(e.style.map.get(end + 'X') ?? '0.5'), y: parseFloat(e.style.map.get(end + 'Y') ?? '0.5') } : { x: 0.5, y: 0.5 };
        b.attach.set(net, { kind: 'port', id: port.id, pin });
        continue;
      }
      // every member pin on the net is a candidate; the closest pair between
      // two blocks is chosen once the blocks are positioned (step 4)
      const cands = [];
      for (const ref of b.refs) {
        const c = parsed.components.find((k) => k.ref === ref);
        const pin = pinOnNet(c, net, cellInfoOf);
        if (pin) cands.push({ kind: 'pin', id: ref, pin });
      }
      if (cands.length) b.attach.set(net, { kind: 'pins', cands });
    }
  }

  // ---- 2. block-level placement by signal flow
  const adj = new Map(blocks.map((b) => [b.id, new Map()]));
  for (const net of boundary) {
    const ids = [...netBlocks.get(net)];
    for (const a of ids) for (const c of ids) if (a !== c) adj.get(a).set(c, (adj.get(a).get(c) || 0) + 1);
  }
  const hasInput = (b) => b.refs.some((ref) => { const c = parsed.components.find((k) => k.ref === ref); return c.prefix === 'V' || c.prefix === 'I' || c.nodes.some((n) => INPUT_RE.test(n)); });
  const rank = new Map();
  const queue = [];
  for (const b of blocks) if (hasInput(b)) { rank.set(b.id, 0); queue.push(b.id); }
  if (!queue.length) { rank.set(blocks[0].id, 0); queue.push(blocks[0].id); }
  while (queue.length) {
    const id = queue.shift();
    for (const [nb] of adj.get(id)) if (!rank.has(nb)) { rank.set(nb, rank.get(id) + 1); queue.push(nb); }
  }
  let maxRank = Math.max(...rank.values());
  for (const b of blocks) if (!rank.has(b.id)) rank.set(b.id, ++maxRank);
  const byRank = [];
  for (const b of blocks) { const r = rank.get(b.id); (byRank[r] = byRank[r] || []).push(b); }
  // at most ROWS blocks per column: a rank with six BJT stages stacked
  // vertically made a 2 800 px sheet with 1 500 px inter-block wires
  const ROWS = 2;
  const columns = [];
  for (const col of byRank) { if (!col) continue; for (let i = 0; i < col.length; i += ROWS) columns.push(col.slice(i, i + ROWS)); }
  for (const b of blocks) rank.set(b.id, columns.findIndex((col) => col.includes(b)));
  // row order: barycentre of neighbours in the previous column
  const rowOf = new Map();
  columns.forEach((col, ci) => {
    if (ci > 0) {
      col.sort((a, b2) => {
        const bary = (blk) => { const prev = [...adj.get(blk.id)].filter(([nb]) => rank.get(nb) === ci - 1); return prev.length ? prev.reduce((s, [nb]) => s + rowOf.get(nb), 0) / prev.length : 1e9; };
        return bary(a) - bary(b2);
      });
    }
    col.forEach((blk, i) => rowOf.set(blk.id, i));
  });
  const GAP_Y = 90;
  let x = 0;
  const colWidth = (col) => Math.max(...col.map((b) => b.box.w));
  columns.forEach((col, ci) => {
    let y = 0;
    for (const b of col) { b.dx = x - b.box.x; b.dy = y - b.box.y; y += b.box.h + GAP_Y; }
    // channel: 100 px + 24 px per net crossing between this column and the next
    const crossing = boundary.filter((net) => { const rs = [...netBlocks.get(net)].map((id) => rank.get(id)); return Math.min(...rs) <= ci && Math.max(...rs) > ci; }).length;
    x += colWidth(col) + 100 + 24 * crossing;
  });

  // ---- 3. transplant
  const componentIds = new Set(parsed.components.map((c) => c.ref));
  const wires = [];
  for (const b of blocks) {
    const idMap = transplant(b.model, model, { dx: b.dx, dy: b.dy, pfx: b.id + '_', keep: componentIds });
    for (const w of b.placed.wires) wires.push(idMap.get(String(w)) || w);
    for (const [net, a] of b.attach) if (a.kind === 'port') a.id = idMap.get(a.id) || a.id;
    b.box = { x: b.box.x + b.dx, y: b.box.y + b.dy, w: b.box.w, h: b.box.h };
  }
  // ---- 4. inter-block nets: MST over attachments, then route ONLY those wires
  const cellsById = new Map(allCells(model).map(cellInfo).map((c) => [c.id, c]));
  const pointOf = (a) => {
    const ci = cellsById.get(a.id);
    if (ci == null) return { x: 0, y: 0 };
    return pinAbs(ci, a.pin);
  };
  const candidatesOf = (att) => att.kind === 'pins' ? att.cands : [att];
  const allCellInfos = allCells(model).map(cellInfo);
  /** A wired net must not ALSO keep an off-page tag: when the block's port
   *  for this net is the only cell naming it there, the tag becomes a
   *  junction dot at its pin and the inter-block wire lands on the dot.
   *  Multiple same-name ports in one block (local bias tags, rule "local
   *  bias ports") stay: they name the net, the wire joins them by name. */
  const portToDot = (a) => {
    const pfx = String(a.id).replace(/_.*$/, '_');   // 'B2_P_b' -> 'B2_' : same-block ports only
    const same = allCellInfos.filter((c) => c.kind === 'vertex' && c.style.map.get('apiShape') === 'port' && c.id !== a.id && String(c.id).startsWith(pfx) && String(c.value).toUpperCase() === String(cellsById.get(a.id)?.value).toUpperCase());
    if (same.length) return a;
    const node = allCells(model).find((n) => n.getAttribute('id') === a.id);
    if (node == null) return a;
    const ci = cellsById.get(a.id);
    const abs = pinAbs(ci, a.pin);
    const cell = mxCellOf(node);
    const g = geomOf(node);
    for (const n of allCells(model)) {
      const e = cellInfo(n);
      if (e.kind !== 'edge') continue;
      const end = e.source === a.id ? 'exit' : e.target === a.id ? 'entry' : null;
      if (end == null) continue;
      const st = parseStyleMap(mxCellOf(n).getAttribute('style') || '');
      st.set(end + 'X', '0.5'); st.set(end + 'Y', '0.5'); st.delete(end + 'Name');
      mxCellOf(n).setAttribute('style', [...st].map(([k, v]) => v === '' ? k : k + '=' + v).join(';') + ';');
    }
    cell.setAttribute('style', 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;');
    if (node.nodeName === 'object') node.setAttribute('label', ''); else cell.setAttribute('value', '');
    g.setAttribute('x', String(abs.x - 3)); g.setAttribute('y', String(abs.y - 3)); g.setAttribute('width', '6'); g.setAttribute('height', '6');
    ci.x = abs.x - 3; ci.y = abs.y - 3; ci.w = 6; ci.h = 6; ci.rotation = 0; ci.flipH = false; ci.flipV = false;
    return { kind: 'dot', id: a.id, pin: { x: 0.5, y: 0.5 } };
  };
  const interWires = [];
  const interBlockNets = [];
  for (const net of boundary) {
    let atts = blocks.map((b) => b.attach.get(net)).filter(Boolean);
    if (atts.length < 2) continue;
    if (atts.every((a) => a.kind === 'port')) {
      // every block already draws a named port for this net (bias buses,
      // clocks, OUT± of a quad…): the net is joined BY NAME, as a human
      // sheet does with off-page tags — no wire across the sheet
      interBlockNets.push({ net, blocks: atts.map((a) => a.id), wires: 0, joinedByName: true });
      continue;
    }
    atts = atts.map((a) => (a.kind === 'port' ? portToDot(a) : a));
    // Prim over BLOCKS, distance = closest candidate pair (Manhattan): the
    // wire leaves each block from the pin that faces the other block
    const cand = atts.map((a) => candidatesOf(a).map((c) => ({ ...c, pt: pointOf(c) })));
    const inTree = [0];
    const edges = [];
    while (inTree.length < atts.length) {
      let best = null;
      for (const i of inTree) for (let j = 0; j < atts.length; j++) {
        if (inTree.includes(j)) continue;
        for (const a of cand[i]) for (const c of cand[j]) {
          const d = Math.abs(a.pt.x - c.pt.x) + Math.abs(a.pt.y - c.pt.y);
          if (best == null || d < best.d) best = { i, j, a, c, d };
        }
      }
      inTree.push(best.j); edges.push(best);
    }
    for (const { a, c } of edges) {
      const anchor = (att) => ({ x: att.pin.x, y: att.pin.y, ...(att.pin.name ? { name: att.pin.name } : {}) });
      const w = addWire(model, { source: a.id, target: c.id, sourcePin: anchor(a), targetPin: anchor(c) });
      interWires.push(w.getAttribute('id'));
    }
    interBlockNets.push({ net, blocks: atts.map((a) => a.id || a.cands[0].id), wires: edges.length, joinedByName: false });
  }
  const r = await routePage(model, interWires, {});
  normalizeOrigin(model);
  applyPortStyle(model, opts);
  preserveElectricalData(model, parsed);
  const all = blocks.flatMap((b) => b.placed.roots || []);
  return {
    components: parsed.components.map((c) => c.ref), wires: [...wires, ...interWires], warnings: parsed.warnings || [],
    engine: 'v4', routed: r.failed == null, roots: all, flippable: blocks.flatMap((b) => b.placed.flippable || []),
    structuredRefs: blocks.flatMap((b) => b.placed.structuredRefs || []), fanouts: {},
    blocks: blocks.map((b) => ({ id: b.id, motif: b.motif, refs: b.refs, box: b.box })), interBlockNets,
  };
}
