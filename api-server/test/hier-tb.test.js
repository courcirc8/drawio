// Eric's correction (Orchestrator, 2026-10-26): a block page never carries a
// voltage or current source. The levels are drawn as: testbench page
// tb_<bloc> (sources, the DUT as one block) -> DUT page -> moderate sub-block
// pages. PDK primitive cells never become pages; resistor strings and banks
// stay on their parent page unless large. The Brokaw target: tb + bandgap +
// ota (complete, two stages) + demarrage, four pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importHier } from '../lib/hier.js';
import { getPage, allCells, cellInfo } from '../lib/model.js';
import { geoLvs } from '../lib/geo-lvs.js';
import { qualityGate } from '../lib/quality.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';

const fx = (f) => fs.readFileSync(new URL(`./fixtures/hier-brokaw/${f}`, import.meta.url), 'utf8');
const refs = (m) => extractNetlist(m).components.map((c) => String(c.ref).toUpperCase());

test('Brokaw testbench: four pages tb_bandgap, bandgap, ota, demarrage; LVS per page and global green', async () => {
  const r = await importHier(fx('brokaw_tb.cir'));
  assert.deepEqual(r.pages.map((p) => p.name), ['tb_bandgap', 'bandgap', 'ota', 'demarrage']);
  assert.equal(r.pages[0].kind, 'testbench');
  assert.ok(Object.values(r.lvs.pages).every(Boolean), JSON.stringify(r.lvs.pages));
  assert.equal(r.lvs.global, true, JSON.stringify(r.lvs.globalReport || {}).slice(0, 400));
  assert.ok(!r.lvs.warnings?.some((w) => /source/.test(w)), JSON.stringify(r.lvs.warnings));
});

test('the sources only on the testbench page; the DUT there is one block', async () => {
  const r = await importHier(fx('brokaw_tb.cir'));
  const tb = refs(getPage(r.doc, 'tb_bandgap'));
  assert.ok(tb.includes('VDD') && tb.includes('XBG'), tb.join(' '));
  for (const p of ['bandgap', 'ota', 'demarrage']) assert.ok(!refs(getPage(r.doc, p)).some((x) => /^[VI]/.test(x)), p);
});

test('the bandgap page is the Brokaw figure: the complete OTA a triangle, its output on vref, no Sortie frame', async () => {
  const r = await importHier(fx('brokaw_tb.cir'));
  const P = r.pages.find((p) => p.name === 'bandgap');
  assert.equal(P.engine, 'brokaw');
  const m = getPage(r.doc, 'bandgap');
  assert.equal(geoLvs(m).ok, true, JSON.stringify(geoLvs(m).errors.slice(0, 4)));
  const texts = allCells(m).map(cellInfo).map((c) => String(c.value || '').replace(/<[^>]+>/g, ''));
  assert.ok(!texts.includes('Sortie'), 'no output frame: MP, Cc and Rz are inside the OTA');
  const ota = refs(getPage(r.doc, 'ota'));
  for (const x of ['XMP', 'XCC', 'XRZ']) assert.ok(ota.includes(x), `${x} on the ota page`);
});

test('a source on a block page fails the quality gate (block pages only)', async () => {
  const text = fx('brokaw_tb.cir').replace('.ends demarrage', 'VX gs ground 0\n.ends demarrage');
  const r = await importHier(text);
  assert.ok(r.lvs.warnings?.some((w) => /source.*demarrage/.test(w)), JSON.stringify(r.lvs.warnings));
  const m = getPage(r.doc, 'demarrage');
  const q = qualityGate(m, { components: [{ ref: 'VX', prefix: 'V', nodes: ['gs', 'ground'] }] }, { block: true });
  assert.equal(q.checks.sources?.ok, false);
  const qt = qualityGate(getPage(r.doc, 'tb_bandgap'), parseSpice('VDD vdd 0 3.3\n.end'), { block: false });
  assert.notEqual(qt.checks.sources?.ok, false);
});

test('no page for PDK primitives nor for short resistor strings', async () => {
  // the older flat-top netlist (sources and circuit on one page) drew 8 pages with the chains
  const old = await importHier(fx('brokaw_hier.cir'), { figure: false });
  assert.ok(!old.pages.some((p) => /^chain_/.test(p.name)), old.pages.map((p) => p.name).join(' '));
  // a .subckt named like an IHP primitive is a primitive, never a page
  const t = fx('brokaw_tb.cir').replace('.subckt ota', '.subckt rhigh 1 2 3\nR1 1 2 1k\n.ends rhigh\n.subckt ota');
  const r = await importHier(t);
  assert.ok(!r.pages.some((p) => /^rhigh$/i.test(p.name)), r.pages.map((p) => p.name).join(' '));
});

test('a top with sources and circuit together: drawn, warned (write the DUT as a .subckt)', async () => {
  const r = await importHier(fx('brokaw_hier.cir'));
  assert.ok(r.lvs.warnings?.some((w) => /source.*top/.test(w)), JSON.stringify(r.lvs.warnings));
});
