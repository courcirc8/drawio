// layout3d draws its cells with engine=auto: the pins of a one-.subckt deck must be named on page 1 there too.
// Before this, the auto branch returned early and skipped labelSharedOnPage1: the ota5t lost vout and ibias.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const OTA = fs.readFileSync(new URL('./fixtures/layout3d/ota5t_cell.sp', import.meta.url), 'utf8');
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

test('engine=auto: every pin of a layout3d cell is named on page 1', async () => {
  const id = (await (await fetch(BASE + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
  const r = await fetch(`${BASE}/documents/${id}/netlist/import?engine=auto`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: OTA });
  const body = await r.json();
  assert.equal(r.status, 201, JSON.stringify(body).slice(0, 300));
  assert.match(String(body.engine), /\(auto\)$/);
  assert.equal(body.dummies?.count > 0, true, 'the dummies went to page 2');
  const cells = await (await fetch(`${BASE}/documents/${id}/cells`)).json();
  const named = new Set(cells.map((c) => c.value));
  // the supplies are symbols (power/ground); every other pin is a port or a net label of its name
  for (const pin of ['vout', 'ibias', 'vinp', 'vinn', 'von', 'vtail']) assert.ok(named.has(pin), `${pin} not named on page 1`);
  // Eric 08.11: each name written once (von and vtail were printed twice)
  for (const pin of ['vout', 'ibias', 'vinp', 'vinn', 'von', 'vtail']) assert.equal(cells.filter((c) => c.value === pin).length, 1, `${pin} written more than once`);
  // Eric 08.11: the OTA template draws it (tail centred under the pair: its drain lead on the middle), its MOS capacitor XM85 beside the bias
  // diode XM88, never past the tail
  assert.match(String(body.engine), /^ota/);
  const at = (r) => cells.find((c) => c.refdes === r);
  const [a, b, t] = ['XM28', 'XM26', 'XM90'].map(at), mid = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
  assert.ok(t.x <= mid && t.x + t.w >= mid, `tail XM90 not under the pair's middle (${t.x}..${t.x + t.w} vs ${mid})`);
  assert.ok(at('XM85').x < at('XM88').x, 'XM85 not on the outer side of the bias diode');
  // review r4 (3): every pin a PORT symbol, as vinp / vinn (Cadence's pins), not an italic label or a wire text
  for (const pin of ['vout', 'ibias', 'vinp', 'vinn', 'von', 'vtail']) {
    const c = cells.find((x) => x.value === pin);
    assert.equal(c.kind, 'vertex', `${pin} printed on a wire, not a port`);
    assert.match(String(c.style), /shape=(single|double)Arrow;.*apiShape=port/, `${pin} not a port arrow`);
  }
  assert.match(String(cells.find((x) => x.value === 'ibias').style), /portDirection=input/, 'the bias current enters');
  assert.deepEqual((body.pinLabels || []).filter((l) => l.on !== 'port').map((l) => l.net), []);
  // Eric 08.11 (corrects review r4 (2)): XM25 (always off, drain on vtail) and XM154 (always off, drain on von) are
  // dummies: page 2, with the dummy=1 ones (XM1 ×48, XM67 ×54, XM139 ×30, XM25 ×2, XM154 ×2)
  assert.ok(!at('XM25') && !at('XM154'), 'XM25 / XM154 on page 1');
  assert.equal(body.dummies.count, 136);
});

// Eric 08.11: "no pins added, just name the net": the PORTS drawn are exactly the .subckt's pins (supplies drawn as
// their symbols); an internal net (vtail, von: not pins here) gets a plain net label, on both pages
const PINS = fs.readFileSync(new URL('./fixtures/layout3d/ota5t_cell_pins.sp', import.meta.url), 'utf8');
test('engine=auto: the ports drawn are the .subckt pins, an internal net only a name (both pages)', async () => {
  const id = (await (await fetch(BASE + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
  const r = await fetch(`${BASE}/documents/${id}/netlist/import?engine=auto`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: PINS });
  const body = await r.json();
  assert.equal(r.status, 201, JSON.stringify(body).slice(0, 300));
  const pins = PINS.match(/^\.subckt\s+\S+\s+(.*)$/m)[1].trim().split(/\s+/).filter((n) => !/^(power|ground)_/.test(n));
  const arrows = (cs) => cs.filter((c) => /apiShape=port/.test(String(c.style)) && /shape=(single|double)Arrow/.test(String(c.style))).map((c) => c.value);
  const p1 = await (await fetch(`${BASE}/documents/${id}/cells`)).json();
  assert.deepEqual(arrows(p1).sort(), [...pins].sort(), 'page 1: one port per .subckt pin, no other');
  for (const n of ['vtail', 'von']) {
    const c = p1.filter((x) => x.value === n);
    assert.equal(c.length, 1, `${n} named once on page 1`);
    assert.doesNotMatch(String(c[0].style), /Arrow/, `${n} is a net label, not a port arrow`);
  }
  const p2 = await (await fetch(`${BASE}/documents/${id}/cells?page=factices`)).json();
  assert.deepEqual(arrows(p2), [], 'page 2: no port arrow');
  for (const r2 of ['XM25', 'XM154']) assert.ok(p2.some((c) => c.refdes === r2), `${r2} on page 2`);
  for (const n of ['vtail', 'von']) assert.ok(p2.some((c) => c.kind === 'vertex' && c.value === n && !/Arrow/.test(String(c.style))), `${n}: a label on page 2`);
  assert.equal(body.dummies.count, 136);
});
