/**
 * dummies.js — dummy transistors are never drawn in the main schematic (Eric 08.11). Every import that has some
 * draws them on a SECOND page, "factices":
 *   - page 1 is the circuit without its dummies, as every engine draws it;
 *   - page 2 holds only the dummies, grouped by the device they protect, with a title such as
 *     "factices de M1/M2 : 4 × sg13_lv_nmos 4.375/8, grille → vss"; on that page they are wired with REAL wires,
 *     to each other and to the supply rail drawn there;
 *   - between the pages the link is by NAME only: a dummy terminal on a net of page 1 (the protected device's
 *     drain, a signal node) gets a net label with that exact net name; no wire crosses pages.
 *
 * A dummy is (Eric 08.11: "the dummies must not be in the main schematic")
 *   - a MOS marked `dummy=1` on its line (the layout3d format, agreed 08.11: `XM7 vss vss vss vss sg13_lv_nmos
 *     w=1u l=0.13u dummy=1`), or
 *   - a MOS whose drain, gate and source are one net, or
 *   - a MOS that is always off: its gate tied to its own off rail (NMOS gate on a negative supply / ground,
 *     PMOS gate on a positive supply), even with its drain on a signal (layout3d's XM25 on vtail, XM154 on von):
 *     that terminal gets, on page 2, a net label of the signal's name, not a wire.
 * A MOS capacitor (gate on a signal, drain and source on a rail) is not a dummy: it stays on page 1.
 * The device a dummy protects: the non-dummy MOS that shares a channel net with it, else the non-dummy MOS of
 * the same model and size (the array it ends), else none ("factices").
 *
 * Parasitic-estimate capacitors (Eric 08.11): a C line ending in `lvs_ignore=1` (layout parasitics annotated
 * back into the netlist) goes to page 2 as well, never page 1, under the heading "Parasites estimés (LVS ignore)",
 * each with its value; wired there to its rails, joined to page-1 nets by name like the dummies.
 */
import { addPage, addVertex, addWire, allCells, cellInfo, deleteCell, freshId, getPage, updateCell } from './model.js';
import { SPICE_MAP, classify } from './components.js';
import { netGroups, pinAbs, polylineOf } from './route.js';
import { getShape } from './stencils.js';
import { supplyPolarity } from './supply-orient.js';
import { portDirection } from './port-style.js';
import { connectivity, extractNetlist } from './netlist.js';
import { compare } from './lvs.js';
import { groundMapper } from './ground-alias.js';
import { annotation, Sheet, emit as emitSheets, placeTr, placeTwo, portVert, tapGnd, tapVdd } from './place-manuel.js';

export const DUMMY_PAGE = 'factices';
const isMos = (c) => c.prefix === 'M' && (c.nodes || []).length >= 3;
const isP = (c) => /pmos|pfet|pch/i.test(String(c.model || c.value || ''));
export const PARASITIC_TITLE = 'Parasites estimés (LVS ignore)';
const parasitic = (c) => c.prefix === 'C' && (String(c.params?.lvs_ignore ?? '') === '1' || /(^|\s)lvs_ignore\s*=\s*1(\s|$)/i.test(String(c.value || '')));
const flagged = (c) => String(c.params?.dummy ?? '') === '1' || /(^|\s)dummy\s*=\s*1(\s|$)/i.test(String(c.value || ''));

