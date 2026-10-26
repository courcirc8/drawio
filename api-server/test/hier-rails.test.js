// D1 (PLAN-HIERARCHIE, boucles-analog, 2026-10-26): the rails of the
// analog-design convention, power_<dom> / ground_<dom> (or bare power / ground),
// are supplies and grounds like vdd / vss: block pins on top / bottom, rail
// symbols on the pages, the global LVS bound through them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importHier } from '../lib/hier.js';
import { extractNetlist } from '../lib/netlist.js';
import { getPage, allCells, cellInfo } from '../lib/model.js';
import { SUPPLY_NAME, GROUND_NAME, groundAlias } from '../lib/ground-alias.js';
import { SUPPLY } from '../lib/manuel-reading.js';

const text = fs.readFileSync(new URL('./fixtures/hier-rails/ota_rails.cir', import.meta.url), 'utf8');
const blockPins = (m, ref) => {
  const b = allCells(m).map(cellInfo).find((c) => /apiBlock/.test(c.styleRaw || '') && String(c.refdes || c.id).toUpperCase() === ref);
  return Object.fromEntries((b.style.map.get('apiBlockPins') || '').split('|').map((t) => { const [n, xy] = t.split('@'); const [x, y] = xy.split(',').map(Number); return [decodeURIComponent(n), { x, y }]; }));
};

test('power_<dom> / ground_<dom> pins: on top and bottom of the block, LVS per page and global green', async () => {
  const r = await importHier(text, { symbols: { ota: 'box' } });   // the box (the triangle: hier-symbols.test.js)
  assert.deepEqual(r.lvs.pages, { top: true, ota: true });
  assert.equal(r.lvs.global, true, JSON.stringify(r.lvs.globalReport || {}).slice(0, 400));
  const p = blockPins(getPage(r.doc, 'top'), 'XOTA');
  assert.equal(p.power_ana.y, 0, 'power_ana on the top side');
  assert.equal(p.ground_ana.y, 1, 'ground_ana on the bottom side');
  assert.equal(p.inp.x, 0); assert.equal(p.out.x, 1);
});

test('the block page draws power_ana as a named supply and ground_ana as the ground', async () => {
  const r = await importHier(text);
  const nets = new Set(extractNetlist(getPage(r.doc, 'ota')).components.flatMap((c) => c.nodes.map(String)));
  assert.ok(nets.has('power_ana'), [...nets].join(' '));
  assert.ok(nets.has('0'), 'ground_ana as the ground symbol');
});

test('rail names: power / ground with or without a domain; two ground domains are never merged', () => {
  for (const n of ['power', 'power_ana', 'POWER_dig']) { assert.ok(SUPPLY_NAME.test(n), n); assert.ok(SUPPLY.test(n), n); }
  for (const n of ['ground', 'ground_ana']) assert.ok(GROUND_NAME.test(n), n);
  for (const n of ['powerx', 'groundplane', 'pwr_ana']) assert.ok(!SUPPLY_NAME.test(n) && !GROUND_NAME.test(n), n);
  assert.equal(groundAlias(['ground_ana', 'x']), 'ground_ana');
  assert.equal(groundAlias(['ground_ana', 'ground_dig']), null);
});

// Orchestrator batch item 3 (2026-10-26): power_down, power_good, ground_sense...
// are signals, not rails; a ground_<dom> drawn as the ground keeps its domain
// name visible next to the symbol (the extracted net stays `0`).
test('rail names: obvious signals (power_down, power_good, power_on, ground_sense) are not rails', () => {
  for (const n of ['power_down', 'POWER_GOOD', 'power_on', 'power_en_n', 'power_ok', 'ground_sense', 'ground_sns'])
    assert.ok(!SUPPLY_NAME.test(n) && !GROUND_NAME.test(n) && !SUPPLY.test(n), n);
  assert.ok(SUPPLY_NAME.test('power_vdd1') && GROUND_NAME.test('ground_dig'));
  assert.equal(groundAlias(['ground_sense', 'x']), null);
});

test('a block pin power_down stays a signal port of the block page, not a supply', async () => {
  const t = text.replace('.subckt ota inp', '.subckt ota power_down inp').replace('.ends ota', 'RPD power_down ground_ana 1meg\n.ends ota')
    .replace('XOTA vin', 'XOTA pd vin').replace(/\.end\s*$/, 'RPDT pd 0 10k\n.end\n');
  const r = await importHier(t, { symbols: { ota: 'box' } });
  const p = blockPins(getPage(r.doc, 'top'), 'XOTA');
  assert.ok(p.power_down, Object.keys(p).join(' '));
  assert.ok(p.power_down.y !== 0, 'power_down is not on the supply side');
});

test('ground_ana drawn as the ground keeps its domain name visible', async () => {
  const r = await importHier(text);
  const m = getPage(r.doc, 'ota');
  const g = allCells(m).map(cellInfo).filter((c) => /signal_ground/.test(c.styleRaw || ''));
  assert.ok(g.length >= 1);
  for (const c of g) assert.match(String(c.value || '').replace(/<[^>]+>/g, ''), /ground_ana/);
  const nets = new Set(extractNetlist(m).components.flatMap((c) => c.nodes.map(String)));
  assert.ok(nets.has('0') && !nets.has('ground_ana'), [...nets].join(' '));
});
