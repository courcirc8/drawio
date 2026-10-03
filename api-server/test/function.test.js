import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice } from '../lib/netlist.js';
import { newDocument, getPage } from '../lib/model.js';
import { importNetlist2 } from '../lib/place2.js';
import { routePage } from '../lib/route.js';
import { recognizeFunction, netRoles, blockRoles } from '../lib/function.js';
import { recognize, similarSchematics } from '../lib/recognize-llm.js';
import { conventionReport } from '../lib/conventions.js';

const cir = (dir, name) => parseSpice(fs.readFileSync(new URL(`../benchmark/${dir}/${name}.cir`, import.meta.url), 'utf8'));

test('recognizeFunction: archive statistics name the obvious functions', () => {
  assert.equal(recognizeFunction(cir('netlists30', 'gilbert-mixer')).types[0].type, 'mixer');
  assert.equal(recognizeFunction(cir('netlists30', 'vco-lc')).types[0].type, 'VCO');
  assert.equal(recognizeFunction(cir('netlists30', 'ota-cmos')).types[0].type, 'opamp');
  assert.equal(recognizeFunction(cir('netlists30', 'bandgap-core')).types[0].type, 'reference');
  // power circuits are outside the archive's types: decided by rule
  assert.equal(recognizeFunction(cir('power-v1', 'three-phase-bridge')).types[0].type, 'rectifier');
  assert.equal(recognizeFunction(cir('power-v1', 'three-phase-inverter')).types[0].type, 'inverter');
  assert.equal(recognizeFunction(cir('power-v1', 'buck')).types[0].type, 'DC-DC');
  assert.equal(recognizeFunction(cir('bjt-v1', 'zener-shunt')).types[0].type, 'reference');
  const p = recognizeFunction(cir('netlists30', 'gilbert-mixer')).types.reduce((s, t) => s + t.p, 0);
  assert.ok(Math.abs(p - 1) < 0.02, 'probabilities sum to 1');
});

test('netRoles and blockRoles', () => {
  const r = netRoles(parseSpice('V1 in 0 AC 1\nVDD vdd 0 1.8\nVB vb 0 0.6\nM1 out in 0 0 NMOS\nR1 vdd out 1k\nM2 x vb out 0 NMOS\n.end'));
  assert.equal(r.in, 'input'); assert.equal(r.out, 'output'); assert.equal(r.vdd, 'supply'); assert.equal(r['0'], 'ground'); assert.equal(r.vb, 'supply');
  const b = blockRoles(cir('netlists30', 'gilbert-mixer'));
  assert.ok(b.length >= 1 && b.every((x) => typeof x.role === 'string'));
});

test('recognize without LLM: Bayes + neighbours, never throws without the index', async () => {
  const r = await recognize(cir('netlists30', 'vco-lc'), { llm: false });
  assert.equal(r.type, 'VCO');
  assert.ok(Array.isArray(r.neighbours.top));
  assert.ok(similarSchematics([]).length === 0);
  for (const s of r.neighbours.top) assert.deepEqual(Object.keys(s).sort(), ['id', 'motifs', 'page', 'rang', 'score', 'type'], 'identifiers and labels only');
});

test('conventionReport: the LNA drawn by place2 follows its conventions', { timeout: 120000 }, async () => {
  const parsed = cir('netlists', 'lna-shaeffer-lee');
  const m = getPage(newDocument());
  const pl = importNetlist2(m, parsed);
  await routePage(m, pl.wires, {});
  const rep = conventionReport(m, parsed, { type: 'LNA' });
  assert.equal(rep.type, 'LNA');
  assert.ok(rep.checks.some((c) => c.name.startsWith('degeneration-below')));
  assert.equal(rep.score, 1, JSON.stringify(rep.failed));
  // weights of layout checks come from the archive (supply on top: 0.903 for LNA)
  const st = rep.checks.find((c) => c.name === 'supply-top');
  if (st) assert.equal(st.weight, 0.903);
});

test('ranker features: candidate identity, check.js counts, conventions, geometry', { timeout: 120000 }, async () => {
  const { rankFeatures, rankScore } = await import('../lib/ranker.js');
  const parsed = cir('netlists', 'vco-lc');
  const m = getPage(newDocument());
  const pl = importNetlist2(m, parsed);
  await routePage(m, pl.wires, {});
  const f = rankFeatures(m, parsed, { eng: 'v2', colW: 230, rowH: 220 });
  assert.equal(f.cand_v2, 1); assert.equal(f.colW, 1); assert.equal(f.rowH, 1);
  for (const k of ['js_errors', 'conv', 'area_per_part', 'wire_per_part', 'bends_per_wire']) assert.ok(Number.isFinite(f[k]), k);
  // no trained model is shipped (the ranker did not beat check.js): score is null
  assert.equal(rankScore(f), null);
});

test('recognizeFromLabels: a vision reading (motifs + component kinds) gets a type ranking', async () => {
  const { recognizeFromLabels } = await import('../lib/function.js');
  const lna = recognizeFromLabels({ motifs: ['inductive-degeneration', 'cascode', 'common-gate'], kinds: ['nmos', 'L', 'C', 'R'] });
  assert.equal(lna.types[0].type, 'LNA');
  const vco = recognizeFromLabels({ motifs: ['cross-coupled-pair', 'tail'], kinds: ['nmos', 'L', 'C', 'varactor'] });
  assert.equal(vco.types[0].type, 'VCO');
  assert.ok(Math.abs(lna.types.reduce((s, t) => s + t.p, 0) - 1) < 0.02);
});
