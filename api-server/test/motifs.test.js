import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice } from '../lib/netlist.js';
import { detectMotifs, MOTIFS } from '../lib/motifs.js';

const cir = (name, dir = 'netlists30') => parseSpice(fs.readFileSync(new URL(`../benchmark/${dir}/${name}.cir`, import.meta.url), 'utf8'));
const has = (r, motif) => r.instances.filter((i) => i.motif === motif);

test('motifs: registry names are unique and every detected motif is registered', () => {
  const names = MOTIFS.map((m) => m.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of ['gilbert-mixer', 'strongarm-latch', 'cherry-hooper', 'ring-vco3', 'lc-match']) {
    const r = detectMotifs(cir(n));
    for (const i of r.instances) assert.ok(names.includes(i.motif), i.motif);
  }
});

test('motifs: the benchmark templates are recognised on their reference circuits', () => {
  assert.ok(has(detectMotifs(cir('gilbert-mixer')), 'gilbert-quad').length >= 1, 'gilbert quad');
  assert.ok(has(detectMotifs(cir('strongarm-latch')), 'latch').length >= 1, 'latch');
  assert.ok(has(detectMotifs(cir('delay-cell-cc')), 'half-latch').length >= 1, 'half-latch');
  assert.ok(has(detectMotifs(cir('cherry-hooper')), 'cascade').length >= 1, 'cascade');
  const ring = has(detectMotifs(cir('ring-vco3')), 'ring');
  assert.equal(ring.length, 1); assert.equal(ring[0].stages, 3);
  assert.ok(has(detectMotifs(cir('ota-cmos')), 'miller-capacitor').length >= 1, 'miller (direct gate-drain cap)');
  assert.equal(has(detectMotifs(cir('ota-miller-nulling')), 'miller-capacitor').length, 0, 'a nulling-resistor Miller path is not a direct gate-drain cap');
  const lc = detectMotifs(cir('lc-match'));
  assert.equal(has(lc, 'passive-axis').length, 1);
  assert.equal(lc.coverage, 1);
  assert.ok(has(detectMotifs(cir('vco-lc')), 'cross-coupled-pair').length >= 1);
});

test('motifs: macro-blocks partition the netlist, uncovered components are listed', () => {
  const r = detectMotifs(cir('gilbert-mixer'));
  const all = r.blocks.flatMap((b) => b.refs);
  assert.equal(new Set(all).size, all.length, 'a component belongs to at most one block');
  const parsed = cir('gilbert-mixer');
  assert.equal(all.length + r.uncovered.length, parsed.components.length);
  assert.ok(r.blocks.some((b) => b.motif === 'gilbert-quad' && b.recipe.startsWith('place2:')));
});

test('motifs: the holdout gap is named — discrete BJT stages and op-amp stages have no recipe', () => {
  const dp = detectMotifs(cir('Differential-pair', 'holdout-ltspice'));
  const stage = has(dp, 'bjt-resistive-stage');
  assert.ok(stage.length >= 1, JSON.stringify(dp.summary));
  assert.match(MOTIFS.find((m) => m.name === 'bjt-resistive-stage').recipe, /^none/);
  const op = detectMotifs(parseSpice('XU1 0 inm out opamp\nR1 in inm 1k\nR2 inm out 10k\nV1 in 0 1\n.end'));
  assert.equal(has(op, 'opamp-stage').length, 1);
  assert.equal(has(op, 'passive-axis').length, 0, 'an op-amp circuit is not a passive network');
});

