import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice } from '../lib/netlist.js';
import { opDeck, operatingPoint, NGSPICE } from '../lib/sim-op.js';

const OTA = `M1 n1 inp tail 0 nmos W=10u L=1u
M2 out inn tail 0 nmos W=10u L=1u
M3 n1 n1 vdd vdd pmos W=20u L=1u
M4 out n1 vdd vdd pmos W=20u L=1u
M5 tail vb 0 0 nmos W=10u L=1u
M6 vb vb 0 0 nmos W=10u L=1u
I1 vdd vb 20u
.end`;

test('point d\'essai deck: simple models, supply and open inputs biased, every assumption listed', () => {
  const { deck, assumptions } = opDeck(parseSpice(OTA));
  assert.match(deck, /\.model nmos nmos \(level=1/);
  assert.match(deck, /\.model pmos pmos \(level=1/);
  assert.match(deck, /^Vop_vdd vdd 0 1\.8$/m);
  assert.match(deck, /^Vop_inp inp 0 0\.9$/m);
  assert.ok(assumptions.some((a) => /vdd alimenté/.test(a)) && assumptions.some((a) => /entrée inp/.test(a)));
});

test('point d\'essai deck: symbolic values and a bias-current input get listed defaults', () => {
  const { deck, assumptions } = opDeck(parseSpice('M1 out in ib1 0 nmos\nR0 vdd out R0\n.end'));
  assert.match(deck, /^R0 vdd out 10k$/m);
  assert.match(deck, /^Iop_ib1 ib1 0 dc 20u$/m);
  assert.ok(assumptions.some((a) => /R = 10 kΩ/.test(a)) && assumptions.some((a) => /entrée de courant ib1/.test(a)));
});

test('point d\'essai by ngspice: a 5T OTA, the mirror current in every branch, all in saturation', { skip: !fs.existsSync(NGSPICE) && 'ngspice not installed' }, () => {
  const { sim } = operatingPoint(parseSpice(OTA));
  assert.equal(sim.format, 'drawio-sim-annotations/1');
  assert.ok(Math.abs(sim.devices.M6.Id - 20e-6) < 1e-6);
  assert.ok(Math.abs(sim.devices.M1.Id - sim.devices.M5.Id / 2) < 1e-6);
  for (const r of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']) assert.equal(sim.devices[r].region, 'saturation', r);
  assert.ok(sim.nodes.vdd.V > 1.79 && sim.nodes.vdd.V < 1.81);
});
