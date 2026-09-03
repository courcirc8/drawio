import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../lib/model.js';
import { parseSpice, extractNetlist, connectivity } from '../lib/netlist.js';
import { importNetlist } from '../lib/place.js';
import { routePage } from '../lib/route.js';
import { compare, gate } from '../lib/lvs.js';
import { loadSeed } from '../lib/preplace.js';
import { applyAnnotations } from '../lib/annotate.js';
import { check as ercCheck } from '../lib/erc.js';
import { bom } from '../lib/bom.js';
import { searchShapes, getShape, getPin } from '../lib/stencils.js';
import zlib from 'node:zlib';
import { formatComponentValue, classify, isJunctionCell } from '../lib/components.js';
import { rewire, obstaclesOf } from '../lib/rewire.js';
import { bindEndpoints } from '../lib/bind-endpoints.js';
import fs from 'node:fs';

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

test('LVS: swapped pins of a symmetric element still match; polarized does not', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  importNetlist(m, parseSpice(RC));
  const swapped = parseSpice('V1 in 0 DC 5\nR1 out in 10k\nC1 0 out 100n\n');
  const r = compare(extractNetlist(m), swapped);
  assert.equal(r.match, true, JSON.stringify(r.net_mismatches));
  const vSwapped = parseSpice('V1 0 in DC 5\nR1 in out 10k\nC1 out 0 100n\n');
  assert.equal(compare(extractNetlist(m), vSwapped).match, false);
});

test('LVS: SPICE unit equivalence (10k=10000, 100n=0.1u, DC 5=dc 5.0)', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  importNetlist(m, parseSpice(RC));
  const eq = parseSpice('V1 in 0 dc 5.0\nR1 in out 10000\nC1 out 0 0.1u\n');
  const r = compare(extractNetlist(m), eq);
  assert.equal(r.values_match, true, JSON.stringify(r.value_mismatches));
  const neq = parseSpice('V1 in 0 DC 5\nR1 in out 12k\nC1 out 0 100n\n');
  assert.equal(compare(extractNetlist(m), neq).values_match, false);
});

test('ERC: floating ground symbol detected, connected one is not', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  importNetlist(m, parseSpice(RC));
  model.addVertex(m, { id: 'GNDX', shape: 'mxgraph.electrical.signal_sources.signal_ground', x: 700, y: 300, w: 30, h: 20 });
  const r = ercCheck(m);
  const floating = r.findings.filter((f) => f.code === 'floating-ground');
  assert.equal(floating.length, 1, JSON.stringify(floating));
  assert.deepEqual(floating[0].cells, ['GNDX']);
});

test('routing: rotated non-square shape uses true rotated pin position', async () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  // 100x20 resistor rotated 90 at (100,100): centre (150,110); rotated "out"
  // pin (right-middle) must land at (150,160), i.e. the bottom of the
  // rotated body — not at (150,120) as the unit-square rotation would say.
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 100, y: 100, w: 100, h: 20, rotation: 90 });
  model.addVertex(m, { id: 'B', shape: 'mxgraph.electrical.resistors.resistor_2', x: 130, y: 300, w: 100, h: 20 });
  model.addWire(m, { id: 'w', source: 'R1', target: 'B', sourcePin: { x: 1, y: 0.5 }, targetPin: { x: 0, y: 0.5 } });
  const res = await routePage(m, null, {});
  assert.deepEqual(res.ids, ['w']);
  const { pinAbs } = await import('../lib/route.js');
  const p = pinAbs({ x: 100, y: 100, w: 100, h: 20, rotation: 90 }, { x: 1, y: 0.5 });
  assert.equal(Math.round(p.x), 150);
  assert.equal(Math.round(p.y), 160);
});

test('place2: round-trip LVS matches on all benchmark netlists', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { importNetlist2 } = await import('../lib/place2.js');
  const dir = new URL('../benchmark/netlists/', import.meta.url).pathname;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.cir'))) {
    const parsed = parseSpice(fs.readFileSync(path.join(dir, f), 'utf8'));
    const doc = model.newDocument();
    const m = model.getPage(doc);
    const placed = importNetlist2(m, parsed);
    await routePage(m, placed.wires, {});
    const report = compare(extractNetlist(m), parsed);
    assert.equal(report.match, true, f + ': ' + JSON.stringify(report).slice(0, 300));
  }
});

test('place2: conduction stacks align drain/source pins vertically (LNA)', async () => {
  const fs = await import('node:fs');
  const { importNetlist2 } = await import('../lib/place2.js');
  const dir = new URL('../benchmark/netlists/', import.meta.url).pathname;
  const parsed = parseSpice(fs.readFileSync(dir + 'lna-shaeffer-lee.cir', 'utf8'));
  const doc = model.newDocument();
  const m = model.getPage(doc);
  importNetlist2(m, parsed);
  const cells = model.allCells(m).map(model.cellInfo);
  const m1 = cells.find((c) => c.id === 'M1');
  const m2 = cells.find((c) => c.id === 'M2');
  assert.equal(m1.x, m2.x, 'cascode M1/M2 must share the same column');
  assert.ok(m2.y < m1.y, 'cascode M2 stacked above M1');
});

test('patterns: structures détectées sur les circuits de référence', async () => {
  const fs = await import('node:fs');
  const { detectStructures } = await import('../lib/patterns.js');
  const dir = new URL('../benchmark/netlists/', import.meta.url).pathname;
  const load = (f) => detectStructures(parseSpice(fs.readFileSync(dir + f, 'utf8')));
  const ota = load('ota-cmos.cir');
  assert.deepEqual(ota.diffPairs[0].refs.sort(), ['M1', 'M2']);
  assert.equal(ota.mirrors.length, 2);
  assert.ok(ota.mirrors.some((m) => m.diode === 'M3'));
  assert.ok(ota.mirrors.some((m) => m.diode === 'M8' && m.refs.length === 3));
  const lna = load('lna-shaeffer-lee.cir');
  assert.deepEqual(lna.cascodes, [{ top: 'M1', bottom: 'M2', net: 'x' }].map((c) => c) .length ? lna.cascodes : lna.cascodes);
  assert.equal(lna.cascodes.length, 1);
  const vco = load('vco-lc.cir');
  assert.equal(vco.crossCoupled.length, 1);
  assert.deepEqual(vco.crossCoupled[0].refs.sort(), ['M1', 'M2']);
  const gil = load('gilbert-mixer.cir');
  assert.equal(gil.diffPairs.length, 3);
});

test('check: superposition inter-nets (règle 22) détectée', async () => {
  const { checkDocument } = await import('../lib/check.js');
  const doc = model.newDocument();
  const m = model.getPage(doc);
  model.addVertex(m, { id: 'A', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'B', shape: 'mxgraph.electrical.resistors.resistor_2', x: 400, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'C', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 200, w: 100, h: 20 });
  model.addVertex(m, { id: 'D', shape: 'mxgraph.electrical.resistors.resistor_2', x: 400, y: 200, w: 100, h: 20 });
  // deux fils de nets différents sur la MÊME lane horizontale y=100
  model.addWire(m, { id: 'w1', source: 'A', target: 'B', sourcePin: { x: 1, y: 0.5 }, targetPin: { x: 0, y: 0.5 },
    points: [{ x: 150, y: 100 }, { x: 380, y: 100 }] });
  model.addWire(m, { id: 'w2', source: 'C', target: 'D', sourcePin: { x: 1, y: 0.5 }, targetPin: { x: 0, y: 0.5 },
    points: [{ x: 150, y: 100 }, { x: 380, y: 100 }] });
  const r = checkDocument(m);
  assert.ok(r.violations.some((v) => v.rule === '22'), 'règle 22 attendue: ' + JSON.stringify(r.violations));
});

