// Tabs per level (Eric, 2026-10-26): the hierarchical Brokaw bench exports one drawio page per cell, named like
// the cell, in hierarchy order; the per-page API gives each page's order, parent and depth, and the block links;
// the HTML viewer shows one tab per page. The testbench page draws the classic bench with wires.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importHier } from '../lib/hier.js';
import { hierPages, hierViewerHtml } from '../lib/hier-export.js';
import { getPage, allCells, cellInfo } from '../lib/model.js';
import { findChrome, closeBrowser } from '../lib/render.js';

const text = fs.readFileSync(new URL('./fixtures/hier-brokaw/brokaw_tb.cir', import.meta.url), 'utf8');

test('Brokaw bench: 4 drawio pages named like the cells, in hierarchy order, with parents', { skip: findChrome() ? false : 'no Chromium' }, async () => {
  try {
  const r = await importHier(text);
  const names = Array.from(r.doc.getElementsByTagName('diagram')).map((d) => d.getAttribute('name'));
  assert.deepEqual(names, ['tb_bandgap', 'bandgap', 'ota', 'demarrage']);
  const hp = await hierPages(r.doc, r.map);
  const rel = hp.pages.map((p) => [p.name, p.order, p.parent, p.depth]);
  assert.deepEqual(rel, [['tb_bandgap', 0, null, 0], ['bandgap', 1, 'tb_bandgap', 1], ['ota', 2, 'bandgap', 2], ['demarrage', 3, 'bandgap', 2]]);
  assert.deepEqual(hp.pages[1].children.sort(), ['demarrage', 'ota']);
  // the block boxes link to their pages (D4)
  const links = Object.values(hp.pages[1].cells).filter((c) => c.block).map((c) => c.page).sort();
  assert.deepEqual(links, ['demarrage', 'ota']);
  const html = hierViewerHtml(hp);
  for (const n of names) assert.match(html, new RegExp(`data-tab="${n}"`));
  } finally { await closeBrowser(); }
});

test('Brokaw bench: each page SVG is cropped to its drawing (sized, viewBox), not stretched over the viewer', { skip: findChrome() ? false : 'no Chromium' }, async () => {
  try {
    const hp = await hierPages((await importHier(text)).doc);
    for (const P of hp.pages) {
      const root = P.svg.match(/<svg\b[^>]*>/)[0];
      const m = root.match(/width="([\d.]+)" height="([\d.]+)" viewBox="0 0 ([\d.]+) ([\d.]+)"/);
      assert.ok(m && m[1] === m[3] && m[2] === m[4], `${P.name}: ${root}`);
      assert.doesNotMatch(root, /[\s;"]width:\s*100%/, P.name);
    }
    // the bench is small: far narrower than the bandgap page
    const w = (n) => +hp.pages.find((P) => P.name === n).svg.match(/width="([\d.]+)"/)[1];
    assert.ok(w('tb_bandgap') < w('bandgap') / 2, `${w('tb_bandgap')} vs ${w('bandgap')}`);
  } finally { await closeBrowser(); }
});

test('Brokaw bench: the testbench page is the classic bench, wired, its pins named on the block', async () => {
  const r = await importHier(text);
  const P = r.pages.find((p) => p.name === 'tb_bandgap');
  assert.equal(P.engine, 'testbench');
  assert.equal(P.lvs, true);
  assert.equal(r.lvs.global, true);
  const cells = allCells(getPage(r.doc)).map(cellInfo);
  const v = (ref) => cells.find((c) => c.kind === 'vertex' && String(c.refdes || '').toUpperCase() === ref);
  const src = v('VDD'), blk = v('XBG'), cl = v('CL');
  assert.ok(src.x + src.w < blk.x, 'the supply source left of the block');
  assert.ok(cl.x > blk.x + blk.w, 'the load right of the block');
  // no net label: power and vref are wires (one output arrow for vref)
  const labels = cells.filter((c) => /apiShape=port/.test(c.styleRaw || '') && /fontStyle=2/.test(c.styleRaw || ''));
  assert.deepEqual(labels.map((c) => c.value), []);
  const texts = cells.map((c) => String(c.value || ''));
  for (const n of ['power', 'ground', 'vref']) assert.ok(texts.includes(n), `pin name ${n} on the block`);
});

test('viewer: the breadcrumb is built with DOM nodes, never innerHTML (page names come from the netlist)', () => {
  const html = hierViewerHtml({ pages: [{ name: 'a"><img src=x onerror=alert(1)>', svg: '<svg/>', parent: null, depth: 0 }] });
  assert.doesNotMatch(html, /innerHTML/);
  assert.doesNotMatch(html, /<img src=x/);
});
