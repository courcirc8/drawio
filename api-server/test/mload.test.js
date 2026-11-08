// MLOAD (layout3d, Orchestrator 08.11): an NMOS mirror load cut out of a layout — two parts, a ground and no supply.
// (1) its channel nets d3 and o1 are ports, flat or as a single .subckt; (2) port names keep their case on every
// engine; (3) W/L ×m under each transistor name on every engine; (4) the diode strap drawn directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage, newDocument, allCells, cellInfo } from '../lib/model.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { mergeFingers } from '../lib/fingers.js';
import { orientSupplies } from '../lib/supply-orient.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';
import { geoLvs } from '../lib/geo-lvs.js';
import { importNetlist2 } from '../lib/place2.js';
import { routePage } from '../lib/route.js';
import { unwrapSingleSubckt } from '../lib/unwrap-subckt.js';
import { annotateSizes } from '../lib/size-labels.js';

const read = (f) => fs.readFileSync(new URL(`./fixtures/supply-rails/${f}`, import.meta.url), 'utf8');
const prep = (text) => orientSupplies(mergeFingers(withGroundAlias(unwrapSingleSubckt(parseSpice(text))))).parsed;
const ports = (cs) => cs.filter((c) => c.kind === 'vertex' && /apiShape=port/.test(c.styleRaw || '')).map((c) => String(c.value));
const plain = (v) => String(v || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');

for (const f of ['mload.sp', 'mload_sub.sp']) {
  test(`MLOAD ${f}: manuel, ports d3 and o1 as written, W/L ×m, LVS and geometric LVS green`, async () => {
    const p = prep(read(f));
    if (f === 'mload_sub.sp') assert.deepEqual(p.pins, ['d3', 'o1', 'vss'], 'the .subckt body, its pins kept');
    const r = await autoPlace(p), m = getPage(r.doc), cs = allCells(m).map(cellInfo);
    assert.match(r.label, /manuel/);
    assert.deepEqual(ports(cs).sort(), ['d3', 'o1']);
    for (const ref of ['XM2', 'XM4']) assert.ok(cs.some((c) => c.kind === 'vertex' && plain(c.value).includes(ref) && plain(c.value).includes('4.375/8 ×8')), ref);
    assert.equal(compare(extractNetlist(m), p).match, true);
    assert.deepEqual(geoLvs(m).errors, []);
    // (4) the diode strap: the d3 wires stay between the two transistors, none loops round XM2's outer side
    const xm2 = cs.find((c) => c.refdes === 'XM2'), xm4 = cs.find((c) => c.refdes === 'XM4');
    const lo = Math.min(xm2.x, xm4.x), hi = Math.max(xm2.x + xm2.w, xm4.x + xm4.w);
    const gateX = (c) => c.x + (c.style.map.get('flipH') === '1' ? c.w : 0);
    for (const e of cs.filter((c) => c.kind === 'edge')) for (const q of e.points || []) assert.ok(q.x >= lo - 1 && q.x <= hi + 1, `${e.id} at x=${q.x} outside [${lo}, ${hi}]`);
    assert.ok(gateX(xm2) >= lo - 1);
  });
}

test('single .subckt deck: unwrapped only when it is the whole deck', () => {
  assert.equal(unwrapSingleSubckt(parseSpice(read('mload_sub.sp'))).components.length, 2);
  const two = parseSpice('.subckt A x y\nR1 x y 1k\n.ends\n.subckt B x y\nR1 x y 1k\n.ends\n.end');
  assert.equal(unwrapSingleSubckt(two), two, 'two definitions: left to --hier');
  const top = parseSpice('.subckt A x y\nR1 x y 1k\n.ends\nX1 a b A\n.end');
  assert.equal(unwrapSingleSubckt(top).components.length, top.components.length, 'an instance at the top: left as is');
});

test('v2 keeps the case of port names and shows W/L ×m under the names', async () => {
  const p = prep('M1 Out1 in 0 0 nmos W=2u L=0.5u m=2\nM2 Out1 in2 0 0 nmos W=2u L=0.5u\nR1 vdd Out1 10k\n.end');
  const m = getPage(newDocument()), placed = importNetlist2(m, p);
  await routePage(m, placed.wires, {});
  annotateSizes(m, p);
  const cs = allCells(m).map(cellInfo);
  assert.ok(ports(cs).includes('Out1'), JSON.stringify(ports(cs)));
  assert.ok(!ports(cs).some((v) => v !== v.toLowerCase() && v === v.toUpperCase() && v !== 'Out1'), 'nothing upper-cased');
  const lbl = cs.find((c) => c.id === 'LBL_M1');
  assert.ok(lbl && plain(lbl.value).includes('2/0.5 ×2'), plain(lbl?.value));
  assert.equal(compare(extractNetlist(m), p).match, true);
});
