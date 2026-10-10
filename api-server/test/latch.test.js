import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { latchReading } from '../lib/place-latch.js';
import { autoPlace } from '../lib/auto.js';
import { qualityGate } from '../lib/quality.js';

// a CML clocked comparator (input pair + cross-coupled pair on the same
// drains, clock switches, tail) — the circuit Eric refused on 2026-10-09
const CML = `R1 vdd n1 5k
R2 vdd n2 5k
M1 n1 vin1 n3 n3 nmos
M2 n2 vin2 n3 n3 nmos
M3 n1 n2 n5 n5 nmos
M4 n2 n1 n5 n5 nmos
M5 n3 clk n4 n4 nmos
M6 n5 clkb n4 n4 nmos
M7 n4 bias gnd gnd nmos
.end`;

test('latch: the CML comparator core is read (pairs, loads, switches, tail)', () => {
  const L = latchReading(parseSpice(CML));
  assert.ok(L);
  assert.deepEqual([L.iA, L.iB, L.cA, L.cB], ['M1', 'M2', 'M3', 'M4']);
  assert.deepEqual([L.LA, L.LB, L.tI, L.tC, L.tT], ['R1', 'R2', 'M5', 'M6', 'M7']);
});

test('latch: no core in a plain differential pair', () => {
  assert.equal(latchReading(parseSpice(`R1 vdd a 1k\nR2 vdd b 1k\nM1 a i1 t t nmos\nM2 b i2 t t nmos\nM3 t bias 0 0 nmos\n.end`)), null);
});

test('latch: auto draws it with the template, LVS-clean, and it passes the quality gate', async () => {
  const p = parseSpice(CML);
  const r = await autoPlace(p);
  const m = getPage(r.doc);
  assert.equal(r.label, 'latch');
  assert.ok(compare(extractNetlist(m), p).match);
  const q = qualityGate(m, p);
  assert.ok(q.pass, JSON.stringify(q.checks));
});

test('quality gate: an absurd reading (parts in two groups joined by no net) is refused', async () => {
  const p = parseSpice(`M1 a g1 0 0 nmos\nR1 vdd a 1k\nM2 b g2 0 0 nmos\nR2 vdd b 1k\n.end`);
  const r = await autoPlace(p);
  const q = qualityGate(getPage(r.doc), p);
  assert.equal(q.checks.netlist.ok, false);
  assert.equal(q.pass, false);
});

test('ota template: the 5T OTA is read and, enabled, drawn by default, LVS-clean, through the quality gate', async () => {
  const { otaReading } = await import('../lib/place-ota.js');
  const p = parseSpice(`M1 n1 inp tail 0 nmos\nM2 out inn tail 0 nmos\nM3 n1 n1 vdd vdd pmos\nM4 out n1 vdd vdd pmos\nM5 tail vb 0 0 nmos\nM6 vb vb 0 0 nmos\nI1 vdd vb 10u\n.end`);
  const O = otaReading(p);
  assert.deepEqual([O.iA, O.iB, O.mA, O.mB, O.tail, O.bias], ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
  const r = await autoPlace(p);   // on by default
  assert.equal(r.label, 'ota');
  assert.ok(compare(extractNetlist(getPage(r.doc)), p).match);
  assert.ok(qualityGate(getPage(r.doc), p).pass);
});

test('netlist: an ngspice .control … .endc block is skipped (no "let" read as an inductor)', () => {
  const p = parseSpice('R1 a b 1k\n.control\nlet x = 2\nlet lmax = 5\nrun\n.endc\nC1 b 0 1p\n.end');
  assert.deepEqual(p.components.map((c) => c.ref), ['R1', 'C1']);
});
