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
  // unwrapped to the top: one testbench page, no extra top page holding only XTB (review of #72, minor)
  assert.deepEqual(r.pages.map((p) => `${p.name}:${p.kind}`), ['tb_bandgap:testbench', 'bandgap:subckt', 'ota:subckt', 'demarrage:subckt']);
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

// review of #72 (Orchestrator, 2026-10-26, REVUE-72.md): B1 and B2
test('B1: an instance read as the parser reads it (a parameter before the name): its definition is checked', () => {
  const m1 = TB.replace('XDEM vref power ground demarrage', 'XDEM vref power ground m=1 demarrage').replace('.ends demarrage', 'VX gs ground 3.3\n.ends demarrage');
  assert.ok(m1.includes('m=1 demarrage'));
  assert.ok(blockSourceCheck(m1).errors.some((e) => /source in block demarrage: VX/.test(e)), 'm=1 before the name');
  const named = TB.replace(/\.subckt demarrage/g, '.subckt macro=1').replace(/\bdemarrage\b/g, 'macro=1').replace('.ends macro=1', 'VX gs ground 1\n.ends macro=1');
  const c = blockSourceCheck(named);
  assert.ok(c.errors.some((e) => /source in block macro=1: VX/.test(e)), JSON.stringify(c));
  assert.deepEqual(c.macro, []);
});

test('B2: a tb_ exempts only a bench body (sources, block instances, R/C/L loads): tb_flat and tb_core are refused', async () => {
  const flat = '* flat in tb\n.subckt tb_flat\nVDD vdd 0 3.3\nXQ1 c1 vb e 0 npn13G2 Nx=18\nXMS vdd gs vref 0 sg13_hv_nmos w=2u l=0.45u ng=1\nRL vref 0 10k\nRB vb 0 10k\nRC c1 vdd 10k\nRE e 0 1k\n.ends tb_flat\nXTB tb_flat\n.end\n';
  assert.ok(blockSourceCheck(flat).errors.some((e) => /source in block tb_flat: VDD/.test(e)), 'transistors in the tb_');
  const core = TB.replace(BENCH, '').replace('.subckt bandgap vref power ground', '.subckt tb_core vref power ground').replace('.ends bandgap', 'VINT power ground 3.3\n.ends tb_core') + 'XC vref vdd 0 tb_core\n.end\n';
  assert.ok(blockSourceCheck(core).errors.some((e) => /source in block tb_core: VINT/.test(e)), 'a block renamed tb_core');
  assert.ok((await importHier(core)).errors?.length);
});

// re-review of #72 (Orchestrator, 2026-10-26, REVUE-72.md « Re-revue 72e57369 »): the next batch
test('a bench with a VCVS supply: the classic bench, E wired from its control source, LVS green', async () => {
  const { getPage, allCells, cellInfo } = await import('../lib/model.js');
  const r = await importHier(TB.replace('VDD vdd 0 3.3\n', 'VREF r 0 1.65\nEDD vdd 0 r 0 2\n'));
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  assert.equal(r.pages[0].name, 'tb_bandgap');
  assert.equal(r.pages[0].engine, 'testbench');
  assert.ok(Object.values(r.lvs.pages).every(Boolean) && r.lvs.global, JSON.stringify(r.lvs));
  const cells = allCells(getPage(r.doc, 'tb_bandgap')).map(cellInfo);
  assert.ok(cells.some((c) => c.refdes === 'EDD') && cells.some((c) => c.refdes === 'VREF'));
  // nc+ by a wire, not a name label
  const labels = cells.filter((c) => /apiShape=port/.test(c.styleRaw || '')).map((c) => String(c.value).replace(/<[^>]+>/g, '').trim());
  assert.ok(!labels.includes('r'), labels.join(' '));
});

test('a VCCS G in a bench and a VCVS on a block page: drawn (no "part with 4 pins" refusal), LVS green', async () => {
  const g = await importHier(TB.replace('CL vref 0 1e-11\n', 'CL vref 0 1e-11\nGI vref 0 r 0 1m\nVR r 0 1\n'));
  assert.ok(Object.values(g.lvs.pages).every(Boolean) && g.lvs.global, JSON.stringify(g.lvs.pages));
  const e = await importHier(TB.replace('VDD vdd 0 3.3\n', 'VDD vdd 0 3.3\nVR r 0 1\nEX vdd2 0 r 0 2\nRX vdd2 0 1k\n'));
  assert.ok(Object.values(e.lvs.pages).every(Boolean) && e.lvs.global, JSON.stringify(e.lvs.pages));
});

test('block .subckt definitions written inside the tb_ .subckt: read nested, the bench passes', async () => {
  const defs = TB.slice(TB.indexOf('.subckt ota'), TB.indexOf(BENCH));
  const t = TB.replace(defs, '').replace(BENCH, `.subckt tb_bandgap\n${defs}${BENCH}.ends tb_bandgap\nXTB tb_bandgap\n`);
  const r = await importHier(t);
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  assert.deepEqual(r.pages.map((p) => `${p.name}:${p.kind}`), ['tb_bandgap:testbench', 'bandgap:subckt', 'ota:subckt', 'demarrage:subckt']);
  assert.ok(Object.values(r.lvs.pages).every(Boolean) && r.lvs.global);
  // the parser: the outer definition resumes after the inner .ends
  const { parseSpice } = await import('../lib/netlist.js');
  const p = parseSpice('.subckt a x y\nR1 x m 1k\n.subckt b u v\nR2 u v 1k\n.ends b\nXB m y b\n.ends a\nXA 1 0 a\n.end\n');
  assert.deepEqual(p.subckts.A.lines.map((l) => l.trim()), ['R1 x m 1k', 'XB m y b']);
  assert.deepEqual(p.subckts.B.lines.map((l) => l.trim()), ['R2 u v 1k']);
});

test('a C or L with ic= in a block: a warning, not in the bench', () => {
  const c = blockSourceCheck(inDem('CBIG gs ground 1 ic=3.3'));
  assert.ok(c.warnings.some((w) => /initial condition in block demarrage: CBIG/.test(w)), JSON.stringify(c.warnings));
  assert.ok(!blockSourceCheck(TB.replace('CL vref 0 1e-11', 'CL vref 0 1e-11 ic=1.2')).warnings.some((w) => /initial condition/.test(w)));
});
