import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, getPage, addVertex, addWire } from '../lib/model.js';
import { crossingCount } from '../lib/crossings.js';

// four port markers at the corners of a square; wires join their centres
function square() {
  const model = getPage(newDocument(), null);
  const pts = { A: [0, 0], B: [100, 0], C: [0, 100], D: [100, 100] };
  for (const [id, [x, y]] of Object.entries(pts)) addVertex(model, { id, shape: 'port', x, y, w: 10, h: 10 });
  return model;
}

test('two diagonals of different nets cross once', () => {
  const m = square();
  addWire(m, { id: 'w1', source: 'A', target: 'D' });
  addWire(m, { id: 'w2', source: 'B', target: 'C' });
  assert.equal(crossingCount(m), 1);
});

test('parallel wires do not cross', () => {
  const m = square();
  addWire(m, { id: 'w1', source: 'A', target: 'B' });
  addWire(m, { id: 'w2', source: 'C', target: 'D' });
  assert.equal(crossingCount(m), 0);
});

test('wires sharing an end vertex (touching) do not count', () => {
  const m = square();
  addWire(m, { id: 'w1', source: 'A', target: 'D' });
  addWire(m, { id: 'w2', source: 'A', target: 'B' });
  assert.equal(crossingCount(m), 0);
});

test('a bend point that makes a wire cross another is counted', () => {
  const m = square();
  addWire(m, { id: 'w1', source: 'A', target: 'B' });
  addWire(m, { id: 'w2', source: 'C', target: 'D', points: [{ x: 55, y: 105 }, { x: 55, y: -20 }, { x: 70, y: -20 }, { x: 70, y: 105 }] });
  assert.equal(crossingCount(m), 2);
});

test('empty drawing has no crossings', () => {
  assert.equal(crossingCount(getPage(newDocument(), null)), 0);
});