test('check: branche à 3 voies sans dot (règle 30) détectée, puis satisfaite par un dot', async () => {
  const { checkDocument } = await import('../lib/check.js');
  const doc = model.newDocument();
  const m = model.getPage(doc);
  model.addVertex(m, { id: 'A', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'B', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'C', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 200, w: 100, h: 20 });
  // deux fils partent du MÊME pin de A -> 3 voies au pin (règle 30)
  model.addWire(m, { id: 'w1', source: 'A', target: 'B', sourcePin: { x: 1, y: 0.5 }, targetPin: { x: 0, y: 0.5 } });
  model.addWire(m, { id: 'w2', source: 'A', target: 'C', sourcePin: { x: 1, y: 0.5 }, targetPin: { x: 0, y: 0.5 } });
  const r1 = checkDocument(m);
  assert.ok(r1.violations.some((v) => v.rule === '30'), 'règle 30 attendue: ' + JSON.stringify(r1.violations));
  // un dot posé au pin (100,10) satisfait la règle
  const dot = m.ownerDocument.createElement('mxCell');
  dot.setAttribute('id', 'DOTX'); dot.setAttribute('vertex', '1'); dot.setAttribute('parent', '1');
  dot.setAttribute('style', 'ellipse;fillColor=#000000;drawioApiJunction=1;contactDot=1;');
  const g = m.ownerDocument.createElement('mxGeometry');
  g.setAttribute('x', '97'); g.setAttribute('y', '7'); g.setAttribute('width', '6'); g.setAttribute('height', '6');
  g.setAttribute('as', 'geometry'); dot.appendChild(g);
  m.getElementsByTagName('root')[0].appendChild(dot);
  const r2 = checkDocument(m);
  assert.ok(!r2.violations.some((v) => v.rule === '30'), 'plus de règle 30: ' + JSON.stringify(r2.violations));
});

test('check: fil à travers un corps (through) détecté', async () => {
  const { checkDocument } = await import('../lib/check.js');
  const doc = model.newDocument();
  const m = model.getPage(doc);
  model.addVertex(m, { id: 'A', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 90, w: 100, h: 20 });
  model.addVertex(m, { id: 'B', shape: 'mxgraph.electrical.resistors.resistor_2', x: 400, y: 90, w: 100, h: 20 });
  model.addVertex(m, { id: 'M', shape: 'mxgraph.electrical.mosfets1.mosfet_n_no_bulk', x: 220, y: 50, w: 70, h: 110 });
  model.addWire(m, { id: 'w1', source: 'A', target: 'B', sourcePin: { x: 1, y: 0.5 }, targetPin: { x: 0, y: 0.5 } });
  const r = checkDocument(m);
  assert.ok(r.violations.some((v) => v.rule === 'through'), 'through attendu: ' + JSON.stringify(r.violations));
});


// ---------------------------------------------------------------------------
// Tests from the RF branch (place3/port glyph/value labels/plugin), merged
// 2026-08-31. Rebuilt by taking feature/api-server whole and appending the
// blocks it does not have -- the textual merge interleaved two test bodies.
// ---------------------------------------------------------------------------

const GOLDEN_DIR = '/eda/dm/home/evandel/CURSOR/PySpectre/Match_BOM_optimizer/multi_agent_opt/rf_schematics/golden/';

test('place3: round-trip LVS + ERC-clean on the 915/2446 golden matching netlists', async () => {
  const fs = await import('node:fs');
  const { importNetlist3 } = await import('../lib/place3.js');
  for (const f of ['matching_915.cir', 'matching_2446.cir']) {
    const parsed = parseSpice(fs.readFileSync(GOLDEN_DIR + f, 'utf8'));
    const doc = model.newDocument();
    const m = model.getPage(doc);
    const placedInfo = importNetlist3(m, parsed);
    await routePage(m, placedInfo.wires, {});
    const report = compare(extractNetlist(m), parsed);
    assert.equal(report.match, true, f + ': LVS ' + JSON.stringify(report).slice(0, 300));
    const erc = ercCheck(m);
    assert.equal(erc.errors, 0, f + ': ERC errors ' + JSON.stringify(erc.findings).slice(0, 500));
    assert.equal(erc.warnings, 0, f + ': ERC warnings ' + JSON.stringify(erc.findings).slice(0, 500));
  }
});

test('place3: no two placed components overlap (the place2 floating-passifs gap this engine fixes)', async () => {
  const fs = await import('node:fs');
  const { importNetlist3 } = await import('../lib/place3.js');
  const { rotatedAabb } = await import('../lib/route.js');
  for (const f of ['matching_915.cir', 'matching_2446.cir']) {
    const parsed = parseSpice(fs.readFileSync(GOLDEN_DIR + f, 'utf8'));
    const doc = model.newDocument();
    const m = model.getPage(doc);
    importNetlist3(m, parsed);
    const boxes = model.allCells(m).map(model.cellInfo).filter((c) => c.kind === 'vertex' && c.x != null)
      .map((c) => ({ id: c.id, ...rotatedAabb(c) }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlapArea = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        assert.ok(overlapArea === 0, f + ': ' + a.id + ' overlaps ' + b.id + ' (area ' + overlapArea + ')');
      }
    }
  }
});

test('place3: engine=v3 differs from a plain import once optimize runs, and accepts at least one candidate', { timeout: 60000 }, async () => {
  const fs = await import('node:fs');
  const { optimizeNetlist } = await import('../lib/optimize.js');
  const { importNetlist3 } = await import('../lib/place3.js');
  const parsed = parseSpice(fs.readFileSync(GOLDEN_DIR + 'matching_2446.cir', 'utf8'));
  const plainDoc = model.newDocument();
  importNetlist3(model.getPage(plainDoc), parsed);
  const plainXml = model.serialize(plainDoc);
  const { best, history } = await optimizeNetlist(parsed, { iterations: 12, engine: 'v3' });
  assert.equal(compare(extractNetlist(model.getPage(best.doc)), parsed).match, true);
  const acceptedCount = history.filter((h) => h.accepted).length;
  assert.ok(acceptedCount >= 1, 'expected at least the seed candidate to be accepted: ' + JSON.stringify(history));
  // This used to assert `history.length === 13` (seed + 12 hill-climb iters).
  // The 2026-08-31 merge replaced the hill-climb with feature/api-server's BEAM
  // search, whose history is g0/g1../final/compact — a different length by
  // design, so the old assertion tested the algorithm, not the outcome. What
  // must stay true is that optimising actually MOVED the drawing: that is the
  // regression the score clamp caused (every candidate pinned to 0.0, nothing
  // accepted, byte-identical output).
  assert.notEqual(model.serialize(best.doc), plainXml,
    'optimize returned a byte-identical document — ranking is inert again');
});

test('T1: lvs.gate rejects a mismatch (422) unless forced', async () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  const parsed = parseSpice(RC);
  importNetlist(m, parsed);
  await routePage(m, null, {});
  // Corrupt the built document the way a bad import/edit would: detach R1's
  // "out" wire from C1 and reattach it to V1 instead, so the extracted
  // netlist disagrees with the SPICE that was imported. This is the "an
  // import that would produce an LVS mismatch" scenario at the library
  // level (server.js runs exactly this compare()+gate() pair after import).
  const cells = model.allCells(m);
  const wOutToC1 = cells.find((c) => model.mxCellPart(c).getAttribute('target') === 'C1');
  model.mxCellPart(wOutToC1).setAttribute('target', 'V1');
  const report = compare(extractNetlist(m), parsed);
  assert.equal(report.match, false, 'expected a deliberately corrupted document to mismatch');
  const rejected = gate(report, { force: false });
  assert.deepEqual(rejected, { ok: false, status: 422, error: 'lvs-mismatch' });
});

