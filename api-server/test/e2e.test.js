/**
 * End-to-end test: boots the HTTP server on an ephemeral port and drives the
 * full scenario — netlist import, routing, extraction, LVS, ERC, BOM, PNG
 * export (skipped when no Chromium is available).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const HAS_CHROME = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium', '/usr/bin/google-chrome', process.env.CHROME_PATH]
  .filter(Boolean).some((p) => fs.existsSync(p));

const RC = 'V1 in 0 DC 5\nR1 in out 10k\nC1 out 0 100n\n.end\n';

let proc;

test.before(async () => {
  // T5: this host has no `node` binary (bun-only environment) — spawn under
  // whatever runtime is executing the test itself instead of hardcoding a
  // name that may not exist on PATH.
  proc = spawn(process.execPath, [path.join(HERE, '../server.js'), '--port', String(PORT)], { stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

test.after(() => { if (proc) proc.kill('SIGTERM'); });

test('e2e: import -> route -> netlist -> lvs -> erc -> bom', async () => {
  const created = await (await fetch(BASE + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const id = created.id;
  const imp = await (await fetch(`${BASE}/documents/${id}/netlist/import`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: RC })).json();
  assert.deepEqual(imp.components, ['V1', 'R1', 'C1']);
  assert.ok(imp.routed >= 4);
  const lvs = await (await fetch(`${BASE}/documents/${id}/lvs`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: RC })).json();
  assert.equal(lvs.match, true, JSON.stringify(lvs));
  const erc = await (await fetch(`${BASE}/documents/${id}/erc`)).json();
  assert.equal(erc.errors, 0);
  const bom = await (await fetch(`${BASE}/documents/${id}/bom`)).json();
  assert.equal(bom.length, 3);
  // edit + checkpoint round-trip
  await fetch(`${BASE}/documents/${id}/checkpoints`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"cp"}' });
  const patched = await (await fetch(`${BASE}/documents/${id}/cells/R1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"rotation":90,"dx":30}' })).json();
  assert.equal(patched.rotation, 90);
  await fetch(`${BASE}/documents/${id}/checkpoints/cp/restore`, { method: 'POST' });
  const cells = await (await fetch(`${BASE}/documents/${id}/cells`)).json();
  assert.equal(cells.find((c) => c.id === 'R1').rotation, 0);
});

// Runtime-agnostic skip: node:test honours the `{skip: ...}` option object, but
// bun's test runner does not -- under bun the test RAN and failed with a 500
// ("no Chromium/Chrome found"), which looks like a regression instead of an
// absent dependency. Returning early works on both runners.
test('e2e: png export via headless chromium', async () => {
  if (!HAS_CHROME) { console.log('  skipped: no chromium found'); return; }
  const created = await (await fetch(BASE + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  await fetch(`${BASE}/documents/${created.id}/netlist/import`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: RC });
  const res = await fetch(`${BASE}/documents/${created.id}/export?format=png&scale=2`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type').split(';')[0], 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 5000, 'png too small: ' + buf.length);
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
});
