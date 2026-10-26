// Review of drawio#70 (Orchestrator, 2026-10-26): the viewer route is a top-level route (served right after a
// ?hier=1 import, the router never grows), a V/I source inside a block .subckt fails the import (Eric's rule,
// blocking, ?force=1 or not; VSONDE_* probes and macro=1 .subckt excepted), and a cell name with XML
// characters imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../lib/render.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const TB = fs.readFileSync(new URL('./fixtures/hier-brokaw/brokaw_tb.cir', import.meta.url), 'utf8');
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

const doc = async () => (await (await fetch(BASE + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
const hier = (id, text, q = '') => fetch(`${BASE}/documents/${id}/netlist/import?hier=1${q}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });

test('viewer.html: served right after a ?hier=1 import, with a CSP; /hier/pages does not add routes', { skip: findChrome() ? false : 'no Chromium' }, async () => {
  const id = await doc();
  assert.equal((await hier(id, TB)).status, 201);
  const v = await fetch(`${BASE}/documents/${id}/hier/viewer.html`);
  assert.equal(v.status, 200);
  assert.match(v.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.match(await v.text(), /data-tab="tb_bandgap"/);
  for (let i = 0; i < 2; i++) assert.equal((await fetch(`${BASE}/documents/${id}/hier/pages`)).status, 200);
  assert.equal((await fetch(`${BASE}/documents/${id}/hier/viewer.html`)).status, 200);
});

test('a V/I source inside a block .subckt fails the import, even with ?force=1', async () => {
  const bad = TB.replace('.ends demarrage', 'VX gs ground 0\n.ends demarrage');
  for (const q of ['', '&force=1']) {
    const r = await hier(await doc(), bad, q);
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /source in block demarrage: VX/);
  }
});

test('the exceptions: a VSONDE_ probe, a .subckt marked macro=1', async () => {
  assert.equal((await hier(await doc(), TB.replace('.ends demarrage', 'VSONDE_1 gs ground 0\n.ends demarrage'))).status, 201);
  const macro = TB.replace(/\.subckt demarrage([^\n]*)/, '.subckt demarrage$1 macro=1').replace('.ends demarrage', 'VX gs ground 0\n.ends demarrage');
  assert.equal((await hier(await doc(), macro)).status, 201);
});

test('a cell name with XML characters imports (the tb_ page name escaped)', async () => {
  const t = TB.replace(/\bbandgap\b/g, 'band"gap&x');
  const r = await hier(await doc(), t);
  const j = await r.json();
  assert.equal(r.status, 201, JSON.stringify(j).slice(0, 300));
  assert.equal(j.pages[0].name, 'tb_band"gap&x');
});

test('a refused import (source rule or LVS) never replaces the document', async () => {
  const id = await doc();
  assert.equal((await hier(id, TB)).status, 201);
  const before = await (await fetch(`${BASE}/documents/${id}`)).text();
  assert.equal((await hier(id, TB.replace('.ends demarrage', 'VX gs ground 0\n.ends demarrage'))).status, 422);
  const after = await (await fetch(`${BASE}/documents/${id}`)).text();
  assert.equal(after, before);
  assert.doesNotMatch(after, /\bVX\b/);
});
