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
  assert.ok(r.errors?.some((w) => /source in block demarrage: VX/.test(w)), JSON.stringify(r.errors));   // blocking (review of #70)
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

// the review before Eric (Orchestrator, 2026-10-26): the figures read like the textbook ones
const vx = (m) => allCells(m).map(cellInfo).filter((c) => c.kind === 'vertex');
const byRef = (m, ref) => vx(m).find((c) => String(c.refdes || '').toUpperCase() === ref);
const plain = (v) => String(v || '').replace(/<[^>]+>/g, '').trim();

test('ota page: one out port, XMN0 the diode half of the mirror beside XMNT, ibias a port', async () => {
  const r = await importHier(fx('brokaw_tb.cir'));
  const m = getPage(r.doc, 'ota');
  const ports = vx(m).filter((c) => /apiShape=port/.test(c.styleRaw || '')).map((c) => plain(c.value));
  assert.equal(ports.filter((n) => n === 'out').length, 1, ports.join(' '));
  assert.ok(ports.includes('ibias'), ports.join(' '));
  const n0 = byRef(m, 'XMN0'), nt = byRef(m, 'XMNT');
  assert.ok(Math.abs(n0.y - nt.y) < 1, 'XMN0 level with XMNT');
  assert.ok(n0.x < nt.x, 'XMN0 left of XMNT');
  const frames = vx(m).filter((c) => /Polarisation/.test(plain(c.value)));
  assert.deepEqual(frames, [], 'no separate Polarisation frame');
});

test('bandgap page: the bias resistor XRB outside the error-amplifier frame', async () => {
  const r = await importHier(fx('brokaw_tb.cir'));
  const m = getPage(r.doc, 'bandgap');
  // the frame: the dashed box holding the title « Amplificateur d'erreur »
  const title = vx(m).find((c) => /^Amplificateur/.test(plain(c.value)));
  const amp = vx(m).find((c) => /dashed=1/.test(c.styleRaw || '') && title && title.x >= c.x && title.x <= c.x + c.w && title.y >= c.y && title.y <= c.y + c.h);
  const rb = vx(m).filter((c) => /^XRB/.test(String(c.refdes || '').toUpperCase()));
  assert.ok(amp && rb.length);
  for (const c of rb) assert.ok(c.y >= amp.y + amp.h || c.x >= amp.x + amp.w || c.x + c.w <= amp.x || c.y + c.h <= amp.y, `${c.refdes} inside the amplifier frame`);
});

test('the textbook rules give way: a circuit they cannot draw keeps the manuel drawing of before', async () => {
  const { autoPlace } = await import('../lib/auto.js');
  // a two-stage resistor-loaded amplifier with a feedback resistor between the stages (bench analoggenie/277 shape)
  const p = parseSpice('* fb\nR4 net1 VOUT1\nR3 net1 0\nR2 net4 VOUT1\nR1 VDD VOUT1\nR0 VDD net4\nM1 VOUT1 net4 0 0 NMOS\nM0 net4 VIN1 net1 0 NMOS\n.end\n');
  const w = await autoPlace(p);
  assert.equal(w.label, 'manuel');
});

// the holes of the source rule (re-review of #70, Orchestrator 2026-10-26): one test each
const inDem = (line) => fx('brokaw_tb.cir').replace('.ends demarrage', `${line}\n.ends demarrage`);
test('source rule: a VSONDE_ probe passes only at value 0', async () => {
  assert.equal((await importHier(inDem('VSONDE_1 gs ground 0'))).errors, undefined);
  assert.equal((await importHier(inDem('VSONDE_2 gs ground DC 0'))).errors, undefined);
  for (const v of ['3.3', 'DC 1.2 SIN(0 1 1k)', '0 AC 1']) {
    const r = await importHier(inDem(`VSONDE_VDD gs ground ${v}`));
    assert.ok(r.errors?.some((e) => /source in block demarrage: VSONDE_VDD/.test(e)), v);
  }
});
test('source rule: a behavioural B source is a source', async () => {
  const r = await importHier(fx('brokaw_tb.cir').replace('.ends bandgap', 'BSUP vb ground V=1.2\n.ends bandgap'));
  assert.ok(r.errors?.some((e) => /source in block bandgap: BSUP/.test(e)), JSON.stringify(r.errors));
});
test('source rule: controlled sources E G F H are sources unless macro=1', async () => {
  for (const l of ['E1 gs ground vref ground 2', 'G1 gs ground vref ground 1m', 'F1 gs ground VSONDE_1 2\nVSONDE_1 power gs 0', 'H1 gs ground VSONDE_1 1k\nVSONDE_1 power gs 0']) {
    const ref = l.split(' ')[0];
    const r = await importHier(inDem(l));
    assert.ok(r.errors?.some((e) => new RegExp(`source in block demarrage: ${ref}\\b`).test(e)), l);
  }
  const macro = fx('brokaw_tb.cir').replace(/\.subckt demarrage([^\n]*)/, '.subckt demarrage$1 macro=1').replace('.ends demarrage', 'E1 gs ground vref ground 2\n.ends demarrage');
  assert.equal((await importHier(macro)).errors, undefined);
});
test('source rule: a .subckt named like a PDK primitive is checked too', async () => {
  const t = fx('brokaw_tb.cir').replace('.subckt ota', '.subckt rppd 1 2 3\nR1 1 2 1k\nVBAD 1 3 1\n.ends rppd\n.subckt ota');
  const r = await importHier(t);
  assert.ok(r.errors?.some((e) => /source in block rppd: VBAD/.test(e)), JSON.stringify(r.errors));
});
test('a .subckt line with params: has no params pin', () => {
  const p = parseSpice('.subckt cell a b params: w=1u l=2u\nR1 a b 1k\n.ends cell\nX1 n1 0 cell\n.end\n');
  assert.deepEqual(p.subckts.CELL.pins, ['a', 'b']);
});
