/**
 * place.js — initial placement + wiring of a parsed SPICE netlist onto a page.
 * Sources in the left column, then BFS rank across shared nets. Ground nodes
 * get one ground symbol per terminal (classic schematic style); nets with >2
 * terminals get a junction dot (star wiring). Run routePage() afterwards.
 */
import { addVertex, addWire, httpError } from './model.js';
import { SPICE_MAP, GROUND_SHAPE, GROUND_PIN } from './components.js';
import { getShape, getPin } from './stencils.js';
import { pinAbs } from './route.js';

const COL_W = 220, ROW_H = 170, X0 = 80, Y0 = 80;
const JUNCTION_STYLE = 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;';

export function importNetlist(model, parsed) {
  const comps = parsed.components;
  if (comps.length === 0) throw httpError(400, 'netlist has no supported components');

  // rank components: BFS from sources over shared non-ground nets
  const byNet = new Map();
  for (const c of comps) for (const node of c.nodes) {
    if (node === '0') continue;
    if (!byNet.has(node)) byNet.set(node, []);
    byNet.get(node).push(c);
  }
  const rank = new Map();
  const queue = comps.filter((c) => c.prefix === 'V' || c.prefix === 'I');
  for (const c of queue) rank.set(c.ref, 0);
  while (queue.length) {
    const c = queue.shift();
    for (const node of c.nodes) {
      if (node === '0') continue;
      for (const o of byNet.get(node) || []) {
        if (!rank.has(o.ref)) { rank.set(o.ref, rank.get(c.ref) + 1); queue.push(o); }
      }
    }
  }
  let maxRank = Math.max(0, ...rank.values());
  for (const c of comps) if (!rank.has(c.ref)) rank.set(c.ref, ++maxRank);

  // place components
  const rows = new Map(); // col -> next row index
  const placed = new Map(); // ref -> {cell info-ish for pinAbs}
  for (const c of comps) {
    const map = SPICE_MAP[c.prefix];
    let shapeKey = map.shape;
    if (map.variants != null && c.model != null) {
      for (const [k, v] of Object.entries(map.variants)) {
        if (c.model.toUpperCase().includes(k)) shapeKey = v;
      }
    }
    const shape = getShape(shapeKey);
    const col = rank.get(c.ref);
    const row = rows.get(col) || 0;
    rows.set(col, row + 1);
    // orientation: vertical for native-vertical shapes; rotate 2-terminal
    // parts touching ground so the grounded pin points down
    let rotation = 0;
    if (!map.vertical && c.nodes.length === 2 && c.nodes.includes('0')) {
      rotation = c.nodes[1] === '0' ? 90 : -90;
    }
    const w = shape.w, h = shape.h;
    const x = X0 + col * COL_W, y = Y0 + row * ROW_H;
    addVertex(model, { id: c.ref, shape: shapeKey, x, y, w, h, rotation, value: c.value || '' });
    placed.set(c.ref, { id: c.ref, x, y, w, h, rotation, shapeKey, spice: c, map });
  }

  // wire nets
  const netTerms = new Map(); // net -> [{ref, pinName, pin}]
  for (const c of comps) {
    const p = placed.get(c.ref);
    c.nodes.forEach((node, i) => {
      const pinName = p.map.pinOrder[i];
      const pin = getPin(p.shapeKey, pinName);
      if (!netTerms.has(node)) netTerms.set(node, []);
      netTerms.get(node).push({ ref: c.ref, pinName, pin });
    });
  }

  const wires = [];
  const gnd = getShape(GROUND_SHAPE);
  let gndN = 0;
  for (const [net, terms] of netTerms) {
    if (net === '0') {
      // one ground symbol under each grounded terminal
      for (const t of terms) {
        const p = placed.get(t.ref);
        const abs = pinAbs(p, t.pin);
        const gw = 30, gh = 20;
        const gid = 'GND' + (++gndN);
        addVertex(model, { id: gid, shape: GROUND_SHAPE, x: abs.x - gw / 2, y: p.y + p.h + 40, w: gw, h: gh });
        const gpin = getPin(GROUND_SHAPE, GROUND_PIN) || gnd.pins[0];
        wires.push(addWire(model, { source: t.ref, target: gid,
          sourcePin: { x: t.pin.x, y: t.pin.y }, targetPin: { x: gpin.x, y: gpin.y } }).getAttribute('id'));
      }
    } else if (terms.length === 2) {
      const [a, b] = terms;
      wires.push(addWire(model, { source: a.ref, target: b.ref,
        sourcePin: { x: a.pin.x, y: a.pin.y }, targetPin: { x: b.pin.x, y: b.pin.y } }).getAttribute('id'));
    } else if (terms.length > 2) {
      // star wiring through a junction dot at the terminals' centroid
      let cx = 0, cy = 0;
      for (const t of terms) { const abs = pinAbs(placed.get(t.ref), t.pin); cx += abs.x; cy += abs.y; }
      cx /= terms.length; cy /= terms.length;
      const jid = 'J_' + net.replace(/[^A-Za-z0-9_]/g, '_');
      addVertex(model, { id: jid, style: JUNCTION_STYLE, x: cx - 3, y: cy - 3, w: 6, h: 6 });
      for (const t of terms) {
        wires.push(addWire(model, { source: t.ref, target: jid,
          sourcePin: { x: t.pin.x, y: t.pin.y }, targetPin: { x: 0.5, y: 0.5 } }).getAttribute('id'));
      }
    }
    // single-terminal nets are left unwired; ERC reports them
  }
  return { components: comps.map((c) => c.ref), wires, warnings: parsed.warnings || [] };
}
