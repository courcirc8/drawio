/**
 * place2.js — placement « à la main » : les composants sont organisés en
 * PILES DE CONDUCTION verticales (chemins VDD → masse), comme un designer
 * dessine un schéma analogique :
 *   - graphe de conduction : chaque dipôle/MOS a un terminal « haut » (source
 *     PMOS, drain NMOS, in des passifs) et « bas » ; on suit les nets depuis
 *     VDD vers la masse → chaque chemin devient une colonne, ses éléments
 *     empilés et ALIGNÉS verticalement ;
 *   - les fan-outs allouent des colonnes adjacentes ; un élément partagé par
 *     plusieurs colonnes (queue de paire diff) est centré sous elles ;
 *   - les gates sont des connexions transverses (fils horizontaux) ; les
 *     entrées gate-seulement reçoivent un port à gauche du transistor ;
 *   - taps VDD au sommet de chaque pile, masses sous chaque pied, jonctions
 *     aux nets >2 terminaux, condensateurs flottants placés entre colonnes.
 * Paramètres exposés dans `opts` pour la boucle d'optimisation.
 */
import { addVertex, addWire, updateCell, httpError } from './model.js';
import { SPICE_MAP, PIN_ORDER_OVERRIDES, GROUND_SHAPE, GROUND_PIN } from './components.js';
import { getShape, getPin } from './stencils.js';
import { pinAbs } from './route.js';
import { detectStructures } from './patterns.js';

const JCT = 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;';
const VDD_TAP = 'mxgraph.electrical.signal_sources.vss2';
const PORT = 'mxgraph.electrical.signal_sources.equipotential';

const DEF = { colW: 190, rowH: 180, x0: 140, y0: 130, order: [], flip: {} };

function isPmos(c) {
  return (c.prefix === 'M' && /pmos|pfet|pch/i.test(c.model || '')) ||
         (c.prefix === 'Q' && /pnp/i.test(c.model || ''));
}

/** terminaux haut/bas dans le sens de conduction + shape/pins par composant */
export function condInfo(c) {
  const map = SPICE_MAP[c.prefix];
  if (c.prefix === 'M' || c.prefix === 'Q') {
    const pmos = isPmos(c);
    const variants = map.variants || {};
    const shapeKey = pmos ? (variants.PMOS || variants.PNP || map.shape) : map.shape;
    const po = PIN_ORDER_OVERRIDES[shapeKey] || map.pinOrder;
    // nodes = [D,G,S] ; conduction PMOS: S(top)->D(bas) ; NMOS: D(top)->S(bas)
    return { shapeKey, po, top: pmos ? c.nodes[2] : c.nodes[0], bot: pmos ? c.nodes[0] : c.nodes[2],
      topPin: po[pmos ? 2 : 0], botPin: po[pmos ? 0 : 2], gate: c.nodes[1], gatePin: po[1] };
  }
  if ('RCLVID'.includes(c.prefix)) {
    const shapeKey = map.shape;
    return { shapeKey, po: map.pinOrder, top: c.nodes[0], bot: c.nodes[1],
      topPin: map.pinOrder[0], botPin: map.pinOrder[1] };
  }
  return null;
}

