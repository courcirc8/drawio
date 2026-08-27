import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../lib/model.js';
import { parseSpice, extractNetlist, connectivity } from '../lib/netlist.js';
import { importNetlist } from '../lib/place.js';
import { routePage } from '../lib/route.js';
import { compare } from '../lib/lvs.js';
import { check as ercCheck } from '../lib/erc.js';
import { bom } from '../lib/bom.js';
import { searchShapes, getShape, getPin } from '../lib/stencils.js';
import zlib from 'node:zlib';

const RC = `* RC low-pass
V1 in 0 DC 5
R1 in out 10k
C1 out 0 100n
.end`;

test('model round-trip: mxfile normalize + edit + serialize + reparse', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 10, y: 20, w: 100, h: 20, value: '1k' });
  model.addVertex(m, { id: 'C1', shape: 'mxgraph.electrical.capacitors.capacitor_1', x: 200, y: 20, w: 100, h: 60 });
  model.addWire(m, { id: 'w1', source: 'R1', target: 'C1', sourcePin: { x: 1, y: 0.5 }, targetPin: { x: 0, y: 0.5 } });
  const xml = model.serialize(doc);
  const doc2 = model.parseDrawio(xml);
  const cells = model.allCells(model.getPage(doc2)).map(model.cellInfo);
  assert.equal(cells.filter((c) => c.kind === 'vertex').length, 2);
  const w = cells.find((c) => c.id === 'w1');
  assert.equal(w.source, 'R1');
  assert.equal(w.target, 'C1');
});

test('model: update, rotation, delete cascades wires', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  model.addVertex(m, { id: 'A', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'B', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 0, w: 100, h: 20 });
  model.addWire(m, { id: 'w', source: 'A', target: 'B' });
  model.updateCell(m, 'A', { dx: 50, rotation: 90, value: '5k' });
  const a = model.cellInfo(model.getCell(m, 'A'));
  assert.equal(a.x, 50);
  assert.equal(a.rotation, 90);
  assert.equal(a.value, '5k');
  const deleted = model.deleteCell(m, 'A');
  assert.deepEqual(deleted.sort(), ['A', 'w']);
  assert.equal(model.getCell(m, 'w'), null);
});

test('parseDrawio: accepts compressed diagram content', () => {
  const inner = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
  const b64 = zlib.deflateRawSync(Buffer.from(encodeURIComponent(inner))).toString('base64');
  const doc = model.parseDrawio(`<mxfile><diagram id="d" name="P">${b64}</diagram></mxfile>`);
  assert.ok(model.getPage(doc));
});

test('stencils: catalog search and pins', () => {
  assert.ok(searchShapes('resistor').length > 0);
  const r = getShape('mxgraph.electrical.resistors.resistor_2');
  assert.equal(r.name, 'Resistor 2');
  assert.deepEqual(getPin(r.key, 'in'), { name: 'in', x: 0, y: 0.5 });
});

test('spice: parse RC netlist', () => {
  const p = parseSpice(RC);
  assert.equal(p.components.length, 3);
  const v1 = p.components.find((c) => c.ref === 'V1');
  assert.deepEqual(v1.nodes, ['in', '0']);
  assert.equal(v1.prefix, 'V');
});

test('spice: continuations, ground aliases, duplicate refs rejected', () => {
  const p = parseSpice('R1 a\n+ GND 1k\n');
  assert.deepEqual(p.components[0].nodes, ['a', '0']);
  assert.throws(() => parseSpice('R1 a b 1\nR1 c d 2\n'), /duplicate/);
});

test('netlist import -> extraction -> LVS clean', async () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  const parsed = parseSpice(RC);
  const placed = importNetlist(m, parsed);
  assert.equal(placed.components.length, 3);
  await routePage(m, placed.wires, {});
  const extracted = extractNetlist(m);
  const report = compare(extracted, parsed);
  assert.equal(report.match, true, JSON.stringify(report));
  assert.equal(report.values_match, true);
});

test('LVS: detects topology and value mismatches', async () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  importNetlist(m, parseSpice(RC));
  const bad = parseSpice('V1 in 0 DC 5\nR1 in out 10k\nC1 in 0 100n\n');
  const report = compare(extractNetlist(m), bad);
  assert.equal(report.match, false);
  assert.ok(report.net_mismatches.length > 0);
  const val = parseSpice('V1 in 0 DC 5\nR1 in out 47k\nC1 out 0 100n\n');
  const r2 = compare(extractNetlist(m), val);
  assert.equal(r2.match, true);
  assert.equal(r2.values_match, false);
  assert.equal(r2.value_mismatches[0].ref, 'R1');
});

test('LVS: missing and extra components', () => {
  const a = { components: [{ ref: 'R1', prefix: 'R', nodes: ['x', 'y'], value: '1k' }] };
  const b = { components: [{ ref: 'R1', prefix: 'R', nodes: ['x', 'y'], value: '1k' }, { ref: 'C9', prefix: 'C', nodes: ['x', '0'], value: '1n' }] };
  const r = compare(a, b);
  assert.deepEqual(r.missing, ['C9']);
  assert.equal(r.match, false);
});

test('ERC: clean netlist import has no findings; floating pin detected', async () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  importNetlist(m, parseSpice(RC));
  const clean = ercCheck(m);
  assert.equal(clean.errors, 0, JSON.stringify(clean.findings));
  // add a resistor with nothing attached -> 2 unconnected pins
  model.addVertex(m, { id: 'R99', shape: 'mxgraph.electrical.resistors.resistor_2', x: 900, y: 20, w: 100, h: 20 });
  const dirty = ercCheck(m);
  assert.ok(dirty.findings.some((f) => f.code === 'unconnected-pin' && f.cells.includes('R99')));
});

test('routing: waypoints avoid an obstacle between terminals', async () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  model.addVertex(m, { id: 'A', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 90, w: 100, h: 20 });
  model.addVertex(m, { id: 'B', shape: 'mxgraph.electrical.resistors.resistor_2', x: 400, y: 90, w: 100, h: 20 });
  model.addVertex(m, { id: 'OB', shape: 'mxgraph.electrical.capacitors.capacitor_1', x: 200, y: 40, w: 100, h: 120 });
  model.addWire(m, { id: 'w', source: 'A', target: 'B', sourcePin: { x: 1, y: 0.5 }, targetPin: { x: 0, y: 0.5 } });
  const res = await routePage(m, null, {});
  assert.deepEqual(res.ids, ['w']);
  const w = model.cellInfo(model.getCell(m, 'w'));
  assert.ok(w.points.length >= 2, 'route should bend around the obstacle: ' + JSON.stringify(w.points));
});

test('bom: rows sorted with type labels', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  importNetlist(m, parseSpice(RC));
  const rows = bom(m);
  assert.deepEqual(rows.map((r) => r.ref), ['C1', 'R1', 'V1']);
  assert.equal(rows.find((r) => r.ref === 'R1').type, 'resistor');
});
