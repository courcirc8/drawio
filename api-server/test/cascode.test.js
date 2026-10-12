import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { qualityGate } from '../lib/quality.js';
import { cascodeReading } from '../lib/place-cascode.js';

// telescopic and folded-cascode OTAs (lib/place-cascode.js), written for the
// test (no bank circuit)
const TELESCOPIC = `* NMOS input, NMOS cascodes, PMOS cascoded mirror load (diode on the left), tail device
M1 a inp t 0 nmos
M2 b inn t 0 nmos
M3 x vc1 a 0 nmos
M4 out vc1 b 0 nmos
M5 x vc2 y vdd pmos
M6 out vc2 z vdd pmos
M7 y x vdd vdd pmos
M8 z x vdd vdd pmos
M0 t vbn 0 0 nmos
.end`;
const FOLDED = `* PMOS input folded onto NMOS sinks, four bias lines, fully differential
M1 fa inp t vdd pmos
M2 fb inn t vdd pmos
I1 vdd t 40u
M3 fa vb4 0 0 nmos
M4 fb vb4 0 0 nmos
M5 o1 vb1 fa 0 nmos
M6 o2 vb1 fb 0 nmos
M7 o1 vb2 p1 vdd pmos
M8 o2 vb2 p2 vdd pmos
M9 p1 vb3 vdd vdd pmos
M10 p2 vb3 vdd vdd pmos
.end`;
const TWO_STAGE = `* telescopic, a common-source stage on each side driven by the column node
M1 a inp t 0 nmos
M2 b inn t 0 nmos
M3 x vc1 a 0 nmos
M4 y vc1 b 0 nmos
M5 x vc2 p vdd pmos
M6 y vc2 q vdd pmos
M7 p vc3 vdd vdd pmos
M8 q vc3 vdd vdd pmos
M0 t vbn 0 0 nmos
M9 o1 x vdd vdd pmos
M10 o2 y vdd vdd pmos
M11 o1 vb4 0 0 nmos
M12 o2 vb4 0 0 nmos
.end`;

test('cascode: a telescopic OTA is read in two columns, the diode on the left', () => {
  const R = cascodeReading(parseSpice(TELESCOPIC));
  assert.ok(R);
  assert.equal(R.kind, 'telescopic');
  assert.deepEqual(R.colA, ['M7', 'M5', 'M3', 'M1']);
  assert.deepEqual(R.colB, ['M8', 'M6', 'M4', 'M2']);
  assert.equal(R.tail, 'M0');
});

test('cascode: a folded-cascode OTA is read, the pair beside the columns', () => {
  const R = cascodeReading(parseSpice(FOLDED));
  assert.ok(R);
  assert.equal(R.kind, 'folded');
  assert.deepEqual(R.colA, ['M9', 'M7', 'M5', 'M3']);
  assert.deepEqual(R.colB, ['M10', 'M8', 'M6', 'M4']);
  assert.deepEqual([R.iA, R.iB, R.tail], ['M1', 'M2', 'I1']);
});

test('cascode: the side stages of a two-stage telescopic OTA are read', () => {
  const R = cascodeReading(parseSpice(TWO_STAGE));
  assert.ok(R);
  assert.deepEqual(R.side.map((s) => [s.col, s.m, s.load]), [['A', 'M9', 'M11'], ['B', 'M10', 'M12']]);
});

test('cascode: a plain 5T OTA (no cascode) is not read', () => {
  assert.equal(cascodeReading(parseSpice(`M1 n1 inp t 0 nmos\nM2 out inn t 0 nmos\nM3 n1 n1 vdd vdd pmos\nM4 out n1 vdd vdd pmos\nM5 t vb 0 0 nmos\n.end`)), null);
});

for (const [name, net] of [['telescopic', TELESCOPIC], ['folded', FOLDED], ['two-stage', TWO_STAGE]]) {
  test(`cascode: auto draws the ${name} OTA with the template, LVS-clean, through the quality gate`, async () => {
    const p = parseSpice(net);
    const r = await autoPlace(p);
    const m = getPage(r.doc);
    assert.equal(r.label, 'cascode');
    assert.ok(compare(extractNetlist(m), p).match);
    const q = qualityGate(m, p);
    assert.ok(q.pass, JSON.stringify(Object.fromEntries(Object.entries(q.checks).filter(([, c]) => !c.ok))));
  });
}

test('cascode: AUTO_CASCODE=0 disables the template', async () => {
  process.env.AUTO_CASCODE = '0';
  try {
    const r = await autoPlace(parseSpice(TELESCOPIC));
    assert.notEqual(r.label, 'cascode');
  } finally { delete process.env.AUTO_CASCODE; }
});
