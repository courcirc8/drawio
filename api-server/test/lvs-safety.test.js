import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { newDocument, getPage } from '../lib/model.js';
import { importNetlist2 } from '../lib/place2.js';
import { routePage } from '../lib/route.js';
import { compare } from '../lib/lvs.js';
import { autoPlace } from '../lib/auto.js';

// a chain element shared by two chains: its shunt cap (C17) was silently dropped
const SHARED = 'M2 out in a 0 PMOS\nM5 a in out 0 PMOS\nM6 vp pgt a 0 PMOS\nM8 a pgt vp 0 PMOS\nC8 vp a 1p\nC10 a pgt 1p\nC12 out in 1p\nC13 vp pgt 1p\nC14 a in 1p\nC16 out 0 1p\nC17 vp 0 1p\nC19 a 0 1p\n.end';

test('place2 draws every part (hangers of a chain element shared by two chains)', { timeout: 60000 }, async () => {
  const p = parseSpice(SHARED);
  const m = getPage(newDocument());
  const r = importNetlist2(m, p, {});
  await routePage(m, r.wires, {});
  assert.equal(compare(extractNetlist(m), p).match, true);
});

test('SPICE node names are case-insensitive', () => {
  const p = parseSpice('V1 Vin 0 1\nR1 vin out 1k\nR2 OUT 0 1k\n.end');
  assert.equal(new Set(p.components.flatMap((c) => c.nodes)).size, 3, 'Vin/vin and out/OUT are one node each');
});

test('engine=auto never returns a drawing that fails LVS when one passes', { timeout: 120000 }, async () => {
  const p = parseSpice(SHARED);
  const a = await autoPlace(p);
  assert.equal(compare(extractNetlist(getPage(a.doc)), p).match, true);
  for (const t of Object.values(a.trials)) assert.ok('lvs' in t);
});