/** parsed -> {main (parsed without its dummies), dummies: [{c, why}], groups: [{protects, items, title}]} */
export function splitDummies(parsed) {
  const { pol } = supplyPolarity(parsed);
  const neg = (n) => n === '0' || pol.get(n) === 'neg', pos = (n) => pol.get(n) === 'pos', rail = (n) => neg(n) || pos(n);
  const dummies = [];
  for (const c of parsed.components) {
    if (!isMos(c)) continue;
    const [d, g, s] = c.nodes;
    const why = flagged(c) ? 'dummy=1' : d === g && g === s ? 'bornes sur un seul net'
      : (isP(c) ? pos(g) : neg(g)) ? 'grille au rail (toujours bloqué)' : null;
    if (why) dummies.push({ c, why });
  }
  const pars = parsed.components.filter(parasitic);
  const dSet = new Set([...dummies.map((x) => x.c.ref), ...pars.map((c) => c.ref)]);
  const main = parsed.components.filter((c) => !dSet.has(c.ref));
  if ((!dummies.length && !pars.length) || !main.length) return { main: parsed, dummies: [], groups: [], parasitics: [] };
  const size = (c) => `${String(c.model || '').toLowerCase()}|${annotation(c).replace(/\s*×\d+$/, '')}`;
  // dummies joined by a net of their own (neither a rail nor a page-1 net) stay in one group: that net is wired on page 2
  const mainNets = new Set(main.flatMap((c) => c.nodes));
  const root = new Map(dummies.map((x) => [x.c.ref, x.c.ref]));
  const find = (r) => (root.get(r) === r ? r : find(root.get(r)));
  const byLocal = new Map();
  for (const x of dummies) for (const n of x.c.nodes) if (!rail(n) && !mainNets.has(n)) {
    if (byLocal.has(n)) root.set(find(x.c.ref), find(byLocal.get(n))); else byLocal.set(n, x.c.ref);
  }
  const protOf = new Map();
  for (const x of dummies) {
    const [d, , s] = x.c.nodes, sig = [d, s].filter((n) => !rail(n));
    // the neighbours on a shared channel net, those of the dummy's own size first; else the devices of its size
    const near = main.filter((m) => isMos(m) && [m.nodes[0], m.nodes[2]].some((n) => sig.includes(n)));
    const same = (l) => l.filter((m) => size(m) === size(x.c));
    let prot = same(near).length ? same(near) : near;
    if (!prot.length) prot = same(main.filter(isMos));
    protOf.set(x.c.ref, prot.map((m) => m.ref));
  }
  const clusters = new Map();   // root -> {refs protected, items}
  for (const x of dummies) {
    const r = find(x.c.ref);
    if (!clusters.has(r)) clusters.set(r, { prot: new Set(), items: [] });
    clusters.get(r).items.push(x.c); for (const p of protOf.get(x.c.ref)) clusters.get(r).prot.add(p);
  }
  const groups = new Map();
  for (const cl of clusters.values()) {
    const key = [...cl.prot].sort().join('/');
    if (!groups.has(key)) groups.set(key, { protects: key ? key.split('/') : [], items: [] });
    groups.get(key).items.push(...cl.items);
  }
  const name = (n) => (n === '0' ? parsed.groundAlias || 'gnd' : n);
  for (const g of groups.values()) {
    const kinds = new Map();
    // N × model W/L: N counts the multipliers (two merged dummy fingers are 2)
    for (const c of g.items) { const k = `${c.model || c.value.split(/\s+/)[0]} ${annotation(c).replace(/\s*×\d+$/, '')}`; kinds.set(k, (kinds.get(k) || 0) + (Number(c.params?.m ?? /\bm=(\d+)/i.exec(c.value || '')?.[1] ?? 1) || 1)); }
    const gates = [...new Set(g.items.map((c) => name(c.nodes[1])))];
    g.title = `${g.protects.length ? `factices de ${g.protects.join('/')}` : 'factices'} : `
      + [...kinds].map(([k, n]) => `${n} × ${k}`).join(' ; ') + `, grille → ${gates.join(', ')}`;
  }
  return { main: { ...parsed, components: main }, dummies, groups: [...groups.values()], parasitics: pars,
    dummyParsed: { ...parsed, components: [...dummies.map((x) => x.c), ...pars] } };
}


