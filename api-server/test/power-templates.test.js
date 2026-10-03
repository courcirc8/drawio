import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newDocument, getPage, allCells, cellInfo } from '../lib/model.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { importNetlist2 } from '../lib/place2.js';
import { importNetlist4 } from '../lib/place4.js';
import { routePage } from '../lib/route.js';
import { compare } from '../lib/lvs.js';
import { checkDocument } from '../lib/check.js';

const cir = (name) => fs.readFileSync(new URL(`../benchmark/power-v1/${name}.cir`, import.meta.url), 'utf8');
async function v2(text) {
  const parsed = parseSpice(text);
  const m = getPage(newDocument());
  const p = importNetlist2(m, parsed);
  await routePage(m, p.wires, {});
  const at = new Map(allCells(m).map(cellInfo).filter((c) => c.kind === 'vertex' && c.refdes).map((c) => [c.refdes, { x: c.x + c.w / 2, y: c.y + c.h / 2 }]));
  return { m, parsed, at };
}

test('diode bridge: one leg per column, upper diode above its lower one, load beside the bridge', { timeout: 120000 }, async () => {
  const { m, parsed, at } = await v2(cir('three-phase-bridge'));
  assert.equal(compare(extractNetlist(m), parsed).match, true);
  for (const [up, down] of [['D1', 'D4'], ['D2', 'D5'], ['D3', 'D6']]) {
    assert.ok(Math.abs(at.get(up).x - at.get(down).x) < 2, `${up}/${down} share a column`);
    assert.ok(at.get(up).y < at.get(down).y - 40, `${up} above ${down}`);
  }
  const legX = ['D1', 'D2', 'D3'].map((r) => at.get(r).x);
  assert.equal(new Set(legX.map(Math.round)).size, 3, 'three distinct legs');
  assert.ok(at.get('Rl').x > Math.max(...legX), 'load right of the bridge');
  const errs = checkDocument(m).violations.filter((v) => v.severity === 'error' && v.rule !== '30');
  assert.deepEqual(errs.map((v) => v.rule), []);
});

test('freewheel diodes across switches stay out of rectifier legs', { timeout: 120000 }, async () => {
  const { m, parsed, at } = await v2(cir('hbridge-switches'));
  assert.equal(compare(extractNetlist(m), parsed).match, true);
  // D1 (across S1) and D2 (across S2) would form a leg bus/la/0 if not excluded
  assert.ok(!(Math.abs(at.get('D1').x - at.get('D2').x) < 2 && at.get('D1').y < at.get('D2').y), 'D1/D2 not stacked as a rectifier leg');
});

test('v4 composes the power circuits and keeps LVS', { timeout: 120000 }, async () => {
  for (const name of ['graetz-rc', 'greinacher-doubler', 'cw-two-stage', 'buck']) {
    const parsed = parseSpice(cir(name));
    const m = getPage(newDocument());
    await importNetlist4(m, parsed);
    assert.equal(compare(extractNetlist(m), parsed).match, true, name);
  }
});