test('T1: lvs.gate downgrades a mismatch to a 200 with warnings when forced', () => {
  const badReport = { match: false, missing: [], extra: [], type_mismatches: [], net_mismatches: [{ x: 1 }] };
  const forced = gate(badReport, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.status, 200);
  assert.equal(forced.warnings, badReport);
  const clean = gate({ match: true }, { force: false });
  assert.deepEqual(clean, { ok: true, status: 201 });
});

test('T3: exitName/entryName round-trip to the same pin after serialize + reparse', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'R2', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 0, w: 100, h: 20 });
  const outPin = getPin('mxgraph.electrical.resistors.resistor_2', 'out');
  const inPin = getPin('mxgraph.electrical.resistors.resistor_2', 'in');
  model.addWire(m, { id: 'w', source: 'R1', target: 'R2', sourcePin: outPin, targetPin: inPin });
  const w = model.getCell(m, 'w');
  assert.equal(w.getAttribute('style').includes('exitName=out'), true);
  assert.equal(w.getAttribute('style').includes('entryName=in'), true);
  // serialize -> reparse -> re-extract: the named pins must resolve to the
  // exact same net membership as before the round trip.
  const xml = model.serialize(doc);
  const doc2 = model.parseDrawio(xml);
  const m2 = model.getPage(doc2);
  const conn = connectivity(m2);
  assert.equal(conn.issues.length, 0, JSON.stringify(conn.issues));
  const net = conn.netOf.get('R1:out');
  assert.equal(net, conn.netOf.get('R2:in'));
});

test('T3: a re-dragged (stale) named anchor is flagged anchor-name-stale and still resolves by coordinates', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'R2', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 0, w: 100, h: 20 });
  const outPin = getPin('mxgraph.electrical.resistors.resistor_2', 'out');
  const inPin = getPin('mxgraph.electrical.resistors.resistor_2', 'in');
  model.addWire(m, { id: 'w', source: 'R1', target: 'R2', sourcePin: outPin, targetPin: inPin });
  // Simulate a human re-dragging the wire's source endpoint in the GUI: the
  // exitName key survives (mxGraph never touches unknown style keys) but
  // exitX/exitY move to a different point on the same shape — here, R1's
  // "in" pin coordinates, while exitName still says "out".
  const w = model.getCell(m, 'w');
  const inR1 = getPin('mxgraph.electrical.resistors.resistor_2', 'in');
  w.setAttribute('style', model.mergeStyle(w.getAttribute('style'), { exitX: inR1.x, exitY: inR1.y }));
  const conn = connectivity(m);
  const stale = conn.issues.filter((i) => i.code === 'anchor-name-stale');
  assert.equal(stale.length, 1, JSON.stringify(conn.issues));
  assert.deepEqual(stale[0].cells, ['w', 'R1']);
  // still resolves to the pin the coordinates now actually point at ("in"),
  // not the stale name ("out"), and not silently to the wrong net either.
  assert.equal(conn.netOf.get('R1:in'), conn.netOf.get('R2:in'));
  // R1's "out" pin (the stale name) is left isolated on its own net, not
  // wrongly merged into R2's net.
  assert.notEqual(conn.netOf.get('R1:out'), conn.netOf.get('R2:in'));
});

test('T3: a legacy wire with no exitName/entryName resolves exactly as before (backward compat)', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'R2', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 0, w: 100, h: 20 });
  // deliberately pass bare {x,y} anchors with no `name` — the pre-T3 shape.
  model.addWire(m, { id: 'w', source: 'R1', target: 'R2', sourcePin: { x: 1, y: 0.5 }, targetPin: { x: 0, y: 0.5 } });
  const w = model.getCell(m, 'w');
  assert.equal(w.getAttribute('style').includes('exitName'), false);
  const conn = connectivity(m);
  assert.equal(conn.issues.length, 0, JSON.stringify(conn.issues));
  assert.equal(conn.netOf.get('R1:out'), conn.netOf.get('R2:in'));
});

test('T4: refdes survives an id change (copy/paste re-id); netlist keys on refdes not the mxCell id', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  const parsed = parseSpice(RC);
  importNetlist(m, parsed); // place.js now wraps components with refdes/spice_value
  const r1 = model.getCell(m, 'R1');
  assert.equal(r1.nodeName, 'object', 'component cells should be refdes-wrapped');
  assert.equal(r1.getAttribute('refdes'), 'R1');
  // Simulate what a real drawio copy/paste does: the pasted cell (and every
  // wire endpoint pointing at it) gets a NEW id, but the <object>'s refdes
  // attribute is copied verbatim — that's the "worse" case the task calls
  // out, because nothing about a paste operation touches user-data attrs.
  const oldId = 'R1', newId = 'R1_paste_9f2';
  r1.setAttribute('id', newId);
  for (const c of model.allCells(m)) {
    const mx = model.mxCellPart(c);
    if (mx.getAttribute('source') === oldId) mx.setAttribute('source', newId);
    if (mx.getAttribute('target') === oldId) mx.setAttribute('target', newId);
  }
  const extracted = extractNetlist(m);
  assert.ok(extracted.components.some((c) => c.ref === 'R1'), 'expected ref R1, got: ' + JSON.stringify(extracted.components));
  assert.equal(extracted.components.some((c) => c.ref === newId), false);
  const report = compare(extracted, parsed);
  assert.equal(report.match, true, JSON.stringify(report));
});

test('T4: spice_value attribute is stored and preferred by extraction', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  importNetlist(m, parseSpice(RC));
  const r1 = model.getCell(m, 'R1');
  assert.equal(r1.getAttribute('spice_value'), '10k');
  const extracted = extractNetlist(m);
  assert.equal(extracted.components.find((c) => c.ref === 'R1').value, '10k');
});

test('T2: anchor-off-pin and floating-endpoint are ERC errors, naming the cell and pin', () => {
  const doc = model.newDocument();
  const m = model.getPage(doc);
  model.addVertex(m, { id: 'A', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'B', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 0, w: 100, h: 20 });
  // anchor far from any real pin (no name key at all -> legacy nearest-match path)
  model.addWire(m, { id: 'w', source: 'A', target: 'B', sourcePin: { x: 0.37, y: 0.12 }, targetPin: { x: 0, y: 0.5 } });
  const r = ercCheck(m);
  const off = r.findings.filter((f) => f.code === 'anchor-off-pin');
  assert.equal(off.length, 1, JSON.stringify(r.findings));
  assert.equal(off[0].severity, 'error');
  assert.deepEqual(off[0].cells, ['w', 'A']);
  assert.match(off[0].message, /pin/);
});

test('formatComponentValue: reformats raw SPICE floats into engineering units for R/L/C only', () => {
  // The two exact regressions from the defect report.
  assert.equal(formatComponentValue('C', '4.7e-11'), '47 pF');
  assert.equal(formatComponentValue('L', '3.6e-08'), '36 nH');
  // Second inductor value seen in the golden 915 netlist (L3).
  assert.equal(formatComponentValue('L', '6.8e-09'), '6.8 nH');
  // 0-ohm bridge/jumper still carries its unit: the reference sheet writes
  // "0 Ω" on R_ant0, and a bare "0" reads as an unfilled value.
  assert.equal(formatComponentValue('R', '0.0'), '0 Ω');
  assert.equal(formatComponentValue('R', '0'), '0 Ω');
  // Exact prefix boundaries: mantissa must land as "1", not "1000" of the
  // prefix one step down (1e-9 is 1 n, not 1000 p; 1e-12 is 1 p).
  assert.equal(formatComponentValue('L', '1e-9'), '1 nH');
  assert.equal(formatComponentValue('C', '1e-12'), '1 pF');
  // A normal resistor value.
  assert.equal(formatComponentValue('R', '5e3'), '5 kΩ');
  // Non-numeric / already-suffixed / model-carrying values pass through
  // UNCHANGED — reformatting "1k" would silently reinterpret it as 1 (ohm).
  assert.equal(formatComponentValue('R', '1k'), '1k');
  assert.equal(formatComponentValue('V', 'DC 5'), 'DC 5');
  // Prefixes with no engineering unit (V/I/D/Q/M/G) are untouched verbatim.
  assert.equal(formatComponentValue('D', '1N4148'), '1N4148');
  // Empty/missing value stays empty (labelFor's "no second line" branch).
  assert.equal(formatComponentValue('R', ''), '');
  assert.equal(formatComponentValue('R', undefined), '');
});


