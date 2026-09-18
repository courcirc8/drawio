import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newDocument, getPage, normalizeOrigin } from '../lib/model.js';
import { parseSpice } from '../lib/netlist.js';
import { importNetlist2 } from '../lib/place2.js';
import { routePage } from '../lib/route.js';
import { toAsc, verifyAsc, exportAsc } from '../lib/export-asc.js';
import { parseAsc } from '../tools/asc2spice.mjs';

async function draw(cir) {
  const d = newDocument(); const m = getPage(d);
  const p = importNetlist2(m, parseSpice(cir));
  await routePage(m, p.wires, {}); normalizeOrigin(m);
  return m;
}

test('export-asc: every generated benchmark topology round-trips to LTspice and back (strict LVS)', { timeout: 120000 }, async () => {
  const dir = new URL('../benchmark/netlists30/', import.meta.url);
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.cir'));
  assert.equal(names.length, 43);
  const failed = [];
  for (const f of names) {
    const m = await draw(fs.readFileSync(new URL(f, dir), 'utf8'));
    const r = exportAsc(m);
    if (!r.verified || r.skipped.length) failed.push({ f, skipped: r.skipped, report: JSON.stringify(r.report).slice(0, 200) });
  }
  assert.deepEqual(failed, []);
});

test('export-asc: symbols, orientation and flags are what the drawing says', async () => {
  const m = await draw('V1 in 0 DC 5\nR1 in out 10k\nC1 out 0 100n\nM1 vdd out 0 0 PMOS\nV2 vdd 0 1.8\n.end');
  const { asc, extracted } = toAsc(m);
  const a = parseAsc(asc);
  const syms = Object.fromEntries(a.syms.map((s) => [s.name, s]));
  assert.equal(syms.R1.sym, 'res');
  assert.equal(syms.C1.sym, 'cap');
  assert.equal(syms.M1.sym, 'pmos4');           // bulk pin kept: 4-pin symbol
  assert.equal(syms.V1.sym, 'voltage');
  assert.equal(syms.R1.value, '10k');
  // grid discipline: every symbol origin and flag on the 16-unit grid
  for (const s of a.syms) { assert.equal(s.x % 16, 0); assert.equal(s.y % 16, 0); }
  for (const f of a.flags) { assert.equal(f.x % 16, 0); assert.equal(f.y % 16, 0); }
  // ground and named nets survive as flags
  assert.ok(a.flags.some((f) => f.name === '0'));
  assert.ok(a.flags.some((f) => f.name.toUpperCase() === 'VDD'));
  const v = verifyAsc(asc, extracted);
  assert.equal(v.match, true, JSON.stringify(v.report).slice(0, 300));
});

test('export-asc: the new element classes (E F B S J X) export and verify', async () => {
  const m = await draw(`V1 in 0 SINE(0 1 1k)
R1 in g 1k
J1 d g 0 J2N3819
R2 vdd d 2.2k
V2 vdd 0 12
E1 e 0 d g 10
R3 e 0 1k
F1 f 0 V2 0.5
R4 f 0 100
B1 bb 0 V=V(d)*2
R5 bb 0 1k
S1 sw 0 in g SWMOD
R6 vdd sw 10k
XU1 d 0 vdd 0 o LT1007
R7 o 0 1k
XU2 o 0 o2 opamp
R8 o2 0 1k
.end`);
  const r = exportAsc(m);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.verified, true, JSON.stringify(r.report).slice(0, 400));
  const a = parseAsc(r.asc);
  const syms = Object.fromEntries(a.syms.map((s) => [s.name, s]));
  assert.equal(syms.XU1.sym, 'Opamps\\UniversalOpamp2');
  assert.equal(syms.XU2.sym, 'Opamps\\opamp');
  assert.equal(syms.S1.sym, 'sw');
  assert.equal(syms.J1.sym, 'njf');
});
