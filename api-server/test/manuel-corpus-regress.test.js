// Non-regression of the manual engine on corpus circuits (review of #67,
// 2026-10-26): the general rules added for the cascode OTA must not take the
// clean manual drawing of other circuits away, nor file supplies, mirrors or
// a bandgap core branch in the wrong frame. Fixtures: test/fixtures/corpus-regress
// (MIT netlists of the bank, source in each file's first line).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { manuelReading } from '../lib/manuel-reading.js';
import { tryManuel } from '../lib/auto.js';

const parse = (t) => withGroundAlias(parseSpice(t));
const fixture = (n) => parse(fs.readFileSync(new URL(`./fixtures/corpus-regress/${n}.cir`, import.meta.url), 'utf8'));
const refs = (R, kind) => (R.frames.find((f) => f.kind === kind)?.parts || []).map((c) => c.ref).sort();

for (const [n, frames] of [['casc_amp', 'core,bias'], ['analoggenie_230', 'core'], ['analoggenie_954', 'core'], ['benoitlx_miller', 'core,bias']]) {
  test(`${n}: still drawn by the manual engine, LVS and geometric LVS green`, () => {
    const p = fixture(n), r = tryManuel(p);
    assert.ok(r, 'a manual drawing');
    assert.equal(r.placed.frames.join(), frames);
    assert.equal(r.placed.geo.ok, true);
    assert.equal(compare(extractNetlist(getPage(r.doc)), p).match, true);
  });
}

test('a gate driven by capacitors only is not a start-up (analoggenie/230)', () => {
  const R = manuelReading(fixture('analoggenie_230'));
  assert.ok(!R.frames.some((f) => f.kind === 'startup'));
  assert.ok(refs(R, 'core').includes('M0'));
});

test('a supply, a bench source or a decoupling capacitor is never a start-up', () => {
  const R = manuelReading(fixture('casc_amp'));
  assert.ok(!R.frames.some((f) => f.kind === 'startup'), JSON.stringify(R.frames.map((f) => f.kind)));
  const t = `M1 o1 inp t 0 nmos
M2 o2 inn t 0 nmos
M3 t vb 0 0 nmos
R1 o1 vdd 1k
R2 o2 vdd 1k
I1 vdd vb 10u
M4 vb vb 0 0 nmos
V1 vdd 0 1.2
C9 vdd 0 1p
.end`;
  const S = manuelReading(parse(t));
  assert.ok(S && !S.frames.some((f) => f.kind === 'startup'), JSON.stringify(S?.frames.map((f) => f.kind)));
});

test('a bandgap core branch into the amplifier input stays in the core (analoggenie/1504)', () => {
  const R = manuelReading(fixture('analoggenie_1504'));
  for (const r of ['Q0', 'R2', 'MM3', 'MM4']) assert.ok(refs(R, 'core').includes(r), `${r} in core: ${refs(R, 'core')}`);
});

test('half of an input pair is never a bias replica (benoitlx Miller OTA: M3 diode over M1)', () => {
  const core = refs(manuelReading(fixture('benoitlx_miller')), 'core');
  for (const r of ['M1', 'M2', 'M3', 'M4']) assert.ok(core.includes(r), `${r} in core: ${core}`);
});

test('a mirror reference stays with its mirror (diode on the node its mirror hangs on)', () => {
  const R = manuelReading(parse(`R1 vg vin 1k
V1 sup 0 1.2
V2 vc 0 0.4
V3 vin 0 1
M1 a vc 0 0 nmos
M2 b vc 0 0 nmos
M3 a a sup sup pmos
M4 c a sup sup pmos
M5 va vg c sup pmos
M6 va vg b 0 nmos
.end`));
  const core = refs(R, 'core');
  for (const r of ['M3', 'M4']) assert.ok(core.includes(r), `${r} in core: ${core}`);
});
