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
  // review r4 (2): XM25 (held off, drain on vtail) and XM154 (held off, drain on von) are not dummies: on page 1,
  // each on its partner's row, outside: XM25 beside the tail XM90 (the side away from the bias), XM154 beside the
  // mirror diode XM155, away from XM156
  const row = (u, v) => Math.abs((u.y + u.h / 2) - (v.y + v.h / 2)) < 1;
  assert.ok(at('XM25') && at('XM154'), 'XM25 / XM154 missing from page 1');
  assert.ok(row(at('XM25'), t) && at('XM25').x > t.x + t.w, 'XM25 not right of the tail, on its row');
  assert.ok(row(at('XM154'), at('XM155')) && at('XM154').x + at('XM154').w < at('XM155').x, 'XM154 not left of XM155, on its row');
  assert.equal(body.dummies.count, 132, 'only the dummy=1 devices (XM1 ×48, XM67 ×54, XM139 ×30) on page 2');
});
