import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newDocument, getPage, serialize, parseDrawio, allCells, cellInfo } from '../lib/model.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { importNetlist4 } from '../lib/place4.js';
import { compare } from '../lib/lvs.js';
import { checkDocument } from '../lib/check.js';

const cir = (name, dir = 'netlists30') => fs.readFileSync(new URL(`../benchmark/${dir}/${name}.cir`, import.meta.url), 'utf8');

async function v4(text) {
  const parsed = parseSpice(text);
  const doc = newDocument(); const m = getPage(doc);
  const placed = await importNetlist4(m, parsed);
  const m2 = getPage(parseDrawio(serialize(doc)));          // from the saved XML, as the server does
  return { parsed, placed, model: m2, lvs: compare(extractNetlist(m2), parsed) };
}

test('place4: multi-block circuits compose into one page that passes strict LVS', { timeout: 120000 }, async () => {
  for (const [name, dir] of [['cherry-hooper', 'netlists30'], ['gilbert-mixer', 'netlists30'], ['strongarm-latch', 'netlists30'],
    ['Common-emitter-BJT', 'holdout-ltspice'], ['Differential-pair', 'holdout-ltspice'], ['Push-pull-amplifier-AB-BJT', 'holdout-ltspice']]) {
    const { placed, lvs, model } = await v4(cir(name, dir));
    assert.equal(lvs.match, true, name + ': ' + JSON.stringify(lvs).slice(0, 400));
    assert.ok(placed.blocks.length >= 2, name + ' should be multi-block');
    assert.equal(placed.routed, true, name + ' routed');
    // a component belongs to exactly one block; every component is placed once
    const refs = placed.blocks.flatMap((b) => b.refs);
    assert.equal(new Set(refs).size, refs.length);
    const ids = allCells(model).map((n) => n.getAttribute('id'));
    assert.equal(new Set(ids).size, ids.length, name + ': duplicate cell ids after transplant');
    assert.equal(ids.filter((i) => i === '0' || i === '1').length, 2, name + ': layer cells must exist exactly once');
    // blocks do not overlap
    const boxes = placed.blocks.map((b) => b.box);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${name}: blocks ${placed.blocks[i].id} and ${placed.blocks[j].id} overlap`);
    }
  }
});

test('place4: a single-block netlist falls back to place2 and is routed', async () => {
  const { placed, lvs, model } = await v4('V1 in 0 DC 1\nR1 in out 1k\nC1 out 0 1p\n.end');
  assert.equal(placed.engine, 'v4->v2');
  assert.equal(lvs.match, true);
  assert.equal(placed.routed, true);
  const edges = allCells(model).map(cellInfo).filter((c) => c.kind === 'edge');
  assert.ok(edges.length >= 2);
  assert.equal(checkDocument(model).violations.filter((v) => v.severity === 'error' && v.rule !== '30').length, 0);
});

test('place4: inter-block nets are wired exactly once (MST) or joined by name when every block has a port', async () => {
  const { placed, model, lvs } = await v4(cir('ota-2stage-pmos'));
  assert.equal(lvs.match, true, JSON.stringify(lvs).slice(0, 400));
  assert.ok(placed.interBlockNets.length >= 1);
  const byName = placed.interBlockNets.filter((n) => n.joinedByName);
  assert.ok(byName.some((n) => n.net.toUpperCase() === 'VB'), 'the VB bias bus has a local port in every block -> joined by name, no wire across the sheet');
  for (const n of placed.interBlockNets) assert.equal(n.wires, n.joinedByName ? 0 : n.blocks.length - 1, n.net + ': tree over the attachments');
  // ports keep their labels (they carry the net name for extraction)
  const portNames = allCells(model).map(cellInfo).filter((c) => c.style.map.get('apiShape') === 'port').map((c) => String(c.value).toUpperCase());
  assert.ok(portNames.filter((p) => p === 'VB').length >= 2);
});

test('place4: the discrete BJT stages of the holdout beat place2 (the measured reason v4 exists)', { timeout: 120000 }, async () => {
  const { importNetlist2 } = await import('../lib/place2.js');
  const { routePage } = await import('../lib/route.js');
  const { normalizeOrigin } = await import('../lib/model.js');
  const errorsOf = (m) => checkDocument(m).violations.filter((v) => v.severity === 'error' && v.rule !== '30').length;
  const text = cir('Push-pull-amplifier-AB-BJT', 'holdout-ltspice');
  const parsed = parseSpice(text);
  const d2 = newDocument(); const m2 = getPage(d2); const p2 = importNetlist2(m2, parsed); await routePage(m2, p2.wires, {}); normalizeOrigin(m2);
  const { model: m4 } = await v4(text);
  assert.ok(errorsOf(m4) < errorsOf(m2), `v4 ${errorsOf(m4)} should be below v2 ${errorsOf(m2)}`);
});