/** draw page 2; page1Nets: the nets of page 1 (a dummy terminal on one of them gets a label of that name) */
export async function drawDummiesPage(doc, split, page1Nets) {
  // a re-import replaces the dummies page, never stacks a second one
  for (const d of Array.from(doc.getElementsByTagName('diagram'))) if (d.getAttribute('name') === DUMMY_PAGE) d.parentNode.removeChild(d);
  addPage(doc, DUMMY_PAGE);
  const model = getPage(doc, DUMMY_PAGE);
  const { pol } = supplyPolarity({ components: [...split.main.components, ...split.dummyParsed.components] });
  const neg = (n) => n === '0' || pol.get(n) === 'neg', pos = (n) => pol.get(n) === 'pos';
  const sheets = [], rails = new Set();
  let y0 = 40;
  for (const g of split.groups) {
    // drawn by hand on a manuel sheet (lib/place-manuel.js), no router: one row of dummies, gate on the left;
    // from the top: positive rails, buses of the nets local to this page, the row, negative rails
    const S = new Sheet();
    const nets = [...new Set(g.items.flatMap((c) => c.nodes.slice(0, 3)))];
    // a page-1 net on two pins or more of the group (d3 at XM6 drain and source): one wire joins them and ONE
    // label names it (review r2, N4), drawn as a bus like a local net
    const uses = new Map();
    for (const c of g.items) for (const n of c.nodes.slice(0, 3)) uses.set(n, (uses.get(n) || 0) + 1);
    const shared = (n) => page1Nets.has(n) && !neg(n) && !pos(n);
    const multi = nets.filter((n) => shared(n) && uses.get(n) >= 2);
    const single = (n) => shared(n) && !multi.includes(n);
    const local = nets.filter((n) => !neg(n) && !pos(n) && (!page1Nets.has(n) || multi.includes(n)));
    const posR = nets.filter(pos), negR = nets.filter(neg);
    const lab = 25 + 8 * Math.max(4, ...nets.filter(single).map((n) => n.length)) + 12;
    const right = Math.max(105, lab), pitch = right + 8 * local.length + 120;
    const top = y0 + 90 + 20 * (posR.length + local.length);   // a positive symbol (26 high) clears the title
    const busY = (n) => top - 30 - 20 * local.indexOf(n);
    const posY = (n) => top - 30 - 20 * local.length - 20 * posR.indexOf(n);
    const h = getShape(SPICE_MAP.M.shape).h;
    const negY = (n) => top + h + 30 + 8 * local.length + 20 * negR.indexOf(n);
    const touch = new Map();            // rail or bus net -> x of its attachments
    const at = (n, x) => { if (!touch.has(n)) touch.set(n, []); touch.get(n).push(x); };
    g.items.forEach((c, i) => {
      const cx = 140 + i * pitch, v = placeTr(S, c, cx, top, -1);
      const gx = v.pinAbs[v.pinOf.gate].x;
      for (const side of ['top', 'bot']) {
        const n = v.netOf[side], p = S.term(n, v, v.pinOf[side]), out = side === 'top' ? -1 : 1;
        if (single(n)) {
          // a page-1 net: its label at the pin, a short wire (the link to page 1 is the name)
          const e = { x: p.x + 25, y: p.y }; S.path(n, p, e); portVert(S, n, e, 1, false); S.term(n, S.verts.at(-1), S.verts.at(-1).portPin);
        } else if (local.includes(n)) {
          if (side === 'top') { S.path(n, p, { x: p.x, y: busY(n) }); at(n, p.x); }
          else { const xr = p.x + right + 8 * local.indexOf(n), yb = p.y + 12 + 8 * local.indexOf(n); S.path(n, p, { x: p.x, y: yb }, { x: xr, y: yb }, { x: xr, y: busY(n) }); at(n, xr); }
        } else if ((out < 0) === pos(n)) {
          // the pin faces its own rail: straight to it
          const y = pos(n) ? posY(n) : negY(n); S.path(n, p, { x: p.x, y }); at(n, p.x);
        } else {
          // the pin faces the other way (a drain on the source's rail): round the gate side, on the gate's column
          // when the gate is on the same rail (they join), else one column further out
          const xc = gx - (v.netOf.gate === n ? 20 : 32), y = pos(n) ? posY(n) : negY(n);
          S.path(n, p, { x: p.x, y: p.y + 12 * out }, { x: xc, y: p.y + 12 * out }, { x: xc, y }); at(n, xc);
        }
      }
      const n = v.netOf.gate, p = S.term(n, v, v.pinOf.gate);
      if (neg(n) || pos(n)) { const y = pos(n) ? posY(n) : negY(n); S.path(n, p, { x: gx - 20, y: p.y }, { x: gx - 20, y }); at(n, gx - 20); }
      else if (local.includes(n)) { S.path(n, p, { x: gx - 20, y: p.y }, { x: gx - 20, y: busY(n) }); at(n, gx - 20); }
      else { const e = { x: p.x - 25, y: p.y }; S.path(n, p, e); portVert(S, n, e, -1, false); S.term(n, S.verts.at(-1), S.verts.at(-1).portPin); }
    });
    // the lines: every rail with its symbol at the left end, every local bus between its outermost attachments
    for (const [n, xs] of touch) {
      const lo = Math.min(...xs), hi = Math.max(...xs);
      if (local.includes(n)) {
        if (hi > lo) S.path(n, { x: lo, y: busY(n) }, { x: hi, y: busY(n) });
        if (multi.includes(n)) {
          // its one label, at the left end of its bus
          const x0 = lo - 30; S.path(n, { x: x0, y: busY(n) }, { x: lo, y: busY(n) });
          const v = portVert(S, n, { x: x0, y: busY(n) }, -1, false); S.term(n, v, v.portPin);
        }
        continue;
      }
      rails.add(n);
      const y = pos(n) ? posY(n) : negY(n), x0 = lo - 30;
      S.path(n, { x: x0, y }, { x: Math.max(hi, x0 + 1), y });
      const sym = n === '0' ? tapGnd(S, { x: x0, y }) : pos(n) ? tapVdd(S, n, { x: x0, y }) : portVert(S, n, { x: x0, y }, -1, false);
      S.term(n, sym, n === '0' ? 'N' : pos(n) ? 'S' : sym.portPin);
    }
    S.text(`<b>${g.title}</b>`, 40, y0, Math.max(200, Math.ceil(7.5 * g.title.length)), 20, 'left', 12);
    sheets.push(S);
    y0 = top + h + 70 + 8 * local.length + 20 * negR.length;
  }
  if (split.parasitics?.length) sheets.push(drawParasitics(split.parasitics, page1Nets, pos, neg, y0, rails));
  emitSheets(model, sheets, split.dummyParsed, rails);
  return model;
}

/**
 * The parasitic capacitors: one row of vertical caps, positive rail end up, negative rail end down; a page-1 net
 * on one pin gets its label on a short stub; a net on two pins or more (or local to page 2) is one bus with one
 * label (review r2, N4).
 */
