// Dummies on a page of their own (Eric 08.11, lib/dummies.js). Every schematic with dummies has two pages:
// (1) no dummy on page 1; (2) every dummy found (dummy=1, or detected) on page 2; (3) a page-2 net that is also
// a page-1 net appears as net labels of the identical name, and the LVS by name of both pages passes; (4) a net
// that only page 2 has (a rail, dummy to dummy) is wired, never joined by labels alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { parseDrawio, getPage, listPages, allCells, cellInfo, newDocument } from '../lib/model.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { mergeFingers } from '../lib/fingers.js';
import { orientSupplies } from '../lib/supply-orient.js';
import { unwrapSingleSubckt } from '../lib/unwrap-subckt.js';
import { geoLvs } from '../lib/geo-lvs.js';
import { splitDummies, drawDummiesPage, lvsTwoPages, page1NetsOf, unnamedWarnings, DUMMY_PAGE } from '../lib/dummies.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OTA = fs.readFileSync(new URL('./fixtures/dummies/ota_dum.sp', import.meta.url), 'utf8');
const DUMMIES = ['XD1', 'XD3', 'XD4', 'XD5', 'XD6'];        // XD2 is merged into XD1 (m=2, lib/fingers.js)
const prep = (text) => orientSupplies(mergeFingers(withGroundAlias(parseSpice(text)))).parsed;
const cellsOf = (m) => allCells(m).map(cellInfo);
const labels = (cs) => cs.filter((c) => c.kind === 'vertex' && /apiShape=port/.test(c.styleRaw || ''));