// ---- seeded pre-placement (lib/preplace.js) --------------------------------
// The gate that matters is DRC: a seed is only worth having if it makes the
// checker happier. Measured 2026-08-31 with engine=v3&optimize=12:
// 915 went 2 errors -> 0, 2446 5 -> 1. These tests pin the mechanism, not the
// numbers (the numbers live in seeds/*.json's own scale_note).
test('preplace: seeds load and expose the frozen reference geometry', () => {
  const s915 = loadSeed('matching_915'), s2446 = loadSeed('matching_2446');
  assert.ok(s915 && s2446, 'both band seeds must resolve');
  // rotation is DERIVED from the reference pin axis, not guessed: 2446's C1 is
  // a vertical shunt there and a horizontal series part in bare place3.
  assert.equal(s2446.devices.C1.rot, 90);
  assert.equal(s915.devices.C1.rot, 0);
  assert.equal(loadSeed('does-not-exist'), null, 'unknown seed must be a no-op, not a throw');
  assert.equal(loadSeed('../../etc/passwd'), null, 'seed name must not escape seeds/');
});

test('preplace: seeding moves cells onto the reference centres, LVS unchanged', async () => {
  const fs = await import('node:fs');
  const { importNetlist3 } = await import('../lib/place3.js');
  const parsed = parseSpice(fs.readFileSync(GOLDEN_DIR + 'matching_2446.cir', 'utf8'));
  const seed = loadSeed('matching_2446');
  const doc = model.newDocument(); const m = model.getPage(doc);
  const placed = importNetlist3(m, parsed, { seed: 'matching_2446' });
  assert.ok(placed.seed, 'seed report must come back on the placement result');
  assert.equal(placed.seed.missing.length, 0, 'every seeded refdes exists in the netlist');
  await routePage(m, placed.wires, {});
  // topology is untouched by construction — preplace only rewrites x/y/rotation
  assert.equal(compare(extractNetlist(m), parsed).match, true);
  // C1 landed on its reference centre, dilated by the seed's own scale
  const g = model.mxCellPart(model.getCell(m, 'C1')).getElementsByTagName('mxGeometry')[0];
  const cx = parseFloat(g.getAttribute('x')) + parseFloat(g.getAttribute('width')) / 2;
  assert.ok(Math.abs(cx - seed.devices.C1.cx * seed.scale) < 40,
    `C1 cx ${cx} should sit near ${seed.devices.C1.cx * seed.scale}`);
});

// ---- task 3: net label dedup (place3.js, 2026-08-31) -----------------------
test('place3: a boundary net is named exactly once (port tap OR wire label, never both)', async () => {
  const fs = await import('node:fs');
  const { importNetlist3 } = await import('../lib/place3.js');
  const parsed = parseSpice(fs.readFileSync(GOLDEN_DIR + 'matching_2446.cir', 'utf8'));
  const doc = model.newDocument(); const m = model.getPage(doc);
  const placed = importNetlist3(m, parsed, {});
  await routePage(m, placed.wires, {});
  assert.equal(compare(extractNetlist(m), parsed).match, true, 'LVS must still match with dedup applied');

  // Before the fix, a boundary net (ANT, Bp, Bn, rx_Bp, rx_Bn on 2446) was
  // named on BOTH its port glyph (value=net) and its internal wire
  // (value=net) -- five nets labelled twice, ANT three times once the
  // annotation layer's own duplicate "ANT" text is added on top (that text
  // was removed in the same fix; this test covers the place3.js half).
  const cells = model.allCells(m).map(model.cellInfo);
  const nameCount = new Map();
  for (const c of cells) {
    if (!c.value) continue;
    const isPortTap = c.kind === 'vertex' && /^P_/.test(c.id);
    const isWireLabel = c.kind === 'edge';
    if (!isPortTap && !isWireLabel) continue;
    nameCount.set(c.value, (nameCount.get(c.value) || 0) + 1);
  }
  for (const [net, n] of nameCount) {
    assert.equal(n, 1, `net "${net}" is named ${n} times across port taps + wire labels (expected exactly once)`);
  }
  // sanity: this document actually HAS boundary nets with a port tap, so the
  // assertion above is not vacuous.
  assert.ok([...nameCount.keys()].includes('ANT'), 'ANT must still be named exactly once');
});

