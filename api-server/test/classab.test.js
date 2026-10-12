import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { qualityGate } from '../lib/quality.js';
import { classabReading } from '../lib/place-classab.js';

// class-AB output stages (lib/place-classab.js), written for the test (no bank circuit)
const MONTICELLI = `* class-AB common-source output, floating current source (Monticelli), driver and top source
MP out a vdd vdd pmos
MN out b 0 0 nmos
MF1 a vbn b 0 nmos
MF2 b vbp a vdd pmos
MS a vbs vdd vdd pmos
MD b in 0 0 nmos
CL out 0 10p
.end`;
const FOLLOWER = `* MOS source-follower class-AB output biased by two diode-connected devices
M1 vdd a out 0 nmos
M2 0 b out vdd pmos
M3 a a m 0 nmos
M4 b b m vdd pmos
I1 vdd a 50u
M5 b in 0 0 nmos
RL out 0 1k
.end`;

test('classab: a common-source stage with a floating current source is read', () => {
  const R = classabReading(parseSpice(MONTICELLI));
  assert.ok(R);
  assert.deepEqual([R.kind, R.top, R.bot, R.A, R.B, R.fA, R.fB], ['cs', 'MP', 'MN', 'a', 'b', 'MS', 'MD']);
  assert.deepEqual(R.steps.map((s) => [...s.parts].sort()), [['MF1', 'MF2']]);
  assert.deepEqual(R.loads, ['CL']);
});

test('classab: a follower stage biased by two diode-connected devices is read', () => {
  const R = classabReading(parseSpice(FOLLOWER));
  assert.ok(R);
  assert.deepEqual([R.kind, R.top, R.bot, R.fA, R.fB], ['follower', 'M1', 'M2', 'I1', 'M5']);
  assert.deepEqual(R.steps.map((s) => s.parts), [['M3'], ['M4']]);
});

test('classab: a Miller second stage (current-source load) is not read', () => {
  assert.equal(classabReading(parseSpice('M6 out o1 vdd vdd pmos\nM7 out vb 0 0 nmos\nM1 o1 inp t 0 nmos\nM2 x inn t 0 nmos\nM3 x x vdd vdd pmos\nM4 o1 x vdd vdd pmos\nM5 t vb 0 0 nmos\n.end')), null);
});

test('classab: an LNA whose "string" runs through its input is not read', () => {
  assert.equal(classabReading(parseSpice('M0 a vb vin1 0 nmos\nM1 out vin1 0 0 nmos\nR2 vin1 0 1k\nM3 out a vdd vdd pmos\nM2 a a vdd vdd pmos\n.end')), null);
});

for (const [name, net] of [['common-source', MONTICELLI], ['follower', FOLLOWER]]) {
  test(`classab: auto draws the ${name} stage with the template, LVS-clean, through the quality gate`, async () => {
    const p = parseSpice(net);
    const r = await autoPlace(p);
    const m = getPage(r.doc);
    assert.equal(r.label, 'classab');
    assert.ok(compare(extractNetlist(m), p).match);
    const q = qualityGate(m, p);
    assert.ok(q.pass, JSON.stringify(Object.fromEntries(Object.entries(q.checks).filter(([, c]) => !c.ok))));
  });
}

test('classab: AUTO_CLASSAB=0 disables the template', async () => {
  process.env.AUTO_CLASSAB = '0';
  try {
    const r = await autoPlace(parseSpice(FOLLOWER));
    assert.notEqual(r.label, 'classab');
  } finally { delete process.env.AUTO_CLASSAB; }
});
