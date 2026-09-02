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
import { addVertex, addWire, updateCell, getCell, httpError } from './model.js';
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

/** Une diagonale volontaire est bloquée si elle traverse un corps — y
 * compris un corps TERMINAL au-delà de 12 px autour de son propre pin
 * (jamais traverser un transistor pour rejoindre son pin du côté opposé). */
function diagBlocked(placed, t0, t1, refA, refB) {
  const clip = (pp, qq, r) => {
    const dx = qq.x - pp.x, dy = qq.y - pp.y;
    let u0 = 0, u1 = 1;
    for (const [pv, qv] of [[-dx, pp.x - r.x], [dx, r.x + r.w - pp.x], [-dy, pp.y - r.y], [dy, r.y + r.h - pp.y]]) {
      if (pv === 0) { if (qv < 0) return null; continue; }
      const t = qv / pv;
      if (pv < 0) { if (t > u1) return null; u0 = Math.max(u0, t); }
      else { if (t < u0) return null; u1 = Math.min(u1, t); }
    }
    if (u0 >= u1) return null;
    return [{ x: pp.x + dx * u0, y: pp.y + dy * u0 }, { x: pp.x + dx * u1, y: pp.y + dy * u1 }];
  };
  return [...placed.values()].some((v) => {
    const r = { x: v.x + 3, y: v.y + 3, w: Math.max(0, v.w - 6), h: Math.max(0, v.h - 6) };
    if (r.w <= 0 || r.h <= 0) return false;
    const c = clip(t0, t1, r);
    if (c == null || Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) < 1) return false;
    if (v.id !== refA && v.id !== refB) return true;
    const own = v.id === refA ? t0 : t1;
    return Math.max(Math.hypot(c[0].x - own.x, c[0].y - own.y),
                    Math.hypot(c[1].x - own.x, c[1].y - own.y)) > 12;
  });
}

