// Eric's rule (08.11): the positive supply is a rail at the TOP, the negative one at the BOTTOM, by default; a
// supply is classified by its name and by the polarity of the devices on it, never by placement cost. First case:
// LOADMIR from layout3d (three PMOS on power_ana, no ground net), drawn upside down with per-pin symbols before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage, allCells, cellInfo } from '../lib/model.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { geoLvs } from '../lib/geo-lvs.js';
import { orientSupplies, supplyPolarity, supplyOrderViolations } from '../lib/supply-orient.js';

const raw = (rel) => withGroundAlias(parseSpice(fs.readFileSync(new URL(rel, import.meta.url), 'utf8')));
const LOADMIR = './fixtures/supply-rails/loadmir.sp';

test('LOADMIR: power_ana one rail at the top, the three PMOS hanging below it, nothing at the bottom', async () => {
  const p0 = raw(LOADMIR), o = orientSupplies(p0);
  assert.deepEqual(o.swapped, ['XM5'], 'the PMOS extracted with its drain on the supply is turned');
  assert.equal(o.polarity.power_ana, 'pos');
  const r = await autoPlace(o.parsed);
  assert.match(r.label, /manuel/);
  const cs = allCells(getPage(r.doc)).map(cellInfo);
  const sup = cs.filter((c) => c.kind === 'vertex' && /signal_sources\.vss2/.test(c.styleRaw || '') && c.value === 'power_ana');
  assert.equal(sup.length, 1, 'one supply symbol');
  assert.equal(cs.filter((c) => c.kind === 'vertex' && /signal_sources\.(gnd|signal_ground|protective_earth)|ground/i.test(c.styleRaw || '')).length, 0, 'no ground');
  const mos = cs.filter((c) => c.kind === 'vertex' && /^XM/.test(c.refdes || ''));
  assert.equal(mos.length, 3);
  for (const m of mos) assert.ok(m.y > sup[0].y + sup[0].h, `${m.refdes} below the rail`);
  assert.equal(new Set(mos.map((m) => m.y)).size, 1, 'the three PMOS on one row');
  // the bias current comes in from outside (no ground in the cell): an input port on von (Eric 07.11)
  const port = (n) => cs.find((c) => c.kind === 'vertex' && /apiShape=port/.test(c.styleRaw || '') && c.value === n);
  assert.ok(port('von'), 'bias current input port von');
  assert.ok(port('vout'), 'output port vout');
  // drawn with XM5 turned, still the extracted netlist (MOS drain and source interchangeable)
  assert.equal(compare(extractNetlist(getPage(r.doc)), p0).match, true);
  assert.deepEqual(supplyOrderViolations(cs, o.parsed), []);
});

test('supply polarity: by name, by bulk, a disagreement is a warning', () => {
  const p = parseSpice('M1 out in vdd vdd pmos W=1u L=1u\nM2 out in 0 0 nmos W=1u L=1u\nM3 a b vneg vneg nmos W=1u L=1u\nM4 a c vdd2 vdd2 nmos W=1u L=1u\n.end');
  const { pol, warnings } = supplyPolarity(p);
  assert.equal(pol.get('vdd'), 'pos'); assert.equal(pol.get('0'), 'neg');
  assert.equal(pol.get('vneg'), 'neg', 'an unnamed NMOS bulk carrying only sources and bulks is negative');
  assert.equal(pol.get('vdd2'), 'pos', 'the name wins');
  assert.ok(warnings.some((w) => /vdd2/.test(w)), 'name and devices disagree: warned');
});

test('LVS: a MOS with drain and source swapped still matches', () => {
  const a = parseSpice('M1 d g s 0 nmos W=1u L=1u\nR1 d vdd 1k\n.end'), b = parseSpice('M1 s g d 0 nmos W=1u L=1u\nR1 d vdd 1k\n.end');
  assert.equal(compare(a, b).match, true);
  const c = parseSpice('M1 d d s 0 nmos W=1u L=1u\nR1 d vdd 1k\n.end');
  assert.equal(compare(a, c).match, false, 'a gate moved onto the drain is a different circuit');
});

// every placement: devices on the positive supply above the devices on the negative one
const SWEEP = ['./fixtures/supply-rails/loadmir.sp', './fixtures/supply-rails/miller_vee.sp',
  ...['ota_5t.sp', 'ota_5t_p.sp', 'ota_miller.sp', 'ota_miller_p.sp', 'folded.sp', 'strongarm.sp'].map((f) => `./fixtures/tail-axis/${f}`),
  ...['miller.sp', 'g_bias.sp', 'bandgap.sp'].map((f) => `./fixtures/manuel/${f}`)];
for (const rel of SWEEP) {
  test(`supply order, auto: ${rel.split('/').pop()}`, async () => {
    const o = orientSupplies(raw(rel)), r = await autoPlace(o.parsed);
    const cs = allCells(getPage(r.doc)).map(cellInfo), bad = supplyOrderViolations(cs, o.parsed);
    // the rule holds in every case of the sweep, warning or not (a warning explains a deviation, none is expected here)
    assert.deepEqual(bad, [], `${r.label}: ${JSON.stringify(bad.slice(0, 4))}`);
    assert.deepEqual(o.warnings, [], 'no name/polarity disagreement in the sweep');
    // the kept rail leaves no stray dot; the whole geometric LVS where it is the engine's gate (manuel). The
    // templates are judged by the checker, not by it (cascode: same-net rail overlaps, StrongARM: its 45° X)
    const geo = geoLvs(getPage(r.doc)).errors;
    assert.deepEqual(geo.filter((x) => x.rule === 'dangling'), [], r.label);
    if (/manuel/.test(r.label)) assert.deepEqual(geo, [], r.label);
    assert.equal(compare(extractNetlist(getPage(r.doc)), raw(rel)).match, true);
  });
}