function drawParasitics(items, page1Nets, pos, neg, y0, rails) {
  const S = new Sheet();
  // [top net, bottom net]: a positive supply up, a negative one down, else the netlist order
  const ends = items.map((c) => { const [a, b] = c.nodes; return pos(b) && !pos(a) || neg(a) && !neg(b) ? [b, a] : [a, b]; });
  const uses = new Map();
  for (const e of ends) for (const n of e) uses.set(n, (uses.get(n) || 0) + 1);
  const sig = (n) => !pos(n) && !neg(n);
  // a bus above when the net is a top end somewhere, else below
  const busUp = [...uses.keys()].filter((n) => sig(n) && (uses.get(n) >= 2 || !page1Nets.has(n)) && ends.some((e) => e[0] === n));
  const busDn = [...uses.keys()].filter((n) => sig(n) && (uses.get(n) >= 2 || !page1Nets.has(n)) && !busUp.includes(n));
  const bus = (n) => busUp.includes(n) || busDn.includes(n);
  const posR = [...new Set(ends.map((e) => e[0]).filter(pos))], negR = [...new Set(ends.map((e) => e[1]).filter(neg))];
  const top = y0 + 90 + 20 * (posR.length + busUp.length);
  const lab = 8 * Math.max(4, ...[...uses.keys()].map((n) => String(n).length)) + 40;
  const pitch = Math.max(170, lab + 100);
  // placed first: the bottom lines sit under the lowest real pin
  const placed = items.map((c, i) => { const cx = 60 + lab + i * pitch, v = placeTwo(S, c, cx, top, ends[i][0], true, 1); return { cx, v }; });
  const bot = Math.max(...placed.map(({ v }) => v.pinAbs[v.other].y));
  const upY = (n) => top - 30 - 20 * busUp.indexOf(n), posY = (n) => top - 30 - 20 * busUp.length - 20 * posR.indexOf(n);
  const dnY = (n) => bot + 30 + 20 * busDn.indexOf(n), negY = (n) => bot + 30 + 20 * busDn.length + 20 * negR.indexOf(n);
  const touch = new Map(), at = (n, x) => { if (!touch.has(n)) touch.set(n, []); touch.get(n).push(x); };
  placed.forEach(({ cx, v }, i) => {
    const [tn, bn] = ends[i];
    const pt = S.term(tn, v, v.first), pb = S.term(bn, v, v.other);
    // the far column, right of the ref text, for a pin whose bus is on the other side
    const xr = cx + 100;
    for (const [n, p, up] of [[tn, pt, true], [bn, pb, false]]) {
      const o = up ? -1 : 1;
      if (up ? pos(n) : neg(n)) { S.path(n, p, { x: p.x, y: up ? posY(n) : negY(n) }); at(n, p.x); }
      else if (bus(n) && busUp.includes(n) === up) { S.path(n, p, { x: p.x, y: up ? upY(n) : dnY(n) }); at(n, p.x); }
      else if (bus(n)) { const yb = busUp.includes(n) ? upY(n) : dnY(n); S.path(n, p, { x: p.x, y: p.y + 12 * o }, { x: xr, y: p.y + 12 * o }, { x: xr, y: yb }); at(n, xr); }
      else {
        // a page-1 net (or a rail on the far side): its label on a stub, left of the cap
        const e = { x: p.x - 15, y: p.y + 15 * o }; S.path(n, p, { x: p.x, y: e.y }, e);
        const lv = portVert(S, n, e, -1, false); S.term(n, lv, lv.portPin);
      }
    }
  });
  for (const [n, xs] of touch) {
    const lo = Math.min(...xs), hi = Math.max(...xs), x0 = lo - 30;
    if (bus(n)) {
      const y = busUp.includes(n) ? upY(n) : dnY(n);
      S.path(n, { x: x0, y }, { x: Math.max(hi, x0 + 1), y });
      const lv = portVert(S, n, { x: x0, y }, -1, false); S.term(n, lv, lv.portPin);
      continue;
    }
    rails.add(n);
    const y = pos(n) ? posY(n) : negY(n);
    S.path(n, { x: x0, y }, { x: Math.max(hi, x0 + 1), y });
    const sym = n === '0' ? tapGnd(S, { x: x0, y }) : pos(n) ? tapVdd(S, n, { x: x0, y }) : portVert(S, n, { x: x0, y }, -1, false);
    S.term(n, sym, n === '0' ? 'N' : pos(n) ? 'S' : sym.portPin);
  }
  S.text(`<b>${PARASITIC_TITLE}</b> : ${items.length} capacité${items.length > 1 ? 's' : ''}`, 40, y0, 360, 20, 'left', 12);
  return S;
}

// terminal ids as lib/lvs.js counts them (R/C/L symmetric, MOS drain/source interchangeable)
const termId = (c, i) => (['R', 'C', 'L'].includes(c.prefix) ? `${c.ref.toUpperCase()}.x` : c.prefix === 'M' && (i === 0 || i === 2) ? `${c.ref.toUpperCase()}.ds` : `${c.ref.toUpperCase()}.${i}`);
function netSigs(comps, map) {
  const t = new Map();
  for (const c of comps) (c.fullNodes || c.nodes).forEach((n, i) => { const k = map(n); if (!t.has(k)) t.set(k, []); t.get(k).push(termId(c, i)); });
  return new Map([...t].map(([n, ts]) => [n, ts.sort().join(' ')]));
}

/**
 * The LVS of both pages against the whole netlist: page 1's nets take their netlist names (same terminal set),
 * page 2's are named by its labels and rails, other page-2 nets stay local; then the union is compared with the
 * netlist, its named nets checked by name (lib/lvs.js).
 */
export function lvsTwoPages(doc, split, full) {
  const p1 = extractNetlist(getPage(doc, 0)), p2 = extractNetlist(getPage(doc, DUMMY_PAGE));
  const g1 = groundMapper(p1.components), gm = groundMapper(split.main.components);
  const want = netSigs(split.main.components, gm), bySig = new Map([...want].map(([n, s]) => [s, n]));
  const have = netSigs(p1.components, g1), ren = new Map([...have].map(([n, s]) => [n, bySig.get(s) ?? `p1:${n}`]));
  const named2 = new Set(p2.namedNets || []);
  const g2 = groundMapper(p2.components);
  const r1 = (n) => ren.get(g1(n)) ?? `p1:${n}`, r2 = (n) => { const k = g2(n); return k === '0' || named2.has(k) ? k : `p2:${k}`; };
  const fix = (c, f) => ({ ...c, nodes: c.nodes.map(f), fullNodes: (c.fullNodes || c.nodes).map(f) });
  const merged = { components: [...p1.components.map((c) => fix(c, r1)), ...p2.components.map((c) => fix(c, r2))],
    issues: [...(p1.issues || []), ...(p2.issues || [])], namedNets: [...named2] };
  const report = compare(merged, full);
  // review r4 (1): the pages are joined by NAME only, but the match above goes by terminals: a page-2 name that
  // page 1 does not print (as a port, a label, a rail or on a wire) is a drawing whose pages do not join
  const shown = new Set([...(p1.namedNets || []), ...allCells(getPage(doc, 0)).map(cellInfo).filter((e) => e.kind === 'edge').map((e) => String(e.value || '').trim())]
    .filter(Boolean).map((n) => String(n).toUpperCase()));
  const gnd = String(split.main?.groundAlias || '').toUpperCase(), p1n = page1NetsOf(split);
  const unnamed = [...named2].filter((n) => g2(n) !== '0' && String(n).toUpperCase() !== gnd && p1n.has(n) && !shown.has(String(n).toUpperCase()));
  if (unnamed.length) { report.match = false; report.unnamed = unnamed; }
  return report;
}

