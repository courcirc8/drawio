// D3 (PLAN-HIERARCHIE §3.2, 2026-10-26): when the TOP page of a hierarchical
// netlist, its amplifier block taken as an amplifier, is a circuit a flat
// drawing reads (the Brokaw bandgap of #66), that drawing replaces the block
// placer: real wires between the bipolars, the OTA triangle beside them and the
// start-up box, instead of blocks with labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importHier } from '../lib/hier.js';
import { getPage, allCells, cellInfo } from '../lib/model.js';
import { geoLvs } from '../lib/geo-lvs.js';
import { qualityGate } from '../lib/quality.js';
import { parseSpice } from '../lib/netlist.js';

const text = fs.readFileSync(new URL('./fixtures/hier-brokaw/brokaw_hier.cir', import.meta.url), 'utf8');
const cells = (m) => allCells(m).map(cellInfo);
const vert = (m, ref) => cells(m).find((c) => c.kind === 'vertex' && String(c.refdes || c.id).toUpperCase() === ref);
const cx = (c) => c.x + c.w / 2;

test('Brokaw top: drawn like the flat figure, OTA triangle and start-up box, LVS per page and global green', async () => {
  const r = await importHier(text);
  const top = r.pages.find((p) => p.name === 'top');
  assert.equal(top.engine, 'brokaw');
  // the resistor strings stay on the top (no chain_* page): the figure draws them
  assert.deepEqual(Object.keys(r.lvs.pages).sort(), ['demarrage', 'ota', 'top']);
  assert.ok(Object.values(r.lvs.pages).every(Boolean), JSON.stringify(r.lvs.pages));
  assert.equal(r.lvs.global, true, JSON.stringify(r.lvs.globalReport || {}).slice(0, 400));
  const m = getPage(r.doc, 'top');
  const geo = geoLvs(m);
  assert.equal(geo.ok, true, JSON.stringify(geo.errors.slice(0, 4)));
  const H = parseSpice(text, { blocks: true });
  const q = qualityGate(m, H);
  const fails = Object.entries(q.checks).filter(([, c]) => !c.ok).map(([k]) => k);
  assert.deepEqual(fails, [], JSON.stringify(fails));
});

test('Brokaw top: Q1 / Q2 columns, the OTA beside them, the start-up box on the left, the inputs by wires', async () => {
  const r = await importHier(text);
  const m = getPage(r.doc, 'top');
  const q1 = vert(m, 'XQ1'), q2 = vert(m, 'XQ2'), ota = vert(m, 'XOTA'), dem = vert(m, 'XDEM');
  assert.ok(q1 && q2 && ota && dem);
  assert.match(ota.styleRaw, /^triangle;/);
  assert.doesNotMatch(dem.styleRaw, /^triangle;/);
  assert.ok(Math.abs(q1.y - q2.y) < 1 && cx(q1) < cx(q2), 'Q1 / Q2 side by side, the small one left');
  assert.ok(ota.x > cx(q2), 'the OTA right of the core');
  assert.ok(dem.x + dem.w < q1.x, 'the start-up box left of the core');
  // the collectors reach the OTA inputs by wires: no port label named c1 / c2 on the top
  const labels = cells(m).filter((c) => c.kind === 'vertex' && /apiPort|port/i.test(c.styleRaw || '')).map((c) => c.value.replace(/<[^>]+>/g, '').trim());
  for (const n of ['c1', 'c2', 'o1']) assert.ok(!labels.includes(n), `${n} drawn as a label: ${labels.join(' ')}`);
  // every block still links to its page (D4)
  assert.ok(cells(m).some((c) => c.kind === 'vertex' && String(c.refdes || c.id).toUpperCase() === 'XOTA'));
});

test('a top the figure does not read keeps the block placer', async () => {
  const r = await importHier(fs.readFileSync(new URL('./fixtures/hier-rails/ota_rails.cir', import.meta.url), 'utf8'));
  assert.equal(r.pages[0].name, 'tb_ota');      // its sources, the OTA and its feedback: a testbench
  assert.equal(r.pages[0].engine, 'blocks');
});
