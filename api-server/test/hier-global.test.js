// The global LVS of ?hier=1 must be an INDEPENDENT check: the drawing of each
// page flattened through the blocks with its OWN extracted nets. The first
// version renamed the extracted nets with the reference names (netMap), which
// glued a cut net back together: 5 of 7 corruptions passed (review of
// drawio#63, 2026-10-25). opts.onPage(name, model) edits a page before its
// extraction, for this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importHier } from '../lib/hier.js';

const fx = (n) => fs.readFileSync(new URL(`./fixtures/hier/${n}`, import.meta.url), 'utf8');
// cut every wire of the cell that has the most (a part or a junction: its
// terminals float, the net is split)
const cutWire = (model) => {
  const wires = Array.from(model.getElementsByTagName('mxCell')).filter((c) => c.getAttribute('edge') === '1');
  const ends = (w) => [w.getAttribute('source'), w.getAttribute('target')].filter(Boolean);
  const count = new Map();
  for (const w of wires) for (const id of ends(w)) count.set(id, (count.get(id) || 0) + 1);
  const victim = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  assert.ok(victim, 'a cell with wires');
  for (const w of wires) if (ends(w).includes(victim)) w.parentNode.removeChild(w);
};
const corrupt = (page) => ({ onPage: (name, model) => { if (name === page) cutWire(model); } });

for (const [file, page] of [['multi.sp', 'inv'], ['multi.sp', 'buf'], ['multi.sp', 'top'], ['tia_op.cir', 'ota1'], ['tia_op.cir', 'bank_o1n_inp'], ['tia_op.cir', 'top']]) {
  test(`a wire cut on page ${page} (${file}) fails the page LVS AND the global LVS`, { timeout: 300000 }, async () => {
    const r = await importHier(fx(file), corrupt(page));
    assert.equal(r.lvs.pages[page], false, 'page LVS');
    assert.equal(r.lvs.global, false, 'global LVS ' + JSON.stringify(r.lvs.pages));
    for (const [p, ok] of Object.entries(r.lvs.pages)) if (p !== page) assert.ok(ok, p);
  });
}

test('untouched drawings: global LVS green', { timeout: 300000 }, async () => {
  for (const f of ['multi.sp', 'tia_op.cir']) assert.ok((await importHier(fx(f))).lvs.global, f);
});