const PORT_TEXT = (align) => `text;html=1;apiShape=port;align=${align};verticalAlign=middle;fontSize=12;fontStyle=2;spacing=2;`;
const STUB = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;endFill=0;drawioApiFixedRoute=1;';
const hit = (r, s) => r.x < s.x + s.w && r.x + r.w > s.x && r.y < s.y + s.h && r.y + r.h > s.y;
const segBox = (a, b, m = 0) => ({ x: Math.min(a.x, b.x) - m, y: Math.min(a.y, b.y) - m, w: Math.abs(a.x - b.x) + 2 * m, h: Math.abs(a.y - b.y) + 2 * m });

/**
 * Review r2 (N1): the link between the pages is a name, so the name must be READ on both pages. Every net named
 * on page 2 (a label or a rail) that page 1 does not name already gets, on page 1, a net label of that exact
 * name on a short stub from one of its device pins (the freest of them). -> [{net, at, clear}]
 */
// a .subckt pin's port arrow (as the template's vinp / vinn), its direction from its name (lib/port-style.js)
const portBox = (net) => ({ w: Math.max(64, 7 * net.length + 28), h: 24 });
function portStyleFor(net, side) {
  const dir = portDirection(net), west = (dir === 'input') === (side > 0);
  return { west, style: `shape=${dir === 'inout' ? 'doubleArrow' : 'singleArrow'};arrowWidth=1;arrowSize=0.18;apiShape=port;portDirection=${dir};direction=${west ? 'west' : 'east'};html=0;fillColor=#ffffff;strokeColor=default;align=center;verticalAlign=middle;fontSize=12;` };
}

/** opts.port: the names are a .subckt's pins (review r4: every pin a port symbol, as Cadence's pins): an arrow
 *  port on a horizontal stub; no horizontal room, the italic label as for page-2 names. */
