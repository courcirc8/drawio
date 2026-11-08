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

// REVIEW 08.11 (R1): the rule checked WITHOUT lib/supply-orient.js — a mutant that swaps the polarities there must
// fail here. Supplies by literal name; MOS kind by model; the top supply symbol above every ground symbol, every
// PMOS on vdd above every NMOS on the ground.
const POS = new Set(['vdd', 'power_ana']), NEG = new Set(['0', 'vee', 'vss']);
for (const rel of SWEEP) {
  test(`supply order, independent of supply-orient: ${rel.split('/').pop()}`, async () => {
    const p = raw(rel), r = await autoPlace(orientSupplies(p).parsed);
    const cs = allCells(getPage(r.doc)).map(cellInfo), v = cs.filter((c) => c.kind === 'vertex' && c.y != null);
    const yc = (c) => c.y + (c.h || 0) / 2, at = new Map(v.filter((c) => c.refdes).map((c) => [c.refdes, yc(c)]));
    const sup = v.filter((c) => /signal_sources\.vss2|apiShape=supply|vdd/i.test(c.styleRaw || '') && POS.has(String(c.value || '').toLowerCase()));
    const gnd = v.filter((c) => /signal_ground|signal_sources\.gnd|ground/i.test(c.styleRaw || ''));
    // top to bottom the symbols alternate supply, ground (a frame of its own — manuel's Polarisation — has its own
    // supply at its top and ground at its bottom); a supply symbol first, a ground symbol last
    const seq = [...sup.map((c) => ['S', yc(c)]), ...gnd.map((c) => ['G', yc(c)])].sort((a, b) => a[1] - b[1]).map((x) => x[0]).join('').replace(/(.)\1+/g, '$1');
    if (sup.length && gnd.length) assert.match(seq, /^(SG)+$/, `${r.label}: supply / ground order ${seq}`);
    const pos = [], neg = [];
    for (const c of p.components.filter((x) => x.prefix === 'M' || (x.prefix === 'X' && /mos/i.test(x.model || '')))) {
      const n = c.fullNodes || c.nodes, ch = [n[0], n[2]].map((x) => String(x).toLowerCase()), m = String(c.model || '').toLowerCase();
      if (/pmos|pfet/.test(m) && ch.some((x) => POS.has(x))) pos.push(c.ref);
      if (/nmos|nfet/.test(m) && ch.some((x) => NEG.has(x))) neg.push(c.ref);
    }
    for (const a of pos) for (const b of neg) if (at.has(a) && at.has(b)) assert.ok(at.get(a) < at.get(b), `${r.label}: ${a} (PMOS on the supply) above ${b}`);
    assert.equal(r.supplyOrder, undefined, 'no runtime supply-order warning');
  });
}

test('R1: a candidate that breaks the supply order loses to one that keeps it, template or not', async () => {
  const { better } = await import('../lib/auto.js');
  const tmpl = { eng: 'ota', errs: 0, gateFails: 0, supplyOrder: 2 }, gen = { eng: 'v2', errs: 5, gateFails: 6, supplyOrder: 0 };
  assert.equal(better(gen, tmpl), true); assert.equal(better(tmpl, gen), false);
});

test('R1: a drawing flipped upside down is caught by the runtime check', async () => {
  const o = orientSupplies(raw('./fixtures/tail-axis/ota_miller.sp')), r = await autoPlace(o.parsed), m = getPage(r.doc);
  for (const n of allCells(m)) { const g = n.getElementsByTagName ? n.getElementsByTagName('mxGeometry')[0] : null; if (g && g.getAttribute('y') != null && g.getAttribute('relative') !== '1') g.setAttribute('y', String(-Number(g.getAttribute('y')) - Number(g.getAttribute('height') || 0))); }
  assert.ok(supplyOrderViolations(allCells(m).map(cellInfo), o.parsed).length > 0);
});

