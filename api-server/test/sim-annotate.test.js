import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage, allCells, cellInfo } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { compare } from '../lib/lvs.js';
import { annotateSim, clearSim, eng } from '../lib/sim-annotate.js';

const NET = `VDD vdd 0 1.2
M1 d1 g1 0 0 nmos
RD vdd d1 2k
RG vdd g1 10k
.end`;
const SIM = { format: 'drawio-sim-annotations/1', simulator: { temp_C: 27 },
  nodes: { vdd: { V: 1.2 }, d1: { V: 0.61 }, g1: { V: 0.55 } },
  devices: { M1: { type: 'nmos', Id: 2.95e-4, gm: 2.1e-3, region: 'saturation' } },
  supplies: { VDD: { V: 1.2, I: 2.95e-4 } } };

test('eng: SI values in French notation', () => {
  assert.equal(eng(0.000811, 'V'), '811 µV');
  assert.equal(eng(4.66e-3, 'A'), '4,66 mA');
  assert.equal(eng(0.164, 'S'), '164 mS');
});

test('sim annotations: nodes through the drawing netlist, device line, summary; inert; removable', async () => {
  const p = parseSpice(NET);
  const r = await autoPlace(p), m = getPage(r.doc);
  const out = annotateSim(m, SIM, { netlist: NET });
  assert.equal(out.annotated_nodes, 3);
  assert.equal(out.annotated_devices, 1);
  assert.deepEqual(out.unmatched, { nodes: [], devices: [] });
  assert.ok(out.summary.some((l) => l.includes('alimentation')));
  assert.ok(compare(extractNetlist(m), p).match);   // the layer changes no connection
  const n = allCells(m).map(cellInfo).filter((c) => c.style.map.get('drawioSimAnnotation') === '1').length;
  assert.equal(clearSim(m), n);
  assert.throws(() => annotateSim(m, { format: 'other/2' }), /format/);
});

test('sim annotations: a port-only node is not annotated; summary_extra lines shown as given', async () => {
  const NET2 = 'VDD vdd 0 1.2\nCIN in g1 1p\nM1 d1 g1 0 0 nmos\nRD vdd d1 2k\nRG vdd g1 10k\n.end';
  const p = parseSpice(NET2);
  const r = await autoPlace(p), m = getPage(r.doc);
  const out = annotateSim(m, { ...SIM, nodes: { ...SIM.nodes, in: { V: 0 } }, summary_extra: ['IIP3 −6,3 dBm'] }, { netlist: NET2 });
  assert.equal(out.annotated_nodes, 3);   // vdd, d1, g1 — not "in"
  assert.ok(out.summary.includes('IIP3 −6,3 dBm'));
});

test('sim annotations: identical transistors in parallel are all matched; those without a clear spot are listed in the summary box', async () => {
  const NET3 = 'VDD vdd 0 1.2\nRD vdd d 500\nM1a d g 0 0 nmos\nM1b d g 0 0 nmos\nM1c d g 0 0 nmos\nM1d d g 0 0 nmos\nRG vdd g 10k\n.end';
  const p = parseSpice(NET3);
  const r = await autoPlace(p), m = getPage(r.doc);
  const dev = (id) => ({ type: 'nmos', Id: id, gm: 1e-3, region: 'saturation' });
  const out = annotateSim(m, { format: 'drawio-sim-annotations/1', nodes: { d: { V: 0.6 }, g: { V: 0.5 } },
    devices: { M1a: dev(1e-4), M1b: dev(1e-4), M1c: dev(1e-4), M1d: dev(1e-4) } }, { netlist: NET3 });
  assert.deepEqual(out.unmatched.devices, []);
  assert.equal(out.annotated_devices + out.unplaced.devices.length, 4);
  for (const ref of out.unplaced.devices) assert.ok(out.summary.some((l) => l.startsWith(ref + ' :')));
});