export function labelSharedOnPage1(doc, split, names, m = getPage(doc, 0), opts = {}) {
  const p1 = extractNetlist(m);
  const named = new Set((p1.namedNets || []).map((n) => String(n).toUpperCase()));
  // a name already carried by a wire (this pass's own fallback, run once for the pins and once for page 2): the
  // net is named, a second wire label would print it twice (Eric's ota5t: von and vtail written twice, 08.11)
  for (const e of allCells(m).map(cellInfo)) if (e.kind === 'edge' && String(e.value || '').trim()) named.add(String(e.value).trim().toUpperCase());
  // ground (and the name it goes by, ground_ana: drawn as the ground symbol, which names it) is never missing
  const gnd = String(split.main?.groundAlias || '').toUpperCase();
  const missing = [...new Set(names)].filter((n) => n !== '0' && String(n).toUpperCase() !== gnd && !named.has(String(n).toUpperCase()));
  if (!missing.length) return [];
  // page-1 net names -> netlist names, by terminal set (as lvsTwoPages)
  const g1 = groundMapper(p1.components), gm = groundMapper(split.main.components);
  const bySig = new Map([...netSigs(split.main.components, gm)].map(([n, s]) => [s, n]));
  const ren = new Map([...netSigs(p1.components, g1)].map(([n, s]) => [n, bySig.get(s)]));
  const conn = connectivity(m);
  const cells = allCells(m).map(cellInfo), byId = new Map(cells.map((c) => [c.id, c]));
  const boxes = cells.filter((c) => c.kind === 'vertex' && c.x != null && c.w).map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h }));
  const segs = [];
  for (const e of cells.filter((c) => c.kind === 'edge')) {
    const pl = polylineOf(e, byId); if (!pl) continue;
    for (let i = 1; i < pl.length; i++) segs.push([pl[i - 1], pl[i]]);
  }
  const out = [];
  for (const net of missing) {
    const keys = [...conn.nets].filter(([k]) => ren.get(g1(k)) === net).flatMap(([, ks]) => ks);
    const cands = [], tw = Math.max(30, 8 * net.length), th = 18, pb = portBox(net);
    // where a stub may start: a device pin of the net, straight out of the device; or a junction dot of the net
    // (where its wires already meet), any of four ways
    const pinTerms = keys.map((k) => conn.termInfo.get(k)).filter((t) => t && classify(t.cell).role === 'component');
    const pinAt = pinTerms.map((t) => pinAbs(t.cell, t.pin));
    const origins = pinTerms.map((t, i) => {
      const p = pinAt[i], dx = p.x - (t.cell.x + t.cell.w / 2), dy = p.y - (t.cell.y + t.cell.h / 2);
      const d = Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
      return { id: t.cell.id, pin: { x: t.pin.x, y: t.pin.y, ...(t.pin.name ? { name: t.pin.name } : {}) }, own: t.cell.id, p, dirs: [d] };
    });
    const groups = netGroups(cells), ends = (e) => { const pl = polylineOf(e, byId); return pl ? [pl[0], pl.at(-1)] : []; };
    const near = (u, v) => Math.hypot(u.x - v.x, u.y - v.y) < 1;
    const netWires = cells.filter((e) => e.kind === 'edge' && ends(e).some((u) => pinAt.some((v) => near(u, v))));
    const gids = new Set(netWires.map((e) => groups.get(e.id)));
    for (const j of cells.filter((c) => c.kind === 'vertex' && c.x != null && classify(c).role === 'junction')) {
      const p = { x: j.x + j.w / 2, y: j.y + j.h / 2 };
      // a dot on the net: a wire ends on it, or (a template's drawn dot, GDOT_*, not attached) one runs through it
      const through = (e) => { const pl = polylineOf(e, byId) || []; for (let i = 1; i < pl.length; i++) { const [u, v] = [pl[i - 1], pl[i]];
        if (Math.abs(u.x - v.x) < 1 && Math.abs(p.x - u.x) < 1 && p.y >= Math.min(u.y, v.y) - 1 && p.y <= Math.max(u.y, v.y) + 1) return true;
        if (Math.abs(u.y - v.y) < 1 && Math.abs(p.y - u.y) < 1 && p.x >= Math.min(u.x, v.x) - 1 && p.x <= Math.max(u.x, v.x) + 1) return true; } return false; };
      if (!cells.some((e) => e.kind === 'edge' && gids.has(groups.get(e.id)) && (e.source === j.id || e.target === j.id || through(e)))) continue;
      origins.push({ id: j.id, pin: { x: 0.5, y: 0.5 }, own: j.id, p, dirs: [{ x: 0, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 }] });
    }
    for (const o of origins) for (const d of o.dirs) {
      const p = o.p;
      // straight out, or out then sideways (an L) when the straight way is taken
      const shapes = [25, 45, 70].map((a) => [a, null, 0]);
      for (const a of [15, 30]) for (const sg of [1, -1]) shapes.push([a, { x: d.y * sg, y: d.x * sg }, 30]);
      // a port arrow is wide: the L out further, and longer sideways, before giving up on it
      if (opts.port) for (const a of [15, 30, 45, 60]) for (const b of [30, 60]) for (const sg of [1, -1]) if (d.x === 0) shapes.push([a, { x: sg, y: 0 }, b]);
      for (const [a, q0, b] of shapes) {
        const k = { x: p.x + d.x * a, y: p.y + d.y * a }, q = q0 || d, e = q0 ? { x: k.x + q.x * b, y: k.y + q.y * b } : k;
        const port = !!opts.port && !!q.x, w = port ? pb.w : tw, h = port ? pb.h : th;
        const r = q.x ? { x: q.x < 0 ? e.x - w : e.x, y: e.y - h / 2, w, h } : { x: e.x - w / 2, y: q.y < 0 ? e.y - h : e.y, w, h };
        const pin = q.x ? (q.x < 0 ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 }) : (q.y < 0 ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 });
        const rr = { x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 };
        // the stub may leave a wire where it starts, never run along a wire, cross one, or touch a body
        const along = [];
        for (let i = 4; i <= a; i += 2) along.push({ x: p.x + d.x * i, y: p.y + d.y * i });
        for (let i = 2; q0 && i <= b; i += 2) along.push({ x: k.x + q.x * i, y: k.y + q.y * i });
        const dot = (u) => ({ x: u.x - 0.5, y: u.y - 0.5, w: 1, h: 1 });
        let bad = 0;
        for (const bx of boxes) if (hit(rr, bx) || along.some((u) => hit(dot(u), bx))) bad++;
        for (const [u, v] of segs) if (hit(rr, segBox(u, v, 0.5)) || along.some((x) => hit(dot(x), segBox(u, v, 0.5)))) bad++;
        if (!bad) cands.push({ len: a + b + (opts.port && !port ? 1000 : 0), port, side: q.x, o, p, k, e, r, pin, bent: !!q0, align: q.x ? (q.x < 0 ? 'right' : 'left') : 'center' });
      }
    }
    // a .subckt pin with no room for its arrow at a pin or a dot (Eric's ota5t: vout runs drain to drain, both
    // pins point into that one wire): a T on the net's own vertical wire, a contact dot, the arrow on a
    // horizontal stub; the wire is split at the dot (two wires, same net)
    if (opts.port && !cands.some((c) => c.port)) {
      for (const e of cells.filter((x) => x.kind === 'edge' && gids.has(groups.get(x.id)))) {
        const pl = polylineOf(e, byId) || [];
        for (let i = 1; i < pl.length; i++) {
          const [u, v] = [pl[i - 1], pl[i]];
          if (Math.abs(u.x - v.x) >= 1 || Math.abs(u.y - v.y) < 60) continue;
          const y0 = Math.min(u.y, v.y) + 20, y1 = Math.max(u.y, v.y) - 20, ym = Math.round((u.y + v.y) / 2);
          const ys = [ym]; for (let t = 10; ym - t >= y0 || ym + t <= y1; t += 10) { if (ym - t >= y0) ys.push(ym - t); if (ym + t <= y1) ys.push(ym + t); }
          for (const y of ys) for (const sg of [1, -1]) for (const b of [30, 45, 60]) {
            const p = { x: u.x, y }, k = { x: u.x + sg * b, y };
            const r = { x: sg < 0 ? k.x - pb.w : k.x, y: y - pb.h / 2, w: pb.w, h: pb.h }, rr = { x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 };
            const along = []; for (let t = 6; t <= b; t += 2) along.push({ x: p.x + sg * t, y });
            const dot = (q) => ({ x: q.x - 0.5, y: q.y - 0.5, w: 1, h: 1 });
            if (boxes.some((bx) => hit(rr, bx) || along.some((q) => hit(dot(q), bx)))) continue;
            if (segs.some(([a2, b2]) => hit(rr, segBox(a2, b2, 0.5)) || along.some((q) => hit(dot(q), segBox(a2, b2, 0.5))))) continue;
            cands.push({ len: 500 + b + Math.abs(y - ym) / 10, port: true, side: sg, tap: { e, i, pl }, o: null, p, k, e: k, r,
              pin: sg < 0 ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 }, bent: false, align: sg < 0 ? 'right' : 'left' });
          }
        }
      }
    }
    if (!cands.length) {
      // no free place for a label: the name goes on one of the net's wires (it names the net, lib/netlist.js)
      // the wire whose middle (where drawio prints the name) is farthest from a dot or a pin: a name printed on
      // a junction is unreadable (Eric's ota5t: vtail written over the tail's T, 08.11)
      const mid = (e) => { const pl = polylineOf(e, byId) || []; let L = 0; for (let i = 1; i < pl.length; i++) L += Math.abs(pl[i].x - pl[i - 1].x) + Math.abs(pl[i].y - pl[i - 1].y);
        let h = L / 2; for (let i = 1; i < pl.length; i++) { const d = Math.abs(pl[i].x - pl[i - 1].x) + Math.abs(pl[i].y - pl[i - 1].y); if (h <= d) { const t = d ? h / d : 0; return { x: pl[i - 1].x + (pl[i].x - pl[i - 1].x) * t, y: pl[i - 1].y + (pl[i].y - pl[i - 1].y) * t }; } h -= d; } return pl[0]; };
      const spots = [...cells.filter((c) => c.kind === 'vertex' && c.x != null && classify(c).role === 'junction').map((j) => ({ x: j.x + j.w / 2, y: j.y + j.h / 2 })), ...pinAt];
      const room = (e) => { const q = mid(e); return q ? Math.min(Infinity, ...spots.map((u) => Math.hypot(u.x - q.x, u.y - q.y))) : -1; };
      const wire = netWires.filter((e) => !e.value).sort((a, b) => room(b) - room(a))[0];
      if (wire) { updateCell(m, wire.id, { value: net }); out.push({ net, at: wire.id, clear: false, on: 'wire' }); continue; }
      // review r4 (1): no free spot, no free wire: the label is POSED all the same, straight out of the net's
      // first pin (or dot), over whatever is there (clear: false); only a net with no pin and no dot on page 1
      // stays unnamed ('none'), and the two-page LVS then refuses the drawing
      const o = origins[0];
      if (!o) { out.push({ net, at: null, clear: false, on: 'none' }); continue; }
      const d = o.dirs[0], k = { x: o.p.x + d.x * 25, y: o.p.y + d.y * 25 };
      cands.push({ len: 25, port: false, side: d.x, o, p: o.p, k, e: k, bent: false, forced: true,
        r: d.x ? { x: d.x < 0 ? k.x - tw : k.x, y: k.y - th / 2, w: tw, h: th } : { x: k.x - tw / 2, y: d.y < 0 ? k.y - th : k.y, w: tw, h: th },
        pin: d.x ? (d.x < 0 ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 }) : (d.y < 0 ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 }),
        align: d.x ? (d.x < 0 ? 'right' : 'left') : 'center' });
    }
    cands.sort((a, b) => a.len - b.len);
    const c = cands[0];
    let style = PORT_TEXT(c.align), tpin = c.pin;
    // drawio turns the anchors with direction=west: the pin named in the unturned frame (lib/place-manuel.js)
    if (c.port) { const ps = portStyleFor(net, c.side); style = ps.style; if (ps.west) tpin = { x: 1 - c.pin.x, y: c.pin.y }; }
    if (c.tap) { c.o = tapWire(m, c.tap, c.p); boxes.push({ id: c.o.id, x: c.p.x - 3, y: c.p.y - 3, w: 6, h: 6 }); }
    const lbl = addVertex(m, { id: freshId(m, c.port ? 'P_' : 'NL_'), style, x: c.r.x, y: c.r.y, w: c.r.w, h: c.r.h, value: net });
    addWire(m, { source: c.o.id, target: lbl.getAttribute('id'), sourcePin: c.o.pin, targetPin: tpin, style: STUB, ...(c.bent ? { points: [c.k] } : {}) });
    boxes.push({ id: lbl.getAttribute('id'), ...c.r }); segs.push([c.p, c.k], [c.k, c.e]);
    out.push({ net, at: c.o.id, clear: !c.forced, on: c.port ? 'port' : 'label' });
  }
  return out;
}