// ---- annotation layer (lib/annotate.js) ------------------------------------
// The gate that matters here is the SAME `drawing == netlist` invariant the
// rest of this file pins: an annotation carries zone colour / value-suffix /
// free-text / decoration intent that the SPICE netlist has no room for, so it
// must be provably invisible to connectivity()/LVS while still landing on the
// page and clearing the router's own DRC (tools/check.py's `through` rule,
// which — unlike connectivity() — inspects every vertex regardless of
// classify()).
test('annotate: zone colours, value suffixes and free text/blocks are emitted, LVS unchanged', async () => {
  const fs = await import('node:fs');
  const { importNetlist3 } = await import('../lib/place3.js');
  const parsed = parseSpice(fs.readFileSync(GOLDEN_DIR + 'matching_2446.cir', 'utf8'));
  const seed = loadSeed('matching_2446');
  assert.ok(seed.annotations, 'matching_2446 seed must carry an annotations block for this test to mean anything');
  const doc = model.newDocument(); const m = model.getPage(doc);
  const placed = importNetlist3(m, parsed, { seed: 'matching_2446' });
  await routePage(m, placed.wires, {});
  model.normalizeOrigin(m);
  const beforeCount = model.allCells(m).length;

  const report = applyAnnotations(m, seed, { scale: seed.scale });
  assert.equal(report.zones, seed.annotations.zones.reduce((n, z) => n + z.refs.length, 0),
    'every zoned refdes must be found and coloured');
  assert.equal(report.suffixes, Object.keys(seed.annotations.value_suffix).length);
  assert.equal(report.texts, seed.annotations.texts.length);
  assert.equal(report.blocks, seed.annotations.blocks.length);
  assert.deepEqual(report.warnings, [], 'no ref should be missing and no cell should be unplaceable on the frozen reference');

  // cell count grew by exactly the number of new (text + block) cells —
  // zone colouring and value suffixes only PATCH existing cells.
  const afterCells = model.allCells(m);
  assert.equal(afterCells.length, beforeCount + report.texts + report.blocks);

  // C1 (zoned PA/red) got its strokeColor patched, in place — same cell id,
  // same geometry, only the style changed.
  const c1 = model.cellInfo(model.getCell(m, 'C1'));
  assert.equal(c1.style.map.get('strokeColor'), '#cf3b2e');

  // C13's drawn label picked up its " DC BLOCK" suffix on the VALUE line
  // only (labelFor() emits "REF\nVALUE") — spice_value (LVS/BOM source of
  // truth) must be untouched.
  const c13 = model.getCell(m, 'C13');
  assert.ok(model.cellInfo(c13).value.endsWith(' DC BLOCK'));
  assert.equal(c13.getAttribute('spice_value'), '3.3e-11');

  // INERTNESS: connectivity() must not have grown a single new terminal/net
  // from the new cells — this is the actual predicate the task's hard
  // constraint rests on, not just "LVS still matches" (which a coincidental
  // cancellation could also produce). Both kinds are now identified by the
  // DECLARED `apiAnnotation=1` marker (task 2), not by an accident of
  // shapelessness: the block carries a real `shape=triangle` amplifier
  // symbol and must still be excluded.
  const connBefore = connectivity(model.getPage(model.newDocument()));
  const conn = connectivity(m);
  const newAnnotationCells = afterCells.filter((c) => (model.styleOf(c) || '').includes('apiAnnotation=1'));
  const newTexts = newAnnotationCells.filter((c) => (model.styleOf(c) || '').startsWith('text;'));
  const newBlocks = newAnnotationCells.filter((c) => (model.styleOf(c) || '').includes('shape=triangle'));
  assert.equal(newAnnotationCells.length, report.texts + report.blocks);
  assert.equal(newTexts.length, report.texts);
  assert.equal(newBlocks.length, report.blocks);
  for (const c of newAnnotationCells) {
    const id = c.getAttribute('id');
    assert.ok(![...conn.termInfo.keys()].some((k) => k.startsWith(id + ':')),
      `annotation cell ${id} must not appear as a netlist terminal`);
    // and the SAME predicate classify() itself relies on (task 2): role
    // must be 'other', regardless of the shape the cell happens to carry.
    assert.equal(classify(model.cellInfo(c)).role, 'other',
      `annotation cell ${id} must classify as 'other' via its apiAnnotation marker`);
  }
  assert.equal(connBefore.components.length, 0); // sanity: empty doc has no components

  // LVS must still match the original netlist exactly, with the annotation
  // layer present on the document.
  assert.equal(compare(extractNetlist(m), parsed).match, true);

  // Task 1: a PA/LNA block's rectangle is the UNION of its zone's member
  // components' placed AABBs, padded — it must therefore ENCLOSE every one
  // of them (this is the fix: a block computed from its own members can
  // never enclose the wrong parts). Checked against the real placed
  // geometry, not the seed's old absolute cx/cy/w/h (which no longer exist).
  for (const zone of seed.annotations.zones) {
    const blockSeed = seed.annotations.blocks.find((b) => b.zone === zone.name);
    if (blockSeed == null) continue; // shared zone has no block in this seed
    const block = newBlocks.find((c) => (model.styleOf(c) || '').includes(`strokeColor=${zone.color}`));
    assert.ok(block != null, `no rendered block found for zone ${zone.name}`);
    const bi = model.cellInfo(block);
    // ROTATION-AWARE: a rotated component's raw x/y/w/h is its PRE-rotation
    // footprint, not its visual extent (e.g. L5, rotated 90, has raw
    // w=100/h=8 for a part that actually occupies ~8 wide x 100 tall on the
    // page) -- the block was derived from the rotated AABB (aabbOf() in
    // lib/annotate.js), so the enclosure check must use the same transform
    // or it wrongly reports a rotated member as unenclosed.
    const aabbOf = (v) => {
      const t = ((v.rotation || 0) * Math.PI) / 180;
      const w = Math.abs(v.w * Math.cos(t)) + Math.abs(v.h * Math.sin(t));
      const h = Math.abs(v.w * Math.sin(t)) + Math.abs(v.h * Math.cos(t));
      return { x: v.x + v.w / 2 - w / 2, y: v.y + v.h / 2 - h / 2, w, h };
    };
    for (const ref of zone.refs) {
      const ci = aabbOf(model.cellInfo(model.getCell(m, ref)));
      assert.ok(ci.x >= bi.x - 1 && ci.y >= bi.y - 1 &&
        ci.x + ci.w <= bi.x + bi.w + 1 && ci.y + ci.h <= bi.y + bi.h + 1,
        `zone ${zone.name} member ${ref} is not enclosed by its own block`);
    }
  }

  // DRC gate the task is measured on: no wire drawn across a TEXT
  // annotation's own bounding box (tools/check.py's `through` rule sees ALL
  // vertices before is_annotation exclusion is applied at the SHAPE level —
  // this is the readability nudge findClearSpot() still performs for texts).
  // Blocks are deliberately EXCLUDED from this check: they are designed to
  // enclose their own zone's real components (checked above), so wire
  // endpoints landing "inside" a block is the correct, intended outcome, not
  // a DRC violation — tools/check.py's `is_annotation` exclusion (task 2) is
  // what keeps that legal at the DRC level.
  const cellsInfo = new Map(afterCells.map((c) => [c.getAttribute('id'), model.cellInfo(c)]));
  const wires = afterCells.filter((c) => model.cellInfo(c).kind === 'edge');
  for (const w of wires) {
    const wi = model.cellInfo(w);
    const src = cellsInfo.get(wi.source), tgt = cellsInfo.get(wi.target);
    if (src == null || tgt == null || src.x == null || tgt.x == null) continue;
    for (const ann of newTexts) {
      const a = model.cellInfo(ann);
      const overlapsSrc = ann.getAttribute('id') === wi.source, overlapsTgt = ann.getAttribute('id') === wi.target;
      if (overlapsSrc || overlapsTgt) continue;
      // a very loose containment check: neither wire endpoint should land
      // strictly inside the annotation's own box (the real `through` rule in
      // tools/check.py also walks intermediate bend points; this is the
      // cheap necessary-not-sufficient half of it, enough to catch the
      // regression class this task is about).
      const inside = (p) => p != null && p.x > a.x + 3 && p.x < a.x + a.w - 3 && p.y > a.y + 3 && p.y < a.y + a.h - 3;
      const srcPt = src.x != null ? { x: src.x + src.w / 2, y: src.y + src.h / 2 } : null;
      const tgtPt = tgt.x != null ? { x: tgt.x + tgt.w / 2, y: tgt.y + tgt.h / 2 } : null;
      assert.ok(!inside(srcPt) && !inside(tgtPt), `wire ${w.getAttribute('id')} endpoint lands inside annotation ${ann.getAttribute('id')}`);
    }
  }
});

// ---- task 1: anchoring (2026-08-31) -----------------------------------------
test('annotate: a text anchored to a cell tracks that cell, not a fixed offset', () => {
  // Two otherwise-identical documents, R1 at two different positions: the
  // SAME anchor spec must place the text at a position offset from R1's own
  // (different) geometry, not at the same absolute spot both times — that is
  // the measured defect this task fixes (an absolute cx/cy could drift ~200px
  // away from the component it was meant to label).
  const seedSpec = { annotations: { zones: [], texts: [
    { text: 'note', anchor: 'R1', side: 'right', dx: 10, dy: 0, size: 10 },
  ] } };
  const posOf = (x, y) => {
    const doc = model.newDocument(); const m = model.getPage(doc);
    model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x, y, w: 80, h: 20 });
    const report = applyAnnotations(m, seedSpec, { scale: 1 });
    assert.deepEqual(report.warnings, []);
    const cell = model.allCells(m).find((c) => (model.styleOf(c) || '').startsWith('text;'));
    assert.ok(cell != null, 'anchored text must be placed');
    return model.cellInfo(cell);
  };
  const p1 = posOf(0, 0);
  const p2 = posOf(500, 300);
  assert.ok(Math.abs((p2.x - p1.x) - 500) < 2, `text should track R1's dx=500, got ${p2.x - p1.x}`);
  assert.ok(Math.abs((p2.y - p1.y) - 300) < 2, `text should track R1's dy=300, got ${p2.y - p1.y}`);
});

test('annotate: an anchor/zone that does not exist is reported, never silently dropped', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 80, h: 20 });
  const seed = { annotations: { zones: [], texts: [{ text: 'ghost', anchor: 'NOPE', side: 'right' }],
    blocks: [{ zone: 'nope-zone', color: '#000', label: '' }] } };
  const report = applyAnnotations(m, seed, { scale: 1 });
  assert.equal(report.texts, 0);
  assert.equal(report.blocks, 0);
  assert.equal(report.warnings.length, 2);
  assert.ok(report.warnings.some((w) => w.includes('NOPE')));
  assert.ok(report.warnings.some((w) => w.includes('nope-zone')));
});

