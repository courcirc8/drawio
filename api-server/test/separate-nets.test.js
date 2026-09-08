// Tests de caractérisation de separateNets (lib/route.js).
//
// Ils figent le comportement OBSERVÉ aujourd'hui pour permettre de refactorer
// la fonction (boucle de réparation O(n²) sur les segments) sans changer ce
// qu'elle produit. Un test qui casse ici signifie « le rendu a changé »,
// pas forcément « le code est faux » : relire le diff des waypoints avant de
// mettre le snapshot à jour.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../lib/model.js';
import { separateNets } from '../lib/route.js';

const RES = 'mxgraph.electrical.resistors.resistor_2';

function page() {
  const doc = model.newDocument();
  return model.getPage(doc);
}

function box(m, id, x, y, w = 20, h = 20) {
  model.addVertex(m, { id, shape: RES, x, y, w, h });
  return { id, x, y, w, h, isMos: false };
}

/** Anchor absolu d'une extrémité (pin relative sur un vertex non tourné). */
function anchor(byId, cell, prefix) {
  const v = byId.get(prefix === 'exit' ? cell.source : cell.target);
  const X = parseFloat(cell.style.map.get(prefix + 'X'));
  const Y = parseFloat(cell.style.map.get(prefix + 'Y'));
  return { x: v.x + X * v.w, y: v.y + Y * v.h };
}

/** Segments H/V (lane, [a,b]) de chaque fil, comme separateNets les voit. */
function segments(m) {
  const cells = model.allCells(m).map(model.cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const out = [];
  for (const c of cells) {
    if (c.kind !== 'edge') continue;
    const pl = [anchor(byId, c, 'exit'), ...(c.points || []), anchor(byId, c, 'entry')];
    for (let i = 0; i + 1 < pl.length; i++) {
      const p = pl[i], q = pl[i + 1];
      if (Math.abs(p.y - q.y) < 0.6 && Math.abs(p.x - q.x) >= 0.6) out.push({ id: c.id, axis: 'h', lane: p.y, a: Math.min(p.x, q.x), b: Math.max(p.x, q.x) });
      else if (Math.abs(p.x - q.x) < 0.6 && Math.abs(p.y - q.y) >= 0.6) out.push({ id: c.id, axis: 'v', lane: p.x, a: Math.min(p.y, q.y), b: Math.max(p.y, q.y) });
    }
  }
  return out;
}

/** Paires de segments de fils DIFFÉRENTS colinéaires (< 6 px) et recouvrants (> 10 px). */
function overlaps(m, sameNet = () => false) {
  const segs = segments(m);
  const found = [];
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s = segs[i], t = segs[j];
    if (s.id === t.id || sameNet(s.id, t.id)) continue;
    if (s.axis !== t.axis || Math.abs(s.lane - t.lane) >= 6) continue;
    if (Math.min(s.b, t.b) - Math.max(s.a, t.a) > 10) found.push([s, t]);
  }
  return found;
}

function points(m, id) {
  return model.cellInfo(model.getCell(m, id)).points;
}

/** Deux nets étrangers qui partagent la lane horizontale y=50 sur [10,310]. */
function twoNetsOnOneLane(fixedStyle) {
  const m = page();
  const obstacles = [box(m, 'A', 0, 0), box(m, 'B', 300, 0), box(m, 'C', 0, 100), box(m, 'D', 300, 100)];
  const lane = [{ x: 10, y: 50 }, { x: 310, y: 50 }];
  model.addWire(m, { id: 'n1', source: 'A', target: 'B', sourcePin: { x: 0.5, y: 1 }, targetPin: { x: 0.5, y: 1 }, points: lane.map((p) => ({ ...p })) });
  model.addWire(m, { id: 'n2', source: 'C', target: 'D', sourcePin: { x: 0.5, y: 0 }, targetPin: { x: 0.5, y: 0 }, points: lane.map((p) => ({ ...p })),
    style: fixedStyle });
  return { m, obstacles };
}

test('separateNets: deux nets sur la même lane ne se recouvrent plus', () => {
  const { m, obstacles } = twoNetsOnOneLane();
  assert.equal(overlaps(m).length, 1, 'le fixture doit partir d\'un recouvrement');
  separateNets(m, obstacles);
  assert.deepEqual(overlaps(m), []);
  // snapshot : c'est le PREMIER fil (n1) qui bouge, de -14 px (premier delta essayé) ; n2 reste en place
  assert.deepEqual(points(m, 'n1'), [{ x: 10, y: 36 }, { x: 310, y: 36 }]);
  assert.deepEqual(points(m, 'n2'), [{ x: 10, y: 50 }, { x: 310, y: 50 }]);
});