/** split edge `e` at point `p` of its segment `i` (polyline `pl`) with a contact dot -> the dot as a stub origin */
function tapWire(m, { e, i, pl }, p) {
  const J = addVertex(m, { id: freshId(m, 'JT_'), style: 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;contactDot=1;', x: p.x - 3, y: p.y - 3, w: 6, h: 6, value: '' });
  const jid = J.getAttribute('id'), mid = { x: 0.5, y: 0.5 };
  const bare = String(e.styleRaw || '').split(';').filter((kv) => kv && !/^(exit|entry)(X|Y|Dx|Dy|Perimeter|Name)=/.test(kv)).join(';') + ';';
  const pinOf = (pre) => { const x = e.style.map.get(pre + 'X'), y = e.style.map.get(pre + 'Y'); if (x == null || y == null) return undefined;
    const n = e.style.map.get(pre + 'Name'); return { x: +x, y: +y, ...(n != null ? { name: n } : {}) }; };
  const sp = pinOf('exit'), tp = pinOf('entry');
  deleteCell(m, e.id);
  addWire(m, { source: e.source, target: jid, sourcePin: sp, targetPin: mid, style: bare, points: pl.slice(1, i) });
  addWire(m, { source: jid, target: e.target, sourcePin: mid, targetPin: tp, style: bare, points: pl.slice(i, -1) });
  return { id: jid, pin: mid, own: jid, p };
}

/** a name page 1 could not print at all (no pin, no dot of that net to hang it on), said, never silent. For a
 *  page-2 name the two-page LVS also refuses the drawing (review r4); for a .subckt pin it is a warning. */
export const unnamedWarnings = (labelled) => labelled.filter((l) => l.on === 'none')
  .map((l) => `net ${l.net}: not named on page 1 (no pin or dot of that net to hang its name on)`);

/** the nets of page 1 (the netlist without its dummies) */
export const page1NetsOf = (split) => new Set(split.main.components.flatMap((c) => c.fullNodes || c.nodes));

/** Page 2 drawn and checked for an import, ALWAYS (Orchestrator decision 08.11: every drawing has its page 2,
 *  "Aucun factice" when the netlist has none); page 1 gets the labels of the nets page 2 names (N1). */
export async function dummiesForImport(doc, split, full) {
  if (!split.dummies.length && !split.parasitics?.length) {
    for (const d of Array.from(doc.getElementsByTagName('diagram'))) if (d.getAttribute('name') === DUMMY_PAGE) d.parentNode.removeChild(d);
    addPage(doc, DUMMY_PAGE);
    addVertex(getPage(doc, DUMMY_PAGE), { id: 'NO_DUMMY', style: 'text;html=1;align=left;verticalAlign=middle;fontSize=12;fontStyle=2;', x: 40, y: 40, w: 160, h: 20, value: 'Aucun factice' });
    return { page: DUMMY_PAGE, count: 0, groups: [], detected: [], labelled: [], lvs: lvsTwoPages(doc, split, full) };
  }
  await drawDummiesPage(doc, split, page1NetsOf(split));
  const named2 = extractNetlist(getPage(doc, DUMMY_PAGE)).namedNets || [];
  const labelled = labelSharedOnPage1(doc, split, named2.filter((n) => page1NetsOf(split).has(n)));
  // test hook (review r3, D10): one wire of page 2 taken away, so the import's page-2 gate is exercised for real
  if (process.env.DRAWIO_TEST_FAULT === 'dummies-page') {
    const w = allCells(getPage(doc, DUMMY_PAGE)).find((el) => el.getAttribute('edge') === '1');
    if (w) w.parentNode.removeChild(w);
  }
  // test hook (review r4, W1/W2): every print of one shared name erased from page 1 (its labels, ports, wire
  // texts), so the name check of the two-page LVS, the 422 and the warning line are exercised end to end
  if (process.env.DRAWIO_TEST_FAULT === 'page1-name') {
    const n = named2.find((x) => page1NetsOf(split).has(x) && x !== '0'), m1 = getPage(doc, 0);
    for (const el of allCells(m1)) {
      const c = cellInfo(el);
      if (String(c.value || '').trim() !== n) continue;
      if (c.kind === 'edge') updateCell(m1, c.id, { value: '' });
      else if (classify(c).role === 'port') {
        for (const e of allCells(m1).map(cellInfo).filter((e) => e.kind === 'edge' && (e.source === c.id || e.target === c.id))) deleteCell(m1, e.id);
        deleteCell(m1, c.id);
      }
    }
  }
  const lvs = lvsTwoPages(doc, split, full);
  const count = split.dummies.reduce((n, x) => n + (Number(x.c.params?.m ?? 1) || 1), 0);
  const np = split.parasitics?.length || 0;
  return { page: DUMMY_PAGE, count, parasitics: (split.parasitics || []).map((c) => c.ref),
    groups: [...split.groups.map((g) => g.title), ...(np ? [PARASITIC_TITLE] : [])],
    detected: split.dummies.map((x) => ({ ref: x.c.ref, why: x.why })), labelled, lvs,
    ...(lvs.unnamed?.length ? { warnings: lvs.unnamed.map((n) => `net ${n}: named on page 2 but not on page 1 (the pages join by name)`) } : {}),
    warning: [count ? `${count} factices` : '', np ? `${np} capacité${np > 1 ? 's' : ''} parasite${np > 1 ? 's' : ''}` : ''].filter(Boolean).join(' et ') + ' sur la page 2' };
}
