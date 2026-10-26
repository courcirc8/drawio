// D4 (PLAN-HIERARCHIE §3.2, 2026-10-26): every block of a hierarchical
// drawing links to its page (drawio `link="data:page/id,…"`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importHier } from '../lib/hier.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const links = (doc) => {
  const ids = new Map(Array.from(doc.getElementsByTagName('diagram')).map((d) => [d.getAttribute('id'), d.getAttribute('name')]));
  const out = {};
  for (const dia of Array.from(doc.getElementsByTagName('diagram'))) {
    for (const o of Array.from(dia.getElementsByTagName('object'))) {
      const l = /^data:page\/id,(.*)$/.exec(o.getAttribute('link') || '');
      if (l) out[`${dia.getAttribute('name')}/${o.getAttribute('refdes')}`] = ids.get(l[1]);
    }
  }
  return out;
};

test('every block links to the page of its definition, or of its bank', async () => {
  const r = await importHier(read('./fixtures/hier/tia_op.cir'));
  const L = links(r.doc);
  assert.equal(L['top/XA1'], 'ota1'); assert.equal(L['top/XA2'], 'ota2'); assert.equal(L['top/XA3'], 'ota3');
  for (const b of r.banks) assert.equal(L[`top/${b.name}`], b.name);
  assert.equal(Object.keys(L).length, 3 + r.banks.length);
});

test('per = instance: every block links to the page of its instance path', async () => {
  const r = await importHier(read('./fixtures/hier/tia_op.cir'), { per: 'instance' });
  const L = links(r.doc);
  assert.equal(L['top/XA1'], 'XA1'); assert.equal(L['top/XA3'], 'XA3');
});
