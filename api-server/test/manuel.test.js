// engine manuel (lib/place-manuel.js) and the geometric LVS (lib/geo-lvs.js)
// orchestrator GO 2026-10-24: manuel first when its reading is sure, the
// "sure" criterion tested, wires in the void = failure
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { newDocument, getPage, allCells, cellInfo, deleteCell, updateCell } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { manuelReading } from '../lib/manuel-reading.js';
import { importNetlistManuel, eng } from '../lib/place-manuel.js';
import { geoLvs } from '../lib/geo-lvs.js';
import { tryManuel } from '../lib/auto.js';

const fx = (n) => withGroundAlias(parseSpice(fs.readFileSync(new URL(`./fixtures/manuel/${n}.sp`, import.meta.url), 'utf8')));
const draw = (p) => { const doc = newDocument(), m = getPage(doc); const r = importNetlistManuel(m, p); return { doc, m, r }; };
const SURE = { g_ota1_core: ['core', 'bias'], g_ota1_cmfb: ['core'], g_ota23: ['core', 'bias', 'cmfb'], g_bias: ['core', 'bias'], g_ota1_hbt: ['core', 'bias', 'cmfb'], miller: ['core', 'bias'], bandgap: ['core'] };

for (const [n, frames] of Object.entries(SURE)) {
  test(`manuel draws ${n}: LVS and geometric LVS green, frames ${frames}`, () => {
    const p = fx(n), { m, r } = draw(p);
    assert.equal(compare(extractNetlist(m), p).match, true);
    assert.equal(r.geo.ok, true, JSON.stringify(r.geo.errors.slice(0, 3)));
    assert.deepEqual(r.frames, frames);
  });
}

test('bias nets are labels, signal nets stay wires', () => {
  const r = manuelReading(fx('g_ota1_core'));
  for (const n of ['vbn', 'vcn', 'vcp', 'vcmfb']) assert.ok(r.labelNets.has(n), n);
  for (const n of ['inp', 'inn', 'o1a', 'o1b']) assert.ok(!r.labelNets.has(n), n);
});

test('"sure" criterion: no reading -> no manuel drawing (fallback)', () => {
  assert.equal(manuelReading(fx('g_bank')), null);                        // a bus ladder of switches
  assert.equal(tryManuel(fx('g_bank')), null);
  const few = parseSpice('R1 a 0 1k\nR2 a b 1k\n.end');                    // fewer than 3 parts
  assert.equal(manuelReading(few), null);
  const sub = parseSpice('X1 a b 0 cell\nM1 a b 0 0 nmos W=1u L=1u\nR1 vdd a 1k\nV1 vdd 0 1.2\n.end');   // a subcircuit call
  assert.equal(manuelReading(sub), null);
  const noGnd = parseSpice('M1 a b s s nmos W=1u L=1u\nR1 vdd a 1k\nR2 s vss 1k\n.end');             // no ground net
  assert.equal(manuelReading(noGnd), null);
});

test('engineering notation', () => {
  assert.equal(eng(100000, 'Ω'), '100 kΩ');
  assert.equal(eng(4.97e-13, 'F'), '497 fF');
});

test('geometric LVS: a wire removed leaves a dangling junction', () => {
  const { m } = draw(fx('g_ota23'));
  const cells = allCells(m).map(cellInfo);
  const deg = new Map();
  for (const e of cells.filter((c) => c.kind === 'edge')) for (const id of [e.source, e.target]) deg.set(id, (deg.get(id) || 0) + 1);
  const j = cells.find((c) => c.kind === 'vertex' && /^MN_j_/.test(c.id) && deg.get(c.id) === 3);
  const e = cells.find((c) => c.kind === 'edge' && (c.source === j.id || c.target === j.id));
  deleteCell(m, e.id);
  const g = geoLvs(m);
  assert.equal(g.ok, true, 'a 2-wire junction is a warning, not an error');
  const e2 = allCells(m).map(cellInfo).find((c) => c.kind === 'edge' && (c.source === j.id || c.target === j.id));
  deleteCell(m, e2.id);
  assert.ok(geoLvs(m).errors.some((x) => x.rule === 'dangling'));
});

test('geometric LVS: a junction moved off its wires is caught', () => {
  const { m } = draw(fx('g_ota1_cmfb'));
  const j = allCells(m).map(cellInfo).find((c) => c.kind === 'vertex' && /^MN_j_/.test(c.id));
  updateCell(m, j.id, { x: j.x + 37, y: j.y + 23 });
  const rules = new Set(geoLvs(m).errors.map((x) => x.rule));
  assert.ok(rules.has('oblique') || rules.has('tee-no-dot') || rules.has('overlap'), [...rules].join(','));
});

test('bandgap core (beta multiplier): gate partners on one row, joined by a bar', () => {
  const { m } = draw(fx('bandgap'));
  const at = (id) => allCells(m).map(cellInfo).find((c) => c.id === id);
  assert.equal(at('M1').y, at('M2').y);
  assert.equal(at('M3').y, at('M4').y);
  assert.ok(Math.abs(at('M1').x - at('M2').x) < 600, 'adjacent columns');
});
