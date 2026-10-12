import test from 'node:test';
import assert from 'node:assert/strict';
import { ringReading } from '../lib/ring-reading.js';

// a tiny parser for the tests: "M1 d g s b nmos" / "C1 a b 1p"
const parse = (txt) => ({ components: txt.trim().split('\n').filter((l) => /^[A-Za-z]/.test(l) && !l.startsWith('.')).map((l) => {
  const t = l.trim().split(/\s+/), prefix = t[0][0].toUpperCase();
  return prefix === 'M' ? { ref: t[0], prefix, nodes: t.slice(1, 5), model: t[5] } : { ref: t[0], prefix, nodes: t.slice(1, 3), model: t[3] };
}) });

const RING3 = `
M1 a c vdd vdd pmos
M2 a c 0 0 nmos
M3 b a vdd vdd pmos
M4 b a 0 0 nmos
M5 c b vdd vdd pmos
M6 c b 0 0 nmos
C1 a 0 1f`;

test('three-stage ring: stages in order from the smallest PMOS ref', () => {
  const R = ringReading(parse(RING3));
  assert.ok(R);
  assert.deepEqual(R.stages.map((s) => [s.p, s.n, s.in, s.out]), [['M1', 'M2', 'c', 'a'], ['M3', 'M4', 'a', 'b'], ['M5', 'M6', 'b', 'c']]);
  assert.equal(R.stages[0].load, 'C1');
  assert.equal(R.stages[1].load, null);
  assert.equal(R.stages[0].sp, null);
  assert.equal(R.biasP, null);
  assert.deepEqual([...R.used].sort(), ['C1', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
});

test('the stage driving an "out" net is the last one', () => {
  const R = ringReading(parse(RING3.replace(/\bc\b/g, 'vout')));
  assert.deepEqual(R.stages.map((s) => s.out), ['a', 'b', 'vout']);
  const R2 = ringReading(parse(RING3.replace(/\bb\b/g, 'OUT')));
  assert.deepEqual(R2.stages.map((s) => s.out), ['c', 'a', 'OUT']);
});

const STARVED = `
M1 chw in gnd gnd NMOS
M2 chw chw vp vp PMOS
M3 1up chw vp vp PMOS
M4 2up chw vp vp PMOS
M5 3up chw vp vp PMOS
M8 1-2 out 1up 1up PMOS
M9 2-3 1-2 2up 2up PMOS
M12 out 2-3 3up 3up PMOS
M13 1-2 out 1dn 1dn NMOS
M14 2-3 1-2 2dn 2dn NMOS
M17 out 2-3 3dn 3dn NMOS
M18 1dn in gnd gnd NMOS
M19 2dn in gnd gnd NMOS
M22 3dn in gnd gnd NMOS`;

test('current-starved ring: starving devices, bias nets and generator', () => {
  const R = ringReading(parse(STARVED));
  assert.ok(R);
  assert.deepEqual(R.stages.map((s) => [s.p, s.n, s.sp, s.sn]), [['M8', 'M13', 'M3', 'M18'], ['M9', 'M14', 'M4', 'M19'], ['M12', 'M17', 'M5', 'M22']]);
  assert.equal(R.biasP, 'chw');
  assert.equal(R.biasN, 'in');
  assert.deepEqual(R.biasDevs, ['M1', 'M2']);
  assert.equal(R.used.size, 14);
});

test('no ring: an even loop (latch), a plain inverter chain, a 5T OTA', () => {
  assert.equal(ringReading(parse(`M1 a b vdd vdd pmos\nM2 a b 0 0 nmos\nM3 b a vdd vdd pmos\nM4 b a 0 0 nmos`)), null);
  assert.equal(ringReading(parse(`M1 a i vdd vdd pmos\nM2 a i 0 0 nmos\nM3 b a vdd vdd pmos\nM4 b a 0 0 nmos\nM5 o b vdd vdd pmos\nM6 o b 0 0 nmos`)), null);
  assert.equal(ringReading(parse(`M1 x x vdd vdd pmos\nM2 o x vdd vdd pmos\nM3 x ip t 0 nmos\nM4 o in t 0 nmos\nM5 t vb 0 0 nmos`)), null);
});

test('five stages: the longest odd loop', () => {
  const st = ['a', 'b', 'c', 'd', 'e'];
  const net = st.map((o, k) => `M${2 * k + 1} ${o} ${st[(k + 4) % 5]} vdd vdd pmos\nM${2 * k + 2} ${o} ${st[(k + 4) % 5]} 0 0 nmos`).join('\n');
  const R = ringReading(parse(net));
  assert.equal(R.stages.length, 5);
  assert.deepEqual(R.stages.map((s) => s.p), ['M1', 'M3', 'M5', 'M7', 'M9']);
});

// the template (lib/place-ring.js), through auto
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { qualityGate } from '../lib/quality.js';

// (with a load capacitor the plain ring loses to the generic engine: noted in ETAT.md)
for (const [name, net] of [['three-stage', RING3.replace(/\bc\b/g, 'out').replace(/^C1.*$/m, '')], ['current-starved', STARVED]]) {
  test(`ring template: auto draws the ${name} ring with it, LVS-clean, failing only the feedback detour`, async () => {
    const p = parseSpice(net + '\n.end');
    const r = await autoPlace(p);
    const m = getPage(r.doc);
    assert.equal(r.label, 'ring');
    assert.ok(compare(extractNetlist(m), p).match);
    // (the feedback runs back under the row: a long U, the one detour allowed)
    const failed = Object.entries(qualityGate(m, p).checks).filter(([k, c]) => !c.ok && k !== 'uWires' && k !== 'avoidable').map(([k]) => k);
    assert.deepEqual(failed, []);
  });
}

test('ring template: AUTO_RING=0 disables it', async () => {
  process.env.AUTO_RING = '0';
  try { assert.notEqual((await autoPlace(parseSpice(RING3 + '\n.end'))).label, 'ring'); } finally { delete process.env.AUTO_RING; }
});
