import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, getPage, normalizeOrigin, serialize, parseDrawio } from '../lib/model.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { importNetlist } from '../lib/place.js';
import { importNetlist2 } from '../lib/place2.js';
import { routePage } from '../lib/route.js';
import { compare } from '../lib/lvs.js';
import { classify } from '../lib/components.js';
import { cellInfo, allCells } from '../lib/model.js';

// SPICE coverage extension (2026-09-18): .subckt/X flattening, K couplings,
// simulation directives without warnings, and the E/F/B/S/J/X(op-amp)
// element classes. Every case is checked the only way that matters here:
// place -> route -> extract -> strict LVS against the parsed reference,
// through BOTH placers (v1 naive, v2 conduction stacks), from the SAVED XML.

async function roundTrip(spice, engine) {
  const parsed = parseSpice(spice);
  const doc = newDocument();
  const m = getPage(doc);
  const placed = engine === 'v2' ? importNetlist2(m, parsed) : importNetlist(m, parsed);
  await routePage(m, placed.wires, {});
  normalizeOrigin(m);
  // from the serialised document, as the server does
  const m2 = getPage(parseDrawio(serialize(doc)));
  const extracted = extractNetlist(m2);
  const report = compare(extracted, parsed);
  return { parsed, extracted, report, model: m2 };
}

const SUBCKT = `* two inverters from one .subckt, hierarchical
.model NMOS NMOS(VTO=0.5)
.subckt INV in out vdd
M1 out in 0 0 NMOS
M2 out in vdd vdd PMOS
.ends
X1 a b vdd INV
X2 b c vdd INV
V1 vdd 0 1.8
V2 a 0 PULSE(0 1.8 0 1n 1n 5n 10n)
R1 c 0 10k
.tran 0 50n
.end`;

test('parseSpice: .subckt/X are flattened with dotted refs and nets, directives are not warnings', () => {
  const p = parseSpice(SUBCKT);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.directives, ['.model NMOS NMOS(VTO=0.5)', '.tran 0 50n']);
  const refs = p.components.map((c) => c.ref);
  assert.deepEqual(refs, ['X1.M1', 'X1.M2', 'X2.M1', 'X2.M2', 'V1', 'V2', 'R1']);
  const x1m1 = p.components[0];
  assert.deepEqual(x1m1.fullNodes, ['b', 'a', '0', '0']);   // pins mapped to the instance nets
  assert.equal(x1m1.model, 'NMOS');
  assert.equal(p.components[1].fullNodes[2], 'vdd');       // subckt pin -> outer net
  assert.ok(Object.keys(p.subckts).includes('INV'));
});

test('parseSpice: nested subckts, internal nets are prefixed, K couplings recorded', () => {
  const p = parseSpice(`.subckt LEAF a b
R1 a mid 1k
C1 mid b 1p
.ends
.subckt BRANCH p q
X1 p t LEAF
X2 t q LEAF
.ends
XB in out BRANCH
L1 in 0 1u
L2 out 0 1u
K1 L1 L2 0.95
V1 in 0 1
.end`);
  assert.deepEqual(p.warnings, []);
  const refs = p.components.map((c) => c.ref);
  assert.ok(refs.includes('XB.X1.R1') && refs.includes('XB.X2.C1'));
  const r1 = p.components.find((c) => c.ref === 'XB.X1.R1');
  assert.deepEqual(r1.nodes, ['in', 'XB.X1.mid']);          // internal net prefixed, pin net resolved
  const c2 = p.components.find((c) => c.ref === 'XB.X2.C1');
  assert.deepEqual(c2.nodes, ['XB.X2.mid', 'out']);
  assert.deepEqual(p.couplings, [{ ref: 'K1', inductors: ['L1', 'L2'], value: '0.95' }]);
});

test('parseSpice: undefined subckt -> op-amp when it looks like one, else unsupported', () => {
  const p = parseSpice(`XU1 inp inn vp vm out LT1007
XU2 inp inn out2 opamp
XZ a b c d e f g h SOMEDIGITAL
.end`);
  assert.equal(p.components.length, 2);
  assert.deepEqual(p.components[0].fullNodes, ['inp', 'inn', 'vp', 'vm', 'out']);
  assert.deepEqual(p.components[0].nodes, ['inp', 'inn', 'out']);
  assert.deepEqual(p.components[1].fullNodes, ['inp', 'inn', 'XU2.V+', 'XU2.V-', 'out2']);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /SOMEDIGITAL/);
});