test('motifs: single-device stages and their decorations (IEEE gaps, 2026-10-03)', () => {
  const lna = detectMotifs(cir('lna-shaeffer-lee', 'netlists'));
  assert.equal(has(lna, 'cascode').length, 1);
  assert.equal(has(lna, 'inductive-degeneration').length, 1, 'Ls under M1');
  assert.equal(has(lna, 'matching-network').length, 1, 'Lg before M1');
  assert.equal(has(lna, 'load').length, 1, 'Ld above M2');
  assert.equal(lna.coverage, 1, 'every LNA component is explained');
  assert.equal(has(lna, 'common-gate').length, 0, 'the cascode top is not re-read as a CG stage');
  const vco = detectMotifs(cir('vco-lc', 'netlists'));
  assert.equal(has(vco, 'matching-network').length, 0, 'tank caps between actives are not an input match');
  const txt = (s) => detectMotifs(parseSpice(s));
  const cs = txt('* CS stage\nM1 out in s 0 NMOS\nR1 s 0 100\nR2 vdd out 1k\n.end');
  assert.equal(has(cs, 'common-source').length, 1); assert.equal(cs.coverage, 1);
  const sf = txt('* follower\nM1 vdd in out 0 NMOS\nI1 out 0 1m\n.end');
  assert.equal(has(sf, 'source-follower').length, 1); assert.equal(sf.coverage, 1);
  const cg = txt('* CG stage\nM1 out vb in 0 NMOS\nR1 vdd out 1k\nL1 in 0 2n\n.end');
  assert.equal(has(cg, 'common-gate').length, 1);
  const sw = txt('* S/H\nM1 in phi1 x 0 NMOS\nC1 x 0 1p\n.end');
  assert.equal(has(sw, 'switch').length, 1);
  const fb = txt('* two stages\nM1 a in 0 0 NMOS\nR1 vdd a 1k\nM2 out a 0 0 NMOS\nR2 vdd out 1k\nRf out in 10k\n.end');
  assert.equal(has(fb, 'resistive-feedback').length, 1);
});

test('a signal source is not a rail; a collector on a rail is a follower', () => {
  const has = (r, m) => r.instances.filter((i) => i.motif === m);
  const txt = (s) => detectMotifs(parseSpice(s));
  // the stimulus V1 must not turn `in` into a rail (the CS gate looked rail-biased)
  const cs = txt('V1 in 0 AC 1\nVDD vdd 0 1.8\nRD vdd out 1k\nM1 out in 0 0 NMOS\n.end');
  assert.equal(has(cs, 'common-source').length, 1);
  const sf = txt('V1 in 0 SIN(0 1 1k)\nVDD vdd 0 1.8\nM1 vdd in out 0 NMOS\nRS out 0 1k\n.end');
  assert.equal(has(sf, 'source-follower').length, 1);
  // a plain DC source is a supply whatever its name
  assert.equal(has(txt('V1 Vin 0 5\nR1 Vin c 1k\nR2 Vin b 10k\nQ1 c b 0 2N3904\n.end'), 'bjt-resistive-stage').length, 1);
  // a pulse source drives a switch (the waveform is in `value`, not `model`)
  assert.equal(has(txt('V1 g 0 PULSE(0 1 0 1n 1n 5n 10n)\nM1 in g x 0 NMOS\nC1 x 0 1p\n.end'), 'switch').length, 1);
  // R from Vcc to the base of a follower is its bias, not shunt feedback, and
  // two followers on Vcc do not merge into one "resistive stage"
  const cc = txt('V2 Vcc 0 12\nV1 sig 0 SINE(0 1 1k)\nQ1 Vcc b1 o1 2N3904\nR1 o1 0 3k\nR2 Vcc b1 620k\nC1 b1 sig 1u\nQ2 Vcc b2 o2 2N3904\nR3 o2 0 3k\nR4 Vcc b2 50k\nR5 b2 0 86k\nC2 b2 sig 1u\n.end');
  assert.equal(has(cc, 'shunt-feedback').length, 0);
  assert.equal(has(cc, 'bjt-resistive-stage').length, 0);
  assert.equal(has(cc, 'source-follower').length, 2);
});

test('power bridges are registered motifs: diode legs and switch legs grouped by their P/N ends', () => {
  const has = (r, m) => r.instances.filter((i) => i.motif === m);
  const pw = (n) => detectMotifs(parseSpice(fs.readFileSync(new URL(`../benchmark/power-v1/${n}.cir`, import.meta.url), 'utf8')));
  const b3 = has(pw('three-phase-bridge'), 'diode-bridge');
  assert.equal(b3.length, 1); assert.equal(b3[0].refs.length, 6);
  const inv = has(pw('three-phase-inverter'), 'switch-bridge');
  assert.equal(inv.length, 1, 'S1/S3 share the source-driven bus p: not a leg');
  assert.equal(inv[0].refs.length, 12, 'six switches + six freewheel diodes');
  assert.equal(has(pw('graetz-rc'), 'diode-bridge')[0].refs.length, 4);
});
