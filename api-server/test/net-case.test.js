// SPICE node names are case-insensitive, also across a .subckt boundary:
// pins written "IN OUT VDD", instance nets "in a vdd" are the same nodes.
// Found by the review of drawio#63 (2026-10-25): the pin was taken for a local
// net XB1.vdd, the flat drawing was electrically wrong and its LVS green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice } from '../lib/netlist.js';
import { importHier } from '../lib/hier.js';

const fx = (n) => fs.readFileSync(new URL(`./fixtures/hier/${n}`, import.meta.url), 'utf8');
// node spelling = first met (netlist.js caseOf), compared in lower case
const conn = (p) => p.components.map((c) => `${c.ref}:${c.nodes.join(',')}`.toLowerCase()).sort();
const low = (a) => a.map((n) => n.toLowerCase());

test('upper-case .subckt pins bind to the lower-case nets of the instance', () => {
  const p = parseSpice(fx('case1.sp'));
  const by = Object.fromEntries(p.components.map((c) => [c.ref, c]));
  assert.deepEqual(low(by['XB1.M1'].nodes), ['a', 'in', 'vdd']);
  assert.deepEqual(low(by['XB2.M2'].nodes), ['out', 'a', '0']);
  assert.ok(!p.components.some((c) => c.nodes.some((n) => /^XB\d\./.test(n))), conn(p).join(' '));
});

test('3 nested levels: mixed-case pins read as the lower-case version', () => {
  assert.deepEqual(conn(parseSpice(fx('nest3.sp'))), conn(parseSpice(fx('nest3_lc.sp'))));
});

test('hier import of mixed-case pins: every page and the global LVS green', async () => {
  for (const f of ['case1.sp', 'nest3.sp']) {
    const r = await importHier(fx(f));
    assert.ok(Object.values(r.lvs.pages).every(Boolean) && r.lvs.global, f + ' ' + JSON.stringify(r.lvs));
  }
});
