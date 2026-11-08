// engine manuel on a StrongARM latch comparator (Orchestrator 07.11: the general columns mixed its two
// cross-coupled pairs and failed the engine's own geometric LVS): its textbook figure, geometric and netlist LVS
// clean. Precharges outside, cross-coupled PMOS over cross-coupled NMOS over the input pair, the tail centred.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { newDocument, getPage, allCells, cellInfo } from '../lib/model.js';
import { classify, activePins } from '../lib/components.js';
import { pinAbs } from '../lib/route.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { importNetlistManuel } from '../lib/place-manuel.js';
import { compare } from '../lib/lvs.js';

const read = (rel) => withGroundAlias(parseSpice(fs.readFileSync(new URL(rel, import.meta.url), 'utf8')));
function pinOn(c, rel) {
  const d = c.style.map.get('direction'); let { x, y } = rel;
  if (d === 'west') { x = 1 - x; y = 1 - y; } else if (d === 'north') [x, y] = [y, 1 - x]; else if (d === 'south') [x, y] = [1 - y, x];
  return pinAbs(c, { x, y });
}
const chan = (c) => { const ps = activePins(classify(c)).filter((p) => p.y !== 0.5).map((p) => pinOn(c, p)); return { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: Math.min(...ps.map((p) => p.y)) }; };

const CASES = [
  ['strongarm (precharge of outputs and inner nodes)', './fixtures/tail-axis/strongarm.sp', { tail: 'Mtail', inner: ['M9', 'M10'] }],
  ['strongarm-latch (outputs precharged only)', '../benchmark/netlists30/strongarm-latch.cir', { tail: 'M9', inner: [] }],
];
for (const [name, rel, k] of CASES) {
  test(`manuel: StrongARM textbook figure, LVS clean (${name})`, () => {
    const p = read(rel), page = getPage(newDocument());
    const r = importNetlistManuel(page, p);           // throws on a geometric LVS failure
    assert.ok(r.geo.ok, JSON.stringify(r.geo.errors.slice(0, 3)));
    assert.deepEqual(r.frames, ['strongarm']);
    const rep = compare(extractNetlist(page), p);
    assert.ok(rep.match, JSON.stringify(rep).slice(0, 400));
    const v = new Map(allCells(page).map(cellInfo).filter((c) => c.kind === 'vertex' && c.refdes).map((c) => [c.refdes, chan(c)]));
    const at = (r) => v.get(r);
    // the columns: P5 over M3 over M1 on the left, mirrored on the right; the cross-coupled pairs on one row each
    assert.ok(Math.abs(at('M5').x - at('M3').x) < 1 && Math.abs(at('M3').x - at('M1').x) < 1, 'left column');
    assert.ok(Math.abs(at('M6').x - at('M4').x) < 1 && Math.abs(at('M4').x - at('M2').x) < 1, 'right column');
    assert.ok(at('M5').y < at('M3').y && at('M3').y < at('M1').y && at('M1').y < at(k.tail).y, 'PMOS, NMOS pair, inputs, tail from top');
    assert.equal(at('M5').y, at('M6').y); assert.equal(at('M3').y, at('M4').y);
    // the output precharges outside, the tail on the axis
    assert.ok(at('M7').x < at('M5').x && at('M8').x > at('M6').x, 'precharges outside');
    for (const r of k.inner) assert.ok(at(r).x < at('M7').x || at(r).x > at('M8').x, `${r} further out`);
    assert.ok(Math.abs(at(k.tail).x - (at('M1').x + at('M2').x) / 2) <= 10, 'tail on the axis');
  });
}

test('manuel: a StrongARM with output inverters is not drawn as the bare figure', () => {
  const src = fs.readFileSync(new URL('./fixtures/tail-axis/strongarm.sp', import.meta.url), 'utf8')
    .replace('.end', 'MI1 qa outn vdd vdd pmos W=1u L=0.13u\nMI2 qa outn 0 0 nmos W=1u L=0.13u\nMI3 qb outp vdd vdd pmos W=1u L=0.13u\nMI4 qb outp 0 0 nmos W=1u L=0.13u\n.end');
  const page = getPage(newDocument());
  let frames = null;
  try { frames = importNetlistManuel(page, withGroundAlias(parseSpice(src))).frames; } catch { /* not sure: fine */ }
  assert.notDeepEqual(frames, ['strongarm']);
});
