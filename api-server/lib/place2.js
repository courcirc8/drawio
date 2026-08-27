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
import { addVertex, addWire, httpError } from './model.js';
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
function condInfo(c) {
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

  function markFloating(vdd) {
    for (const c of comps) {
      const ci = info.get(c.ref);
      if (ci == null || !'RCL'.includes(c.prefix)) continue;
      if (ci.top !== vdd && ci.top !== '0' && ci.bot !== vdd && ci.bot !== '0') {
        floating.add(c.ref);
        unplaced.delete(c.ref);
      }
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
    const shared = below.filter((c) => parentsOf(info.get(c.ref).top) > 1);
    const solo = below.filter((c) => !shared.includes(c));
    let k = 0;
    for (const c of solo) {
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
  const structures = detectStructures(parsed);
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
  const wantFlip = (pr) => structures.crossCoupled.includes(pr) ||
    (P.flipPairs || []).includes(pr.refs.join('/'));
  for (const pr of [...structures.diffPairs, ...structures.crossCoupled]) {
    if (!wantFlip(pr)) continue;
    const [a, b] = pr.refs;
    const ca = slots.get(a), cb = slots.get(b);
    if (ca == null || cb == null) continue;
    const right = ca.col <= cb.col ? b : a;
    const rc = slots.get(right).col;
    for (const [ref, sl] of slots) if (sl.col === rc) flipRefs.add(ref);
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
    if (ci == null || floating.has(c.ref)) continue;
    const s = slots.get(c.ref);
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
    let x = cx - w / 2, y = cy - h / 2;
    if (c.prefix === 'M' || c.prefix === 'Q') x = flipped ? cx - 15 : cx - w + 15; // canal proche de l'axe
    const cell = addVertex(model, { id: c.ref, shape: ci.shapeKey, x, y, w, h, rotation, value: c.value || '' });
    if (flipped) cell.setAttribute('style', cell.getAttribute('style') + 'flipH=1;');
    const pc = { id: c.ref, x, y, w, h, rotation, flipH: flipped };
    placed.set(c.ref, pc);
    // enregistrer les terminaux
    for (let i = 0; i < ci.po.length; i++) {
      const pin = getPin(ci.shapeKey, ci.po[i]);
      term(c.nodes[i], c.ref, ci.po[i], pin);
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
      // posé horizontalement à gauche du pin côté circuit, à sa hauteur
      const a = empty0 ? anchors[1] : anchors[0];
      cx = a.x - 60 - shape.w / 2;
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
        addVertex(model, { id, shape: VDD_TAP, x: abs.x - 20, y: p.y - 66, w: 40, h: 26, value: 'VDD' });
        wire(null, { source: t.ref, target: id, sourcePin: { x: t.pin.x, y: t.pin.y }, targetPin: { x: 0.5, y: 1 } });
      }
    } else if (net === '0') {
      for (const t of terms) {
        const p = placed.get(t.ref);
        const abs = pinAbs(p, t.pin);
        const id = 'GND' + (++seq);
        addVertex(model, { id, shape: GROUND_SHAPE, x: abs.x - 15, y: Math.max(...[...placed.values()].map((q) => q.y + q.h)) + 40, w: 30, h: 20 });
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
      let cx = 0, cy = 0;
      const pts = terms.map((t) => pinAbs(placed.get(t.ref), t.pin));
      for (const q of pts) { cx += q.x; cy += q.y; }
      cx /= pts.length; cy /= pts.length;
      let snap = pts.reduce((best, q) => Math.abs(q.x - cx) < Math.abs(best.x - cx) ? q : best, pts[0]);
      const gateCount = terms.filter((t) => {
        const c = comps.find((k) => k.ref === t.ref);
        return c != null && (c.prefix === 'M' || c.prefix === 'Q') && info.get(c.ref).gatePin === t.pinName;
      }).length;
      const nCols = new Set(pts.map((q) => Math.round((q.x - P.x0) / P.colW))).size;
      const isBus = gateCount >= 2 && nCols >= 3;
      // net de miroir NON-bus : jonction ancrée sur le drain de la diode
      const diode = isBus ? null : comps.find((k) => (k.prefix === 'M' || k.prefix === 'Q') &&
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
      addVertex(model, { id, style: JCT, x: snap.x - 3, y: jy - 3, w: 6, h: 6 });
      for (const t of terms) {
        wire(null, { source: t.ref, target: id, sourcePin: { x: t.pin.x, y: t.pin.y } });
      }
    }
  }

  return { components: comps.map((c) => c.ref), wires, warnings: parsed.warnings || [],
    engine: 'place2', params: P, roots,
    pairs: structures.diffPairs.map((p) => p.refs.join('/')),
    flippable: comps.filter((c) => 'RCLD'.includes(c.prefix)).map((c) => c.ref) };
}
