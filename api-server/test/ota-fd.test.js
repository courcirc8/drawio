import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, getPage, normalizeOrigin, serialize, parseDrawio, cellInfo, allCells } from '../lib/model.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { importNetlist } from '../lib/place.js';
import { importNetlist2 } from '../lib/place2.js';
import { routePage } from '../lib/route.js';
import { compare } from '../lib/lvs.js';
import { classify } from '../lib/components.js';

// A fully differential op-amp (2026-10-27, analog-design TIA, Eric's option 1): an undefined
// .subckt `opamp_fd` with 4 pins in+ in- out+ out- is drawn as the catalogue OTA 2 and
// extracts back to the same 4 nodes, so strict LVS matches (it was skipped: lvs-mismatch).

async function roundTrip(spice, engine) {
  const parsed = parseSpice(spice);
  const doc = newDocument();
  const m = getPage(doc);
  const placed = engine === 'v2' ? importNetlist2(m, parsed) : importNetlist(m, parsed);
  await routePage(m, placed.wires, {});
  normalizeOrigin(m);
  const m2 = getPage(parseDrawio(serialize(doc)));
  return { parsed, extracted: extractNetlist(m2), model: m2 };
}

// a first-order differential TIA stage: input currents into the virtual grounds, RC feedback
export const TIA_FD = `* differential TIA, one fully differential OTA
I1 0 inp 1u
I2 0 inn 1u
XA1 inp inn outp outn opamp_fd
RF1 inp outn 10k
CF1 inp outn 1p
RF2 inn outp 10k
CF2 inn outp 1p
RL1 outp 0 100k
RL2 outn 0 100k
.end`;

test('parseSpice: opamp_fd with 4 pins is a fully differential op-amp, no hidden supplies', () => {
  const p = parseSpice('XA1 inp inn outp outn opamp_fd\nXA2 a b c d OTA_FD\nXZ a b c d somebox\n.end');
  assert.equal(p.components.length, 2);
  assert.deepEqual(p.components[0].fullNodes, ['inp', 'inn', 'outp', 'outn']);
  assert.deepEqual(p.components[0].nodes, ['inp', 'inn', 'outp', 'outn']);
  assert.equal(p.components[1].model, 'OPAMP_FD');
  assert.match(p.warnings.join('\n'), /somebox/);
});

for (const engine of ['v1', 'v2']) {
  test(`opamp_fd TIA round-trips through ${engine} + strict LVS`, async () => {
    const { parsed, extracted, model } = await roundTrip(TIA_FD, engine);
    assert.deepEqual(parsed.warnings, []);
    const report = compare(extracted, parsed);
    assert.equal(report.match, true, JSON.stringify(report).slice(0, 800));
    const xa1 = allCells(model).map(cellInfo).find((c) => c.refdes === 'XA1' || c.id === 'XA1');
    assert.equal(xa1.style.map.get('shape'), 'mxgraph.electrical.abstract.ota_2');
    const cls = classify(xa1);
    assert.equal(cls.prefix, 'X');
    assert.deepEqual(cls.mapping.pinOrder, ['in+', 'in-', 'out+', 'out-']);
    const ex = extracted.components.find((c) => c.ref === 'XA1');
    assert.equal(ex.fullNodes.length, 4);
    assert.equal(ex.value, 'opamp_fd');
  });
}

test('the single-ended opamp keeps ota_1 and its 5 nodes', async () => {
  const { parsed, extracted } = await roundTrip('XU1 inp inn out opamp\nR1 out inn 10k\nR2 inp 0 1k\nV1 inp 0 1\n.end', 'v2');
  assert.equal(compare(extracted, parsed).match, true);
  assert.equal(extracted.components.find((c) => c.ref === 'XU1').fullNodes.length, 5);
});

test('opamp_fd with 5 or 3 pins is refused with a warning, never a crash (review of #74, m-1)', async () => {
  const p = parseSpice('XA1 inp inn outp outn vdd opamp_fd\nXA2 inp inn out ota_fd\n.end');
  assert.equal(p.components.length, 0);
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings[0], /exactly 4 pins.*got 5/);
  assert.match(p.warnings[1], /exactly 4 pins.*got 3/);
  for (const engine of ['v1', 'v2']) {
    const { parsed } = await roundTrip('XA1 inp inn outp outn vdd opamp_fd\nR1 inp outn 10k\nR2 inn outp 10k\nV1 vdd 0 1\n.end', engine);
    assert.equal(parsed.warnings.length, 1);
  }
});

test('a 5-pin op-amp whose name merely contains opamp_fd keeps the single-ended symbol', async () => {
  for (const engine of ['v1', 'v2']) {
    const { parsed, extracted, model } = await roundTrip('XU1 inp inn vp vm out my_opamp_fd2\nR1 out inn 10k\nR2 inp 0 1k\nV1 vp 0 1\nV2 vm 0 -1\n.end', engine);
    assert.equal(compare(extracted, parsed).match, true);
    const xu1 = allCells(model).map(cellInfo).find((c) => c.refdes === 'XU1' || c.id === 'XU1');
    assert.equal(xu1.style.map.get('shape'), 'mxgraph.electrical.abstract.ota_1');
  }
});