test('separateNets: un fil drawioApiFixedRoute ne bouge jamais, l\'autre s\'écarte', () => {
  const fixed = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;jettySize=auto;endArrow=none;endFill=0;drawioApiFixedRoute=1;';
  const { m, obstacles } = twoNetsOnOneLane(fixed);
  const before = points(m, 'n2');
  separateNets(m, obstacles);
  assert.deepEqual(points(m, 'n2'), before);
  assert.deepEqual(overlaps(m), []);
  assert.deepEqual(points(m, 'n1'), [{ x: 10, y: 36 }, { x: 310, y: 36 }]);
});

test('separateNets: idempotente, un second appel ne change rien', () => {
  const { m, obstacles } = twoNetsOnOneLane();
  separateNets(m, obstacles);
  const n1 = points(m, 'n1'), n2 = points(m, 'n2');
  separateNets(m, obstacles);
  assert.deepEqual(points(m, 'n1'), n1);
  assert.deepEqual(points(m, 'n2'), n2);
});

test('separateNets: deux fils du MÊME net colinéaires sont laissés tels quels', () => {
  const m = page();
  const obstacles = [box(m, 'A', 0, 0), box(m, 'B', 300, 0), box(m, 'C', 600, 0)];
  // A-B et B-C partagent le pin de B : même composante connexe (union-find sur les clés d'extrémité)
  model.addWire(m, { id: 'w1', source: 'A', target: 'B', sourcePin: { x: 0.5, y: 1 }, targetPin: { x: 0.5, y: 1 }, points: [{ x: 10, y: 50 }, { x: 310, y: 50 }] });
  model.addWire(m, { id: 'w2', source: 'B', target: 'C', sourcePin: { x: 0.5, y: 1 }, targetPin: { x: 0.5, y: 1 }, points: [{ x: 310, y: 50 }, { x: 610, y: 50 }] });
  const before = [points(m, 'w1'), points(m, 'w2')];
  separateNets(m, obstacles);
  assert.deepEqual([points(m, 'w1'), points(m, 'w2')], before);
});

test('separateNets: un fil qui frôle (< 6 px) le pin d\'un net étranger s\'en écarte', () => {
  const m = page();
  const obstacles = [box(m, 'A', 0, 0), box(m, 'B', 300, 0), box(m, 'C', 0, 100), box(m, 'D', 300, 100)];
  // n1 sort du bas de A (10,20) vers le bas de B ; n2 passe sous A à y=24, à 4 px du pin de A
  model.addWire(m, { id: 'n1', source: 'A', target: 'B', sourcePin: { x: 0.5, y: 1 }, targetPin: { x: 0.5, y: 1 }, points: [{ x: 10, y: 60 }, { x: 310, y: 60 }] });
  model.addWire(m, { id: 'n2', source: 'C', target: 'D', sourcePin: { x: 0.5, y: 0 }, targetPin: { x: 0.5, y: 0 }, points: [{ x: 10, y: 24 }, { x: 310, y: 24 }] });
  const before = points(m, 'n2');
  separateNets(m, obstacles);
  const after = points(m, 'n2');
  assert.notDeepEqual(after, before, 'le fil frôlant doit avoir bougé');
  const lane = after[0].y;
  assert.ok(Math.abs(lane - 20) >= 6, 'la lane du fil doit être à >= 6 px du pin (10,20), obtenu y=' + lane);
  // snapshot du comportement ACTUEL : un dog-leg vers x=-4 est inséré sur le segment
  // vertical (10,24)->(10,100) puis la lane horizontale est décalée de +14 (24 -> 38).
  // Deux quirks à traiter lors du refactor, figés ici pour ne pas les changer par accident :
  //  - le waypoint (10,38) est dupliqué ;
  //  - le détour part à gauche de A (x=-4) alors que le fil ne longe A que sur 10 px.
  assert.deepEqual(after, [
    { x: 10, y: 34 }, { x: -4, y: 34 }, { x: -4, y: 38 }, { x: 10, y: 38 }, { x: 10, y: 38 }, { x: 310, y: 38 },
  ]);
});

test('separateNets: sans conflit, aucun waypoint ne change', () => {
  const m = page();
  const obstacles = [box(m, 'A', 0, 0), box(m, 'B', 300, 0), box(m, 'C', 0, 200), box(m, 'D', 300, 200)];
  model.addWire(m, { id: 'n1', source: 'A', target: 'B', sourcePin: { x: 0.5, y: 1 }, targetPin: { x: 0.5, y: 1 }, points: [{ x: 10, y: 50 }, { x: 310, y: 50 }] });
  model.addWire(m, { id: 'n2', source: 'C', target: 'D', sourcePin: { x: 0.5, y: 0 }, targetPin: { x: 0.5, y: 0 }, points: [{ x: 10, y: 150 }, { x: 310, y: 150 }] });
  const before = [points(m, 'n1'), points(m, 'n2')];
  separateNets(m, obstacles);
  assert.deepEqual([points(m, 'n1'), points(m, 'n2')], before);
});
