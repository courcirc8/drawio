// LVS-preservation invariant, layers 1 & 3: this is NOT a rewrite of
// generator.test.js (which stays as-is — a smaller, faster smoke test over a
// STABLE subset). This file specifically exercises the connectivity
// fingerprint added in lib/invariant.js: it runs the FULL corpus
// (benchmark/netlists30/*.cir, all 43 -- probed empirically to place/route/
// LVS-match cleanly with place2, unlike generator.test.js's STABLE subset
// which also gates on the JS checker being clean) plus the two frozen RF
// nets, through place -> route -> compact, asserting LVS holds after each
// stage and that route.js/compact.js leave the connectivity fingerprint
// byte-for-byte unchanged. It also runs a genuine NEGATIVE control: a guard
// nobody has watched fail is not known to work.
//
// bun's DEFAULT PER-TEST TIMEOUT IS 5000ms (see plugin.test.js's own note on
// this exact trap: it caused a long-misdiagnosed "flake" in this repo
// before). Routing+compacting 45 real netlists is comfortably over that, so
// every test below carries an explicit generous timeout.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDocument, getPage, normalizeOrigin, updateCell } from '../lib/model.js';
import { importNetlist2 } from '../lib/place2.js';
import { importNetlist3 } from '../lib/place3.js';
import { routePage } from '../lib/route.js';
import { compactPage } from '../lib/compact.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { compare } from '../lib/lvs.js';
import { connectivityFingerprint, assertGeometryOnly, GeometryOnlyViolation } from '../lib/invariant.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NETS30 = path.join(HERE, '../benchmark/netlists30');
const RF_GOLDEN = [
  '/eda/dm/home/evandel/CURSOR/PySpectre/Match_BOM_optimizer/multi_agent_opt/rf_schematics/golden/matching_915.cir',
  '/eda/dm/home/evandel/CURSOR/PySpectre/Match_BOM_optimizer/multi_agent_opt/rf_schematics/golden/matching_2446.cir',
];

const netlists30 = fs.existsSync(NETS30)
  ? fs.readdirSync(NETS30).filter((f) => f.endsWith('.cir')).map((f) => ({ name: f, path: path.join(NETS30, f), engine: 'v2' }))
  : [];
const rfGolden = RF_GOLDEN.filter((p) => fs.existsSync(p)).map((p) => ({ name: path.basename(p), path: p, engine: 'v3' }));
const topologies = [...netlists30, ...rfGolden];

// Sanity on the fixture set itself: if either RF golden file went missing
// (wrong path, moved), fail loudly here rather than silently running a
// smaller corpus than the one described in the report.
test('invariant corpus: fixture set is the expected size', () => {
  assert.strictEqual(netlists30.length, 43, `benchmark/netlists30 file count drifted (found ${netlists30.length})`);
  assert.strictEqual(rfGolden.length, 2, `RF golden fixtures missing (found ${rfGolden.length}/2): ${RF_GOLDEN.join(', ')}`);
});

for (const topo of topologies) {
  test(`invariant: ${topo.name} — LVS holds after place+route+compact, geometry-only stages fingerprint-stable`,
    { timeout: 60000 }, async () => {
      const cir = fs.readFileSync(topo.path, 'utf8');
      const parsed = parseSpice(cir);
      const doc = newDocument();
      const m = getPage(doc);
      const placed = topo.engine === 'v3' ? importNetlist3(m, parsed, {}) : importNetlist2(m, parsed, {});

      // ---- stage 1: route (wrapped as a whole in route.js — see its own
      // "EMPIRICAL FINDING" docstring for why the whole function qualifies)
      const fBeforeRoute = connectivityFingerprint(m);
      await routePage(m, placed.wires, {});
      if (topo.engine === 'v3') normalizeOrigin(m); // optimize.js does the same after place3, see its own note
      assertGeometryOnly(fBeforeRoute, connectivityFingerprint(m), 'routePage');
      let lvsReport = compare(extractNetlist(m), parsed);
      assert.ok(lvsReport.match, `LVS mismatch after route: ${JSON.stringify(lvsReport).slice(0, 300)}`);

      // ---- stage 2: compact (wrapped as a whole in compact.js)
      const fBeforeCompact = connectivityFingerprint(m);
      await compactPage(m, { maxMoves: 8 }); // small budget: this test cares about the invariant, not the score
      assertGeometryOnly(fBeforeCompact, connectivityFingerprint(m), 'compactPage');
      lvsReport = compare(extractNetlist(m), parsed);
      assert.ok(lvsReport.match, `LVS mismatch after compact: ${JSON.stringify(lvsReport).slice(0, 300)}`);
    });
}

// ---- NEGATIVE CONTROL --------------------------------------------------
// A guard nobody has watched fail is not known to work. Take a real placed
// document, deliberately repoint one wire's target to a DIFFERENT node (the
// exact class of bug the rewire.js/optimize.js history describes: a wire
// silently rebound onto the wrong pin), and assert the fingerprint actually
// changes and assertGeometryOnly actually throws.
test('invariant NEGATIVE CONTROL: repointing a wire target changes the fingerprint and assertGeometryOnly fires',
  { timeout: 30000 }, async () => {
    const name = netlists30.find((t) => t.name === 'rc-filter.cir') || netlists30[0];
    const cir = fs.readFileSync(name.path, 'utf8');
    const parsed = parseSpice(cir);
    const doc = newDocument();
    const m = getPage(doc);
    const placed = importNetlist2(m, parsed, {});
    await routePage(m, placed.wires, {});

    // find an edge with two DISTINCT non-junction vertex endpoints, and a
    // third vertex that is neither, to repoint onto.
    const { allCells, cellInfo } = await import('../lib/model.js');
    const cells = allCells(m).map(cellInfo);
    const vertices = cells.filter((c) => c.kind === 'vertex' && c.x != null);
    const edges = cells.filter((c) => c.kind === 'edge' && c.source != null && c.target != null);
    const edge = edges.find((e) => vertices.some((v) => v.id === e.source) &&
      vertices.some((v) => v.id === e.target) &&
      vertices.some((v) => v.id !== e.source && v.id !== e.target));
    assert.ok(edge != null, 'fixture has no edge suitable for the negative control (unexpected)');
    const otherVertex = vertices.find((v) => v.id !== edge.source && v.id !== edge.target);

    const before = connectivityFingerprint(m);
    updateCell(m, edge.id, { target: otherVertex.id }); // the deliberate corruption
    const after = connectivityFingerprint(m);

    assert.notStrictEqual(before, after, 'repointing a wire target did not change the fingerprint — the guard would never fire');
    assert.throws(() => assertGeometryOnly(before, after, 'negative-control'), GeometryOnlyViolation);

    // and, independently, confirm this actually broke LVS (the guard is
    // catching a REAL defect class, not a fingerprint artifact with no
    // electrical meaning)
    const lvsReport = compare(extractNetlist(m), parsed);
    assert.strictEqual(lvsReport.match, false, 'repointing a wire target should have broken LVS too (sanity on the control itself)');
  });
