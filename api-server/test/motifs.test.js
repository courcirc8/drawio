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