export function wireNets(model, { comps, info, placed, netTerms, vddNet, P }) {
  const wires = [];
  const wire = (a, b) => wires.push(addWire(model, a === null ? b : a).getAttribute('id'));
  let seq = 0;
  let ccPairs = [];
  let quads = [];
  try {
    const st2 = detectStructures({ components: comps });
    ccPairs = st2.crossCoupled.map((s) => s.refs);
    quads = st2.quads || [];
  } catch { /* netlist sans MOS */ }
  // rails de drain du quad : affectation des lanes par COÛT PRÉDICTIF (les
  // plongées du net du haut traversent le rail du bas si elles tombent dans
  // sa portée ; idem pour les descentes des résistances de charge)
  const quadRail = new Map();
  for (const q of quads) {
    const qRefs = q.refs.filter((r) => placed.has(r) && info.get(r) != null);
    if (qRefs.length !== 4) continue;
    const qTop = Math.min(...qRefs.map((r) => placed.get(r).y));
    const dnet = (r) => (comps.find((c2) => c2.ref === r) || { nodes: [] }).nodes[0];
    const nets2 = [...new Set(qRefs.map(dnet))];
    if (nets2.length !== 2) continue;
    const dropX = (r) => pinAbs(placed.get(r), getPin(info.get(r).shapeKey, info.get(r).po[0])).x;
    const span = {};
    for (const n2 of nets2) {
      const xs2 = qRefs.filter((r) => dnet(r) === n2).map(dropX);
      span[n2] = [Math.min(...xs2), Math.max(...xs2)];
    }
    const rOf = {};
    for (const c2 of comps) {
      if (c2.prefix !== 'R' || !placed.has(c2.ref)) continue;
      const ciR = info.get(c2.ref);
      if (ciR == null) continue;
      for (const n2 of nets2) {
        if (ciR.top === n2 || ciR.bot === n2) {
          rOf[n2] = (rOf[n2] || []).concat(placed.get(c2.ref).x + placed.get(c2.ref).w / 2);
        }
      }
    }
    const crossCost = (upper, lower) => {
      let k2 = 0;
      for (const r of qRefs.filter((r2) => dnet(r2) === upper)) {
        const x2 = dropX(r);
        if (x2 > span[lower][0] - 5 && x2 < span[lower][1] + 5) k2++;
      }
      for (const xr of (rOf[lower] || [])) {
        if (xr > span[upper][0] - 5 && xr < span[upper][1] + 5) k2++;
      }
      return k2;
    };
    const [nA2, nB2] = nets2;
    const upper = crossCost(nA2, nB2) <= crossCost(nB2, nA2) ? nA2 : nB2;
    const lower = upper === nA2 ? nB2 : nA2;
    quadRail.set(upper, { lane: qTop - 48 });
    quadRail.set(lower, { lane: qTop - 28 });
  }

  // rails : tap VDD au-dessus de chaque terminal du net vdd ; masse sous chaque terminal de 0
  for (const [net, terms] of netTerms) {
    if (net === vddNet && vddNet !== '0') {
      for (const t of terms) {
        const p = placed.get(t.ref);
        const abs = pinAbs(p, t.pin);
        const id = 'VT' + (++seq);
        // position ancrée sur le PIN ABSOLU (les formes tournées ont leur pin
        // ailleurs que le haut de leur bbox) + écart franc de 30 px
        // idem masse : ne pas poser le tap sur un composant flottant voisin
        let ty = abs.y - 26 - 30;
        const tClash = () => [...placed.values()].some((v) =>
          abs.x - 20 < v.x + v.w + 6 && abs.x + 20 > v.x - 6 && ty < v.y + v.h + 6 && ty + 26 > v.y - 6);
        for (let k2 = 0; k2 < 5 && tClash(); k2++) ty -= 30;
        const tapCell = addVertex(model, { id, shape: VDD_TAP, x: abs.x - 20, y: ty, w: 40, h: 26, value: 'VDD' });
        tapCell.setAttribute('style', tapCell.getAttribute('style')
          .replace('verticalLabelPosition=bottom;verticalAlign=top;', 'verticalLabelPosition=top;verticalAlign=bottom;'));
        wire(null, { source: t.ref, target: id, sourcePin: { x: t.pin.x, y: t.pin.y }, targetPin: { x: 0.5, y: 1 } });
      }
    } else if (net === '0') {
      for (const t of terms) {
        const p = placed.get(t.ref);
        const abs = pinAbs(p, t.pin);
        const id = 'GND' + (++seq);
        // masse LOCALE : juste sous le pin (comme le petit trait des figures
        // publiées), jamais un long rail vers une ligne de fond commune.
        // Pin LATÉRAL ou HAUT (base de BJT, corps rond) : sortir du corps
        // horizontalement puis descendre — jamais de masse DANS le corps
        let gx = abs.x, gy = abs.y + 45;
        const bodyBot = p.y + (p.h || 0);
        const leftish2 = abs.x <= p.x + (p.w || 0) / 2;
        if (abs.y < bodyBot - 6) {
          gx = abs.x + (leftish2 ? -44 : 44);
          gy = Math.max(abs.y + 45, bodyBot + 25);
        }
        // ne jamais poser la masse SUR un voisin (corps rond de BJT…) :
        // écarter latéralement puis descendre jusqu'à une case libre
        const gClash = () => [...placed.values()].some((v) =>
          gx - 13 < v.x + v.w + 6 && gx + 13 > v.x - 6 && gy < v.y + v.h + 6 && gy + 18 > v.y - 6);
        for (let k2 = 0; k2 < 5 && gClash(); k2++) gx += leftish2 ? -30 : 30;
        for (let k2 = 0; k2 < 5 && gClash(); k2++) gy += 30;
        // ±13 px et pas ±15 : la lane d'échappée des fils est à ±14 px du
        // flanc — une masse à ±15 la chevauchait STRUCTURELLEMENT de 1 px
        // (through systématique, invisible dans le clear() érodé de 1.5)
        addVertex(model, { id, shape: GROUND_SHAPE, x: gx - 13, y: gy, w: 26, h: 18 });
        const gp = getPin(GROUND_SHAPE, GROUND_PIN);
        wire(null, { source: t.ref, target: id, sourcePin: { x: t.pin.x, y: t.pin.y }, targetPin: { x: gp.x, y: gp.y } });
      }
    }
  }

  // nets de signal
  // lanes déjà prises par les liaisons gate-gate FIGÉES : deux nets (LOP et
  // LOM du mélangeur en anneau) prenaient la même lane et se superposaient
  const usedGateLanes = [];
  for (const [net, terms] of netTerms) {
    if (net === vddNet || net === '0') continue;
    if (terms.length === 1) {
      // entrée/sortie : port
      const t = terms[0];
      const p = placed.get(t.ref);
      const abs = pinAbs(p, t.pin);
      const id = 'P_' + net.replace(/[^A-Za-z0-9]/g, '_');
      // direction PHYSIQUE du pin (flips/rotations compris) : un pin qui
      // regarde en haut reçoit son port AU-DESSUS, en bas AU-DESSOUS —
      // jamais un port de côté relié par un détour
      const midX = Math.abs(abs.x - (p.x + p.w / 2)) < Math.max(14, p.w / 3);
      if (midX && abs.y <= p.y + 2) {
        const cellUp = addVertex(model, { id, shape: PORT, x: abs.x - 12, y: abs.y - 70, w: 24, h: 24, value: net.toUpperCase() });
        cellUp.setAttribute('style', cellUp.getAttribute('style') + 'flipV=1;verticalLabelPosition=top;verticalAlign=bottom;');
        placed.set(id, { id, x: abs.x - 12, y: abs.y - 70, w: 24, h: 24, rotation: 0, flipV: true });
        wire(null, { source: id, target: t.ref, sourcePin: { x: 0.5, y: 0 }, targetPin: { x: t.pin.x, y: t.pin.y } });
        continue;
      }
      if (midX && abs.y >= p.y + p.h - 2) {
        addVertex(model, { id, shape: PORT, x: abs.x - 12, y: abs.y + 46, w: 24, h: 24, value: net.toUpperCase() });
        placed.set(id, { id, x: abs.x - 12, y: abs.y + 46, w: 24, h: 24, rotation: 0 });
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
      // cross-couplage de quad : gate-gate même rangée, colonnes éloignées
      // -> diagonale droite assumée (style des figures publiées), non routée
      const gA = comps.find((k) => k.ref === a.ref), gB = comps.find((k) => k.ref === b.ref);
      const bothGates = gA != null && gB != null &&
        (gA.prefix === 'M' || gA.prefix === 'Q') && (gB.prefix === 'M' || gB.prefix === 'Q') &&
        info.get(gA.ref).gatePin === a.pinName && info.get(gB.ref).gatePin === b.pinName;
      const pA = pinAbs(placed.get(a.ref), a.pin), pB = pinAbs(placed.get(b.ref), b.pin);
      // la diagonale n'est légitime que si sa ligne de vue est LIBRE : un
      // fil droit qui traverse un corps est une faute (revue sceptique)
      const losClear = !diagBlocked(placed, pA, pB, a.ref, b.ref);
      if (bothGates && Math.abs(pA.y - pB.y) < 60 && Math.abs(pA.x - pB.x) > (P.colW || 190)) {
        if (losClear) {
          wire(null, { source: a.ref, target: b.ref,
            sourcePin: { x: a.pin.x, y: a.pin.y }, targetPin: { x: b.pin.x, y: b.pin.y },
            style: 'edgeStyle=none;html=1;endArrow=none;endFill=0;' });
          continue;
        }
        // ligne de vue bloquée -> contournement par une lane extérieure
        // CLAIRE (sous ou sur la rangée), comme dans les figures publiées ;
        // le tracé est figé (drawioApiFixedRoute) pour échapper au routeur
        const bodies = [...placed.values()].filter((v) => v.id !== a.ref && v.id !== b.ref)
          .flatMap((v) => v.h >= 80 ? [v, { x: v.x, y: v.y + v.h, w: v.w, h: 18 }] : [v]);
        const clearSeg = (p, q) => !bodies.some((v) =>
          Math.max(p.x, q.x) > v.x + 3 && Math.min(p.x, q.x) < v.x + v.w - 3 &&
          Math.max(p.y, q.y) > v.y + 3 && Math.min(p.y, q.y) < v.y + v.h - 3);
        const bA = placed.get(a.ref), bB = placed.get(b.ref);
        const yTop = Math.min(bA.y, bB.y), yBot = Math.max(bA.y + bA.h, bB.y + bB.h);
        let lane = null;
        const x1s = Math.min(pA.x, pB.x) - 6, x2s = Math.max(pA.x, pB.x) + 6;
        const laneFree = (yl) => !usedGateLanes.some((u) =>
          Math.abs(u.y - yl) < 10 && x1s < u.x2 && x2s > u.x1);
        outer: for (let k = 0; k < 6; k++) {
          for (const yl of [yBot + 24 + k * 12, yTop - 24 - k * 12]) {
            if (laneFree(yl) &&
                clearSeg(pA, { x: pA.x, y: yl }) && clearSeg({ x: pA.x, y: yl }, { x: pB.x, y: yl }) &&
                clearSeg({ x: pB.x, y: yl }, pB)) { lane = yl; break outer; }
          }
        }
        if (lane != null) {
          usedGateLanes.push({ y: lane, x1: x1s, x2: x2s });
          // échappée horizontale : la plongée se fait à 14 px du flanc
          // (jamais le long du canal, règle utilisateur)
          const escA = (a.pin.x <= 0.5) !== !!placed.get(a.ref).flipH ? -14 : 14;
          const escB = (b.pin.x <= 0.5) !== !!placed.get(b.ref).flipH ? -14 : 14;
          wire(null, { source: a.ref, target: b.ref,
            sourcePin: { x: a.pin.x, y: a.pin.y }, targetPin: { x: b.pin.x, y: b.pin.y },
            style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;jettySize=0;endArrow=none;endFill=0;drawioApiFixedRoute=1;',
            points: [{ x: pA.x + escA, y: pA.y }, { x: pA.x + escA, y: lane },
                     { x: pB.x + escB, y: lane }, { x: pB.x + escB, y: pB.y }] });
          continue;
        }
      }
      wire(null, { source: a.ref, target: b.ref, sourcePin: { x: a.pin.x, y: a.pin.y }, targetPin: { x: b.pin.x, y: b.pin.y } });
    } else {
      // règle 31 : net multi-terminal = ARBRE COUVRANT MINIMAL sur les
      // coordonnées réelles des pins (Prim, distance de Manhattan) — un
      // tronc et des dérivations comme dans un dessin humain, jamais
      // d'étoile redondante ni de fil de diode séparé (la gate est un
      // terminal comme un autre, l'arbre la raccorde au plus court) ;
      // les points de contact naissent aux pins partagés (règle 30)
      const pts = terms.map((t) => pinAbs(placed.get(t.ref), t.pin));
      const preLinkedQuad = [];
      // QUAD (Gilbert) : les deux nets de drain deviennent des RAILS à
      // lanes dédiées au-dessus de la rangée (style Razavi) — plongées
      // verticales des drains, lanes affectées par coût prédictif
      if (quadRail.has(net)) {
        const q = quads.find((q2) => q2.refs.some((r) => terms.some((t) => t.ref === r)));
        const members = q ? q.refs.filter((r) => {
          const mi2 = info.get(r);
          return mi2 != null && terms.some((t) => t.ref === r && t.pinName === mi2.po[0]);
        }) : [];
        if (members.length === 2) {
          const [mA, mB] = members;
          const pA2 = pinAbs(placed.get(mA), getPin(info.get(mA).shapeKey, info.get(mA).po[0]));
          const pB2 = pinAbs(placed.get(mB), getPin(info.get(mB).shapeKey, info.get(mB).po[0]));
          const ri = quadRail.get(net);
          wire(null, { source: mA, target: mB,
            sourcePin: { x: (terms.find((t) => t.ref === mA) || {}).pin.x, y: (terms.find((t) => t.ref === mA) || {}).pin.y },
            targetPin: { x: (terms.find((t) => t.ref === mB) || {}).pin.x, y: (terms.find((t) => t.ref === mB) || {}).pin.y },
            style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;jettySize=0;endArrow=none;endFill=0;drawioApiFixedRoute=1;',
            points: [{ x: pA2.x, y: ri.lane }, { x: pB2.x, y: ri.lane }] });
          const endIsA = pA2.x >= pB2.x;
          ri.endRef = endIsA ? mA : mB;
          ri.endX = Math.max(pA2.x, pB2.x);
          ri.endPin = (terms.find((t) => t.ref === ri.endRef) || {}).pin;
          const iA = terms.findIndex((t) => t.ref === mA && t.pinName === info.get(mA).po[0]);
          const iB = terms.findIndex((t) => t.ref === mB && t.pinName === info.get(mB).po[0]);
          if (iA >= 0 && iB >= 0) preLinkedQuad.push([iA, iB]);
        }
      }
      // paire cross-couplée : la gate rejoint le drain du PARTENAIRE par une
      // diagonale volontaire (le X des figures publiées) — deux tracés
      // orthogonaux qui se disputent les mêmes lanes sont irréparables (VCO)
      const preLinked = [];
      for (const [rX, rY] of ccPairs) {
        for (const gRef of [rX, rY]) {
          const iG = terms.findIndex((t) => t.ref === gRef && info.get(gRef) != null && t.pinName === info.get(gRef).gatePin);
          if (iG < 0) continue;
          // candidats : les autres terminaux du net, du plus proche au plus
          // loin — premier dont la ligne de vue est libre
          const cand = terms.map((_, i2) => i2)
            .filter((i2) => i2 !== iG && terms[i2].ref !== gRef)
            .sort((u, v) => (Math.abs(pts[u].x - pts[iG].x) + Math.abs(pts[u].y - pts[iG].y))
                          - (Math.abs(pts[v].x - pts[iG].x) + Math.abs(pts[v].y - pts[iG].y)));
          let iD = -1;
          // la diagonale X ne se justifie qu'entre voisins de MÊME RANGÉE
          // (VCO/Gilbert) — entre étages (StrongARM) elle balafre le schéma
          for (const i2 of cand) {
            if (Math.abs(pts[i2].y - pts[iG].y) > 160) continue;
            if (clearDiagTo(i2)) { iD = i2; break; }
          }
          if (iD < 0) continue;
          function clearDiagTo(i2) {
            return !diagBlocked(placed, pts[iG], pts[i2], gRef, terms[i2].ref);
          }
          wire(null, { source: terms[iG].ref, target: terms[iD].ref,
            sourcePin: { x: terms[iG].pin.x, y: terms[iG].pin.y },
            targetPin: { x: terms[iD].pin.x, y: terms[iD].pin.y },
            style: 'edgeStyle=none;html=1;endArrow=none;endFill=0;' });
          preLinked.push([iG, iD]);
        }
      }
      for (const pl2 of preLinkedQuad) preLinked.push(pl2);
      const linkedOf = (i2) => preLinked.flatMap(([u, v]) => (u === i2 ? [v] : v === i2 ? [u] : []));
      const inTree = [0];
      const seen = new Set([0]);
      const absorb = (i2) => { for (const l of linkedOf(i2)) if (!seen.has(l)) { seen.add(l); inTree.push(l); absorb(l); } };
      absorb(0);
      const rest2 = terms.map((_, i2) => i2).filter((i2) => !seen.has(i2));
      while (rest2.length) {
        let bi = -1, bj = -1, bd = Infinity;
        for (const i2 of inTree) {
          for (const j2 of rest2) {
            const dx2 = Math.abs(pts[i2].x - pts[j2].x), dy2 = Math.abs(pts[i2].y - pts[j2].y);
            // coût orienté axe : une liaison colinéaire (tronc) coûte moitié
            // prix, l'arbre préfère les troncs puis les dérivations courtes
            let d2 = dx2 + dy2;
            if (dx2 < 5 || dy2 < 5) d2 *= 0.5;
            if (d2 < bd) { bd = d2; bi = i2; bj = j2; }
          }
        }
        if (bi < 0) {
          const missing = terms.filter((t) => !placed.has(t.ref)).map((t) => t.ref);
          throw new Error(`wireNets: net sans candidat MST (non places: ${missing.join(',') || 'aucun'}; terms: ${terms.map((t, i9) => `${t.ref}.${t.pinName}@${Math.round(pts[i9].x)},${Math.round(pts[i9].y)}`).join(' ')}; inTree=${inTree.join(',')} rest=${rest2.join(',')})`);
        }
        const ta = terms[bi], tb = terms[bj];
        wire(null, { source: ta.ref, target: tb.ref,
          sourcePin: { x: ta.pin.x, y: ta.pin.y }, targetPin: { x: tb.pin.x, y: tb.pin.y } });
        seen.add(bj);
        inTree.push(bj);
        absorb(bj);
        rest2.splice(0, rest2.length, ...rest2.filter((k) => !seen.has(k)));
      }
    }
  }

  // ports d'interface : un net multi-terminal NOMMÉ (in/out/lo/rf/vb...)
  // sans étiquette est illisible — l'OL du Gilbert n'existait nulle part
  for (const [net, terms] of netTerms) {
    if (net === vddNet || net === '0' || terms.length < 2) continue;
    if (!/(^|_)(in|out|rf|lo|if|clk|bias|osc|vb)/i.test(net)) continue;
    const withAbs = terms.map((t) => ({ t, abs: pinAbs(placed.get(t.ref), t.pin) }));
    const cxm = withAbs.reduce((s2, w2) => s2 + w2.abs.x, 0) / withAbs.length;
    // préférer un terminal dont le pin REGARDE vers l'extérieur (sinon le
    // fil du port doit contourner — ou pire, traverser — le corps)
    const facing = (w2) => {
      const pl2 = (w2.t.pin.x <= 0.5) !== !!(placed.get(w2.t.ref) || {}).flipH;
      return (pl2 ? -1 : 1) === (w2.abs.x <= cxm ? -1 : 1);
    };
    const riNet = quadRail.get(net);
    if (riNet != null && riNet.endRef != null) {
      const id2 = 'PN' + (++seq);
      let pxR = riNet.endX + 46;
      const clashR = () => [...placed.values()].some((v) =>
        pxR < v.x + v.w + 8 && pxR + 24 > v.x - 8 && riNet.lane < v.y + v.h + 8 && riNet.lane + 24 > v.y - 8);
      for (let k3 = 0; k3 < 8 && clashR(); k3++) pxR += 40;
      addVertex(model, { id: id2, shape: PORT, x: pxR, y: riNet.lane, w: 24, h: 24, value: net.toUpperCase() });
      placed.set(id2, { id: id2, x: pxR, y: riNet.lane, w: 24, h: 24, rotation: 0, railPort: true });
      wire(null, { source: id2, target: riNet.endRef, sourcePin: { x: 0.5, y: 0 }, targetPin: { x: riNet.endPin.x, y: riNet.endPin.y } });
      continue;
    }
    // deux gates FACE À FACE (lom du quad) : port dans l'ENTREFER, dessous
    if (withAbs.length === 2) {
      const [u1, u2] = [...withAbs].sort((a2, b2) => a2.abs.x - b2.abs.x);
      const dir1 = (u1.t.pin.x <= 0.5) !== !!(placed.get(u1.t.ref) || {}).flipH ? -1 : 1;
      const dir2 = (u2.t.pin.x <= 0.5) !== !!(placed.get(u2.t.ref) || {}).flipH ? -1 : 1;
      if (dir1 === 1 && dir2 === -1 && Math.abs(u1.abs.y - u2.abs.y) < 8) {
        const mx2 = (u1.abs.x + u2.abs.x) / 2;
        const id2 = 'PN' + (++seq);
        addVertex(model, { id: id2, shape: PORT, x: mx2 - 12, y: u1.abs.y + 40, w: 24, h: 24, value: net.toUpperCase() });
        placed.set(id2, { id: id2, x: mx2 - 12, y: u1.abs.y + 40, w: 24, h: 24, rotation: 0 });
        wire(null, { source: id2, target: u1.t.ref, sourcePin: { x: 0.5, y: 0 }, targetPin: { x: u1.t.pin.x, y: u1.t.pin.y } });
        continue;
      }
    }
    const upFacing = (w2) => {
      const p2 = placed.get(w2.t.ref);
      return p2 != null && Math.abs(w2.abs.y - p2.y) < 3 &&
        Math.abs(w2.abs.x - (p2.x + p2.w / 2)) < Math.max(14, p2.w / 3);
    };
    const ups = withAbs.filter(upFacing);
    const pool = withAbs.filter(facing);
    const cands2 = (ups.length ? ups : (pool.length ? pool : withAbs))
      .sort((u, v) => Math.abs(v.abs.x - cxm) - Math.abs(u.abs.x - cxm));
    const { t, abs } = cands2[0];
    const id = 'PN' + (++seq);
    if (ups.length) {
      const cellUp2 = addVertex(model, { id, shape: PORT, x: abs.x - 12, y: abs.y - 70, w: 24, h: 24, value: net.toUpperCase() });
      cellUp2.setAttribute('style', cellUp2.getAttribute('style') + 'flipV=1;verticalLabelPosition=top;verticalAlign=bottom;');
      placed.set(id, { id, x: abs.x - 12, y: abs.y - 70, w: 24, h: 24, rotation: 0, flipV: true });
      wire(null, { source: id, target: t.ref, sourcePin: { x: 0.5, y: 0 }, targetPin: { x: t.pin.x, y: t.pin.y } });
      continue;
    }
    const leftish = (t.pin.x <= 0.5) !== !!(placed.get(t.ref) || {}).flipH;
    let px = abs.x + (leftish ? -80 : 56), py = abs.y + 36;
    const clash = () => [...placed.values()].some((v) =>
      px < v.x + v.w + 8 && px + 24 > v.x - 8 && py < v.y + v.h + 8 && py + 24 > v.y - 8);
    // le L port->pin doit être LIBRE de tout corps (le fil du port LO du
    // Gilbert traversait un transistor du quad)
    const clearL = () => {
      const legs = [[{ x: px + 12, y: py }, { x: px + 12, y: abs.y }],
                    [{ x: px + 12, y: abs.y }, { x: abs.x, y: abs.y }]];
      return legs.every(([p2, q2]) => ![...placed.values()].some((v) =>
        v.id !== t.ref &&
        Math.max(p2.x, q2.x) > v.x + 2 && Math.min(p2.x, q2.x) < v.x + v.w - 2 &&
        Math.max(p2.y, q2.y) > v.y + 2 && Math.min(p2.y, q2.y) < v.y + v.h - 2));
    };
    for (let k2 = 0; k2 < 6 && (clash() || !clearL()); k2++) px += leftish ? -60 : 60;
    for (let k2 = 0; k2 < 6 && (clash() || !clearL()); k2++) py += 50;
    addVertex(model, { id, shape: PORT, x: px, y: py, w: 24, h: 24, value: net.toUpperCase() });
    placed.set(id, { id, x: px, y: py, w: 24, h: 24, rotation: 0 });
    wire(null, { source: id, target: t.ref, sourcePin: { x: 0.5, y: 0 }, targetPin: { x: t.pin.x, y: t.pin.y } });
  }

  // paires de ports différentiels (XP/XM) : MÊME hauteur — un circuit
  // symétrique ne pique pas OUTP et OUTM à deux niveaux différents
  {
    const ports = [...placed.entries()].filter(([id2]) => /^(P_|PN)/.test(id2));
    const stems = new Map();
    for (const [id2, p2] of ports) {
      const cell2 = getCell(model, id2);
      const val = (cell2 && cell2.getAttribute('value') || '').toUpperCase();
      const m2 = /^(.*)(P|M)$/.exec(val);
      if (m2 == null || m2[1] === '') continue;
      if (!stems.has(m2[1])) stems.set(m2[1], []);
      stems.get(m2[1]).push({ id: id2, p: p2 });
    }
    for (const [, pair] of stems) {
      if (pair.length !== 2) continue;
      // un port de bout de rail garde SA hauteur (celle de son rail)
      if (pair.some((pr) => pr.p.railPort)) continue;
      const target = Math.min(pair[0].p.y, pair[1].p.y);
      for (const pr of pair) {
        const dy = target - pr.p.y;
        if (Math.abs(dy) > 1) { pr.p.y += dy; updateCell(model, pr.id, { dy }); }
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
  // rails UNIQUEMENT pour un vrai net d'alimentation nommé — deviner un rail
  // sur « le net avec le plus de tops » déguisait l'entrée du biquad en VDD
  const vddNet = [...byTopNet.keys()].find((n) => /^a?v(dd|cc)d?$/i.test(n)) ?? null;

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

  // ---- LATCH (StrongARM) : deux paires cross-couplées de POLARITÉS
  //      OPPOSÉES sur les MÊMES deux nets. Gabarit dédié : un trunk
  //      vertical par net (précharge -> cc PMOS -> cc NMOS -> étage du
  //      dessous dans la même colonne), paire PMOS au centre, précharges
  //      clk à l'extérieur — comme les figures publiées (Razavi JSSC'09)
  const latchRefs = new Set();
  let latchRoots = null;
  {
    const cc = structures.crossCoupled;
    const kindOf = (r) => isPmos(comps.find((k) => k.ref === r));
    for (let i = 0; i < cc.length && latchRoots == null; i++) {
      for (let j = i + 1; j < cc.length; j++) {
        const a = cc[i], b = cc[j];
        if (new Set([...a.nets, ...b.nets]).size !== 2) continue;
        if (kindOf(a.refs[0]) === kindOf(b.refs[0])) continue;
        const pPair = kindOf(a.refs[0]) ? a : b;
        for (const r of [...a.refs, ...b.refs]) latchRefs.add(r);
        // précharges : autres MOS racine dont le drain est un des deux nets
        const prechOf = (net) => comps.find((k) =>
          (k.prefix === 'M' || k.prefix === 'Q') && !latchRefs.has(k.ref) &&
          info.get(k.ref) != null && info.get(k.ref).top === vddNet &&
          info.get(k.ref).bot === net);
        const [netL, netR] = pPair.nets;
        const pL = prechOf(netL), pR = prechOf(netR);
        latchRoots = [pL && pL.ref, pPair.refs[0], pPair.refs[1], pR && pR.ref]
          .filter(Boolean);
        break;
      }
    }
  }
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
  // latch : ordre IMPOSÉ [précharge, ccP, ccP, précharge] — la descente de
  // conduction construit alors un trunk vertical par net de sortie
  if (latchRoots != null) {
    roots = latchRoots.filter((r) => roots.includes(r))
      .concat(roots.filter((r) => !latchRoots.includes(r)));
  }
  if (P.order.length) roots = P.order.filter((r) => roots.includes(r)).concat(roots.filter((r) => !P.order.includes(r)));
  for (const r of roots) if (unplaced.has(r)) place(r, nextCol++, 0);

  // pseudo-racines : transistors ORPHELINS de conduction — leur drain n'est
  // relié à vdd qu'à travers un dipôle latéral (ex: R de contre-réaction du
  // Cherry-Hooper). Sans ça, tout leur étage partait dans le coin gauche.
  // Vraies colonnes à droite, la paire/le regroupement s'appliquent ensuite.
  {
    let progress = true;
    while (progress) {
      progress = false;
      for (const c of comps) {
        if (!unplaced.has(c.ref) || (c.prefix !== 'M' && c.prefix !== 'Q')) continue;
        const ci2 = info.get(c.ref);
        if (ci2 == null || ci2.top === '0') continue;
        const hasProducer = comps.some((k) => k.ref !== c.ref &&
          info.get(k.ref) != null && info.get(k.ref).bot === ci2.top);
        if (hasProducer) continue;
        place(c.ref, nextCol++, 0);
        progress = true;
      }
    }
  }

  // éléments partagés : centrés sous leurs colonnes, un niveau sous le plus profond
  const sharedParents = new Map(); // ref -> cols parents (pour re-calcul après permutation)
  const sideOff = new Map(); // ref -> décalage latéral (shunt accroché à côté)
  let guard = comps.length;
  while (colOf.size && guard-- > 0) {
    for (const [ref, cols] of [...colOf]) {
      if (!unplaced.has(ref)) { colOf.delete(ref); continue; }
      const depthOf = (cl) =>
        Math.max(...[...slots.values()].filter((s) => s.col === cl).map((s) => s.level));
      const deepest = Math.max(...cols.map(depthOf));
      // parents de PROFONDEURS différentes (ex: M4 du folded cascode entre la
      // chaîne cascode et le drain de la paire) : coller à la colonne du
      // parent le plus profond, la moyenne l'envoyait au milieu de nulle part.
      // Parents de même profondeur (queue de paire diff) : centré comme avant.
      const deepCols = cols.filter((cl) => depthOf(cl) >= deepest - 0.5);
      let mid = deepCols.reduce((a, b) => a + b, 0) / deepCols.length;
      // shunt R/C/L vers la masse sous UNE seule colonne : accroché À CÔTÉ
      // (col+0.6) comme dans les figures — centré sous la colonne, son fil
      // devait traverser la zone de masse du composant du dessus
      const cc5 = comps.find((k) => k.ref === ref);
      const isSideShunt = cc5 != null && 'RCL'.includes(cc5.prefix) &&
        (info.get(ref) || {}).bot === '0' && deepCols.length === 1;
      if (isSideShunt) { mid += 0.6; sideOff.set(ref, 0.6); }
      sharedParents.set(ref, [...deepCols]);
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
    const ti2 = info.get(t.ref);
    const pi0 = info.get(t.pair[0]);
    if (ti2 != null && pi0 != null && ti2.bot === pi0.top) {
      // queue PMOS : elle ALIMENTE la paire par le haut — au-dessus
      // (folded cascode : M0 se retrouvait sous M1/M2, tête en bas)
      st.level = Math.min(pa.level, pb.level) - 1;
    } else {
      st.level = Math.max(pa.level, pb.level) + 1;
    }
  }
  // règle 26 : les transistors d'un même MIROIR partagent la rangée (la plus
  // profonde du groupe) — gates sur un bus rectiligne, comme un dessin humain
  for (const mg of structures.mirrors) {
    const ss = mg.refs.map((r) => slots.get(r)).filter(Boolean);
    if (ss.length < 2) continue;
    const L = Math.max(...ss.map((x) => x.level));
    for (const x of ss) x.level = L;
  }

  // reste : un dipôle R/L/C entre deux nets de SIGNAL sans pile d'accueil
  // (ex: R de contre-réaction inter-étages) rejoint les flottants — placé au
  // barycentre de ses nets, jamais parqué dans un coin. Le vrai reste
  // (sources V vers masse, branches isolées) : colonnes à gauche.
  for (const c of comps) {
    if (!unplaced.has(c.ref)) continue;
    const ci3 = info.get(c.ref);
    if (ci3 == null) continue;
    if ('RCL'.includes(c.prefix) && ci3.top !== vddNet && ci3.top !== '0' &&
        ci3.bot !== vddNet && ci3.bot !== '0') {
      floating.add(c.ref);
      unplaced.delete(c.ref);
      continue;
    }
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
      // les paires du LATCH sont intégrées VERTICALEMENT dans les trunks :
      // les coller côte à côte détruirait le gabarit
      if (p.refs.some((r) => latchRefs.has(r))) continue;
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
      // un parent peut être lui-même à colonne fractionnaire (élément partagé
      // en cascade) : newOf ne connaît que les entières — interpoler
      const nv = (c) => (newOf.has(c) ? newOf.get(c)
        : ((newOf.get(Math.floor(c)) ?? Math.floor(c)) + (newOf.get(Math.ceil(c)) ?? Math.ceil(c))) / 2);
      sl.col = cols.map(nv).reduce((a, b) => a + b, 0) / cols.length + (sideOff.get(ref) || 0);
    }
  }

  // ---- quad : paires ADJACENTES (M3 M4 | M5 M6, style Razavi). Les
  //      colonnes issues des nets de drain ENTRELACENT les paires, ce qui
  //      force la barre de sources d'une paire à enjamber le pin de l'autre
  //      (court-circuit visuel, vu au checker). On réordonne : paire 1 sur
  //      les 2 premières colonnes, paire 2 sur les 2 suivantes ; chaque
  //      queue RF au centre de SA paire.
  for (const q of (structures.quads || [])) {
    const refs = q.refs.filter((r) => slots.has(r));
    if (refs.length !== 4) continue;
    const cols = refs.map((r) => slots.get(r).col).sort((a, b) => a - b);
    const [p1, p2] = q.pairs;
    const first = refs.reduce((a, b) => (slots.get(a).col <= slots.get(b).col ? a : b));
    const A = p1.includes(first) ? p1 : p2;
    const Bp = A === p1 ? p2 : p1;
    const ordered = [
      ...[...A].sort((x, y) => slots.get(x).col - slots.get(y).col),
      ...[...Bp].sort((x, y) => slots.get(x).col - slots.get(y).col),
    ];
    // remap oldCol -> newCol, appliqué AUSSI aux charges au-dessus du quad
    // (R2 restait au-dessus de M5 alors que son net est M4/M6 : croisement
    // gratuit de son fil de descente avec le rail de l'autre sortie)
    const colMap = new Map();
    ordered.forEach((r, i) => { colMap.set(slots.get(r).col, cols[i]); });
    const qLevel = Math.min(...refs.map((r) => slots.get(r).level));
    for (const [ref2, sl2] of slots) {
      if (refs.includes(ref2)) continue;
      if (sl2.level < qLevel && colMap.has(sl2.col)) sl2.col = colMap.get(sl2.col);
    }
    ordered.forEach((r, i) => { slots.get(r).col = cols[i]; });
    // queues RF : centre de leur paire
    const mos = comps.filter((c) => c.prefix === 'M' || c.prefix === 'Q');
    for (const rf of q.rfPair || []) {
      const sl = slots.get(rf);
      if (sl == null) continue;
      const rfc = mos.find((c) => c.ref === rf);
      const tailNet = rfc != null ? rfc.nodes[0] : null;
      const pair = [A, Bp].find((pp) => pp.some((r) => {
        const c = mos.find((k) => k.ref === r);
        return c != null && c.nodes[2] === tailNet;
      }));
      if (pair != null) {
        sl.col = pair.reduce((a2, r) => a2 + slots.get(r).col, 0) / pair.length;
      }
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
  // une paire cross-couplée partage aussi sa source : elle est REdétectée
  // comme paire diff — le flip cc (gates au centre) doit gagner, pas les deux
  const ccKeys = new Set(structures.crossCoupled.map((p) => [...p.refs].sort().join('/')));
  const dedupPairs = [...structures.diffPairs.filter((p) => !ccKeys.has([...p.refs].sort().join('/'))),
    ...structures.crossCoupled];
  for (const pr of dedupPairs) {
    if (pr.refs.some((r) => latchRefs.has(r))) {
      // latch : flip du membre GAUCHE seul (sa gate regarde le trunk
      // opposé), JAMAIS de propagation de colonne — les trunks portent
      // les étages du dessous
      const [a0, b0] = pr.refs;
      const sa0 = slots.get(a0), sb0 = slots.get(b0);
      if (sa0 != null && sb0 != null) flipRefs.add(sa0.col <= sb0.col ? a0 : b0);
      continue;
    }
    if (!wantFlip(pr)) continue;
    const [a, b] = pr.refs;
    const ca = slots.get(a), cb = slots.get(b);
    if (ca == null || cb == null) continue;
    const right = ca.col <= cb.col ? b : a;
    // paire diff : membre DROIT flippé (gates extérieures, règle 18) ;
    // cross-couplée : membre GAUCHE flippé (gates FACE AU CENTRE, le X des
    // figures publiées reste compact entre les deux transistors)
    const isCc = structures.crossCoupled.includes(pr);
    const rs = slots.get(isCc ? (right === a ? b : a) : right);
    // garde de niveau : la rangée de la paire et en dessous — jamais les
    // charges/miroirs au-dessus (leur gate doit regarder leur diode)
    for (const [ref, sl] of slots) {
      if (sl.col === rs.col && sl.level >= rs.level) flipRefs.add(ref);
    }
  }

  // règle 28 : miroir à 2 transistors -> gates FACE À FACE vers le centre
  // (flip du membre gauche, sa rangée uniquement — l'axe étant indépendant
  // du flip, l'alignement de colonne est préservé)
  for (const mg of structures.mirrors) {
    const ms = mg.refs.filter((r) => slots.has(r));
    if (ms.length !== 2) continue;
    if (ms.some((r) => quadRefs.has(r))) continue;
    const [la, lb] = ms.sort((a, b) => slots.get(a).col - slots.get(b).col);
    const sl = slots.get(la);
    for (const [ref, s2] of slots) {
      if (s2.col === sl.col && s2.level === sl.level) flipRefs.add(ref);
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

  // ---- aucun DEUX corps dans la même case (col, level) : deux paires
  //      cross-couplées partageant les mêmes nets (StrongARM) se
  //      superposaient exactement — l'alimenté descend sous son producteur
  {
    // NB : une variante « pair-aware » (bumper les deux membres d'une paire)
    // a été mesurée PIRE (cascade de collisions, StrongARM 10→26 err) — le
    // bump individuel gagne, quitte à casser la rangée d'une paire (règle 14)
    const key2 = (s) => Math.round(s.col * 4) + '|' + Math.round(s.level * 4);
    const bump = (ref2) => { slots.get(ref2).level += 1; };
    for (let pass2 = 0; pass2 < 6; pass2++) {
      let moved2 = false;
      const occ = new Map();
      for (const c of comps) {
        const s2 = slots.get(c.ref);
        if (s2 == null) continue;
        let g3 = 24;
        while (occ.has(key2(s2)) && occ.get(key2(s2)) !== c.ref && g3-- > 0) {
          const other = occ.get(key2(s2));
          const oi = info.get(other), ci4 = info.get(c.ref);
          if (oi != null && ci4 != null && oi.top === ci4.top && oi.bot === ci4.bot) {
            // éléments PARALLÈLES (mêmes deux nets, ex: C2 // R3 du
            // Colpitts) : séparation LATÉRALE — l'un sous l'autre force le
            // fil du haut à envelopper le corps du premier (wrap-around)
            s2.col += 0.6;
          } else if (oi != null && ci4 != null && ci4.bot != null && oi.top === ci4.bot) {
            // c alimente other : other descend, c prendra la case
            occ.delete(key2(slots.get(other)));
            bump(other);
          } else bump(c.ref);
          moved2 = true;
        }
        occ.set(key2(s2), c.ref);
      }
      if (!moved2) break;
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
    // selfs verticales = la MÊME bobine que l'horizontale (inductor_3),
    // simplement tournée — l'inductor_2 « rectangle IEC » dénotait avec les
    // figures publiées (remarque utilisateur)
    const w2 = w, h2 = h, shapeKey2 = ci.shapeKey, rot2 = rotation;
    let x = axisX - w2 / 2, y = cy - h2 / 2;
    if (c.prefix === 'M' || c.prefix === 'Q') x = flipped ? axisX : axisX - w2;
    else if (rot2 !== 0) {
      // dipôle tourné (+90) : amener la LIGNE DE PINS (rel y=py, tournée en
      // x = cx - (py-0.5)*h) exactement sur l'axe de conduction
      const py = (getPin(shapeKey2, ci.po[0]) || { y: 0.5 }).y;
      x = axisX + (py - 0.5) * h2 - w2 / 2;
    }
    const cell = addVertex(model, { id: c.ref, shape: shapeKey2, x, y, w: w2, h: h2, rotation: rot2, value: c.value || '' });
    if (flipped) cell.setAttribute('style', cell.getAttribute('style') + 'flipH=1;');
    // transistors : afficher le REFDES (M1...) comme dans les figures
    // publiées — le modèle (NMOS/PMOS) reste dans value pour l'extraction,
    // masqué (noLabel) ; le texte est un obstacle que le routeur évite
    if (c.prefix === 'M' || c.prefix === 'Q') {
      cell.setAttribute('style', cell.getAttribute('style') + 'noLabel=1;');
      const lw = Math.round(7.2 * c.ref.length + 6), lh = 16;
      const lx = x + w2 / 2 - lw / 2, ly = y + h2 + 4;
      addVertex(model, { id: 'LBL_' + c.ref, style: 'text;html=1;align=center;verticalAlign=middle;fontSize=12;', x: lx, y: ly, w: lw, h: lh, value: c.ref });
      placed.set('LBL_' + c.ref, { id: 'LBL_' + c.ref, x: lx, y: ly, w: lw, h: lh, rotation: 0 });
    }
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
      const cx = ga.x - 110 - k * 125; // pas compacté (le LNA étirait 800 px de vide)
      // aligner les PINS de l'élément sur la ligne de chaîne (les selfs
      // horizontales ont leurs pins au bord bas, pas au centre)
      const cy = ga.y;
      const pinRelY = (getPin(ci.shapeKey, ci.po[0]) || { y: 0.5 }).y;
      const y = ga.y - pinRelY * shape.h;
      // ORIENTATION PAR NET : le pin du net côté ancre (e.net) regarde à
      // DROITE — sinon les fils s'enroulent autour du composant
      const eFlip = e.c.nodes[0] === e.net;
      const cellE = addVertex(model, { id: e.c.ref, shape: ci.shapeKey, x: cx - shape.w / 2, y, w: shape.w, h: shape.h, rotation: 0, value: e.c.value || '' });
      if (eFlip) cellE.setAttribute('style', cellE.getAttribute('style') + 'flipH=1;');
      placed.set(e.c.ref, { id: e.c.ref, x: cx - shape.w / 2, y, w: shape.w, h: shape.h, rotation: 0, flipH: eFlip });
      for (let i = 0; i < ci.po.length; i++) term(e.c.nodes[i], e.c.ref, ci.po[i], getPin(ci.shapeKey, ci.po[i]));
      // dérivations : bias en haut (vertical), shunt masse en bas (vertical)
      // AXE = le MILIEU du fil de jonction (entre le pin de cet élément et
      // celui du voisin côté ancre) : le té répartit les espaces comme dans
      // un dessin humain (remarque utilisateur sur Cm), et le fil du hanger
      // tombe droit dessus (zéro coude, remarque sur Lb1)
      const jPin = getPin(ci.shapeKey, ci.po[Math.max(0, e.c.nodes.indexOf(e.net))]) || { x: 1, y: 0.5 };
      const jSelfX = pinAbs(placed.get(e.c.ref), jPin).x;
      let jPrevX = ga.x;
      const kIdx = ch.elems.indexOf(e);
      if (kIdx > 0) {
        const pe = ch.elems[kIdx - 1].c;
        const pi = info.get(pe.ref);
        const pPin = getPin(pi.shapeKey, pi.po[Math.max(0, pe.nodes.indexOf(e.net))]) || { x: 0, y: 0.5 };
        const pp2 = placed.get(pe.ref);
        if (pp2 != null) jPrevX = pinAbs(pp2, pPin).x;
      }
      const junctionX = (jSelfX + jPrevX) / 2;
      let upK = 0, downK = 0;
      for (const h of e.hangers) {
        const hi = info.get(h.c.ref);
        // rot +90 met nodes[0] ('in') en HAUT, -90 en BAS ; le pin du net
        // partagé (e.net) doit regarder la chaîne : bas pour un hanger haut,
        // haut pour un shunt bas — Lb1 était monté à l'envers (fil en Π)
        const inShared = h.c.nodes[0] === e.net;
        const hShape = hi.shapeKey, hRot = h.up ? (inShared ? -90 : 90) : (inShared ? 90 : -90);
        const hs = getShape(hShape);
        const hx = junctionX + (h.up ? (upK++) : (downK++)) * 40;
        const hh = hs.w;
        const hy = h.up ? cy - 80 - hh / 2 : cy + 80 + hh / 2;
        // ligne de pins du dipôle tourné sur l'axe vertical hx
        const hpy = (getPin(hShape, hi.po[0]) || { y: 0.5 }).y;
        const hxpos = hx + (hRot === 90 ? 1 : -1) * (hpy - 0.5) * hs.h - hs.w / 2;
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
      const cx = ga.x - 110 - k * 125; // pas compacté (le LNA étirait 800 px de vide)
      const cy = ga.y + 90;
      addVertex(model, { id: ch.endV.ref, shape: vi.shapeKey, x: cx - vs.w / 2, y: cy - vs.h / 2, w: vs.w, h: vs.h, rotation: 0, value: ch.endV.value || '' });
      placed.set(ch.endV.ref, { id: ch.endV.ref, x: cx - vs.w / 2, y: cy - vs.h / 2, w: vs.w, h: vs.h, rotation: 0 });
      for (let i = 0; i < vi.po.length; i++) term(ch.endV.nodes[i], ch.endV.ref, vi.po[i], getPin(vi.shapeKey, vi.po[i]));
    }
  }

  // ---- justification verticale des colonnes : les dipôles de pile se
  //      répartissent à GAPS ÉGAUX entre les éléments fixes (transistors,
  //      dont les rangées sont structurelles) — les nœuds/tés verticaux
  //      tombent alors à espaces réguliers (règle utilisateur)
  {
    const drawnBoxOf = (v) => {
      const rot = ((v.rotation || 0) % 180 + 180) % 180 !== 0;
      const cx2 = v.x + v.w / 2, cy2 = v.y + v.h / 2;
      const w2 = rot ? v.h : v.w, h2 = rot ? v.w : v.h;
      return { top: cy2 - h2 / 2, bot: cy2 + h2 / 2, h: h2 };
    };
    // les colonnes d'une paire CROSS-COUPLÉE sont exclues : la ligne de
    // vue du X (diagonales) est un équilibre géométrique voulu que le
    // moindre décalage vertical casse (vu : VCO)
    const ccCols = new Set();
    for (const pr of (structures.crossCoupled || [])) {
      for (const r of pr.refs) {
        const sl2 = slots.get(r);
        if (sl2 != null) ccCols.add(Math.round(sl2.col));
      }
    }
    const cols = new Map();
    for (const c of comps) {
      const sl = slots.get(c.ref);
      if (sl == null || !Number.isInteger(sl.col) || !placed.has(c.ref)) continue;
      if (floating.has(c.ref) || chainRefs.has(c.ref)) continue;
      if (ccCols.has(sl.col)) continue;
      if (!cols.has(sl.col)) cols.set(sl.col, []);
      cols.get(sl.col).push(c);
    }
    for (const [, items] of cols) {
      const sorted = items.map((c) => ({ c, p: placed.get(c.ref) }))
        .sort((u, v2) => u.p.y - v2.p.y);
      // segments entre éléments FIXES (MOS/Q) consécutifs
      let segStart = null; // {bot} borne haute du segment
      let mobiles = [];
      const flush = (boundBot) => {
        if (mobiles.length === 0) { mobiles = []; return; }
        const boxes = mobiles.map((m) => drawnBoxOf(m.p));
        const topLim = segStart != null ? segStart : boxes[0].top;
        const botLim = boundBot;
        if (botLim == null) { mobiles = []; return; }
        const space = botLim - topLim - boxes.reduce((a2, b2) => a2 + b2.h, 0);
        if (space < mobiles.length + 1) { mobiles = []; return; }
        const gap = space / (mobiles.length + 1);
        let cursor = topLim + gap;
        mobiles.forEach((m, i2) => {
          const bx = boxes[i2];
          // déplacement BORNÉ : l'équilibrage ne doit pas casser les
          // lignes de vue et corridors accordés autour de la grille
          const dy = Math.max(-20, Math.min(20, cursor - bx.top));
          if (Math.abs(dy) > 1) {
            m.p.y += dy;
            updateCell(model, m.c.ref, { dy });
          }
          cursor += bx.h + gap;
        });
        mobiles = [];
      };
      for (const it of sorted) {
        const fixed = it.c.prefix === 'M' || it.c.prefix === 'Q';
        const bx = drawnBoxOf(it.p);
        if (fixed) {
          flush(bx.top);
          segStart = bx.bot;
        } else {
          mobiles.push(it);
        }
      }
      flush(null);
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
    // cap de CONTRE-RÉACTION (Miller) : ses deux nets touchent la gate et
    // le drain du MÊME transistor -> discrète, VERTICALE, collée à côté du
    // transistor entre les deux niveaux (règle utilisateur : pas de voûtes,
    // pas de fils au même potentiel qui se longent, pas de coudes)
    if (c.prefix === 'C') {
      const ccRefs = new Set(structures.crossCoupled.flatMap((pr) => pr.refs));
      const fb = comps.find((m2) => {
        if ((m2.prefix !== 'M' && m2.prefix !== 'Q') || !placed.has(m2.ref)) return false;
        // cross-couplé : gate/drain sont les nets l'un de l'autre — la cap
        // de RÉSERVOIR n'est pas une Miller
        if (ccRefs.has(m2.ref)) return false;
        const mi = info.get(m2.ref);
        if (mi == null) return false;
        const nets = [ci.top, ci.bot];
        return nets.includes(mi.gate) && nets.includes(m2.nodes[0]) && mi.gate !== m2.nodes[0];
      });
      if (fb != null) {
        const mi = info.get(fb.ref);
        const pM = placed.get(fb.ref);
        const gAbs = pinAbs(pM, getPin(mi.shapeKey, mi.gatePin));
        const dAbs = pinAbs(pM, getPin(mi.shapeKey, mi.po[0]));
        const shape2 = getShape(ci.shapeKey);
        // HORIZONTALE, dans le corridor SOUS le transistor (entre les
        // rangées, comme les figures publiées) : taps courts sur les deux
        // verticales, jamais coincée sous un corps (cul-de-sac vu sur M6)
        const cxC = (gAbs.x + dAbs.x) / 2;
        const cyC = Math.max(pM.y + pM.h, Math.max(gAbs.y, dAbs.y)) + 45;
        const leftNet = gAbs.x <= dAbs.x ? mi.gate : fb.nodes[0];
        const flipC = ci.top !== leftNet;
        const xC = cxC - shape2.w / 2, yC = cyC - shape2.h / 2;
        const cellC = addVertex(model, { id: c.ref, shape: ci.shapeKey, x: xC, y: yC, w: shape2.w, h: shape2.h, rotation: 0, value: c.value || '' });
        if (flipC) cellC.setAttribute('style', cellC.getAttribute('style') + 'flipH=1;');
        placed.set(c.ref, { id: c.ref, x: xC, y: yC, w: shape2.w, h: shape2.h, rotation: 0, flipH: flipC });
        for (let i2 = 0; i2 < ci.po.length; i2++) term(c.nodes[i2], c.ref, ci.po[i2], getPin(ci.shapeKey, ci.po[i2]));
        continue;
      }
    }
    let cx, cy, flipF = false;
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
      // ORIENTATION : le pin LIBRE (futur port) regarde vers l'extérieur
      flipF = empty0 ? dir > 0 : dir < 0;
    } else {
      cx = (anchors[0].x + anchors[1].x) / 2;
      cy = (anchors[0].y + anchors[1].y) / 2 + (P.floatDrop || 0);
      // ORIENTATION : le pin 'in' (nodes[0]) regarde le centroïde de SON net
      flipF = anchors[0].x > anchors[1].x;
    }
    // liaison principalement VERTICALE : dipôle tourné (règle 42 — un corps
    // horizontal entre deux nets superposés force un fil qui enveloppe)
    let rotF = 0;
    if (anchors[0].n > 0 && anchors[1].n > 0 && 'RCLD'.includes(c.prefix) &&
        Math.abs(anchors[0].y - anchors[1].y) > Math.abs(anchors[0].x - anchors[1].x) + 20) {
      rotF = anchors[0].y <= anchors[1].y ? 90 : -90; // +90 : 'in' en HAUT
      flipF = false;
    }
    let x = cx - shape.w / 2, y = cy - shape.h / 2;
    // JAMAIS sur un autre corps : on remonte (puis descend) jusqu'à une
    // position libre — la capa du tank VCO se posait sur les transistors
    // boîte DESSINÉE (une self rot90 fait 8 px de large, pas 100 : la
    // boîte brute chassait la cap série à 48 px du milieu du tronc)
    const drawn = (v) => {
      const rot = ((v.rotation || 0) % 180 + 180) % 180 !== 0;
      const cx2 = v.x + v.w / 2, cy2 = v.y + v.h / 2;
      const w2 = rot ? v.h : v.w, h2 = rot ? v.w : v.h;
      return { x: cx2 - w2 / 2, y: cy2 - h2 / 2, w: w2, h: h2 };
    };
    const overlaps = () => [...placed.values()].some((v0) => {
      const v = drawn(v0);
      return x < v.x + v.w + 24 && x + shape.w > v.x - 24 && y < v.y + v.h + 24 && y + shape.h > v.y - 24;
    });
    if (overlaps()) {
      // dégagement le plus PROCHE de l'idéal, dans les 4 directions — le
      // push aveugle vers le haut envoyait la cap Miller au-dessus des VDD
      const x00 = x, y00 = y;
      let best = null;
      for (const [dx2, dy2] of [[0, -20], [0, 20], [-20, 0], [20, 0], [-20, -20], [20, -20], [-20, 20], [20, 20]]) {
        for (let k = 1; k <= 12; k++) {
          x = x00 + dx2 * k; y = y00 + dy2 * k;
          if (!overlaps()) {
            // le vertical est préféré : le latéral coûte double (il ignore
            // les masses/taps qui naîtront plus tard au droit des pins)
            const d2 = Math.hypot(x - x00, y - y00) * (dx2 !== 0 ? 2 : 1);
            if (best == null || d2 < best.d2) best = { x, y, d2 };
            break;
          }
        }
      }
      if (best != null) { x = best.x; y = best.y; } else { x = x00; y = y00; }
    }
    const cellF = addVertex(model, { id: c.ref, shape: ci.shapeKey, x, y, w: shape.w, h: shape.h, rotation: rotF, value: c.value || '' });
    if (flipF) cellF.setAttribute('style', cellF.getAttribute('style') + 'flipH=1;');
    placed.set(c.ref, { id: c.ref, x, y, w: shape.w, h: shape.h, rotation: rotF, flipH: flipF });
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

  // ---- aucun corps sur un autre : la diode accolée (colonne -0.55) peut
  //      chevaucher sa voisine quand colW rétrécit -> pousser vers la gauche
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    const ids = [...placed.keys()].filter((r) => slots.has(r) && placed.get(r).w >= 20);
    const drawnBox = (v) => {
      const rot = ((v.rotation || 0) % 180 + 180) % 180 !== 0;
      const cx2 = v.x + v.w / 2, cy2 = v.y + v.h / 2;
      const w2 = rot ? v.h : v.w, h2 = rot ? v.w : v.h;
      return { x: cx2 - w2 / 2, y: cy2 - h2 / 2, w: w2, h: h2 };
    };
    for (const r1 of ids) {
      for (const r2 of ids) {
        if (r1 === r2) continue;
        const a2 = drawnBox(placed.get(r1)), b2 = drawnBox(placed.get(r2));
        const ox = Math.min(a2.x + a2.w, b2.x + b2.w) - Math.max(a2.x, b2.x);
        const oy = Math.min(a2.y + a2.h, b2.y + b2.h) - Math.max(a2.y, b2.y);
        if (ox <= 4 || oy <= 4) continue;
        const frac = !Number.isInteger(slots.get(r1).col) ? r1
          : (!Number.isInteger(slots.get(r2).col) ? r2 : null);
        if (frac == null) continue;
        const v = placed.get(frac);
        const dx = -(ox + 26); // place pour le cadre de diode (16 px + marge)
        v.x += dx;
        updateCell(model, frac, { dx });
        moved = true;
      }
    }
    if (!moved) break;
  }

  // ---- source de polarisation au-dessus de sa diode : alignée sur le pin
  //      de drain (plongée droite, pas de baïonnette — remarque utilisateur)
  for (const c of comps) {
    if (c.prefix !== 'I' && c.prefix !== 'V') continue;
    const p2 = placed.get(c.ref); const ci2 = info.get(c.ref);
    if (p2 == null || ci2 == null) continue;
    const diode = comps.find((m2) => m2.prefix === 'M' && m2.nodes[0] === m2.nodes[1] &&
      m2.nodes[0] === ci2.bot && placed.has(m2.ref));
    if (diode == null) continue;
    const dpin = pinAbs(placed.get(diode.ref), getPin(info.get(diode.ref).shapeKey, info.get(diode.ref).po[0]));
    const bot = pinAbs(p2, getPin(ci2.shapeKey, ci2.botPin || ci2.po[1]));
    const dx2 = dpin.x - bot.x;
    if (Math.abs(dx2) > 2 && Math.abs(dx2) < 150) { p2.x += dx2; updateCell(model, c.ref, { dx: dx2 }); }
  }

  // ---- RÈGLE 52 : sens de lecture européen — entrées à GAUCHE, sorties à
  //      DROITE. Si le placement sort inversé, miroir GLOBAL avant câblage
  //      (x réfléchi, flipH basculé, rotation opposée ; cellules texte : x
  //      seulement)
  {
    const inRe = /^(in\d*$|inp|inm|vin|rf|lo|clk)/i, outRe = /^(out|vout|sa$|if)/i;
    const xs = { i: [], o: [] };
    for (const c of comps) {
      const p2 = placed.get(c.ref);
      if (p2 == null) continue;
      for (const n2 of c.nodes) {
        if (inRe.test(n2)) xs.i.push(p2.x + p2.w / 2);
        else if (outRe.test(n2)) xs.o.push(p2.x + p2.w / 2);
      }
    }
    const mean2 = (a2) => a2.reduce((s2, v2) => s2 + v2, 0) / a2.length;
    if (xs.i.length && xs.o.length && mean2(xs.i) > mean2(xs.o) + 20) {
      const boxes2 = [...placed.values()];
      const M2 = Math.min(...boxes2.map((v2) => v2.x)) + Math.max(...boxes2.map((v2) => v2.x + v2.w));
      for (const [ref2, p2] of placed) {
        const cell2 = getCell(model, ref2);
        const isText = ref2.startsWith('LBL_');
        const nx = M2 - p2.x - p2.w;
        p2.x = nx;
        if (cell2 != null) {
          const g2 = cell2.getElementsByTagName('mxGeometry')[0];
          if (g2 != null) g2.setAttribute('x', String(nx));
        }
        if (isText) continue;
        p2.flipH = !p2.flipH;
        if (p2.rotation) p2.rotation = -p2.rotation;
        if (cell2 != null) {
          let st3 = cell2.getAttribute('style') || '';
          st3 = st3.includes('flipH=1') ? st3.replace('flipH=1;', '') : st3 + 'flipH=1;';
          st3 = st3.replace(/rotation=(-?\d+(?:\.\d+)?)/, (m3, r3) => 'rotation=' + (-parseFloat(r3)));
          cell2.setAttribute('style', st3);
        }
      }
    }
  }

  // étiquettes : composant à flux VERTICAL (fils en haut/bas) -> étiquette
  // sur le FLANC gauche, où la place est libre. Pour un dipôle TOURNÉ, le
  // label du symbole tournerait avec lui (texte couché, remarque
  // utilisateur) : on le masque (noLabel) et on pose une CELLULE TEXTE
  // horizontale à gauche — qui devient au passage un obstacle de routage.
  for (const c of comps) {
    const cell2 = getCell(model, c.ref);
    if (cell2 == null) continue;
    const st2 = cell2.getAttribute('style') || '';
    if (/transistor|mosfet|nmos|pmos/.test(st2)) continue;
    const p2 = placed.get(c.ref);
    if (p2 == null) continue;
    const rotated = ((p2.rotation || 0) % 180 + 180) % 180 !== 0;
    const dw = rotated ? p2.h : p2.w, dh = rotated ? p2.w : p2.h;
    if (dh < dw) continue;
    if (!rotated) {
      cell2.setAttribute('style', st2.replace('verticalLabelPosition=bottom;verticalAlign=top;',
        'verticalLabelPosition=middle;verticalAlign=middle;labelPosition=left;align=right;spacing=8;'));
      continue;
    }
    const txt = c.value || '';
    if (!txt) continue;
    cell2.setAttribute('style', st2 + 'noLabel=1;');
    const lw = Math.round(7.2 * String(txt).length + 6), lh = 16;
    const cxb = p2.x + p2.w / 2, cyb = p2.y + p2.h / 2;
    const lx = cxb - dw / 2 - 6 - lw, ly = cyb - lh / 2;
    const lid = 'LBL_' + c.ref;
    addVertex(model, { id: lid, style: 'text;html=1;align=right;verticalAlign=middle;fontSize=12;', x: lx, y: ly, w: lw, h: lh, value: String(txt) });
    placed.set(lid, { id: lid, x: lx, y: ly, w: lw, h: lh, rotation: 0 });
  }

  // NB : une passe de flip barycentrique des dipôles verticaux (règle 42) a
  // été mesurée NÉGATIVE ici (le x des dipôles tournés est calculé pour +90 ;
  // inverser la rotation décale la ligne de pins ; gilbert 64->40) — retirée.

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
    // NB : retirer le move de flip a été mesuré PIRE (gilbert 0->4 err,
    // vco-lc-pmos 0->4) — la recherche CORRIGE plus d'orientations qu'elle
    // n'en casse (R4/L3 à l'envers = 2 err, contre 9 sans le move)
    flippable: comps.filter((c) => 'RCLD'.includes(c.prefix)).map((c) => c.ref) };
}
