// Brokaw bandgap drawn like a textbook figure (lib/place-brokaw.js). Request of
// Eric through the Orchestrator, 2026-10-25: the analog-design drawing of its
// Brokaw reference was unreadable. Two forms of the same block: the verifier
// netlist (SPICE primitives, strings joined) and the IHP X-primitive form of
// bloc.py (split resistor strings, bench supply).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { newDocument, getPage, allCells, cellInfo } from '../lib/model.js';
import { compare } from '../lib/lvs.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { importNetlistManuel } from '../lib/place-manuel.js';
import { brokawReading } from '../lib/place-brokaw.js';
import { tryManuel } from '../lib/auto.js';

const src = (n) => fs.readFileSync(new URL(`./fixtures/brokaw/${n}.sp`, import.meta.url), 'utf8');
const fx = (n) => withGroundAlias(parseSpice(src(n)));
const draw = (p) => { const doc = newDocument(), m = getPage(doc); const r = importNetlistManuel(m, p); return { m, r }; };
const vertices = (m) => new Map(allCells(m).map(cellInfo).filter((c) => c.kind === 'vertex').map((c) => [String(c.refdes || c.id).toUpperCase(), c]));
// a frame: the dashed box whose title text sits at its top-left corner (lib/place-manuel.js emit)
const frameOf = (m, title) => {
  const cells = allCells(m).map(cellInfo).filter((c) => c.kind === 'vertex');
  const t = cells.find((c) => c.value.replace(/<[^>]+>/g, '').trim() === title);
  return t && cells.find((c) => /dashed=1/.test(c.styleRaw) && c.x === t.x - 8 && c.y === t.y - 4);
};
const cx = (c) => c.x + c.w / 2, cy = (c) => c.y + c.h / 2;

const FORMS = { brokaw_verifier: '', brokaw_bloc: 'X' };

for (const [n, x] of Object.entries(FORMS)) {
  test(`brokaw reading by roles (${n})`, () => {
    const B = brokawReading(fx(n));
    assert.ok(B, 'reading must be sure');
    assert.equal(B.X, 'vref'); assert.equal(B.VB, 'vb'); assert.equal(B.E, 'e');
    assert.equal(B.core.small.ref, `${x}Q1`); assert.equal(B.core.big.ref, `${x}Q2`);
    assert.equal(B.out.ref, `${x}MP`);
    assert.deepEqual(B.start.stack.map((c) => c.ref).slice(0, 2), [`${x}MPL0`, `${x}MPL1`]);
  });

  test(`brokaw drawn: LVS and geometric LVS green, frames (${n})`, () => {
    const p = fx(n), { m, r } = draw(p);
    assert.equal(compare(extractNetlist(m), p).match, true);
    assert.equal(r.geo.ok, true, JSON.stringify(r.geo.errors.slice(0, 3)));
    assert.deepEqual(r.frames, ['startup', 'core', 'amplifier', 'output']);
  });

  test(`brokaw reads like the textbook (${n})`, () => {
    const { m } = draw(fx(n)), v = vertices(m), g = (r) => v.get(`${x}${r}`.toUpperCase());
    // the core pair side by side, the small one left, at the same height
    assert.equal(cy(g('Q1')), cy(g('Q2'))); assert.ok(cx(g('Q1')) < cx(g('Q2')));
    // R1 under the big emitter, R2 under the small one
    const r1 = g(x ? 'R1_0' : 'R1'), r2 = g(x ? 'R2_0' : 'R2');
    const under = (r, q) => cx(r) > q.x && cx(r) < q.x + q.w && r.y > q.y + q.h;   // the symbol box is offset by the base
    assert.ok(under(r1, g('Q2')));
    assert.ok(under(r2, g('Q1')) && r2.y > r1.y);
    // the PMOS mirror on top of the input pair
    assert.ok(g('M3').y < g('M1').y && g('M4').y < g('M2').y);
    // left -> right: start-up, core, amplifier, output, each in its frame
    const fr = ['Démarrage', 'Cœur', "Amplificateur d'erreur", 'Sortie'].map((t) => frameOf(m, t));
    assert.ok(fr.every(Boolean), 'four titled frames');
    for (let i = 1; i < fr.length; i++) assert.ok(fr[i - 1].x < fr[i].x);
    const inside = (c, f) => c.x >= f.x && c.x + c.w <= f.x + f.w && c.y >= f.y && c.y + c.h <= f.y + f.h;
    assert.ok(inside(g('MPL0'), fr[0]) && inside(g('MS'), fr[0]), 'start-up in « Démarrage »');
    assert.ok(inside(g('Q1'), fr[1]) && inside(g('M1'), fr[2]) && inside(g('MP'), fr[3]));
    // the emitter-area ratio written beside the pair
    const texts = allCells(m).map(cellInfo).map((c) => c.value.replace(/<[^>]+>/g, ''));
    assert.ok(texts.includes('A (×18)') && texts.includes('8A (×144)'), texts.filter((t) => /A \(/.test(t)).join('|'));
  });
}

test('brokaw: not sure when a role is missing (no R2) or doubled (two outputs)', () => {
  const noR2 = src('brokaw_verifier').split('\n').filter((l) => !/^R2 /.test(l)).join('\n');
  assert.equal(brokawReading(parseSpice(noR2)), null);
  const twoOut = src('brokaw_verifier').replace(/^\.end/m, 'MP2 vref o1 vdd vdd pmos w=10u l=1u\n.end');
  assert.equal(brokawReading(parseSpice(twoOut)), null);
});

test('brokaw: tryManuel returns the textbook drawing', () => {
  for (const n of Object.keys(FORMS)) assert.equal(tryManuel(fx(n))?.placed.frames.join(), 'startup,core,amplifier,output');
});
