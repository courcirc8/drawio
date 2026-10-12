import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { qualityGate } from '../lib/quality.js';
import { bandgapReading } from '../lib/place-bandgap.js';

// bandgap cores (lib/place-bandgap.js), written for the test (no bank circuit)
const MIRROR3 = `* PMOS mirror feeding three columns: plain diode, ΔVbe resistor, output resistor
M1 x g vdd vdd pmos
M2 y g vdd vdd pmos
M3 out g vdd vdd pmos
Q1 0 0 x pnp
R1 y z 10k
Q2 0 0 z pnp
R2 out w 100k
Q3 0 0 w pnp
EA g 0 y x 1000
.end`;
const RES2 = `* resistor-fed columns with Banba resistors to the ground
R3 vdd x 10k
R4 vdd y 10k
Q1 0 0 x pnp
R1 y z 1k
Q2 0 0 z pnp
R5 x 0 50k
R6 y 0 50k
EA o 0 y x 1000
.end`;

test('bandgap: three mirror-fed columns are read, the plain diode first', () => {
  const R = bandgapReading(parseSpice(MIRROR3));
  assert.ok(R);
  assert.equal(R.cols.length, 3);
  assert.deepEqual(R.cols[0], { q: 'Q1', chain: [], feed: 'M1', top: 'x', bottom: 'x' });
  assert.equal(R.mirror, 'g');
});

test('bandgap: resistor-fed columns and their Banba resistors are read', () => {
  const R = bandgapReading(parseSpice(RES2));
  assert.ok(R);
  assert.deepEqual(R.cols.map((c) => [c.feed, ...c.chain, c.q]), [['R3', 'Q1'], ['R4', 'R1', 'Q2']]);
  assert.deepEqual(R.side.map((s) => s.r).sort(), ['R5', 'R6']);
});

test('bandgap: two plain diodes with no series resistor are not read', () => {
  assert.equal(bandgapReading(parseSpice('R1 vdd a 1k\nR2 vdd b 1k\nQ1 a a 0 npn\nQ2 b b 0 npn\n.end')), null);
});

for (const [name, net] of [['mirror-fed', MIRROR3], ['resistor-fed', RES2]]) {
  test(`bandgap: the ${name} core is drawn by the template, LVS-clean, through the quality gate`, async () => {
    const p = parseSpice(net);
    const r = await autoPlace(p);
    const m = getPage(r.doc);
    assert.equal(r.label, 'bandgap');
    assert.ok(compare(extractNetlist(m), p).match);
    // (the controlled source standing for the amplifier is outside the
    // template: its port wire may keep a bend)
    const q = qualityGate(m, p), failed = Object.entries(q.checks).filter(([k, c]) => !c.ok && k !== 'avoidable');
    assert.deepEqual(failed, []);
  });
}

test('bandgap: AUTO_BANDGAP=0 disables the template', async () => {
  process.env.AUTO_BANDGAP = '0';
  try {
    const r = await autoPlace(parseSpice(RES2));
    assert.notEqual(r.label, 'bandgap');
  } finally { delete process.env.AUTO_BANDGAP; }
});
