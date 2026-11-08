// REVIEW r3 (B1): when v4 draws in blocks its name labels are B<n>_LBL_<ref>; the W/L line goes under them too,
// with the v4 engine asked for, with auto when v4 wins, and on the ?optimize=N path (through the HTTP server).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
// two inverter instances: v4 draws one block per instance (B1_, B2_), auto picks v4 (bench, 08.11)
const CASE1 = fs.readFileSync(new URL('./fixtures/hier/case1.sp', import.meta.url), 'utf8');
const WL = { 'XB1.M1': '2/0.18', 'XB1.M2': '1/0.18', 'XB2.M1': '2/0.18', 'XB2.M2': '1/0.18' };
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
const imp = async (query) => {
  const id = (await (await fetch(BASE + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
  const r = await fetch(`${BASE}/documents/${id}/netlist/import?${query}&force=1`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: CASE1 });
  const body = await r.json();
  const xml = await (await fetch(`${BASE}/documents/${id}`)).text();
  const page1 = xml.slice(0, xml.indexOf('id="page-2"') > 0 ? xml.indexOf('id="page-2"') : xml.length);
  // name label of each transistor: its id and drawn text, whatever the prefix
  const labels = new Map([...page1.matchAll(/<mxCell [^>]*?id="((?:B\d+_)?LBL_([^"]+))"[^>]*>/g)]
    .map((m) => [m[2], { id: m[1], value: (/value="([^"]*)"/.exec(m[0]) || [])[1] || '' }]));
  return { status: r.status, body, labels };
};
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

for (const [what, query, blocks] of [['engine v4', 'engine=v4', true], ['engine auto (v4 wins)', 'engine=auto', true], ['?optimize=2', 'optimize=2', false]]) {
  test(`${what}: W/L under every transistor name`, async () => {
    const { status, body, labels } = await imp(query);
    assert.equal(status, 201, JSON.stringify(body).slice(0, 300));
    if (blocks) {
      assert.match(String(body.engine), /^v4/, 'the case must really be drawn by v4');
      assert.ok([...labels.values()].some((l) => /^B\d+_LBL_/.test(l.id)), 'v4 drew no block label: the test no longer covers B1');
    }
    for (const [ref, wl] of Object.entries(WL)) {
      const l = labels.get(ref);
      assert.ok(l, `${ref}: no name label`);
      assert.ok(unesc(l.value).includes(wl), `${ref} (${l.id}): no W/L ${wl} in ${unesc(l.value)}`);
    }
  });
}
