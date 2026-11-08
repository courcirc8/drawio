// REVIEW r3 (D10): an import whose page 2 (dummies) fails the LVS of both pages is refused (422), like page 1;
// with force=1 it is drawn and the failed LVS is said. The fault is a page-2 wire taken away by a test hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MLOAD = fs.readFileSync(new URL('./fixtures/dummies/eric_mload_par.sp', import.meta.url), 'utf8');
const start = async (env) => {
  // a port the system says is free (a random one could be another test server's: its /health answered, the
  // import went to a server without this test's DRAWIO_TEST_FAULT), and our own process still alive
  const port = await new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(HERE, '../server.js'), '--port', String(port)], { stdio: 'pipe', env: { ...process.env, ...env } });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode != null) throw new Error(`server exited (${proc.exitCode})`);
    try { if ((await fetch(base + '/health')).ok && proc.exitCode == null) return { proc, base }; } catch { /* not up yet */ }
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

// REVIEW r4 (1), W1/W2: the pages join by NAME. A page-2 name that page 1 does not print fails the two-page LVS
// (its terminal match is not enough): 422 without force; with force=1 the failure, the net and the warning line
// reach the response. The fault erases every print of one shared name from page 1 (test hook).
test('a page-2 name missing from page 1: 422 without force, said with force=1', async () => {
  const { proc, base } = await start({ DRAWIO_TEST_FAULT: 'page1-name' });
  try {
    const no = await imp(base, 'engine=manuel');
    assert.equal(no.status, 422, JSON.stringify(no.body).slice(0, 300));
    assert.match(JSON.stringify(no.body), /named on page 2, not on page 1: \w+/);
    const yes = await imp(base, 'engine=manuel&force=1');
    assert.equal(yes.status, 201, JSON.stringify(yes.body).slice(0, 300));
    const lv = yes.body.dummies?.lvs;
    assert.equal(lv?.match, false);
    assert.equal(lv.unnamed?.length, 1, JSON.stringify(lv.unnamed));
    // W1 (dummiesForImport) and W2 (server copy): the line is in the dummies report AND in the response warnings
    const line = `net ${lv.unnamed[0]}: named on page 2 but not on page 1 (the pages join by name)`;
    assert.ok(yes.body.dummies.warnings?.includes(line), JSON.stringify(yes.body.dummies.warnings));
    assert.ok(yes.body.warnings?.includes(line), JSON.stringify(yes.body.warnings));
  } finally { proc.kill('SIGTERM'); }
});
