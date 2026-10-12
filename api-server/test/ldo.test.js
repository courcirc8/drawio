import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { ldoReading } from '../lib/place-ldo.js';

// an LDO written for the test (no bank circuit): 5T error amplifier, PMOS
// pass device, divider with an ammeter (0 V source), load capacitor
const LDO = `M1 n fb t 0 nmos
M2 eg vref t 0 nmos
M3 n n vdd vdd pmos
M4 eg n vdd vdd pmos
I1 t 0 20u
M5 vout eg vdd vdd pmos
V1 brk vout dc 0
R1 brk fb 10k
R2 fb 0 10k
CL vout 0 1p
.end`;

test('ldo: amplifier, pass device, divider through an ammeter and load are read', () => {
  const R = ldoReading(parseSpice(LDO));
  assert.ok(R);
  assert.deepEqual([R.pass, R.vout, R.tap, R.chain.join('-'), R.loads.join(',')], ['M5', 'vout', 'fb', 'V1-R1-R2', 'CL']);
});

test('ldo: a 5T OTA alone is not read', () => {
  assert.equal(ldoReading(parseSpice(LDO.replace(/^M5.*\n/m, ''))), null);
});

test('ldo: auto draws it with the template, LVS-clean', async () => {
  const p = parseSpice(LDO);
  const r = await autoPlace(p);
  assert.equal(r.label, 'ldo');
  assert.ok(compare(extractNetlist(getPage(r.doc)), p).match);
});

test('ldo: AUTO_LDO=0 disables the template', async () => {
  process.env.AUTO_LDO = '0';
  try { assert.notEqual((await autoPlace(parseSpice(LDO))).label, 'ldo'); } finally { delete process.env.AUTO_LDO; }
});
