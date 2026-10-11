import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { toNeutral, neutralNetlist, checkNeutral } from '../lib/neutral.js';

const DECK = `M1 out in 0 0 nmos\nR1 vdd out 1k\nC1 out 0 1p\n.end`;

test('neutral: a drawn page gives a neutral schematic whose geometry alone redraws the deck', async () => {
  const p = parseSpice(DECK);
  const N = toNeutral(getPage((await autoPlace(p)).doc));
  assert.equal(N.format, 'schema-neutre/1');
  assert.deepEqual(N.components.map((c) => c.ref).sort(), ['C1', 'M1', 'R1']);
  assert.ok(N.wires.length > 0 && N.wires.every((w) => w.points.length >= 2));
  assert.ok(N.rails.some((r) => r.kind === 'ground'));
  assert.ok(checkNeutral(N, p).match);
});

test('neutral: a wire end moved off its pin is caught by the neutral LVS', async () => {
  const p = parseSpice(DECK);
  const N = toNeutral(getPage((await autoPlace(p)).doc));
  // cut every wire touching R1's pins (R1 floats): the geometry no longer redraws the deck
  const r1 = N.components.find((c) => c.ref === 'R1');
  const at = Object.values(r1.pins).map((q) => q.at.join(','));
  for (const w of N.wires) for (const pt of [w.points[0], w.points.at(-1)]) if (at.includes(pt.join(','))) { pt[0] += 7; pt[1] += 7; }
  assert.equal(checkNeutral(N, p).match, false);
  assert.ok(neutralNetlist(N).components.find((c) => c.ref === 'R1'));
});
