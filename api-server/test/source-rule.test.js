// Follow-up of the review of drawio#71 (Orchestrator, 2026-10-26, REVUE-71.md §3): the source rule without its
// false positives (a testbench written as a .subckt, an unused library .subckt, a zero probe written 0e0 or with an
// inline comment) and without its misses (a source in a nested definition, an XSPICE source), the macro-models
// listed and a redefinition warned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importHier, blockSourceCheck } from '../lib/hier.js';

const TB = fs.readFileSync(new URL('./fixtures/hier-brokaw/brokaw_tb.cir', import.meta.url), 'utf8');
const BENCH = 'VDD vdd 0 3.3\nXBG vref vdd 0 bandgap\nCL vref 0 1e-11\n';
const asSubckt = (name) => TB.replace(BENCH, `.subckt ${name}\n${BENCH}.ends ${name}\nXTB ${name}\n`);
const inDem = (line) => TB.replace('.ends demarrage', `${line}\n.ends demarrage`);

test('fixture: the bench lines are where the tests expect them', () => assert.ok(TB.includes(BENCH)));

test('a testbench written as .subckt tb_bandgap, instantiated at the top: its sources pass, LVS green', async () => {
  const r = await importHier(asSubckt('tb_bandgap'));
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  assert.ok(Object.values(r.lvs.pages).every(Boolean), JSON.stringify(r.lvs.pages));
  assert.equal(r.lvs.global, true);
});

test('a tb_* name exempts nothing below a block, nor beside other parts at the top', () => {
  const below = TB.replace('.subckt bandgap vref power ground', '.subckt tb_sup a b\nVS a b 3.3\n.ends tb_sup\n.subckt bandgap vref power ground\nXS power ground tb_sup');
  assert.ok(blockSourceCheck(below).errors.some((e) => /source in block tb_sup: VS/.test(e)), 'tb_sup instantiated in bandgap');
  const beside = asSubckt('tb_bandgap').replace('XTB tb_bandgap', 'XTB tb_bandgap\nR9 vdd 0 1k');
  assert.ok(blockSourceCheck(beside).errors.some((e) => /source in block tb_bandgap/.test(e)), 'other parts at the top');
  assert.ok(blockSourceCheck(asSubckt('bench_bandgap')).errors.some((e) => /source in block bench_bandgap/.test(e)), 'not a tb_ name');
});

test('an uninstantiated library .subckt with a source: a warning, not an error', () => {
  const c = blockSourceCheck(TB.replace('.subckt ota ', '.subckt supply a b\nVS a b 1.2\n.ends supply\n.subckt ota '));
  assert.deepEqual(c.errors, []);
  assert.ok(c.warnings.some((w) => /unused \.subckt supply holds a source/.test(w)), JSON.stringify(c.warnings));
});

test('a zero probe written 0e0, 0.0V or with an inline comment passes; a non-zero one does not', () => {
  for (const v of ['0e0', '0.0e-3', 'DC 0.0V', '0 $ probe', '0 ; probe', 'dc 0 $ c']) assert.deepEqual(blockSourceCheck(inDem(`VSONDE_1 gs ground ${v}`)).errors, [], v);
  for (const v of ['1e-3', '0 AC 1', '0 1', 'DC 1 $ 0']) assert.ok(blockSourceCheck(inDem(`VSONDE_1 gs ground ${v}`)).errors.length, v);
});

test('a source inside a nested .subckt definition and an XSPICE source are seen', () => {
  const nested = inDem('.subckt inner a b\nRI a b 1k\n.ends inner\nVX gs ground 3.3');
  assert.ok(blockSourceCheck(nested).errors.some((e) => /source in block demarrage: VX/.test(e)), 'after the inner .ends');
  const nested2 = inDem('XI gs ground inner\n.subckt inner a b\nVI a b 3.3\n.ends inner');
  assert.ok(blockSourceCheck(nested2).errors.some((e) => /source in block inner: VI/.test(e)), 'in the inner definition');
  const xs = inDem('AS [gs] dsrc\n.model dsrc d_source(input_file="x.txt")');
  assert.ok(blockSourceCheck(xs).errors.some((e) => /source in block demarrage: AS/.test(e)), 'XSPICE d_source');
  assert.deepEqual(blockSourceCheck(inDem('AG gs ground gain1\n.model gain1 gain(gain=2)')).errors, [], 'XSPICE gain is no source');
});

test('macro=1 models are listed; a source definition redefined as macro=1 is warned', async () => {
  const twice = TB.replace('.subckt ota ', '.subckt demarrage vref power ground\nVX vref ground 1.2\n.ends demarrage\n.subckt ota ')
    .replace(/\.subckt demarrage vref power ground\n(?!VX)/, '.subckt demarrage vref power ground macro=1\n');
  const c = blockSourceCheck(twice);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.macro, ['demarrage']);
  assert.ok(c.warnings.some((w) => /\.subckt demarrage defined twice.*first holds a source: VX.*macro=1/.test(w)), JSON.stringify(c.warnings));
  const r = await importHier(twice);
  assert.deepEqual(r.macroModels, ['demarrage']);
});