export function wireNets(model, { comps, info, placed, netTerms, vddNet, P }) {
  const wires = [];
  const wire = (a, b) => wires.push(addWire(model, a === null ? b : a).getAttribute('id'));
  let seq = 0;

  // rails : tap VDD au-dessus de chaque terminal du net vdd ; masse sous chaque terminal de 0
  for (const [net, terms] of netTerms) {
    if (net === vddNet && vddNet !== '0') {
      for (const t of terms) {
        const p = placed.get(t.ref);
        const abs = pinAbs(p, t.pin);
        const id = 'VT' + (++seq);
        // position ancrée sur le PIN ABSOLU (les formes tournées ont leur pin
        // ailleurs que le haut de leur bbox) + écart franc de 30 px
        addVertex(model, { id, shape: VDD_TAP, x: abs.x - 20, y: abs.y - 26 - 30, w: 40, h: 26, value: 'VDD' });
        wire(null, { source: t.ref, target: id, sourcePin: { x: t.pin.x, y: t.pin.y }, targetPin: { x: 0.5, y: 1 } });
      }
    } else if (net === '0') {
      for (const t of terms) {
        const p = placed.get(t.ref);
        const abs = pinAbs(p, t.pin);
        const id = 'GND' + (++seq);
        // masse LOCALE : juste sous le pin (comme le petit trait des figures
        // publiées), jamais un long rail vers une ligne de fond commune
        addVertex(model, { id, shape: GROUND_SHAPE, x: abs.x - 15, y: abs.y + 45, w: 30, h: 20 });
        const gp = getPin(GROUND_SHAPE, GROUND_PIN);
        wire(null, { source: t.ref, target: id, sourcePin: { x: t.pin.x, y: t.pin.y }, targetPin: { x: gp.x, y: gp.y } });
      }
    }
  }

  // nets de signal
  for (const [net, terms] of netTerms) {
    if (net === vddNet || net === '0') continue;
    if (terms.length === 1) {
      // entrée/sortie : port
      const t = terms[0];
      const p = placed.get(t.ref);
      const abs = pinAbs(p, t.pin);
      const id = 'P_' + net.replace(/[^A-Za-z0-9]/g, '_');
      if (t.pin.y === 0 && t.pin.x > 0.25 && t.pin.x < 0.75) {
        const cellUp = addVertex(model, { id, shape: PORT, x: abs.x - 12, y: abs.y - 70, w: 24, h: 24, value: net.toUpperCase() });
        cellUp.setAttribute('style', cellUp.getAttribute('style') + 'flipV=1;verticalLabelPosition=top;verticalAlign=bottom;');
        placed.set(id, { id, x: abs.x - 12, y: abs.y - 70, w: 24, h: 24, rotation: 0, flipV: true });
        wire(null, { source: id, target: t.ref, sourcePin: { x: 0.5, y: 0 }, targetPin: { x: t.pin.x, y: t.pin.y } });
        continue;
      }
      const leftish = (t.pin.x <= 0.5) !== !!p.flipH;
      let px = abs.x + (leftish ? -80 : 56), py = abs.y + 36;
      const clash = () => [...placed.values()].some((v) =>
        px < v.x + v.w + 8 && px + 24 > v.x - 8 && py < v.y + v.h + 8 && py + 24 > v.y - 8);
      for (let k = 0; k < 6 && clash(); k++) { px += leftish ? -60 : 60; }
      for (let k = 0; k < 6 && clash(); k++) { py += 50; }
      addVertex(model, { id, shape: PORT, x: px, y: py, w: 24, h: 24, value: net.toUpperCase() });
      placed.set(id, { id, x: px, y: py, w: 24, h: 24, rotation: 0 });
      wire(null, { source: id, target: t.ref, sourcePin: { x: 0.5, y: 0 }, targetPin: { x: t.pin.x, y: t.pin.y } });
    } else if (terms.length === 2) {
      const [a, b] = terms;
      wire(null, { source: a.ref, target: b.ref, sourcePin: { x: a.pin.x, y: a.pin.y }, targetPin: { x: b.pin.x, y: b.pin.y } });
    } else {
      // diode-connectée sur ce net : petit fil direct gate->drain (comme les
      // figures publiées), et seul le DRAIN participe à l'étoile
      const seen = new Map();
      for (const t of [...terms]) {
        if (!seen.has(t.ref)) { seen.set(t.ref, t); continue; }
        const other = seen.get(t.ref);
        // liaison diode : L EXTÉRIEUR au corps (waypoints explicites — le
        // renderer dessine sinon une diagonale à travers le transistor)
        const pc2 = placed.get(t.ref);
        const gate = t.pin.x === 0 ? t : other;
        const drain = gate === t ? other : t;
        const g = pinAbs(pc2, gate.pin), dr = pinAbs(pc2, drain.pin);
        const left = g.x <= pc2.x + pc2.w / 2;
        const ox = left ? Math.min(g.x, pc2.x) - 16 : Math.max(g.x, pc2.x + pc2.w) + 16;
        const top = dr.y <= pc2.y + pc2.h / 2;
        const oy = top ? pc2.y - 14 : pc2.y + pc2.h + 14;
        wire(null, { source: t.ref, target: t.ref,
          sourcePin: { x: gate.pin.x, y: gate.pin.y }, targetPin: { x: drain.pin.x, y: drain.pin.y },
          points: [{ x: ox, y: g.y }, { x: ox, y: oy }, { x: dr.x, y: oy }] });
        const idx = terms.indexOf(gate);
        if (idx >= 0) terms.splice(idx, 1);
      }
      const pts = terms.map((t) => pinAbs(placed.get(t.ref), t.pin));
      // S1' : point MÉDIAN = optimum L1 exact pour un branchement unique
      // (esprit HyperedgeRerouter de libavoid, non exporté par le bundle)
      const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor((a.length - 1) / 2)]; };
      let cx = med(pts.map((q) => q.x)), cy = med(pts.map((q) => q.y));
      let snap = { x: cx, y: cy };
      const gateCount = terms.filter((t) => {
        const c = comps.find((k) => k.ref === t.ref);
        return c != null && (c.prefix === 'M' || c.prefix === 'Q') && info.get(c.ref).gatePin === t.pinName;
      }).length;
      const nCols = new Set(pts.map((q) => Math.round((q.x - P.x0) / P.colW))).size;
      const isBus = gateCount >= 2 && nCols >= 3;
      // axe vertical dominant (pile) : si >=2 pins partagent le même x,
      // la jonction reste SUR cet axe, entre eux
      const byX = new Map();
      for (const q of pts) {
        const key = Math.round(q.x / 5) * 5;
        if (!byX.has(key)) byX.set(key, []);
        byX.get(key).push(q);
      }
      const axis = [...byX.entries()].find(([, l]) => l.length >= 2);
      if (axis != null && !isBus) {
        const ys = axis[1].map((q) => q.y).sort((a, b) => a - b);
        snap = { x: axis[1][0].x, y: 0 };
        cy = (ys[0] + ys[ys.length - 1]) / 2;
      } else if (!isBus) {
        // axe horizontal dominant (ligne de chaîne) : dot SUR la ligne, au
        // droit du pin hors-ligne
        const byY = new Map();
        for (const q of pts) {
          const key = Math.round(q.y / 5) * 5;
          if (!byY.has(key)) byY.set(key, []);
          byY.get(key).push(q);
        }
        const yAxis = [...byY.entries()].find(([, l]) => l.length >= 2);
        if (yAxis != null) {
          const off = pts.find((q) => Math.round(q.y / 5) * 5 !== yAxis[0]);
          snap = { x: (off || pts[0]).x, y: 0 };
          cy = yAxis[1][0].y;
        }
      }
      // net de miroir NON-bus : jonction ancrée sur le drain de la diode
      const diode = (isBus || axis != null) ? null : comps.find((k) => (k.prefix === 'M' || k.prefix === 'Q') &&
        k.nodes[0] === net && k.nodes[1] === net && placed.has(k.ref));
      if (diode != null) {
        const di = info.get(diode.ref);
        const dpin = getPin(di.shapeKey, di.po[0]);
        const dabs = pinAbs(placed.get(diode.ref), dpin);
        const p = placed.get(diode.ref);
        snap = dabs;
        cy = isPmos(diode) ? p.y + p.h + 28 : p.y - 28;
      }
      let jy = isBus ? Math.max(...pts.map((q) => q.y)) + 55 : cy;
      {
        // jamais dans un corps de composant (bus compris)
        const boxes = [...placed.values()].filter((v) => Math.abs((v.x + v.w / 2) - snap.x) < v.w);
        const inBox = (yy) => boxes.some((v) => yy > v.y - 8 && yy < v.y + v.h + 8);
        if (inBox(jy)) {
          const base = jy;
          for (let d = 10; d < 400; d += 10) {
            if (!inBox(base + d)) { jy = base + d; break; }
            if (!isBus && !inBox(base - d)) { jy = base - d; break; }
          }
        }
      }
      const id = 'J_' + net.replace(/[^A-Za-z0-9]/g, '_');
      const hint = P.junctionHint != null ? P.junctionHint.get(id) : null;
      if (hint != null) { snap = { x: hint.x + 3, y: 0 }; jy = hint.y + 3; }
      const span = Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x));
      if (terms.length >= 4 && span > (P.colW || 190) * 1.5 && hint == null) {
        // BUS : tronc horizontal à 2 jonctions (comme la ligne vb des papiers),
        // chaque terminal se raccorde à la jonction de son côté
        const sorted = [...terms].map((t, i) => ({ t, x: pts[i].x })).sort((a, b) => a.x - b.x);
        const half = Math.ceil(sorted.length / 2);
        const left = sorted.slice(0, half), right = sorted.slice(half);
        const med = (arr) => { const a = arr.map((e) => e.x).sort((x, y) => x - y); return a[Math.floor((a.length - 1) / 2)]; };
        const id2 = id + '_2';
        addVertex(model, { id, style: JCT, x: med(left) - 3, y: jy - 3, w: 6, h: 6 });
        addVertex(model, { id: id2, style: JCT, x: med(right) - 3, y: jy - 3, w: 6, h: 6 });
        wire(null, { source: id, target: id2 });
        for (const e of left) wire(null, { source: e.t.ref, target: id, sourcePin: { x: e.t.pin.x, y: e.t.pin.y } });
        for (const e of right) wire(null, { source: e.t.ref, target: id2, sourcePin: { x: e.t.pin.x, y: e.t.pin.y } });
        continue;
      }
      addVertex(model, { id, style: JCT, x: snap.x - 3, y: jy - 3, w: 6, h: 6 });
      for (const t of terms) {
        wire(null, { source: t.ref, target: id, sourcePin: { x: t.pin.x, y: t.pin.y } });
      }
    }
  }

  return wires;
}