const PORT = 9000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
test.before(async () => {
  proc = spawn(process.execPath, [path.join(HERE, '../server.js'), '--port', String(PORT)], { stdio: 'pipe' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
test.after(() => { if (proc) proc.kill('SIGTERM'); });
const newDoc = async () => (await (await fetch(BASE + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
const imp = (id, text, engine) => fetch(`${BASE}/documents/${id}/netlist/import?engine=${engine}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
const docOf = async (id) => parseDrawio(await (await fetch(`${BASE}/documents/${id}`)).text());

test('detection: dummy=1 honoured as written, d=g=s, gate on its off rail; a MOS capacitor is not a dummy', () => {
  const s = splitDummies(prep(OTA));
  assert.deepEqual(s.dummies.map((x) => x.c.ref).sort(), DUMMIES);
  assert.equal(s.dummies.find((x) => x.c.ref === 'XD1').why, 'dummy=1');
  assert.equal(s.dummies.find((x) => x.c.ref === 'XD4').why, 'bornes sur un seul net');
  assert.match(s.dummies.find((x) => x.c.ref === 'XD3').why, /grille au rail/);
  // Eric 08.11 (corrects review r4 (2)): layout3d's ota5t, XM25 (gate on ground, drain on vtail) and XM154 (gate
  // on power, drain on von) carry no dummy=1 but are always off: dummies, on page 2, with XM1, XM67, XM139
  const cell = fs.readFileSync(new URL('./fixtures/layout3d/ota5t_cell.sp', import.meta.url), 'utf8');
  const l3 = splitDummies(orientSupplies(mergeFingers(withGroundAlias(unwrapSingleSubckt(parseSpice(cell))))).parsed);
  assert.deepEqual(l3.dummies.map((x) => x.c.ref).sort(), ['XM1', 'XM139', 'XM154', 'XM25', 'XM67']);
  for (const r of ['XM25', 'XM154']) assert.ok(!l3.main.components.some((c) => c.ref === r), r + ' not on page 1');
  // the MOS capacitor XM85 (gate on ibias, drain and source on ground) stays on page 1
  assert.ok(l3.main.components.some((c) => c.ref === 'XM85'), 'XM85 (MOS capacitor) on page 1');
  // dummy=1 alone decides: this gate is on a signal, nothing else would call it a dummy
  const flag = splitDummies(prep('M1 out in 0 0 nmos W=1u L=1u\nM2 a in 0 0 nmos W=1u L=1u dummy=1\nR1 vdd out 1k\nR2 vdd a 1k\n.end'));
  assert.deepEqual(flag.dummies.map((x) => [x.c.ref, x.why]), [['M2', 'dummy=1']]);
  const cap = splitDummies(prep('M1 out in 0 0 nmos W=1u L=1u\nM2 0 in 0 0 nmos W=1u L=1u\nR1 vdd out 1k\n.end'));
  assert.deepEqual(cap.dummies, [], 'gate on a signal, drain and source on ground: a MOS capacitor');
  // grouped by the device protected; series dummies (a net of their own) stay in one group
  assert.deepEqual(s.groups.map((g) => g.title), [
    'factices de XM1/XM2 : 2 × sg13_lv_nmos 4.375/8, grille → vss',
    'factices de XM3 : 1 × sg13_lv_pmos 2/1, grille → vdd',
    'factices de XM5/XM6 : 3 × sg13_lv_nmos 4/2, grille → vss']);
});

for (const engine of ['auto', 'v2']) {
  test(`import ${engine}: two pages, dummies on page 2 only, joined by name, local nets wired`, async () => {
    const id = await newDoc();
    const r = await imp(id, OTA, engine), body = await r.json();
    assert.equal(r.status, 201, JSON.stringify(body).slice(0, 400));
    assert.equal(body.lvs.match, true);
    assert.equal(body.dummies.lvs.match, true, JSON.stringify(body.dummies.lvs).slice(0, 400));
    assert.equal(body.dummies.count, 6);
    assert.ok(body.warnings.includes('6 factices sur la page 2'), JSON.stringify(body.warnings));
    const doc = await docOf(id);
    assert.deepEqual(listPages(doc).map((p) => p.name).slice(-1), [DUMMY_PAGE]);
    const p1 = cellsOf(getPage(doc, 0)), p2 = cellsOf(getPage(doc, DUMMY_PAGE));
    // (1) no dummy on page 1
    for (const d of [...DUMMIES, 'XD2']) assert.ok(!p1.some((c) => c.id === d || c.refdes === d), `${d} on page 1`);
    // (2) every dummy on page 2, nothing of page 1 there
    for (const d of DUMMIES) assert.ok(p2.some((c) => c.kind === 'vertex' && c.id === d), `${d} missing from page 2`);
    assert.ok(!p2.some((c) => /^XM\d$/.test(c.id)), 'a main device on page 2');
    // (3) page-1 nets as labels of the identical name: one per group and net (N4: XD1 drain and source share
    // ONE label, joined by a wire; XD5's drain, in another group, has its own)
    const lab = labels(p2).map((c) => String(c.value));
    assert.deepEqual([...new Set(lab)].sort(), ['tail', 'x']);
    assert.equal(lab.filter((v) => v === 'tail').length, 2, 'one tail label per group');
    // (4) nets local to page 2 are wired: no label named dn, XD5 and XD6 joined by wires, the page clean
    const ex = extractNetlist(getPage(doc, DUMMY_PAGE)).components;
    const node = (ref, k) => ex.find((c) => c.ref === ref).nodes[k];
    assert.equal(node('XD5', 2), node('XD6', 0), 'XD5 source and XD6 drain on one wired net');
    assert.deepEqual(geoLvs(getPage(doc, DUMMY_PAGE)).errors, []);
    // the rails of page 2 are drawn there: a ground symbol and a vdd symbol, wired
    assert.ok(p2.some((c) => /signal_ground/.test(c.styleRaw || '')));
    assert.ok(p2.some((c) => String(c.value) === 'vdd' && /signal_sources/.test(c.styleRaw || '')));
  });
}

test('POST /lvs on a document with dummies: page 1 without them, both pages with the whole netlist', async () => {
  const id = await newDoc();
  await (await imp(id, OTA, 'v2')).json();
  const lvsOf = async (text) => (await fetch(`${BASE}/documents/${id}/lvs`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text })).json();
  const ok = await lvsOf(OTA);
  assert.equal(ok.match, true, JSON.stringify(ok).slice(0, 400));
  assert.equal(ok.dummies.match, true);
  const bad = await lvsOf(OTA.replace('XD6 dn vss vss vss', 'XD6 dn vss tail vss'));
  assert.equal(bad.match, false, 'a dummy moved to another net');
});

test('re-import replaces the dummies page; a netlist without dummies still has its page 2, "Aucun factice"', async () => {
  const id = await newDoc();
  await (await imp(id, OTA, 'v2')).json();
  await (await imp(id, OTA, 'v2')).json();
  assert.equal(listPages(await docOf(id)).filter((p) => p.name === DUMMY_PAGE).length, 1);
  const id2 = await newDoc();
  const body = await (await imp(id2, 'M1 out in 0 0 nmos W=1u L=1u\nR1 vdd out 1k\n.end', 'v2')).json();
  assert.equal(body.dummies.count, 0);
  assert.ok(!(body.warnings || []).some((w) => /factices sur la page 2/.test(w)), JSON.stringify(body.warnings));
  const doc2 = await docOf(id2);
  assert.deepEqual(listPages(doc2).map((p) => p.name), [listPages(doc2)[0].name, DUMMY_PAGE]);
  const p2 = cellsOf(getPage(doc2, DUMMY_PAGE));
  assert.deepEqual(p2.filter((c) => c.kind === 'vertex').map((c) => String(c.value)), ['Aucun factice']);
});

test('the two-page LVS fails when a label is renamed or a page-2 wire is cut', async () => {
  const full = prep(OTA), s = splitDummies(full);
  const doc = newDocument();
  await drawDummiesPage(doc, s, page1NetsOf(s));
  // page 1 empty here: only page 2 is checked against the dummies part of the netlist
  const only = { ...s, main: { ...s.main, components: [] } };
  assert.equal(lvsTwoPages(doc, only, s.dummyParsed).match, true);
  const lab = labels(cellsOf(getPage(doc, DUMMY_PAGE))).find((c) => String(c.value) === 'tail');
  const el = allCells(getPage(doc, DUMMY_PAGE)).find((e) => e.getAttribute('id') === lab.id);
  el.setAttribute('value', 'tail2');
  assert.equal(lvsTwoPages(doc, only, s.dummyParsed).match, false, 'renamed label');
  el.setAttribute('value', 'tail');
  const wire = allCells(getPage(doc, DUMMY_PAGE)).find((e) => e.getAttribute('edge') === '1' && (e.getAttribute('source') === 'XD6' || e.getAttribute('target') === 'XD6'));
  wire.parentNode.removeChild(wire);
  assert.equal(lvsTwoPages(doc, only, s.dummyParsed).match, false, 'wire cut');
});

// ---- review r2 (Orchestrator 08.11): N1 names read on both pages, N2 W/L and pins on every engine,
// N3 Eric's exact MLOAD, N4 one label per net and group
const FIX = (n) => fs.readFileSync(new URL(`./fixtures/dummies/${n}.sp`, import.meta.url), 'utf8');
const ENGINES = ['auto', 'manuel', 'v2', 'v4', 'elk', 'v3', 'v1'];
// the names a reader sees on a page: labels, ports, supply symbols, and wires that carry a name
const namesOn = (m) => new Set([...(extractNetlist(m).namedNets || []),
  ...cellsOf(m).filter((c) => c.kind === 'edge' && c.value).map((c) => String(c.value))].map((n) => n.toLowerCase()));
const importDoc = async (text, engine) => {
  const id = await newDoc();
  const r = await fetch(`${BASE}/documents/${id}/netlist/import?engine=${engine}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
  return { status: r.status, body: await r.json(), doc: await docOf(id) };
};

for (const fx of ['ota_dum', 'eric_mload_dum', 'eric_mload_flat_dum', 'eric_mload_par', 'eric_mload_par_only']) {
  test(`N1 ${fx}: every name page 2 shows is shown on page 1 too, on every engine`, async () => {
    for (const engine of fx === 'ota_dum' ? ENGINES.filter((e) => e !== 'manuel') : ENGINES) {
      const { status, body, doc } = await importDoc(FIX(fx), engine);
      assert.equal(status, 201, `${engine}: ${JSON.stringify(body).slice(0, 300)}`);
      assert.equal(body.dummies.lvs.match, true, `${engine}: two-page LVS`);
      const on1 = namesOn(getPage(doc, 0));
      const on2 = [...namesOn(getPage(doc, DUMMY_PAGE))].filter((n) => n !== '0');
      assert.ok(on2.length > 0);
      for (const n of on2) assert.ok(on1.has(n), `${engine}: "${n}" is named on page 2, not on page 1 (${[...on1]})`);
    }
  });
}

test('N4 eric_mload_dum: d3 on XM6 drain and source is ONE label and a wire', async () => {
  const { doc } = await importDoc(FIX('eric_mload_dum'), 'auto');
  const p2 = getPage(doc, DUMMY_PAGE);
  assert.equal(labels(cellsOf(p2)).filter((c) => String(c.value) === 'd3').length, 1);
  const xm6 = extractNetlist(p2).components.find((c) => c.ref === 'XM6');
  assert.equal(xm6.nodes[0], xm6.nodes[2], 'XM6 drain and source wired together');
  assert.deepEqual(geoLvs(p2).errors, []);
});

for (const fx of ['eric_mload_sub', 'eric_mload_flat']) {
  test(`N2/N3 ${fx} (Eric's exact netlist): W/L ng under each name and the pins named, on every engine`, async () => {
    for (const engine of ENGINES) {
      const { status, body, doc } = await importDoc(FIX(fx), engine);
      assert.equal(status, 201, `${engine}: ${JSON.stringify(body).slice(0, 300)}`);
      assert.equal(body.lvs.match, true, engine);
      const m = getPage(doc, 0), cs = cellsOf(m);
      for (const ref of ['XM3', 'XM4']) {
        assert.ok(cs.some((c) => c.kind === 'vertex' && new RegExp(`${ref}</b><br>.*35/8 ng=8`).test(String(c.value))), `${engine}: ${ref} 35/8 ng=8`);
      }
      if (fx === 'eric_mload_sub') for (const pin of ['d3', 'o1']) assert.ok(namesOn(m).has(pin), `${engine}: pin ${pin} not named on page 1`);
      assert.equal(listPages(doc).at(-1).name, DUMMY_PAGE);
    }
  });
}

// Eric 08.11: parasitic-estimate capacitors (C ... lvs_ignore=1) go to page 2 with the dummies, never page 1
test('parasitics: an lvs_ignore=1 capacitor is split off page 1; a plain capacitor stays', () => {
  const sp = prep(FIX('eric_mload_par').replace('.end', 'C9 d3 o1 1p\n.end'));
  const s = splitDummies(sp);
  assert.deepEqual(s.parasitics.map((c) => c.ref).sort(), ['Cp1', 'Cp2', 'Cp3']);
  assert.ok(!s.main.components.some((c) => /^Cp/.test(c.ref)));
  assert.ok(s.main.components.some((c) => c.ref === 'C9'));
});

for (const fx of ['eric_mload_par', 'eric_mload_par_only']) {
  test(`parasitics ${fx}: none on page 1, all on page 2 under their heading with their value, on every engine`, async () => {
    for (const engine of ENGINES) {
      const { status, body, doc } = await importDoc(FIX(fx), engine);
      assert.equal(status, 201, `${engine}: ${JSON.stringify(body).slice(0, 300)}`);
      assert.equal(body.dummies.lvs.match, true, `${engine}: two-page LVS`);
      const c1 = cellsOf(getPage(doc, 0)), p2 = getPage(doc, DUMMY_PAGE), c2 = cellsOf(p2);
      const refs = fx === 'eric_mload_par' ? ['Cp1', 'Cp2', 'Cp3'] : ['Cp1', 'Cp2'];
      for (const r of refs) {
        assert.ok(!c1.some((c) => c.id === r || c.refdes === r), `${engine}: ${r} on page 1`);
        assert.ok(c2.some((c) => c.kind === 'vertex' && c.id === r), `${engine}: ${r} missing from page 2`);
      }
      assert.ok(c2.some((c) => /Parasites estimés \(LVS ignore\)/.test(String(c.value))), `${engine}: heading`);
      for (const v of ['12.5 fF', '8.1 fF']) assert.ok(c2.some((c) => String(c.value).includes(v)), `${engine}: value ${v}`);
      // wired on page 2: each cap's vss end on the ground rail, shared nets by one label each (N4)
      assert.deepEqual(geoLvs(p2).errors, [], engine);
      const cp1 = extractNetlist(p2).components.find((c) => c.ref === 'Cp1');
      assert.ok(cp1.nodes.includes('0'), `${engine}: Cp1 to ground on page 2 (${cp1.nodes})`);
      if (fx === 'eric_mload_par_only') {
        for (const n of ['d3', 'o1']) assert.equal(labels(c2).filter((c) => String(c.value) === n).length, 1, `${engine}: one ${n} label`);
        assert.ok(!c2.some((c) => c.id === 'NO_DUMMY'), `${engine}: "Aucun factice" with parasitics`);
      }
    }
  });
}

test('review r3: a net left unnamed on page 1 is said in the warnings, never silent', () => {
  const w = unnamedWarnings([{ net: 'd3', on: 'label' }, { net: 'o1', on: 'wire' }, { net: 'bias', on: 'none' }]);
  assert.deepEqual(w, ['net bias: not named on page 1 (no pin or dot of that net to hang its name on)']);
  assert.deepEqual(unnamedWarnings([{ net: 'd3', on: 'label' }]), []);
});
