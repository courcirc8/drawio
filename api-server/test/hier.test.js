// HIERARCHICAL drawing (lib/hier.js, Orchestrator GO 2026-10-25 for
// analog-design): one page per .subckt (or per instance), banks / series
// chains of the top level grouped into their own pages, a top page of blocks;
// LVS per page and of the whole drawing flattened back; the map from a
// flattened ref (XA1.XM5) to its (page, cell).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { newDocument, getPage, listPages } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { hierReading, importHier, importBlockPage } from '../lib/hier.js';

const fx = (n) => fs.readFileSync(new URL(`./fixtures/hier/${n}`, import.meta.url), 'utf8');
const allGreen = (r) => Object.values(r.lvs.pages).every(Boolean) && r.lvs.global;
const topItems = (H) => {
  const grouped = new Set(H.banks.flatMap((b) => b.parts.map((c) => c.ref)));
  return H.top.components.filter((c) => !grouped.has(c.ref)).length + H.banks.length;
};

test('IHP SG13G2 primitives written as X lines are read as devices', () => {
  const p = parseSpice(['* ihp', 'XM1 d g s b sg13_lv_nmos w=2u l=0.13u ng=2 m=1', 'XR1 a c 0 rppd w=0.5u l=10u b=0 m=1',
    'XC1 a 0 cap_cmim w=10u l=10u', 'XQ1 c b e 0 npn13G2 Nx=1', '.end'].join('\n'));
  const by = Object.fromEntries(p.components.map((c) => [c.ref, c]));
  assert.equal(p.warnings.length, 0, JSON.stringify(p.warnings));
  assert.equal(by.XM1.prefix, 'M'); assert.deepEqual(by.XM1.nodes, ['d', 'g', 's']);
  assert.equal(by.XR1.prefix, 'R'); assert.deepEqual(by.XR1.nodes, ['a', 'c']); assert.deepEqual(by.XR1.body, ['0']);
  assert.equal(by.XC1.prefix, 'C'); assert.equal(by.XQ1.prefix, 'Q'); assert.deepEqual(by.XQ1.nodes, ['c', 'b', 'e']);
});

test('multi-instance, nested: one page per definition, global LVS, map', async () => {
  const r = await importHier(fx('multi.sp'));
  assert.deepEqual(r.pages.map((p) => p.name).sort(), ['buf', 'inv', 'top']);
  assert.ok(allGreen(r), JSON.stringify(r.lvs));
  assert.deepEqual(r.map['XB2.X1.M2'], { page: 'inv', cell: 'M2' });
  assert.deepEqual(r.map['XB2.X1'], { page: 'buf', cell: 'X1' });
  assert.deepEqual(r.map.XB1, { page: 'top', cell: 'XB1' });
  assert.deepEqual(r.map.RL, { page: 'top', cell: 'RL' });
  // the pages are in the document, under their names
  assert.deepEqual(listPages(r.doc).map((p) => p.name).sort(), ['buf', 'inv', 'top']);
});

test('multi-instance, nested: ?per=instance draws one page per instance path', async () => {
  const r = await importHier(fx('multi.sp'), { per: 'instance' });
  assert.deepEqual(r.pages.map((p) => p.name).sort(), ['XB1', 'XB1.X1', 'XB1.X2', 'XB2', 'XB2.X1', 'XB2.X2', 'top']);
  assert.ok(allGreen(r), JSON.stringify(r.lvs));
  assert.deepEqual(r.map['XB2.X1.M2'], { page: 'XB2.X1', cell: 'M2' });
  assert.deepEqual(r.map['XB2.X1'], { page: 'XB2', cell: 'X1' });
});

test('a block cell carries its pins in order: a swapped binding fails the top LVS', () => {
  const H = hierReading(fx('multi.sp'));
  const doc = newDocument('top'), m = getPage(doc);
  const r = importBlockPage(m, H.top, H.banks);
  assert.ok(r.geo.ok, JSON.stringify(r.geo.errors));
  const ex = extractNetlist(m);
  assert.ok(compare(ex, r.golden).match);
  const bad = { ...r.golden, components: r.golden.components.map((c) => c.ref === 'XB1' ? { ...c, nodes: [c.nodes[1], c.nodes[0], c.nodes[2]], fullNodes: [c.nodes[1], c.nodes[0], c.nodes[2]] } : c) };
  assert.equal(compare(ex, bad).match, false);
});

test('TIA (sim/op.cir): 3 OTA pages, 6 switched banks drawn as ladders, top <= 30 items', async () => {
  const text = fx('tia_op.cir');
  const H = hierReading(text);
  assert.equal(H.banks.filter((b) => b.kind === 'bank').length, 6);
  for (const b of H.banks) assert.equal(b.parts.length, 29, b.name);     // 7 slices x 4 + the direct capacitor
  assert.ok(topItems(H) <= 30, `top items ${topItems(H)}`);
  const r = await importHier(text);
  assert.ok(allGreen(r), JSON.stringify(r.lvs));
  for (const p of r.pages.filter((p) => p.kind === 'bank')) assert.equal(p.engine, 'manuel', p.name);
  assert.deepEqual(r.map['XA1.XM5'], { page: 'ota1', cell: 'XM5' });
  assert.deepEqual(r.map.XSWF11, { page: 'bank_o1n_inp', cell: 'XSWF11' });
  assert.deepEqual(r.map.XF10, { page: 'bank_o1n_inp', cell: 'XF10' });
});

test('TIA (proj5, cycle 5): resistor strings grouped as chains, lone keepers on the top, all LVS green', { timeout: 600000 }, async () => {
  const text = fx('tia_proj5.cir');
  const H = hierReading(text);
  const chains = H.banks.filter((b) => b.kind === 'chain');
  assert.ok(chains.some((c) => c.name === 'chain_XRF1' && c.parts.length === 23), chains.map((c) => c.name).join(' '));
  assert.ok(topItems(H) <= 32, `top items ${topItems(H)}`);
  const r = await importHier(text);
  assert.ok(allGreen(r), JSON.stringify(r.lvs).slice(0, 2000));
  assert.deepEqual(r.map.XRF1u7, { page: 'chain_XRF1', cell: 'XRF1u7' });
  assert.deepEqual(r.map.XKP, { page: 'top', cell: 'XKP' });
  assert.ok(r.lvs.warnings && r.lvs.warnings.length, 'the .nodeset directive is reported');
});
