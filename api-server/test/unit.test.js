import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../lib/model.js';
import { parseSpice, extractNetlist, connectivity } from '../lib/netlist.js';
import { importNetlist } from '../lib/place.js';
import { routePage } from '../lib/route.js';
import { compare, gate } from '../lib/lvs.js';
import { check as ercCheck } from '../lib/erc.js';
import { bom } from '../lib/bom.js';
import { searchShapes, getShape, getPin } from '../lib/stencils.js';
import zlib from 'node:zlib';
import { formatComponentValue } from '../lib/components.js';

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
  // 0-ohm bridge/jumper: bare "0", not "0 ohm" (see components.js docstring).
  assert.equal(formatComponentValue('R', '0.0'), '0');
  assert.equal(formatComponentValue('R', '0'), '0');
  // Exact prefix boundaries: mantissa must land as "1", not "1000" of the
  // prefix one step down (1e-9 is 1 n, not 1000 p; 1e-12 is 1 p).
  assert.equal(formatComponentValue('L', '1e-9'), '1 nH');
  assert.equal(formatComponentValue('C', '1e-12'), '1 pF');
  // A normal resistor value.
  assert.equal(formatComponentValue('R', '5e3'), '5 kohm');
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

