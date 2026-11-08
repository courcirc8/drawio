// REVIEW r3 (D10): an import whose page 2 (dummies) fails the LVS of both pages is refused (422), like page 1;
// with force=1 it is drawn and the failed LVS is said. The fault is a page-2 wire taken away by a test hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MLOAD = fs.readFileSync(new URL('./fixtures/dummies/eric_mload_par.sp', import.meta.url), 'utf8');
const start = async (env) => {
  const port = 9000 + Math.floor(Math.random() * 900), base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(HERE, '../server.js'), '--port', String(port)], { stdio: 'pipe', env: { ...process.env, ...env } });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) return { proc, base }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGTERM'); throw new Error('server did not start');
};
const imp = async (base, query) => {
  const id = (await (await fetch(base + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
  const r = await fetch(`${base}/documents/${id}/netlist/import?${query}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: MLOAD });
  return { status: r.status, body: await r.json() };
};

test('page 2 failing its LVS: 422 without force, drawn and said with force=1', async () => {
  const { proc, base } = await start({ DRAWIO_TEST_FAULT: 'dummies-page' });
  try {
    const no = await imp(base, 'engine=manuel');
    assert.equal(no.status, 422, JSON.stringify(no.body).slice(0, 300));
    assert.match(JSON.stringify(no.body), /dummies page: LVS of both pages failed/);
    const yes = await imp(base, 'engine=manuel&force=1');
    assert.equal(yes.status, 201, JSON.stringify(yes.body).slice(0, 300));
    assert.equal(yes.body.dummies?.lvs?.match, false);
  } finally { proc.kill('SIGTERM'); }
});
test('the same import without the fault: 201, both pages LVS-clean', async () => {
  const { proc, base } = await start({});
  try {
    const ok = await imp(base, 'engine=manuel');
    assert.equal(ok.status, 201, JSON.stringify(ok.body).slice(0, 300));
    assert.equal(ok.body.dummies?.lvs?.match, true);
  } finally { proc.kill('SIGTERM'); }
});