export function importNetlist2(model, parsed, opts = {}) {
  const P = { ...DEF, ...opts };
  const comps = parsed.components;
  if (comps.length === 0) throw httpError(400, 'netlist vide');
  const info = new Map(comps.map((c) => [c.ref, condInfo(c)]));
  const unplaced = new Set(comps.map((c) => c.ref));
  const byTopNet = new Map();
  for (const c of comps) {
    const ci = info.get(c.ref);
    if (ci == null) continue;
    if (!byTopNet.has(ci.top)) byTopNet.set(ci.top, []);
    byTopNet.get(ci.top).push(c);
  }
  // net d'alimentation : 'vdd' explicite sinon net avec le plus de "tops"
  let vddNet = [...byTopNet.keys()].find((n) => /^vdd$/i.test(n));
  if (vddNet == null) {
    let best = 0;
    for (const [n, l] of byTopNet) if (n !== '0' && l.length > best) { best = l.length; vddNet = n; }
  }

  // ---- construction des piles (DFS depuis vdd, fan-out -> colonnes sœurs)
  // slot: {ref, col, level} ; shared: éléments à top multiple (queues) traités après
  const slots = new Map();
  let nextCol = 0;
  const colOf = new Map(); // ref -> [cols] pour centrage des partagés
  // passifs flottants : R/C/L entre deux nets de signal (ni VDD ni 0) -> hors piles
  const floating = new Set();

  // nets de conduction MOS (drain/source)
  const dsNets = new Set();
  for (const c of comps) {
    if (c.prefix !== 'M' && c.prefix !== 'Q') continue;
    const ci = info.get(c.ref);
    if (ci != null) { dsNets.add(ci.top); dsNets.add(ci.bot); }
  }

  function markFloating(vdd) {
    // un L ou R touchant un net de conduction fait partie d'une pile ;
    // seuls les C (bloquants DC) et les L/R purement « signal » sont flottants
    for (const c of comps) {
      const ci = info.get(c.ref);
      if (ci == null || !'RCL'.includes(c.prefix)) continue;
      if (ci.top === vdd || ci.top === '0' || ci.bot === vdd || ci.bot === '0') continue;
      if (c.prefix !== 'C' && (dsNets.has(ci.top) || dsNets.has(ci.bot))) continue;
      floating.add(c.ref);
      unplaced.delete(c.ref);
    }
  }

  function place(ref, col, level) {
    slots.set(ref, { col, level });
    unplaced.delete(ref);
    const ci = info.get(ref);
    const below = (byTopNet.get(ci.bot) || []).filter((c) => unplaced.has(c.ref));
    // ne descendre que si le net du bas n'est pas un rail
    if (ci.bot === '0' || ci.bot === vddNet) return;
    const parentsOf = (net) => comps.filter((k) => {
      const ki = info.get(k.ref);
      return ki != null && ki.bot === net;
    }).length;
    // diode de polarisation accrochée au net (D=G=net, S=0) : accolée à
    // CÔTÉ du nœud, pas dans une colonne de conduction (règle E1/Fig.13)
    const sideDiodes = below.filter((c) => (c.prefix === 'M' || c.prefix === 'Q') &&
      c.nodes[0] === c.nodes[1] && info.get(c.ref).bot === '0');
    for (const d of sideDiodes) {
      slots.set(d.ref, { col: col - 0.55, level: level + 0.55 });
      unplaced.delete(d.ref);
    }
    const rest = below.filter((c) => !sideDiodes.includes(c));
    const shared = rest.filter((c) => parentsOf(info.get(c.ref).top) > 1);
    const solo = rest.filter((c) => !shared.includes(c));
    let solo2 = solo;
    const co = (P.childOrder || {})[ci.bot];
    if (co != null) {
      solo2 = [...solo].sort((a, b) => {
        const ia = co.indexOf(a.ref), ib = co.indexOf(b.ref);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    }
    let k = 0;
    for (const c of solo2) {
      place(c.ref, k === 0 ? col : nextCol++, level + 1);
      k++;
    }
    for (const c of shared) {
      // partagé (ex: queue de paire diff) : noter, placé en phase 2
      if (!colOf.has(c.ref)) colOf.set(c.ref, []);
      colOf.get(c.ref).push(col);
    }
  }

  markFloating(vddNet);
  const structures = detectStructures(parsed);
  // ---- chaînes de signal : suites d'éléments série (passifs flottants)
  //      aboutissant à une gate ; posées horizontalement dans l'ordre du flux,
  //      dérivations shunt vers la masse en bas, branches de polarisation en
  //      haut, source V terminale en bas à gauche (règle E1, LNA Fig.13)
  const chains = []; // {anchorRef, anchorPinName, elems:[{c, hangers:[{c, up}]}], endV}
  const chainRefs = new Set();
  {
    const onNet = (net) => comps.filter((k) => k.nodes.includes(net));
    const otherNet = (c, net) => {
      const ci = info.get(c.ref);
      return ci.top === net ? ci.bot : ci.top;
    };
    for (const dev of comps) {
      if (dev.prefix !== 'M' && dev.prefix !== 'Q') continue;
      const ci = info.get(dev.ref);
      let net = ci.gate;
      if (net === '0' || net === vddNet || dsNets.has(net)) continue;
      const elems = [];
      let endV = null;
      let guard2 = comps.length + 2;
      while (guard2-- > 0) {
        const cands = onNet(net).filter((k) => floating.has(k.ref) &&
          !chains.some((ch) => ch.elems.some((e) => e.c === k)) &&
          !elems.some((e) => e.c === k));
        if (cands.length === 0) {
          // source V terminale ?
          const v = onNet(net).find((k) => k.prefix === 'V' && unplaced.has(k.ref));
          if (v != null) endV = v;
          break;
        }
        // série = le candidat dont l'autre net continue (ou le premier)
        const next = cands.find((k) => {
          const on = otherNet(k, net);
          return on !== '0' && on !== vddNet;
        }) || cands[0];
        const hangers = [];
        for (const h of cands) {
          if (h === next) continue;
          hangers.push({ c: h, up: otherNet(h, net) !== '0' });
        }
        // shunts rail-connectés sur le net (ex: C d'adaptation vers la masse)
        for (const h of onNet(net)) {
          if (!unplaced.has(h.ref) || !'RCL'.includes(h.prefix)) continue;
          if (hangers.some((g) => g.c === h)) continue;
          const on = otherNet(h, net);
          if (on === '0' || on === vddNet) hangers.push({ c: h, up: on === vddNet, shunt: true });
        }
        // dérivations non-flottantes déjà en piles (ex: shunt C vers 0)
        elems.push({ c: next, hangers, net });
        net = otherNet(next, net);
        if (net === '0' || net === vddNet) break;
      }
      if (elems.length >= 2 || (elems.length >= 1 && endV != null)) {
        chains.push({ anchorRef: dev.ref, elems, endV });
        for (const e of elems) {
          floating.delete(e.c.ref);
          chainRefs.add(e.c.ref);
          for (const h of e.hangers) {
            floating.delete(h.c.ref);
            unplaced.delete(h.c.ref);
            chainRefs.add(h.c.ref);
          }
        }
        if (endV != null) { unplaced.delete(endV.ref); chainRefs.add(endV.ref); }
      }
    }
  }

  let roots = (byTopNet.get(vddNet) || []).map((c) => c.ref);
  // heuristique : la pile de polarisation (source de courant en racine) à gauche
  roots.sort((a, b) => (comps.find((c) => c.ref === b).prefix === 'I' ? 1 : 0) -
                       (comps.find((c) => c.ref === a).prefix === 'I' ? 1 : 0));
  if (P.order.length) roots = P.order.filter((r) => roots.includes(r)).concat(roots.filter((r) => !P.order.includes(r)));
  for (const r of roots) if (unplaced.has(r)) place(r, nextCol++, 0);

  // éléments partagés : centrés sous leurs colonnes, un niveau sous le plus profond
  const sharedParents = new Map(); // ref -> cols parents (pour re-calcul après permutation)
  let guard = comps.length;
  while (colOf.size && guard-- > 0) {
    for (const [ref, cols] of [...colOf]) {
      if (!unplaced.has(ref)) { colOf.delete(ref); continue; }
      const deepest = Math.max(...cols.map((cl) =>
        Math.max(...[...slots.values()].filter((s) => s.col === cl).map((s) => s.level))));
      const mid = cols.reduce((a, b) => a + b, 0) / cols.length;
      sharedParents.set(ref, [...cols]);
      place(ref, mid, deepest + 1);
      colOf.delete(ref);
    }
  }
  // paires différentielles / cross-couplées : MÊME RANGÉE obligatoirement
  // (règle humaine), queue recentrée sous le milieu de la paire
  for (const pr of [...structures.diffPairs, ...structures.crossCoupled]) {
    const [ra, rb] = pr.refs;
    const sa = slots.get(ra), sb = slots.get(rb);
    if (sa == null || sb == null || sa.level === sb.level) continue;
    const L = Math.min(sa.level, sb.level);
    sa.level = L; sb.level = L;
  }
  for (const t of structures.tails) {
    const st = slots.get(t.ref);
    const [pa, pb] = t.pair.map((r) => slots.get(r));
    if (st == null || pa == null || pb == null) continue;
    st.col = (pa.col + pb.col) / 2;
    st.level = Math.max(pa.level, pb.level) + 1;
  }
  // règle 26 : les transistors d'un même MIROIR partagent la rangée (la plus
  // profonde du groupe) — gates sur un bus rectiligne, comme un dessin humain
  for (const mg of structures.mirrors) {
    const ss = mg.refs.map((r) => slots.get(r)).filter(Boolean);
    if (ss.length < 2) continue;
    const L = Math.max(...ss.map((x) => x.level));
    for (const x of ss) x.level = L;
  }

  // reste (sources V vers masse, branches isolées) : colonnes à gauche
  for (const c of comps) {
    if (!unplaced.has(c.ref)) continue;
    if (info.get(c.ref) == null) continue;
    place(c.ref, -1 - [...slots.values()].filter((s) => s.col < 0).length, 0);
  }
  // éléments mappés sans conduction (G/OTA…) : colonnes de flux à droite
  for (const c of comps) {
    if (!unplaced.has(c.ref) || SPICE_MAP[c.prefix] == null) continue;
    slots.set(c.ref, { col: nextCol++, level: 0 });
    unplaced.delete(c.ref);
  }

  // ---- regroupement de colonnes par structures (paires adjacentes,
  //      miroirs adjacents diode en tête)
  {
    const colOfRef = (ref) => {
      const sl = slots.get(ref);
      return sl != null && Number.isInteger(sl.col) ? sl.col : null;
    };
    const intCols = [...new Set([...slots.values()].map((s) => s.col).filter(Number.isInteger))].sort((a, b) => a - b);
    // union-find de colonnes à coller
    const parent = new Map(intCols.map((c) => [c, c]));
    const find = (c) => { while (parent.get(c) !== c) c = parent.get(c); return c; };
    const union = (a, b) => { if (a != null && b != null) parent.set(find(a), find(b)); };
    const firstOf = new Map(); // cluster -> colonne à mettre en tête (diode de miroir)
    for (const m of structures.mirrors) {
      // ne coller que les miroirs de CHARGE : tous les membres au même niveau
      // (les miroirs de distribution de bias traversent le schéma — les
      // regrouper casserait le flux du signal)
      const lvls = m.refs.map((r) => slots.get(r)).filter(Boolean).map((sl) => sl.level);
      if (new Set(lvls).size !== 1) continue;
      const cols = m.refs.map(colOfRef).filter((c) => c != null);
      for (let i = 1; i < cols.length; i++) union(cols[0], cols[i]);
      const dc = colOfRef(m.diode);
      if (dc != null) firstOf.set(find(dc), dc);
    }
    for (const p of [...structures.diffPairs, ...structures.crossCoupled]) {
      const lvls = p.refs.map((r) => slots.get(r)).filter(Boolean).map((sl) => sl.level);
      if (new Set(lvls).size !== 1) continue;
      const cols = p.refs.map(colOfRef).filter((c) => c != null);
      for (let i = 1; i < cols.length; i++) union(cols[0], cols[i]);
    }
    // ordre final : clusters dans l'ordre de leur plus petite colonne ;
    // à l'intérieur : diode d'abord, puis ordre d'origine
    const clusters = new Map();
    for (const c of intCols) {
      const r = find(c);
      if (!clusters.has(r)) clusters.set(r, []);
      clusters.get(r).push(c);
    }
    const orderedClusters = [...clusters.entries()]
      .sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]));
    const newOf = new Map();
    let k = 0;
    for (const [root, cols] of orderedClusters) {
      cols.sort((a, b) => a - b);
      const head = firstOf.get(find(root));
      if (head != null && cols.includes(head)) {
        cols.splice(cols.indexOf(head), 1);
        cols.unshift(head);
      }
      for (const c of cols) newOf.set(c, k++);
    }
    for (const [ref, sl] of slots) {
      if (Number.isInteger(sl.col)) sl.col = newOf.get(sl.col);
    }
    for (const [ref, cols] of sharedParents) {
      const sl = slots.get(ref);
      sl.col = cols.map((c) => newOf.get(c)).reduce((a, b) => a + b, 0) / cols.length;
    }
  }

  // ---- flips de symétrie, propagés à toute la colonne. Par défaut :
  //      seulement les paires cross-couplées (gain net) ; les paires diff
  //      sont flippées à la demande de l'optimiseur (P.flipPairs).
  const flipRefs = new Set();
  const quadRefs = new Set((structures.quads || []).flatMap((q) => q.refs));
  // miroir vertical PAR DÉFAUT pour les paires diff (membre droit flippé,
  // gates vers l'extérieur, 2e entrée à droite) ; P.flipPairs INVERSE ce
  // défaut pour la recherche ; quads gérés à part
  const wantFlip = (pr) => {
    if (pr.refs.some((r) => quadRefs.has(r))) return false;
    const base = true;
    const toggled = (P.flipPairs || []).includes(pr.refs.join('/'));
    return structures.crossCoupled.includes(pr) ? true : (base !== toggled);
  };
  for (const pr of [...structures.diffPairs, ...structures.crossCoupled]) {
    if (!wantFlip(pr)) continue;
    const [a, b] = pr.refs;
    const ca = slots.get(a), cb = slots.get(b);
    if (ca == null || cb == null) continue;
    const right = ca.col <= cb.col ? b : a;
    const rs = slots.get(right);
    // garde de niveau : la rangée de la paire et en dessous — jamais les
    // charges/miroirs au-dessus (leur gate doit regarder leur diode)
    for (const [ref, sl] of slots) {
      if (sl.col === rs.col && sl.level >= rs.level) flipRefs.add(ref);
    }
  }

  // quad canonique : gates INTERNES face à face (flip du 2e par colonne),
  // membres du quad exclus des flips de recherche
  for (const q of (structures.quads || [])) {
    const sorted = q.refs.filter((r) => slots.has(r)).sort((a, b) => slots.get(a).col - slots.get(b).col);
    if (sorted.length === 4) {
      const inner = slots.get(sorted[1]);
      // uniquement la rangée du quad et sa charge au-dessus — jamais la
      // paire RF (colonne fractionnaire identique) ni la queue en dessous
      for (const [ref, sl] of slots) {
        if (sl.col === inner.col && sl.level <= inner.level) flipRefs.add(ref);
      }
    }
  }

  // ---- géométrie
  const placed = new Map();
  const netTerms = new Map();
  const term = (net, ref, pinName, pin) => {
    if (!netTerms.has(net)) netTerms.set(net, []);
    netTerms.get(net).push({ ref, pinName, pin });
  };
  for (const c of comps) {
    let ci = info.get(c.ref);
    if (ci == null && SPICE_MAP[c.prefix] != null && slots.has(c.ref)) {
      const map = SPICE_MAP[c.prefix];
      ci = { shapeKey: map.shape, po: map.pinOrder };
      info.set(c.ref, ci);
    }
    if (ci == null || floating.has(c.ref) || chainRefs.has(c.ref)) continue;
    const s = slots.get(c.ref);
    if (s == null) continue;
    const shape = getShape(ci.shapeKey);
    const flip = P.flip[c.ref] ? -1 : 1;
    // dipôles verticaux : rotation 90 (in en haut) ; MOS natifs (déjà verticaux)
    let rotation = 0;
    if ('RCLD'.includes(c.prefix)) rotation = 90 * flip;
    const w = shape.w, h = shape.h;
    const cx = P.x0 + s.col * P.colW;
    const cy = P.y0 + s.level * P.rowH;
    // centre la BOÎTE TOURNÉE sur (cx, cy) : le canal (pins NE/SE x=1) des MOS est à +w/2-? — aligner le canal sur l'axe
    const flipped = flipRefs.has(c.ref);
    // axe de conduction UNIQUE par colonne, indépendant des flips (un flip
    // décalait l'axe de ±15 px et désalignait les piles mixtes -> baïonnettes)
    const axisX = cx + 15;
    let w2 = w, h2 = h, shapeKey2 = ci.shapeKey, rot2 = rotation;
    if (c.prefix === 'L' && rotation !== 0) {
      // inductance VERTICALE : symbole vertical natif (pins traversants sur
      // l'axe) au lieu d'une bobine tournée aux pins en coin -> zéro coude
      shapeKey2 = 'mxgraph.electrical.inductors.inductor_2';
      const vs = getShape(shapeKey2);
      w2 = vs.w; h2 = vs.h; rot2 = 0;
      ci.shapeKey = shapeKey2;
    }
    let x = axisX - w2 / 2, y = cy - h2 / 2;
    if (c.prefix === 'M' || c.prefix === 'Q') x = flipped ? axisX : axisX - w2;
    if (shapeKey2 === 'mxgraph.electrical.inductors.inductor_2') {
      x = axisX - (flipped ? (1 - 0.6977) : 0.6977) * w2;
    }
    const cell = addVertex(model, { id: c.ref, shape: shapeKey2, x, y, w: w2, h: h2, rotation: rot2, value: c.value || '' });
    if (flipped) cell.setAttribute('style', cell.getAttribute('style') + 'flipH=1;');
    const pc = { id: c.ref, x, y, w: w2, h: h2, rotation: rot2, flipH: flipped };
    placed.set(c.ref, pc);
    // enregistrer les terminaux
    for (let i = 0; i < ci.po.length; i++) {
      const pin = getPin(ci.shapeKey, ci.po[i]);
      term(c.nodes[i], c.ref, ci.po[i], pin);
    }
  }

  // chaînes de signal : à gauche de la gate d'ancrage, dans l'ordre du flux
  for (const ch of chains) {
    const anchor = placed.get(ch.anchorRef);
    if (anchor == null) continue;
    const ai = info.get(ch.anchorRef);
    const gpin = getPin(ai.shapeKey, ai.gatePin || ai.po[1]);
    const ga = pinAbs(anchor, gpin);
    let k = 0;
    for (const e of ch.elems) {
      const ci = info.get(e.c.ref);
      const shape = getShape(ci.shapeKey);
      const cx = ga.x - 130 - k * 160;
      // aligner les PINS de l'élément sur la ligne de chaîne (les selfs
      // horizontales ont leurs pins au bord bas, pas au centre)
      const cy = ga.y;
      const pinRelY = (getPin(ci.shapeKey, ci.po[0]) || { y: 0.5 }).y;
      const y = ga.y - pinRelY * shape.h;
      addVertex(model, { id: e.c.ref, shape: ci.shapeKey, x: cx - shape.w / 2, y, w: shape.w, h: shape.h, rotation: 0, value: e.c.value || '' });
      placed.set(e.c.ref, { id: e.c.ref, x: cx - shape.w / 2, y, w: shape.w, h: shape.h, rotation: 0 });
      for (let i = 0; i < ci.po.length; i++) term(e.c.nodes[i], e.c.ref, ci.po[i], getPin(ci.shapeKey, ci.po[i]));
      // dérivations : bias en haut (vertical), shunt masse en bas (vertical)
      for (const h of e.hangers) {
        const hi = info.get(h.c.ref);
        let hShape = hi.shapeKey, hRot = h.up ? -90 : 90;
        if (h.c.prefix === 'L') { hShape = 'mxgraph.electrical.inductors.inductor_2'; hRot = 0; hi.shapeKey = hShape; }
        const hs = getShape(hShape);
        const hx = cx + 85;
        const hh = hRot === 0 ? hs.h : hs.w;
        const hy = h.up ? cy - 80 - hh / 2 : cy + 80 + hh / 2;
        const hxpos = hShape === 'mxgraph.electrical.inductors.inductor_2' ? hx - 0.6977 * hs.w : hx - hs.w / 2;
        addVertex(model, { id: h.c.ref, shape: hShape, x: hxpos, y: hy - hs.h / 2, w: hs.w, h: hs.h, rotation: hRot, value: h.c.value || '' });
        placed.set(h.c.ref, { id: h.c.ref, x: hxpos, y: hy - hs.h / 2, w: hs.w, h: hs.h, rotation: hRot });
        for (let i = 0; i < hi.po.length; i++) term(h.c.nodes[i], h.c.ref, hi.po[i], getPin(hShape, hi.po[i]));
      }
      k++;
    }
    if (ch.endV != null) {
      const vi = info.get(ch.endV.ref) || (() => {
        const map = SPICE_MAP[ch.endV.prefix];
        const o = { shapeKey: map.shape, po: map.pinOrder, top: ch.endV.nodes[0], bot: ch.endV.nodes[1] };
        info.set(ch.endV.ref, o);
        return o;
      })();
      const vs = getShape(vi.shapeKey);
      const cx = ga.x - 130 - k * 160;
      const cy = ga.y + 90;
      addVertex(model, { id: ch.endV.ref, shape: vi.shapeKey, x: cx - vs.w / 2, y: cy - vs.h / 2, w: vs.w, h: vs.h, rotation: 0, value: ch.endV.value || '' });
      placed.set(ch.endV.ref, { id: ch.endV.ref, x: cx - vs.w / 2, y: cy - vs.h / 2, w: vs.w, h: vs.h, rotation: 0 });
      for (let i = 0; i < vi.po.length; i++) term(ch.endV.nodes[i], ch.endV.ref, vi.po[i], getPin(vi.shapeKey, vi.po[i]));
    }
  }

  // passifs flottants : horizontaux, centrés entre les positions moyennes de leurs deux nets
  for (const c of comps) {
    if (!floating.has(c.ref)) continue;
    const ci = info.get(c.ref);
    const shape = getShape(ci.shapeKey);
    const anchors = [ci.top, ci.bot].map((net) => {
      const pts = [];
      for (const o of comps) {
        const oi = info.get(o.ref);
        if (oi == null || !placed.has(o.ref)) continue;
        o.nodes.forEach((n, i) => {
          if (n === net) pts.push(pinAbs(placed.get(o.ref), getPin(oi.shapeKey, oi.po[i])));
        });
      }
      return pts.length ? { n: pts.length, x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length } : { n: 0, x: P.x0, y: P.y0 };
    });
    let cx, cy;
    const empty0 = anchors[0].n === 0, empty1 = anchors[1].n === 0;
    if (empty0 !== empty1) {
      // élément série vers l'extérieur (l'autre net deviendra un port) :
      // posé horizontalement du côté EXTÉRIEUR du schéma, à hauteur du pin
      const a = empty0 ? anchors[1] : anchors[0];
      const centers = [...placed.values()].map((v) => v.x + v.w / 2);
      const mid = centers.length ? (Math.min(...centers) + Math.max(...centers)) / 2 : a.x;
      const dir = a.x >= mid ? 1 : -1;
      cx = a.x + dir * (60 + shape.w / 2);
      cy = a.y;
    } else {
      cx = (anchors[0].x + anchors[1].x) / 2;
      cy = (anchors[0].y + anchors[1].y) / 2 + (P.floatDrop || 0);
    }
    const x = cx - shape.w / 2, y = cy - shape.h / 2;
    addVertex(model, { id: c.ref, shape: ci.shapeKey, x, y, w: shape.w, h: shape.h, rotation: 0, value: c.value || '' });
    placed.set(c.ref, { id: c.ref, x, y, w: shape.w, h: shape.h, rotation: 0 });
    for (let i = 0; i < ci.po.length; i++) {
      term(c.nodes[i], c.ref, ci.po[i], getPin(ci.shapeKey, ci.po[i]));
    }
  }

  // règle 25 : dans un groupe de même rangée, aligner les PINS DE DRAIN
  for (const grp of [...structures.diffPairs.map((p) => p.refs), ...structures.mirrors.map((m) => m.refs)]) {
    const members = grp.filter((r) => placed.has(r) && (comps.find((c) => c.ref === r)));
    if (members.length < 2) continue;
    const drainY = (ref) => {
      const ci2 = info.get(ref);
      if (ci2 == null || ci2.po == null) return null;
      const pin = getPin(ci2.shapeKey, ci2.po[0]);
      return pin != null ? pinAbs(placed.get(ref), pin).y : null;
    };
    const ys = members.map(drainY).filter((y) => y != null);
    if (ys.length < 2) continue;
    const med = [...ys].sort((a, b) => a - b)[Math.floor((ys.length - 1) / 2)];
    members.forEach((ref, i) => {
      const y = drainY(ref);
      if (y == null || Math.abs(y - med) < 0.5 || Math.abs(y - med) > 60) return;
      const pc3 = placed.get(ref);
      updateCell(model, ref, { dy: med - y });
      pc3.y += med - y;
    });
  }

  const wires = wireNets(model, { comps, info, placed, netTerms, vddNet, P });

  return { components: comps.map((c) => c.ref), wires, warnings: parsed.warnings || [],
    engine: 'place2', params: P, roots,
    structuredRefs: [...new Set([
      ...structures.diffPairs.flatMap((p) => p.refs),
      ...structures.crossCoupled.flatMap((p) => p.refs),
      ...structures.mirrors.flatMap((m) => m.refs),
      ...(structures.quads || []).flatMap((q) => q.refs),
      ...structures.tails.map((t) => t.ref),
    ])],
    fanouts: (() => {
      const out = {};
      const byNet = new Map();
      for (const c of comps) {
        const ci2 = info.get(c.ref);
        if (ci2 == null || ci2.top == null) continue;
        if (!byNet.has(ci2.top)) byNet.set(ci2.top, []);
        byNet.get(ci2.top).push(c.ref);
      }
      for (const [n, l] of byNet) if (l.length >= 2 && n !== '0') out[n] = l;
      return out;
    })(),
    pairs: structures.diffPairs.map((p) => p.refs.join('/')),
    flippable: comps.filter((c) => 'RCLD'.includes(c.prefix)).map((c) => c.ref) };
}