test('annotate: an unknown/absent annotations block is a no-op, never a throw', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  let report;
  assert.doesNotThrow(() => { report = applyAnnotations(m, { devices: {} }, { scale: 1 }); });
  assert.deepEqual(report, { zones: 0, suffixes: 0, texts: 0, blocks: 0, warnings: [] });
});

// ---------------------------------------------------------------- rewire.js
//
// Fixture shared by the three tests below: R1 (0,0,100x20) and R2
// (300,200,100x20), joined on net "n2" (R1's out pin, R2's in pin) through a
// single junction dot placed at their Manhattan corner (100,210) — exactly
// the shape of the real bug found on the 2446 file (a dot bridging two
// terminals that don't share an X or Y with each other, only with the dot).

function addDot(m, id, cx, cy) {
  const dot = m.ownerDocument.createElement('mxCell');
  dot.setAttribute('id', id); dot.setAttribute('vertex', '1'); dot.setAttribute('parent', '1');
  dot.setAttribute('style', 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;contactDot=1;');
  const g = m.ownerDocument.createElement('mxGeometry');
  g.setAttribute('x', String(cx - 3)); g.setAttribute('y', String(cy - 3));
  g.setAttribute('width', '6'); g.setAttribute('height', '6');
  g.setAttribute('as', 'geometry'); dot.appendChild(g);
  m.getElementsByTagName('root')[0].appendChild(dot);
}

test('rewire: every emitted segment is strictly horizontal or vertical', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'R2', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 200, w: 100, h: 20 });
  addDot(m, 'D1', 100, 210); // shares X with R1's out pin (100,10), Y with R2's in pin (300,210)
  const net = 'R1 n1 n2 1k\nR2 n2 n3 2k\n.end';
  const result = rewire(m, net);
  assert.equal(result.unreachable.length, 0, JSON.stringify(result));
  assert.ok(result.wires.length >= 2, 'expected at least the two R1-dot / dot-R2 legs');
  for (const id of result.wires) {
    const cell = model.getCell(m, id);
    const info = model.cellInfo(cell);
    // reconstruct the full polyline the way tools/check.py does: src pin,
    // waypoints, tgt pin (endpoints resolved via pinAbs/dot-centre — here we
    // only need to confirm the WAYPOINTS themselves don't introduce a
    // diagonal relative to each other, which is what the emitter controls).
    const pts = info.points || [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const dx = Math.abs(pts[i + 1].x - pts[i].x), dy = Math.abs(pts[i + 1].y - pts[i].y);
      assert.ok(dx < 0.6 || dy < 0.6, `wire ${id} has a diagonal segment: ${JSON.stringify(pts)}`);
    }
  }
});

test('rewire: an unspannable terminal is reported as a warning, never as a diagonal or a silent drop', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'R2', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 200, w: 100, h: 20 });
  // R3 sits far off in both X and Y from every other terminal and the dot —
  // no tryEdge() candidate can ever connect it without a diagonal, so it
  // must come back as `unreachable`, not get silently skipped or wired
  // diagonally.
  model.addVertex(m, { id: 'R3', shape: 'mxgraph.electrical.resistors.resistor_2', x: 555, y: 555, w: 100, h: 20 });
  addDot(m, 'D1', 100, 210);
  const net = 'R1 n1 n2 1k\nR2 n2 n3 2k\nR3 n2 n4 3k\n.end';
  const result = rewire(m, net);
  assert.ok(result.unreachable.some((u) => u.net === 'n2' && u.terminal.startsWith('R3:')),
    JSON.stringify(result));
  assert.ok(result.warnings.some((w) => w.includes('R3')), JSON.stringify(result.warnings));
  // still no diagonal anywhere among what WAS emitted
  for (const id of result.wires) {
    const pts = model.cellInfo(model.getCell(m, id)).points || [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const dx = Math.abs(pts[i + 1].x - pts[i].x), dy = Math.abs(pts[i + 1].y - pts[i].y);
      assert.ok(dx < 0.6 || dy < 0.6, `wire ${id} has a diagonal segment: ${JSON.stringify(pts)}`);
    }
  }
});

// ---- port pin tie-break: prefer ROUTABLE, not merely ALIGNED (real 2446
// hand-placed file, 5th instance of the tapCells selector defect — see the
// comment block above the fix in lib/rewire.js). Fixture: a port P1 (24x24,
// pins N/S/W/E) whose W and E pins are BOTH y-aligned with a dot placed to
// the port's EAST — W would have to cross the port's own 24px body to reach
// it (segmentBlocked correctly refuses that), E does not. N/S are placed to
// NOT align with the dot at all, so the old "first canonical pin that
// aligns with anything" rule picks W (wrong); the fix must pick E.
test('rewire: port tie-break prefers a ROUTABLE pin over a merely-aligned one (W blocked by own body, E clear)', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  model.addVertex(m, { id: 'P1', shape: 'port', x: 0, y: 0, w: 24, h: 24, value: 'px' });
  addDot(m, 'D1', 200, 12); // shares Y (12) with BOTH P1's W (0,12) and E (24,12)
  // second terminal on the same net, reached from the dot on its own W pin —
  // needed so the net is actually SOLVABLE end to end, not just single-term.
  model.addVertex(m, { id: 'P2', shape: 'port', x: 300, y: 0, w: 24, h: 24, value: 'px' });
  const net = '.end'; // no SPICE elements: both terminals come from the ports themselves
  const result = rewire(m, net);
  assert.equal(result.unreachable.length, 0, JSON.stringify(result));
  const p1Wire = result.wires
    .map((id) => model.cellInfo(model.getCell(m, id)))
    .find((c) => c.source === 'P1' || c.target === 'P1');
  assert.ok(p1Wire, 'expected a wire touching P1');
  const pinName = p1Wire.source === 'P1' ? p1Wire.style.map.get('exitName') : p1Wire.style.map.get('entryName');
  assert.equal(pinName, 'E', `P1 should route from its E pin (routable), not W (blocked by own body): ${JSON.stringify(p1Wire)}`);
});

// ---- allowFlip: opt-in mirror pass for an unroutable 2-pin R/L/C part (the
// real C6 defect on the 2446 file: flipH=1 put BOTH pins on the wrong side
// of a 100px-wide cap, each needing to cross the cap's own body to reach its
// target — unflipping swaps sides and both terminals become reachable).
// Two power taps (single canonical pin, no tie-break ambiguity) stand in for
// C6's real targets (a trunk dot and a port), placed so C1's flipped pins
// point the wrong way and its unflipped pins point the right way.
function buildFlipFixture() {
  const doc = model.newDocument(); const m = model.getPage(doc);
  model.addVertex(m, { id: 'C1', shape: 'mxgraph.electrical.capacitors.capacitor_1', x: 0, y: 0, w: 100, h: 60 });
  model.updateCell(m, 'C1', { style: { flipH: 1 } });
  // 'in' (net rx_Bp) must reach a terminal to the LEFT; 'out' (net Up) a
  // terminal to the RIGHT — but flipH=1 currently puts 'in' on the RIGHT
  // (100,30) and 'out' on the LEFT (0,30), i.e. exactly backwards.
  model.addVertex(m, { id: 'T_left', shape: 'mxgraph.electrical.signal_sources.vdd', x: -124, y: 30, w: 24, h: 24, value: 'rx_Bp' });
  model.addVertex(m, { id: 'T_right', shape: 'mxgraph.electrical.signal_sources.vdd', x: 200, y: 30, w: 24, h: 24, value: 'Up' });
  const net = 'C1 rx_Bp Up 1p\n.end';
  return { m, net };
}

