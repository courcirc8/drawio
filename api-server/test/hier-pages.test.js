// D4 + D5 (PLAN-HIERARCHIE §3.2, 2026-10-26): every block of a hierarchical
// drawing links to its page (drawio `link="data:page/id,…"`), and every page
// exports as an SVG with the geometry of its cells in that SVG's units, the
// flattened refs placed through `map`, blocks clickable to their page's SVG.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importHier } from '../lib/hier.js';
import { hierPages } from '../lib/hier-export.js';
import { findChrome, closeBrowser } from '../lib/render.js';

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

test('per-page SVG + geometry: every flattened ref placed on its page, blocks clickable', { skip: findChrome() ? false : 'no Chromium' }, async () => {
  try {
    const r = await importHier(read('./fixtures/hier-rails/ota_rails.cir'));
    const out = await hierPages(r.doc, r.map);
    assert.deepEqual(out.pages.map((p) => p.name), ['tb_ota', 'ota']);
    for (const p of out.pages) assert.match(p.svg, /^<\?xml[\s\S]*<svg[\s\S]*<\/svg>$/);
    // every device of the flattened netlist has a box on its page
    for (const ref of ['XOTA.M1', 'XOTA.M2', 'XOTA.MNT', 'XOTA.MN0', 'RB', 'RF1', 'CL']) {
      const b = out.map[ref];
      assert.ok(b && b.w > 0 && b.h > 0, ref);
      assert.equal(b.page, ref.startsWith('XOTA.') ? 'ota' : 'tb_ota');
    }
    // the boxes are in the SVG's units: inside its painted extent, and distinct
    const ota = out.pages.find((p) => p.name === 'ota');
    const W = Number(/min-width: (\d+)px/.exec(ota.svg)[1]), H = Number(/min-height: (\d+)px/.exec(ota.svg)[1]);
    for (const c of Object.values(ota.cells)) assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= W + 1 && c.y + c.h <= H + 1, JSON.stringify(c));
    assert.notDeepEqual(out.map['XOTA.M1'], out.map['XOTA.M2']);
    // the block on the top page: a link to ota.svg over the triangle
    const top = out.pages.find((p) => p.name === 'tb_ota');
    const blk = Object.values(top.cells).find((c) => c.block === 'ota');
    assert.equal(blk.page, 'ota');
    assert.match(top.svg, new RegExp(`<a xlink:href="ota\\.svg" data-page="ota"><rect x="${blk.x}" y="${blk.y}"`));
  } finally { await closeBrowser(); }
});