// REVIEW 08.11 (R2): the rail is kept when the checker counts more errors (Eric 08.11); undoing it again must fail here
test('R2: a rail is redrawn although the checker counts more errors, with a warning', async () => {
  const { drawRails } = await import('../lib/rails.js');
  const r = await autoPlace(orientSupplies(raw('./fixtures/tail-axis/ota_5t.sp')).parsed), m = getPage(r.doc);
  let n = 0; const worse = async () => n++;   // every count higher than the last
  const out = await drawRails(m, { errorCount: worse });
  assert.ok(out.rails >= 1);
  assert.equal(out.redrawn, out.rails, JSON.stringify(out));
  assert.ok((out.warnings || []).some((w) => /more error/.test(w)), JSON.stringify(out));
});

// REVIEW 08.11 (R3): vee is the bottom rail by polarity and keeps its name on the drawing; a fixture whose device
// parameters are not numbers (L=vee.5u, a non-token substitution) is caught
test('R3: vee keeps its name on the bottom rail', async () => {
  const r = await autoPlace(orientSupplies(raw('./fixtures/supply-rails/miller_vee.sp')).parsed);
  const cs = allCells(getPage(r.doc)).map(cellInfo);
  assert.ok(cs.some((c) => c.kind === 'vertex' && String(c.value || '') === 'vee'), `${r.label}: a vee label`);
});
test('R3: every MOS of the sweep fixtures has numeric W and L', () => {
  for (const rel of SWEEP) {
    for (const line of fs.readFileSync(new URL(rel, import.meta.url), 'utf8').split('\n').filter((l) => /^\s*[MX]/i.test(l) && /\b[WL]=/i.test(l))) {
      for (const m of line.matchAll(/\b([WL])=(\S+)/gi)) assert.match(m[2], /^[\d.]+(e-?\d+)?[a-z]*$/i, `${rel}: ${line.trim()}`);
    }
  }
});

// REVIEW r2 (B1): a pin whose straight drop runs on a body (a device tied to its own rail) is jogged or routed;
// the rail stays one line with one symbol (rule 5), it is never dissolved into one symbol per pin
test('B1: the template keeps one vdd and one ground rail when a drop would cross a body', async () => {
  const { trial } = await import('../lib/auto.js');
  const { wiresOnBody } = await import('../lib/quality.js');
  const t = await trial(raw('./fixtures/supply-rails/ota5t_tied.sp'), 'ota', null, {}, {});
  const m = getPage(t.doc), cs = allCells(m).map(cellInfo);
  assert.equal(cs.filter((c) => /signal_sources\.(vdd|vss2)/.test(c.styleRaw || '')).length, 1, 'one vdd symbol');
  assert.equal(cs.filter((c) => /signal_ground/.test(c.styleRaw || '')).length, 1, 'one ground symbol');
  assert.deepEqual(wiresOnBody(m), []);
  assert.equal(t.errs, 0);
});

// REVIEW r2 (A6, A8): names and MOS disagree (PMOS on "vss", NMOS on "vdd"), every drawing breaks the order by name
const CONFLICT = 'M1 out in vss vss pmos W=2u L=1u\nM2 out in2 vdd vdd nmos W=1u L=1u\n.end';
test('R1 (r2): a candidate trial counts its supply-order breaks', async () => {
  const { trial } = await import('../lib/auto.js');
  const p = orientSupplies(withGroundAlias(parseSpice(CONFLICT))).parsed;
  assert.ok((await trial(p, 'v4', null, {}, {})).supplyOrder > 0);
});
test('R1 (r2): autoPlace reports a final drawing that still breaks the order', async () => {
  const o = orientSupplies(withGroundAlias(parseSpice(CONFLICT)));
  assert.ok(o.warnings.length >= 1, 'the name/polarity disagreement is said');
  const r = await autoPlace(o.parsed);
  assert.ok(Array.isArray(r.supplyOrder) && r.supplyOrder.length > 0, JSON.stringify(r.supplyOrder));
});
test('R1 (r2): supplyOrderWarnings words each pair', async () => {
  const { supplyOrderWarnings } = await import('../lib/supply-orient.js');
  const o = orientSupplies(withGroundAlias(parseSpice(CONFLICT))), r = await autoPlace(o.parsed);
  const w = supplyOrderWarnings(allCells(getPage(r.doc)).map(cellInfo), o.parsed);
  assert.deepEqual(w, ['supply order: M2 (positive supply) is not above M1 (negative supply)']);
});
