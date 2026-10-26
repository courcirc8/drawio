// Fully differential OTA with a telescopic cascode input stage, read by the
// manual engine (lib/manuel-reading.js + lib/place-manuel.js). Request of the
// Orchestrator, 2026-10-25: the OTA pages of the TIA proj5 (tia-butterworth3,
// our own IHP SG13G2 design) fell back to another engine with LVS failing.
// ota1 carries a power-on kick (XKA/XKB, RPOR, CPOR); ota2 is the same OTA
// without it; the tia_op OTA is the plain (non-cascoded) version.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { newDocument, getPage, allCells, cellInfo } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { importNetlistManuel } from '../lib/place-manuel.js';
import { manuelReading } from '../lib/manuel-reading.js';
import { qualityGate } from '../lib/quality.js';
import { tryManuel } from '../lib/auto.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const src = (n) => read(`./fixtures/cascode-ota/${n}.sp`);
// the plain OTA: the ota1 body of the tia_op hierarchy
const plain = () => read('./fixtures/hier/tia_op.cir').split(/^\.subckt ota1 .*$/m)[1].split(/^\.ends/m)[0] + '.end\n';
const parse = (t) => withGroundAlias(parseSpice(t));
const FORMS = { ota1: () => src('ota1'), ota2: () => src('ota2'), plain };
const draw = (p) => { const doc = newDocument(), m = getPage(doc); const r = importNetlistManuel(m, p); return { m, r }; };
const vertices = (m) => new Map(allCells(m).map(cellInfo).filter((c) => c.kind === 'vertex').map((c) => [String(c.refdes || c.id).toUpperCase(), c]));
const frameRefs = (R, kind) => (R.frames.find((f) => f.kind === kind)?.parts || []).map((c) => c.ref).sort();
const flipped = (c) => String(c.style.map.get('flipH') || '0') === '1';

test('cascode OTA reading: core, replica bias, CMFB and the power-on kick apart (ota1)', () => {
  const R = manuelReading(parse(src('ota1')));
  assert.ok(R && R.sure);
  assert.deepEqual(R.frames.map((f) => f.kind), ['core', 'bias', 'cmfb', 'startup']);
  assert.deepEqual(frameRefs(R, 'startup'), ['CPOR', 'RPOR', 'XKA', 'XKB']);
  // the cascode-bias replicas leave the core for « Polarisation »
  const bias = frameRefs(R, 'bias');
  for (const r of ['XMBN', 'XRBN', 'XMPN', 'XMPD', 'XMQ1', 'XRBP', 'XMBP', 'XMQ2']) assert.ok(bias.includes(r), `${r} in bias: ${bias}`);
  const core = frameRefs(R, 'core');
  for (const r of ['XM1', 'XM2', 'XMCA', 'XMCB', 'XMPA', 'XMPB', 'XM3', 'XM4', 'XM5', 'XM6A', 'XM7B', 'XCCA', 'XRZB']) assert.ok(core.includes(r), `${r} in core`);
  assert.deepEqual(frameRefs(R, 'cmfb'), ['CCMA', 'CCMB', 'RCMA', 'RCMB', 'XM10', 'XM11', 'XM12', 'XM8', 'XM9']);
});

test('cascode OTA reading: no start-up frame without the kick (ota2)', () => {
  const R = manuelReading(parse(src('ota2')));
  assert.deepEqual(R.frames.map((f) => f.kind), ['core', 'bias', 'cmfb']);
});

for (const [n, text] of Object.entries(FORMS)) {
  test(`OTA drawn: LVS, geometric LVS and the quality gate green (${n})`, () => {
    const p = parse(text()), { m, r } = draw(p);
    assert.equal(compare(extractNetlist(m), p).match, true);
    assert.equal(r.geo.ok, true, JSON.stringify(r.geo.errors.slice(0, 3)));
    const bad = Object.entries(qualityGate(m, p).checks).filter(([, v]) => !v.ok).map(([k, v]) => `${k} ${JSON.stringify(v).slice(0, 200)}`);
    assert.deepEqual(bad, []);
  });
}

test('cascode OTA reads like the textbook (ota1)', () => {
  const { m } = draw(parse(src('ota1'))), v = vertices(m), g = (r) => v.get(r);
  // the telescopic stack, top to bottom: load, P cascode, N cascode, input
  for (const s of ['A', 'B']) {
    const stack = [s === 'A' ? 'XM3' : 'XM4', `XMP${s}`, `XMC${s}`, s === 'A' ? 'XM1' : 'XM2'].map(g);
    for (let i = 1; i < stack.length; i++) assert.ok(stack[i - 1].y < stack[i].y, `stack ${s}`);
  }
  // both halves mirrored: the input pair and the CMFB pair
  assert.notEqual(flipped(g('XM1')), flipped(g('XM2')));
  assert.notEqual(flipped(g('XM8')), flipped(g('XM9')));
  assert.equal(g('XM8').y, g('XM9').y);
  // the R || C sensing rungs drawn side by side
  assert.equal(g('RCMA').y + g('RCMA').h / 2, g('CCMA').y + g('CCMA').h / 2);
});

test('cascode OTA: the kick stays in the core when its gate node is driven by a transistor', () => {
  const t = src('ota1').replace(/^\.end/m, 'XMX por vbn 0 0 sg13_lv_nmos w=1u l=0.13u ng=1 m=1\n.end');
  const R = manuelReading(parse(t));
  assert.ok(!R || !R.frames.some((f) => f.kind === 'startup'));
});

test('a tail biased by a plain divider is not a start-up (no capacitor: a bias)', () => {
  const R = manuelReading(parse(`M1 o1 inp t 0 nmos
M2 o2 inn t 0 nmos
M3 t vb 0 0 nmos
R1 o1 vdd 1k
R2 o2 vdd 1k
R3 0 vb 1k
R4 vb vdd 1k
.end`));
  assert.ok(!R || !R.frames.some((f) => f.kind === 'startup'));
});

test('cascode OTA: tryManuel returns the manual drawing', () => {
  assert.equal(tryManuel(parse(src('ota1')))?.placed.frames.join(), 'core,bias,cmfb,startup');
  assert.equal(tryManuel(parse(src('ota2')))?.placed.frames.join(), 'core,bias,cmfb');
});