for (const engine of ['v1', 'v2']) {
  test(`subckt flatten round-trips through ${engine} + strict LVS`, async () => {
    const { report, extracted } = await roundTrip(SUBCKT, engine);
    assert.equal(report.match, true, JSON.stringify(report).slice(0, 600));
    assert.ok(extracted.spice.includes('X1.M1 '));
  });

  test(`E/F/B/S/J/X elements round-trip through ${engine} + strict LVS`, async () => {
    const spice = `* coverage
V1 in 0 SINE(0 1 1k)
R1 in g 1k
J1 d g 0 J2N3819
R2 vdd d 2.2k
V2 vdd 0 12
E1 e 0 d g 10
R3 e 0 1k
F1 f 0 V2 0.5
R4 f 0 100
B1 bb 0 V=V(d)*2
R5 bb 0 1k
S1 sw 0 in g SWMOD
R6 vdd sw 10k
XU1 d 0 vdd 0 o LT1007
R7 o 0 1k
XU2 o 0 o2 opamp
R8 o2 0 1k
.model SWMOD SW(Ron=1 Roff=1Meg Vt=0.5)
.end`;
    const { parsed, report, extracted, model } = await roundTrip(spice, engine);
    assert.deepEqual(parsed.warnings, []);
    assert.equal(report.match, true, JSON.stringify(report).slice(0, 800));
    // hidden terminals came back (extracted net names are synthetic, so we
    // check arity and the named hidden-only nets, LVS above checks the rest)
    const ex = Object.fromEntries(extracted.components.map((c) => [c.ref, c]));
    assert.equal(ex.S1.fullNodes.length, 4);
    assert.equal(ex.S1.value, 'SWMOD');
    assert.equal(ex.XU1.fullNodes.length, 5);
    assert.equal(ex.XU1.prefix, 'X');
    assert.deepEqual(ex.XU2.fullNodes.slice(2, 4), ['XU2.V+', 'XU2.V-']);
    assert.equal(ex.E1.fullNodes.length, 4);
    assert.equal(ex.J1.prefix, 'J');
    // the shared OTA stencil is classified by refdes: XU1 is an X, not a G
    const xu1 = allCells(model).map(cellInfo).find((c) => c.id === 'XU1' || c.refdes === 'XU1');
    assert.equal(classify(xu1).prefix, 'X');
  });
}

test('G (OTA) still classifies as G on the shared stencil', async () => {
  const { report, model } = await roundTrip(`G1 n1 0 in vout gm1
R1 vout 0 1k
V1 in 0 1
C1 n1 0 1p
.end`, 'v1');
  assert.equal(report.match, true, JSON.stringify(report).slice(0, 400));
  const g1 = allCells(model).map(cellInfo).find((c) => c.id === 'G1' || c.refdes === 'G1');
  assert.equal(classify(g1).prefix, 'G');
});

test('parseSpice: .param/.step stay warnings (strict LVS must keep rejecting them), .tran does not', () => {
  const p = parseSpice('R1 a 0 {R}\n.param R=1k\n.tran 0 1m\n.end');
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /not representable.*\.param/);
  assert.deepEqual(p.directives, ['.param R=1k', '.tran 0 1m']);
});

test('extraction: synthetic net names never collide with real n1..nK net names (holdout Boost-converter-1)', async () => {
  // n3/n4 are REAL nets of the reference (switch control, port-labelled in
  // the drawing); the extractor's own synthetic numbering must skip them
  const { report, extracted } = await roundTrip(`Vd n1 0 100
D1 n2 Vo D
L1 n1 n2 10m
C1 Vo 0 10u
R1 Vo 0 100
S1 0 n2 n3 n4 MOSFET
V2 n3 n4 PULSE(0 100 0 1n 1n 5u 10u)
.end`, 'v2');
  assert.equal(report.match, true, JSON.stringify(report).slice(0, 500));
  const names = new Set(extracted.components.flatMap((c) => c.fullNodes).map((x) => x.toUpperCase()));
  assert.ok(names.has('N3') && names.has('N4'));
});

test('parseSpice: pin-count mismatch on an X instance is a warning, not a crash', () => {
  const p = parseSpice(`.subckt A p q
R1 p q 1
.ends
X1 a b c A
.end`);
  assert.equal(p.components.length, 0);
  assert.match(p.warnings[0], /X X1: 3 nodes/);
});