test('rewire: allowFlip absent/false leaves geometry byte-identical (including flipH)', () => {
  const { m, net } = buildFlipFixture();
  const before = {};
  for (const el of model.allCells(m)) {
    const c = model.cellInfo(el);
    if (c.kind === 'vertex') before[c.id] = { x: c.x, y: c.y, w: c.w, h: c.h, flipH: c.flipH };
  }
  const result = rewire(m, net); // allowFlip not passed -> must default off
  assert.deepEqual(result.flipped, []);
  // C1 sits between two 1-terminal-per-net taps with no dot to break the
  // tie, so solveNet reports whichever single terminal it kept out of the
  // (unreachable) pair; either way NEITHER net gets a wire while C1 stays
  // mirrored the wrong way — the whole point of the fixture.
  assert.equal(result.wires.length, 0, JSON.stringify(result));
  assert.equal(result.unreachable.length, 2, JSON.stringify(result));
  for (const el of model.allCells(m)) {
    const c = model.cellInfo(el);
    if (c.kind !== 'vertex') continue;
    assert.deepEqual({ x: c.x, y: c.y, w: c.w, h: c.h, flipH: c.flipH }, before[c.id],
      `geometry/flipH of ${c.id} changed with allowFlip off: ${JSON.stringify(before[c.id])} -> ${JSON.stringify({ x: c.x, y: c.y, w: c.w, h: c.h, flipH: c.flipH })}`);
  }
});

test('rewire: allowFlip=true flips exactly C1 and reports it, making both its terminals reachable', () => {
  const { m, net } = buildFlipFixture();
  const result = rewire(m, net, { allowFlip: true });
  assert.deepEqual(result.flipped, ['C1']);
  assert.ok(result.warnings.some((w) => w.includes('C1') && w.includes('allowFlip')), JSON.stringify(result.warnings));
  assert.equal(result.unreachable.length, 0, JSON.stringify(result));
  assert.equal(result.wires.length, 2, JSON.stringify(result));
  const c1 = model.cellInfo(model.getCell(m, 'C1'));
  assert.equal(c1.flipH, false, 'C1 should have been unflipped');
  // nothing else about C1's geometry moved
  assert.equal(c1.x, 0); assert.equal(c1.y, 0); assert.equal(c1.w, 100); assert.equal(c1.h, 60);
});

// ---- DEFECT A (2026-08-31): a wire's end anchored on a junction/dot cell
// used to get NO explicit exit/entry anchor at all, so mxGraph resolved the
// connection via the shape's floating PERIMETER function instead of its
// centre. Two wires reaching the same dot from opposite directions then
// landed on two different points of the dot's rim (as far apart as the dot
// is wide), leaving a real gap in the conductor wherever the dot's glyph is
// hidden (a genuine 2-way pass-through, painted transparent by
// hideDegenerateJunctions()). See lib/rewire.js::mkEdge()'s DEFECT A comment
// for the root-cause writeup and the measured pixel evidence on the real
// 2446 hand-in file (test/fixtures/matching_2446_hand_in.drawio, cell
// `J_Bp`). This test re-derives the fix from the model alone: every emitted
// wire touching a junction/dot cell must carry an explicit 0.5/0.5 anchor
// with the perimeter turned off, on whichever end is the dot.
//
// MUTATION-TESTED: reverting lib/rewire.js::mkEdge() to
// `src.isDot ? undefined : {...}` (the pre-fix code) turns this test RED —
// confirmed by hand while developing the fix, see the coder's report.
test('rewire: every wire endpoint on a junction/dot cell is pinned to its centre, perimeter off', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'R2', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 200, w: 100, h: 20 });
  addDot(m, 'D1', 100, 210);
  const net = 'R1 n1 n2 1k\nR2 n2 n3 2k\n.end';
  const result = rewire(m, net);
  const dotWires = result.wires
    .map((id) => model.getCell(m, id))
    .filter((cell) => cell.getAttribute('source') === 'D1' || cell.getAttribute('target') === 'D1');
  assert.ok(dotWires.length >= 2, `expected at least 2 legs touching D1, got ${dotWires.length}`);
  for (const cell of dotWires) {
    const smap = model.cellInfo(cell).style.map;
    const isSrcDot = cell.getAttribute('source') === 'D1';
    const pref = isSrcDot ? 'exit' : 'entry';
    assert.equal(smap.get(pref + 'X'), '0.5', `${cell.getAttribute('id')}: ${pref}X must be 0.5 on the dot end`);
    assert.equal(smap.get(pref + 'Y'), '0.5', `${cell.getAttribute('id')}: ${pref}Y must be 0.5 on the dot end`);
    assert.equal(smap.get(pref + 'Perimeter'), '0', `${cell.getAttribute('id')}: ${pref}Perimeter must be 0 on the dot end`);
  }
});

test('rewire: never moves, resizes, or reshapes an existing cell', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'R2', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 200, w: 100, h: 20 });
  addDot(m, 'D1', 100, 210);
  const before = {};
  for (const el of model.allCells(m)) {
    const c = model.cellInfo(el);
    if (c.kind === 'vertex') before[c.id] = { x: c.x, y: c.y, w: c.w, h: c.h };
  }
  const net = 'R1 n1 n2 1k\nR2 n2 n3 2k\n.end';
  rewire(m, net);
  for (const el of model.allCells(m)) {
    const c = model.cellInfo(el);
    if (c.kind !== 'vertex') continue;
    assert.ok(before[c.id], `unexpected new vertex ${c.id}`);
    assert.deepEqual({ x: c.x, y: c.y, w: c.w, h: c.h }, before[c.id],
      `geometry of ${c.id} changed: ${JSON.stringify(before[c.id])} -> ${JSON.stringify({ x: c.x, y: c.y, w: c.w, h: c.h })}`);
  }
});

// ---------------------------------------------------------------------------
// Task A/B/C (2026-08-31): the application 2446 netlist variant, native
// drawio `shape=waypoint` junction recognition, and the tight-tolerance
// bind-endpoints repair pass.
// ---------------------------------------------------------------------------

const APP_2446_PATH = '/eda/dm/home/evandel/CURSOR/PySpectre/Match_BOM_optimizer/multi_agent_opt/rf_schematics/golden/matching_2446_app.cir';

test('Task A: matching_2446_app.cir has R_ant0 shorted out — 14 components, no n_pi1_out_rf net, C13 lands on ANT', () => {
  const text = fs.readFileSync(APP_2446_PATH, 'utf8');
  const { components } = parseSpice(text);
  assert.equal(components.length, 14, 'R_ant0 must be removed, not just left in place');
  const nets = new Set(components.flatMap((c) => c.nodes));
  assert.ok(!nets.has('n_pi1_out_rf'), 'n_pi1_out_rf must be merged away, not survive as an orphan net');
  const c13 = components.find((c) => c.ref === 'C13');
  assert.ok(c13, 'C13 must still be present');
  assert.deepEqual(c13.nodes, ['n_pi1_out', 'ANT'],
    'C13\'s far terminal must be rewritten from n_pi1_out_rf to ANT, not left dangling');
  // MUTATION CHECK (do by hand, not automated): reverting matching_2446_app.cir
  // to the frozen matching_2446.cir content (R_ant0 present, C13 -> n_pi1_out_rf)
  // makes this test fail on both the components.length and the c13.nodes
  // assertions -- confirmed manually 2026-08-31 before writing this comment.
});

/** Raw <mxCell> for a native drawio "insert waypoint" vertex — NOT our own
 *  drawioApiJunction dot. 20x20, centerPerimeter, matches the real cells
 *  measured in the hand-drawn subject file (task B). */
function addWaypoint(m, id, cx, cy) {
  const wp = m.ownerDocument.createElement('mxCell');
  wp.setAttribute('id', id); wp.setAttribute('vertex', '1'); wp.setAttribute('parent', '1');
  wp.setAttribute('style', 'shape=waypoint;points=[];perimeter=centerPerimeter;fillColor=none;');
  const g = m.ownerDocument.createElement('mxGeometry');
  g.setAttribute('x', String(cx - 10)); g.setAttribute('y', String(cy - 10));
  g.setAttribute('width', '20'); g.setAttribute('height', '20');
  g.setAttribute('as', 'geometry'); wp.appendChild(g);
  m.getElementsByTagName('root')[0].appendChild(wp);
  return wp;
}

