import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { qualityGate } from '../lib/quality.js';
import { indirectReading } from '../lib/place-indirect.js';

// two-stage OTAs with INDIRECT compensation (lib/place-indirect.js), written
// for the test (no bank circuit)
const AHUJA = `* PMOS input, common-gate buffer feeding the first output, resistor load
M1 n1 inm s vdd pmos
M2 o1 inp s vdd pmos
M3 n1 n1 0 0 nmos
M4 o1 n1 0 0 nmos
I1 vdd s 20u
M9 o1 vcg x vdd pmos
I2 vdd x 10u
M6 out o1 0 0 nmos
R1 vdd out 10k
CC out x 1p
.end`;
const CASCODE = `* NMOS input, cascoded PMOS load (low-voltage mirror), Cc into the cascode's source
M1 a inp t 0 nmos
M2 b inn t 0 nmos
M3 a vbc ca vdd pmos
M4 b vbc cb vdd pmos
M5 ca a vdd vdd pmos
M6 cb a vdd vdd pmos
M0 t vbn 0 0 nmos
M7 out b vdd vdd pmos
M8 out vbn 0 0 nmos
CC cb out 2p
CL out 0 1p
.end`;
const FULL = `* NMOS input, tail with bias diode and reference, buffer with its bias source, Rz, load device, CL
M1 n1 inp tail 0 nmos
M2 o1 inn tail 0 nmos
M3 n1 n1 vdd vdd pmos
M4 o1 n1 vdd vdd pmos
M5 tail vb 0 0 nmos
M8 vb vb 0 0 nmos
IREF vdd vb 20u
M9 o1 vcg x 0 nmos
I2 x 0 10u
M6 out o1 vdd vdd pmos
M7 out vb 0 0 nmos
CC x m 1p
RZ m out 1k
CL out 0 2p
.end`;

test('indirect: the Ahuja buffer form is read', () => {
  const R = indirectReading(parseSpice(AHUJA));
  assert.ok(R);
  assert.equal(R.kind, 'buffer');
  assert.deepEqual([R.iA, R.iB, R.mA, R.mB, R.mg, R.m6, R.load, R.cc], ['M1', 'M2', 'M3', 'M4', 'M9', 'M6', 'R1', 'CC']);
});

test('indirect: the cascode form is read (Cc into the output-side cascode source)', () => {
  const R = indirectReading(parseSpice(CASCODE));
  assert.ok(R);
  assert.equal(R.kind, 'cascode');
  assert.deepEqual([R.iA, R.iB, R.cA, R.cB, R.mA, R.mB, R.m6, R.m7, R.tail, R.x], ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M0', 'cb']);
  assert.ok(R.m7Tail);
});

test('indirect: tail bias, Rz in series and the buffer bias source are read', () => {
  const R = indirectReading(parseSpice(FULL));
  assert.ok(R);
  assert.deepEqual([R.kind, R.tail, R.bias, R.ref, R.rz, R.m7], ['buffer', 'M5', 'M8', 'IREF', 'RZ', 'M7']);
});

test('indirect: a plain Miller OTA (Cc between the two outputs) is not read', () => {
  const p = parseSpice(FULL.replace('CC x m 1p', 'CC o1 m 1p').replace(/^M9.*\n/m, '').replace(/^I2.*\n/m, ''));
  assert.equal(indirectReading(p), null);
});

for (const [name, net] of [['Ahuja buffer', AHUJA], ['cascode', CASCODE], ['full', FULL]]) {
  test(`indirect: auto draws the ${name} form with the template, LVS-clean, through the quality gate`, async () => {
    const p = parseSpice(net);
    const r = await autoPlace(p);
    const m = getPage(r.doc);
    assert.equal(r.label, 'indirect');
    assert.ok(compare(extractNetlist(m), p).match);
    const q = qualityGate(m, p);
    assert.ok(q.pass, JSON.stringify(Object.fromEntries(Object.entries(q.checks).filter(([, c]) => !c.ok))));
  });
}

test('indirect: AUTO_INDIRECT=0 disables the template', async () => {
  process.env.AUTO_INDIRECT = '0';
  try {
    const r = await autoPlace(parseSpice(AHUJA));
    assert.notEqual(r.label, 'indirect');
  } finally { delete process.env.AUTO_INDIRECT; }
});
