// REVIEW r2: the supply order (Eric 08.11: positive rail on top) is checked on the finished drawing of EVERY engine,
// and a break is said in the import response (`supply.warnings`), never silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const MILLER = fs.readFileSync(new URL('./fixtures/tail-axis/ota_miller.sp', import.meta.url), 'utf8');
const CONFLICT = 'M1 out in vss vss pmos W=2u L=1u\nM2 out in2 vdd vdd nmos W=1u L=1u\n.end';
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
const imp = async (text, engine) => {
  const id = (await (await fetch(BASE + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
  const r = await fetch(`${BASE}/documents/${id}/netlist/import?engine=${engine}&force=1`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
  return r.json();
};
const order = (b) => (b.supply?.warnings || []).filter((w) => /^supply order:/.test(w));

// v1, elk and v3 draw this Miller OTA with PMOS under NMOS: said; v2 and auto keep the order: nothing said
for (const [engine, broken] of [['v1', true], ['elk', true], ['v3', true], ['v2', false], ['auto', false]]) {
  test(`engine ${engine}: the supply order is checked on the drawing`, async () => {
    const b = await imp(MILLER, engine);
    assert.equal(order(b).length > 0, broken, JSON.stringify(b.supply));
  });
}
test('engine auto: a drawing that still breaks the order is said', async () => {
  const b = await imp(CONFLICT, 'auto');
  assert.ok(order(b).length > 0, JSON.stringify(b.supply));
});
// REVIEW r3 (A7c): the ?optimize=N path says the supply order too
test('?optimize=2: a drawing that breaks the order is said', async () => {
  const id = (await (await fetch(BASE + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
  const r = await fetch(`${BASE}/documents/${id}/netlist/import?optimize=2&force=1`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: CONFLICT });
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b).slice(0, 300));
  assert.match(String(b.engine), /optimize/);
  assert.ok(order(b).length > 0, JSON.stringify(b.supply));
});