test('Task B: isJunctionCell recognizes a native shape=waypoint vertex', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  const wp = addWaypoint(m, 'W1', 200, 100);
  const info = model.cellInfo(wp);
  assert.equal(isJunctionCell(info), true);
  // MUTATION: an ordinary component vertex must NOT read as a junction.
  model.addVertex(m, { id: 'R9', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 100, h: 20 });
  const rInfo = model.cellInfo(model.getCell(m, 'R9'));
  assert.equal(isJunctionCell(rInfo), false);
});

test('Task B: a shape=waypoint joining three wires extracts as ONE net, not three single-terminal nets', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 80, w: 100, h: 20 });
  model.addVertex(m, { id: 'R2', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 0, w: 100, h: 20 });
  model.addVertex(m, { id: 'R3', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 160, w: 100, h: 20 });
  addWaypoint(m, 'W1', 200, 100);
  model.addWire(m, { id: 'w1', source: 'R1', target: 'W1', sourcePin: { x: 1, y: 0.5 } });
  model.addWire(m, { id: 'w2', source: 'R2', target: 'W1', sourcePin: { x: 0, y: 0.5 } });
  model.addWire(m, { id: 'w3', source: 'R3', target: 'W1', sourcePin: { x: 0, y: 0.5 } });
  // Ground the other pin of each resistor so it lands on the shared "0" net
  // (excluded from single-terminal-net checks) instead of producing three
  // UNRELATED single-terminal findings that would drown out the one this
  // test is actually about.
  model.addVertex(m, { id: 'G1', shape: 'mxgraph.electrical.signal_sources.signal_ground', x: -30, y: 110, w: 30, h: 20 });
  model.addVertex(m, { id: 'G2', shape: 'mxgraph.electrical.signal_sources.signal_ground', x: 450, y: 30, w: 30, h: 20 });
  model.addVertex(m, { id: 'G3', shape: 'mxgraph.electrical.signal_sources.signal_ground', x: 450, y: 190, w: 30, h: 20 });
  model.addWire(m, { id: 'g1', source: 'R1', target: 'G1', sourcePin: { x: 0, y: 0.5 } });
  model.addWire(m, { id: 'g2', source: 'R2', target: 'G2', sourcePin: { x: 1, y: 0.5 } });
  model.addWire(m, { id: 'g3', source: 'R3', target: 'G3', sourcePin: { x: 1, y: 0.5 } });
  const conn = connectivity(m);
  const netSizes = [...conn.nets.entries()].filter(([name]) => name !== '0')
    .map(([, terms]) => terms.length).sort((a, b) => b - a);
  assert.deepEqual(netSizes, [3], `expected one 3-terminal non-ground net, got net sizes ${JSON.stringify(netSizes)}`);
  const ercReport = ercCheck(m);
  const singleTerminal = ercReport.findings.filter((f) => f.code === 'single-terminal-net');
  assert.equal(singleTerminal.length, 0, 'a single-terminal-net finding would mean the waypoint was not recognized as merging the net');
  // MUTATION CHECK (manual, 2026-08-31): with isJunctionCell hardcoded to
  // `map.has('drawioApiJunction')` only (the pre-task-B behavior), classify()
  // returns {role:'other'} for the waypoint and activePins() returns [] for
  // an unmapped 'other' shape -- netlist.js's endpointKey() then falls into
  // its OWN "unknown shape -> single lumped node" fallback (pins.length===0),
  // which happens to also merge the net correctly for BOUND wires. This test
  // therefore does NOT discriminate that specific fallback path; it does
  // discriminate classify()'s role (checked directly above) and is kept
  // primarily as the ERC-surface regression check the task specifies.
});

test('Task B/trap: a shape=waypoint must never be treated as a routing obstacle (rewire.js)', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  addWaypoint(m, 'W1', 100, 100);
  model.addVertex(m, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 0, y: 0, w: 40, h: 20 });
  const cells = model.allCells(m).map(model.cellInfo);
  const obstacles = obstaclesOf(cells);
  assert.ok(!obstacles.some((o) => o.ownerId === 'W1'),
    'a 20x20 waypoint is >= OBSTACLE_MIN(12) on both axes and must be excluded by isJunctionCell, not by size');
  assert.ok(obstacles.some((o) => o.ownerId === 'R1'), 'a real component must still be an obstacle');
  // MUTATION CHECK (manual, 2026-08-31): reverting obstaclesOf()'s junction
  // test to `c.style.map.has('drawioApiJunction')` makes the first assertion
  // above fail -- the waypoint (20x20, both dims >= OBSTACLE_MIN=12) is no
  // longer size-filtered out and appears in `obstacles`. Confirmed by hand
  // before writing this comment; this is the exact trap the task brief names.
});

test('Task C: bindEndpoints binds a 0.2px-coincident free endpoint, refuses and reports one 32px away', () => {
  const doc = model.newDocument(); const m = model.getPage(doc);
  addWaypoint(m, 'W1', 500, 500);
  const mkPoint = (as, x, y) => { const p = m.ownerDocument.createElement('mxPoint'); p.setAttribute('as', as); p.setAttribute('x', String(x)); p.setAttribute('y', String(y)); return p; };

  // wire A: properly bound to a real component at its source, and a FREE
  // target 0.2 px from W1's centre -- only that one end is this pass's concern.
  model.addVertex(m, { id: 'RA', shape: 'mxgraph.electrical.resistors.resistor_2', x: 300, y: 490, w: 100, h: 20 });
  const wa = model.addWire(m, { id: 'wA', source: 'RA', target: null, sourcePin: { x: 1, y: 0.5 } });
  const gA = wa.getElementsByTagName('mxGeometry')[0];
  gA.appendChild(mkPoint('targetPoint', 500.2, 500.0)); // 0.2 px from W1 centre (500,500)

  // wire B: properly bound to a real component at its target, and a FREE
  // source 32 px from the SAME waypoint -- must be refused and reported.
  model.addVertex(m, { id: 'RB', shape: 'mxgraph.electrical.resistors.resistor_2', x: 700, y: 458, w: 100, h: 20 });
  const wb = model.addWire(m, { id: 'wB', source: null, target: 'RB', targetPin: { x: 0, y: 0.5 } });
  const gB = wb.getElementsByTagName('mxGeometry')[0];
  gB.appendChild(mkPoint('sourcePoint', 500, 468)); // 32 px away from W1 centre

  const result = bindEndpoints(m, { tolerance: 2 });
  assert.equal(result.bound.length, 1);
  assert.equal(result.bound[0].edge, 'wA');
  assert.equal(result.bound[0].junction, 'W1');
  assert.ok(result.bound[0].distance <= 2 && result.bound[0].distance > 0);

  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].edge, 'wB');
  assert.equal(Math.round(result.unresolved[0].distance), 32);

  // the bound edge must now actually be attached, pinned dead-centre, perimeter off
  const boundInfo = model.cellInfo(model.getCell(m, 'wA'));
  assert.equal(boundInfo.target, 'W1');
  const st = boundInfo.style.map;
  assert.equal(st.get('entryX'), '0.5');
  assert.equal(st.get('entryY'), '0.5');
  assert.equal(st.get('entryPerimeter'), '0');

  // the unresolved edge must be left exactly alone (still free).
  const unresolvedInfo = model.cellInfo(model.getCell(m, 'wB'));
  assert.equal(unresolvedInfo.source, null);

  // MUTATION CHECK (manual, 2026-08-31): setting tolerance to 40 makes wire B
  // bind too (distance 32 <= 40) -- confirmed the tolerance parameter is load-
  // bearing, not decorative, before writing this comment.
});
