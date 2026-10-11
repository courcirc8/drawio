import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice } from '../lib/netlist.js';
import { qxform } from '../lib/export-qucs.js';
import { lxform } from '../lib/export-ltspice.js';
import { ascLvs, deliverLtspice } from '../tools/ltspice-check.mjs';
import { exportLtspice } from '../lib/export-ltspice.js';

const DECK = 'M1 out in 0 0 nmos W=2u L=0.13u\nR1 vdd out 1k\nC1 out 0 1p\n.end';

test('qucs transform: mirror (y → −y) then rotations (x, y) → (y, −x), 8 distinct cases', () => {
  assert.deepEqual(qxform([30, 0], 1, 0), [0, -30]);
  const seen = new Set(); for (let r = 0; r < 4; r++) for (const m of [0, 1]) seen.add(qxform([0, -30], r, m).concat(qxform([20, 0], r, m)).join(','));
  assert.equal(seen.size, 8);
});

test('ltspice transform: 16 LTspice units = 10, mirror then R90 (x, y) → (−y, x)', () => {
  assert.deepEqual(lxform([16, 16], 'R0'), [10, 10]);
  assert.deepEqual(lxform([16, 96], 'R270'), [60, -10]);
});

test('ltspice export: real wires (no flag per pin), re-read by the .asc reader with LVS matching', async () => {
  const p = parseSpice(DECK), r = await exportLtspice(p);
  assert.ok(r.asc.split('\n').filter((l) => l.startsWith('WIRE ')).length >= 4);
  assert.ok(r.asc.split('\n').filter((l) => l.startsWith('FLAG ')).length < 8, 'flags for rails / ports / bulks only');
  assert.ok(ascLvs(r.asc, p).match);
  void deliverLtspice;
});
