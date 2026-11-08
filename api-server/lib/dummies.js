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
 * A dummy is
 *   - a MOS marked `dummy=1` on its line (the layout3d format, agreed 08.11: `XM7 vss vss vss vss sg13_lv_nmos
 *     w=1u l=0.13u dummy=1`), or
 *   - a MOS whose drain, gate and source are one net, or
 *   - a MOS that is always off: its gate tied to its own off rail (NMOS gate on a negative supply / ground,
 *     PMOS gate on a positive supply).
 * A MOS capacitor (gate on a signal, drain and source on a rail) is not a dummy.
 * The device a dummy protects: the non-dummy MOS that shares a channel net with it, else the non-dummy MOS of
 * the same model and size (the array it ends), else none ("factices").
 */
import { addPage, getPage } from './model.js';
import { SPICE_MAP } from './components.js';
import { getShape } from './stencils.js';
import { supplyPolarity } from './supply-orient.js';
import { extractNetlist } from './netlist.js';
import { compare } from './lvs.js';
import { groundMapper } from './ground-alias.js';
import { annotation, Sheet, emit as emitSheets, placeTr, portVert, tapGnd, tapVdd } from './place-manuel.js';

export const DUMMY_PAGE = 'factices';
const isMos = (c) => c.prefix === 'M' && (c.nodes || []).length >= 3;
const isP = (c) => /pmos|pfet|pch/i.test(String(c.model || c.value || ''));
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
  const dSet = new Set(dummies.map((x) => x.c.ref));
  const main = parsed.components.filter((c) => !dSet.has(c.ref));
  if (!dummies.length || !main.length) return { main: parsed, dummies: [], groups: [] };
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
  return { main: { ...parsed, components: main }, dummies, groups: [...groups.values()], dummyParsed: { ...parsed, components: dummies.map((x) => x.c) } };
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
    const local = nets.filter((n) => !neg(n) && !pos(n) && !page1Nets.has(n));
    const posR = nets.filter(pos), negR = nets.filter(neg);
    const lab = 25 + 8 * Math.max(4, ...nets.filter((n) => page1Nets.has(n) && !neg(n) && !pos(n)).map((n) => n.length)) + 12;
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
        if (page1Nets.has(n) && !neg(n) && !pos(n)) {
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
      if (local.includes(n)) { if (hi > lo) S.path(n, { x: lo, y: busY(n) }, { x: hi, y: busY(n) }); continue; }
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
  emitSheets(model, sheets, split.dummyParsed, rails);
  return model;
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
  return compare(merged, full);
}

/** the nets of page 1 (the netlist without its dummies) */
export const page1NetsOf = (split) => new Set(split.main.components.flatMap((c) => c.fullNodes || c.nodes));

/** Page 2 drawn and checked for an import: null when the netlist has no dummy, else what the response says. */
export async function dummiesForImport(doc, split, full) {
  if (!split.dummies.length) return null;
  await drawDummiesPage(doc, split, page1NetsOf(split));
  const lvs = lvsTwoPages(doc, split, full);
  const count = split.dummies.reduce((n, x) => n + (Number(x.c.params?.m ?? 1) || 1), 0);
  return { page: DUMMY_PAGE, count, groups: split.groups.map((g) => g.title),
    detected: split.dummies.map((x) => ({ ref: x.c.ref, why: x.why })), lvs, warning: `${count} factices sur la page 2` };
}
