// Orchestrator decision 08.11 on DIFFCC (Layout3D, against drawio-prod a68a522): XM1 (tail vdd vdd vdd, always off)
// goes to page 2 and takes with it every page-1 print of vdd; the import was refused ("named on page 2, not on
// page 1: vdd"), with or without dummy=1.
//  (a) a SUPPLY net is global: missing from page 1 is never an error, the rail on page 2 is enough
//  (b) a .subckt pin (not a supply) that page 1 does not draw is still a real pin: its port on page 1
//  (c) an internal net named only on page 2 is still refused (422)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSpice } from '../lib/netlist.js';
import { parseDrawio, getPage, allCells, cellInfo } from '../lib/model.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { mergeFingers } from '../lib/fingers.js';
import { orientSupplies } from '../lib/supply-orient.js';
import { unwrapSingleSubckt } from '../lib/unwrap-subckt.js';
import { splitDummies, labelSharedOnPage1, supplyNetsOf } from '../lib/dummies.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(new URL(`./fixtures/dummies/${n}.sp`, import.meta.url), 'utf8');
const start = async (env) => {
  const port = 9000 + Math.floor(Math.random() * 900), base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(HERE, '../server.js'), '--port', String(port)], { stdio: 'pipe', env: { ...process.env, ...env } });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) return { proc, base }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGTERM'); throw new Error('server did not start');
};
const imp = async (base, text, query) => {
  const id = (await (await fetch(base + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
  const r = await fetch(`${base}/documents/${id}/netlist/import?${query}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
  const body = await r.json();
  const cells = r.status < 300 ? await (await fetch(`${base}/documents/${id}/cells`)).json() : [];
  const cells2 = r.status < 300 ? await (await fetch(`${base}/documents/${id}/cells?page=factices`)).json() : [];
  return { status: r.status, body, cells, cells2, id };
};
const ports = (cs) => cs.filter((c) => c.kind === 'vertex' && /apiShape=port/.test(String(c.style)) && /Arrow/.test(String(c.style))).map((c) => c.value).sort();

test('(a) DIFFCC: vdd only on page 2 (and the pair\'s bulks) is no error, on every engine, with or without dummy=1', async () => {
  const { proc, base } = await start({});
  try {
    for (const f of ['diffcc', 'diffcc_dum']) for (const eng of ['auto', 'v2', 'v4']) {
      const r = await imp(base, fx(f), `engine=${eng}`);
      assert.equal(r.status, 201, `${f} ${eng}: ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.equal(r.body.dummies?.lvs?.match, true, `${f} ${eng}: both pages LVS-clean`);
      assert.deepEqual(r.body.dummies?.lvs?.unnamed || [], []);
      assert.ok(!JSON.stringify(r.body.warnings || []).includes('vdd'), `${f} ${eng}: no warning on vdd: ${JSON.stringify(r.body.warnings)}`);
      assert.ok(r.cells2.some((c) => c.refdes === 'XM1'), `${f} ${eng}: XM1 on page 2`);
      assert.ok(r.cells2.some((c) => c.kind === 'vertex' && c.value === 'vdd'), `${f} ${eng}: the vdd rail on page 2`);
    }
  } finally { proc.kill('SIGTERM'); }
});

test('(b) a .subckt pin only a dummy uses (vbd): its port on page 1, its label on page 2; no supply port', async () => {
  const { proc, base } = await start({});
  try {
    const text = fx('diffcc_pin'), pins = text.match(/^\.subckt\s+\S+\s+(.*)$/m)[1].trim().split(/\s+/);
    for (const eng of ['auto', 'v2']) {
      const r = await imp(base, text, `engine=${eng}`);
      assert.equal(r.status, 201, `${eng}: ${JSON.stringify(r.body).slice(0, 300)}`);
      // every pin but the supply is a port, and nothing else is: vbd included, though no page-1 device uses it
      assert.deepEqual(ports(r.cells), pins.filter((n) => n !== 'vdd').sort(), eng);
      assert.ok(r.cells2.some((c) => c.kind === 'vertex' && c.value === 'vbd' && !/Arrow/.test(String(c.style))), `${eng}: vbd labelled on page 2`);
      assert.deepEqual(ports(r.cells2), [], `${eng}: no port arrow on page 2`);
      assert.equal(r.body.dummies?.lvs?.match, true, eng);
      assert.ok(!JSON.stringify(r.body.warnings || []).match(/vdd|vbd/), `${eng}: ${JSON.stringify(r.body.warnings)}`);
    }
  } finally { proc.kill('SIGTERM'); }
});

test('(c) an internal net (tail) named on page 2 and erased from page 1: still 422, said with force=1', async () => {
  const { proc, base } = await start({ DRAWIO_TEST_FAULT: 'page1-name' });
  try {
    const no = await imp(base, fx('diffcc'), 'engine=v2');
    assert.equal(no.status, 422, JSON.stringify(no.body).slice(0, 300));
    assert.match(JSON.stringify(no.body), /named on page 2, not on page 1: tail/);
    const yes = await imp(base, fx('diffcc'), 'engine=v2&force=1');
    assert.equal(yes.status, 201);
    assert.deepEqual(yes.body.dummies?.lvs?.unnamed, ['tail']);
  } finally { proc.kill('SIGTERM'); }
});

// ---- review #81 (Orchestrator 08.11)
const splitOf = (text) => splitDummies(orientSupplies(mergeFingers(withGroundAlias(unwrapSingleSubckt(parseSpice(text))))).parsed);
const warned = (r, net) => (r.body.warnings || []).some((w) => w.startsWith(`net ${net}: not named on page 1`));

test('#81 (6) a supply by its devices only (vp, bulk of the pair, no supply name): global as vdd', async () => {
  assert.equal(supplyNetsOf(splitOf(fx('diffcc_bulk')))('vp'), true, 'vp a supply by the vote of page 1');
  const { proc, base } = await start({});
  try {
    for (const eng of ['auto', 'v2', 'v4']) {
      const r = await imp(base, fx('diffcc_bulk'), `engine=${eng}`);
      assert.equal(r.status, 201, `${eng}: ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.equal(r.body.dummies?.lvs?.match, true, eng);
      assert.ok(!JSON.stringify(r.body.warnings || []).includes('vp'), `${eng}: ${JSON.stringify(r.body.warnings)}`);
      assert.ok(r.cells2.some((c) => c.refdes === 'XM1'), `${eng}: XM1 on page 2`);
    }
  } finally { proc.kill('SIGTERM'); }
});

test('#81 (2) mid on a dummy\'s bulk and drain is no supply: labelled on both pages; erased from page 1, a 422', async () => {
  const split = splitOf(fx('mid_dum'));
  assert.equal(supplyNetsOf(split)('mid'), false, 'a dummy\'s bulk never votes');
  assert.equal(supplyNetsOf(split)('vdd'), true, 'vdd, only on the dummy: a supply by its name');
  const ok = await start({});
  try {
    for (const eng of ['auto', 'v2', 'v4']) {
      const r = await imp(ok.base, fx('mid_dum'), `engine=${eng}`);
      assert.equal(r.status, 201, `${eng}: ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.equal(r.body.dummies?.lvs?.match, true, eng);
      const mid = r.cells2.filter((c) => c.kind === 'vertex' && c.value === 'mid');
      assert.ok(mid.length && mid.every((c) => !/signal_sources/.test(String(c.style))), `${eng}: mid a label on page 2, not a rail`);
    }
  } finally { ok.proc.kill('SIGTERM'); }
  const bad = await start({ DRAWIO_TEST_FAULT: 'page1-name' });
  try {
    const no = await imp(bad.base, fx('mid_dum'), 'engine=v2');
    assert.equal(no.status, 422);
    assert.match(JSON.stringify(no.body), /named on page 2, not on page 1: mid/);
  } finally { bad.proc.kill('SIGTERM'); }
});

test('#81 (1) no dummy: a supply pin page 1 does not name (vdd, bulk only) keeps its warning, no port', async () => {
  const { proc, base } = await start({});
  try {
    for (const eng of ['auto', 'v2']) {
      const r = await imp(base, fx('pair_nodum'), `engine=${eng}`);
      assert.equal(r.status, 201, `${eng}: ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.ok(warned(r, 'vdd'), `${eng}: the vdd warning stays: ${JSON.stringify(r.body.warnings)}`);
      assert.ok(!ports(r.cells).includes('vdd'), `${eng}: no supply port`);
    }
  } finally { proc.kill('SIGTERM'); }
});

test('#81 (3) (b) is for pins page 1 does not use: vbody (bulk on page 1) no port, a warning; vbd its port', async () => {
  const { proc, base } = await start({});
  try {
    for (const eng of ['auto', 'v2']) {
      const r = await imp(base, fx('bodypin'), `engine=${eng}`);
      assert.equal(r.status, 201, `${eng}: ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.ok(!ports(r.cells).includes('vbody'), `${eng}: no port for vbody`);
      assert.ok(warned(r, 'vbody'), `${eng}: ${JSON.stringify(r.body.warnings)}`);
      assert.ok(ports(r.cells).includes('vbd'), `${eng}: vbd's port`);
    }
  } finally { proc.kill('SIGTERM'); }
});

test('#81 (3) a standalone port only for a .subckt pin (opts.port): never for a page-2 name', async () => {
  // page 1 of diffcc (no pin), the split of diffcc_pin (vbd a pin only XD1 uses)
  const split = splitOf(fx('diffcc_pin'));
  const { proc, base } = await start({});
  try {
    const r = await imp(base, fx('diffcc'), 'engine=v2');
    assert.equal(r.status, 201);
    const xml = await (await fetch(`${base}/documents/${r.id}`)).text();
    const portCount = (m) => allCells(m).map(cellInfo).filter((c) => c.kind === 'vertex' && /apiShape=port/.test(c.styleRaw || '') && c.value === 'vbd').length;
    let doc = parseDrawio(xml);
    assert.deepEqual(labelSharedOnPage1(doc, split, ['vbd'], getPage(doc, 0)).map((l) => l.on), ['none'], 'a page-2 name: no port');
    assert.equal(portCount(getPage(doc, 0)), 0);
    doc = parseDrawio(xml);
    assert.deepEqual(labelSharedOnPage1(doc, split, ['vbd'], getPage(doc, 0), { port: true }).map((l) => l.on), ['port'], 'a pin: its port');
    assert.equal(portCount(getPage(doc, 0)), 1);
  } finally { proc.kill('SIGTERM'); }
});
