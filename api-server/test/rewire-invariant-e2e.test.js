/**
 * End-to-end regression for the /rewire LVS-preservation invariant (layer 2,
 * server.js's `/documents/:id/rewire` handler). Boots a real HTTP server
 * (ephemeral port, same pattern as e2e.test.js) and drives the ACTUAL,
 * twice-reproduced bug this endpoint was hardened against — not a synthetic
 * stand-in: chaining /rewire on top of an `optimize`-placed 2446 document
 * flips a passing LVS to failing (~14 "terminal unreachable" nets), and
 * nothing objected before this hardening.
 *
 * FIXTURE PROVENANCE — test/fixtures/optimized_2446.drawio
 * ----------------------------------------------------------------------
 * Frozen so this test never re-runs a 12-iteration place3 hill-climb.
 * Generated 2026-09-03 against a local instance of this checkout's
 * api-server (port 8791, chosen non-default so it never collides with a
 * session already using the default 8770):
 *
 *   bun run server.js --port 8791     # this host has no `node`; e2e.test.js
 *                                      # notes the same (T5) and spawns under
 *                                      # process.execPath instead of a
 *                                      # hardcoded `node`
 *
 *   curl -X POST http://127.0.0.1:8791/documents \
 *     -H 'Content-Type: application/json' -d '{}'
 *   # -> {"id":"doc1", ...}
 *
 *   curl -X POST 'http://127.0.0.1:8791/documents/doc1/netlist/import?engine=v3&optimize=12' \
 *     --data-binary @/eda/dm/home/evandel/CURSOR/PySpectre/Match_BOM_optimizer/multi_agent_opt/rf_schematics/golden/matching_2446.cir \
 *     -H 'Content-Type: text/plain'
 *   # -> 201, lvs.match == true, compared_components == 15
 *   # (engine=v3&optimize=12 is the SHIPPING config per AGENTS.md's
 *   # schematic-generation section: place3 for source-less RF chains,
 *   # regenerated through optimize.js's 12-iteration hill-climb -- bare
 *   # engine=v3 without ?optimize is explicitly NOT the deliverable there)
 *
 *   curl http://127.0.0.1:8791/documents/doc1 > test/fixtures/optimized_2446.drawio
 *
 * Regenerate DELIBERATELY with these exact commands if place3/optimize
 * changes in a way that should be reflected here -- never hand-edit the
 * fixture body. Re-verify `lvs.match === true` on the fresh capture before
 * committing it; if it comes back false, something upstream regressed and
 * this fixture must not be refrozen on top of that.
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

const FIXTURE_PATH = path.join(HERE, 'fixtures/optimized_2446.drawio');
const CIR_PATH = '/eda/dm/home/evandel/CURSOR/PySpectre/Match_BOM_optimizer/multi_agent_opt/rf_schematics/golden/matching_2446.cir';
const fixtureXml = fs.readFileSync(FIXTURE_PATH, 'utf8');
const cir = fs.readFileSync(CIR_PATH, 'utf8');

let proc;

test.before(async () => {
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

// Sanity on the fixture itself, independent of the rest of this file: if a
// future edit to place3/optimize/netlist.js silently changed what "LVS
// passing" means for this exact frozen XML, every assertion below would be
// testing a fiction. Fail loudly here instead.
test('rewire-invariant e2e: fixture precondition — LVS passes on the frozen optimized_2446.drawio as-is', async () => {
  const created = await (await fetch(`${BASE}/documents`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: fixtureXml,
  })).json();
  const lvs = await (await fetch(`${BASE}/documents/${created.id}/lvs`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: cir,
  })).json();
  assert.equal(lvs.match, true, `fixture precondition failed -- LVS does not pass on optimized_2446.drawio as frozen: ${JSON.stringify(lvs).slice(0, 300)}`);
});

test('rewire-invariant e2e: /rewire on the optimize-placed 2446 fixture breaks LVS -> 409, non-empty diff, document rolled back BYTE-IDENTICAL',
  { timeout: 30000 }, async () => {
    const created = await (await fetch(`${BASE}/documents`, {
      method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: fixtureXml,
    })).json();
    const id = created.id;

    const res = await fetch(`${BASE}/documents/${id}/rewire`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: cir,
    });
    assert.equal(res.status, 409, 'expected the rewire call to be REFUSED (LVS regression), not silently accepted');
    const body = await res.json();

    // "the returned diff is non-empty" -- both facets of it: the unreachable
    // terminals rewire.js itself reported, AND the structural net_mismatches
    // lvs.compare() found on the attempted (never-applied) result.
    assert.ok(Array.isArray(body.unreachable) && body.unreachable.length > 0,
      `expected a non-empty unreachable list, got: ${JSON.stringify(body.unreachable)}`);
    assert.equal(body.lvs_before.match, true, 'precondition of the whole scenario: LVS must have been PASSING before the call');
    assert.equal(body.lvs_after.match, false, 'LVS must be FAILING in the (rolled-back) attempted result -- that is the regression being caught');
    assert.ok(Array.isArray(body.lvs_after.net_mismatches) && body.lvs_after.net_mismatches.length > 0,
      `expected a non-empty net_mismatches diff, got: ${JSON.stringify(body.lvs_after.net_mismatches)}`);

    // The part that actually matters: the STORED document was rolled back,
    // not merely reported as broken while a partially-mutated model sits in
    // memory. rewire() deletes every edge before re-adding them, so a
    // failure to roll back would be visible as a missing/altered wire set --
    // checked here the strongest possible way, exact byte equality against
    // the frozen fixture, not just "LVS matches again" (which a DIFFERENT,
    // also-valid rewiring could also satisfy while still not being a real
    // rollback).
    const after = await (await fetch(`${BASE}/documents/${id}`)).text();
    assert.equal(after, fixtureXml, 'stored document is NOT byte-identical to the pre-call fixture -- rollback left a mutated model');
  });

test('rewire-invariant e2e: mirror case — LVS already false before the call is NOT rolled back, and before/after are both reported',
  { timeout: 30000 }, async () => {
    const created = await (await fetch(`${BASE}/documents`, {
      method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: fixtureXml,
    })).json();
    const id = created.id;

    // Corrupt one real wire's target onto an unrelated junction dot (same
    // defect class the negative control in invariant.test.js exercises, but
    // via the live HTTP PATCH surface here instead of a direct model call).
    // w756 (C4 -> J_Bp, net "Bp") and J_Up (the "Up" net's own dot) are both
    // named cells inside the FROZEN fixture -- hardcoding them is correct
    // here precisely because the fixture is frozen, not regenerated per run.
    const patchRes = await fetch(`${BASE}/documents/${id}/cells/w756`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'J_Up' }),
    });
    assert.equal(patchRes.status, 200, 'setup step (PATCH) failed -- fixture cell ids drifted?');

    const preLvs = await (await fetch(`${BASE}/documents/${id}/lvs`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: cir,
    })).json();
    assert.equal(preLvs.match, false, 'setup step failed -- the deliberate corruption did not actually break LVS');
    // snapshot taken right after corrupting, right before calling /rewire --
    // this (not the original fixture) is the only state a wrongful rollback
    // could possibly restore to, since server.js snapshots at call time.
    const corruptedXml = await (await fetch(`${BASE}/documents/${id}`)).text();

    const res = await fetch(`${BASE}/documents/${id}/rewire`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: cir,
    });
    assert.equal(res.status, 200, 'a document that was ALREADY LVS-failing must not be refused/rolled back (409) -- the caller may be repairing it');
    const body = await res.json();
    assert.ok(!('error' in body), 'a 200 response must not carry the rollback error shape');
    assert.equal(body.lvs_before.match, false, 'before-status must be reported and reflect the pre-existing failure');
    assert.equal(typeof body.lvs.match, 'boolean', 'after-status must be reported');

    // Not rolled back: rewire() deletes and re-adds every edge, so the
    // stored document must have actually changed from the corrupted
    // snapshot taken right before this /rewire call (a no-op/rollback would
    // leave it byte-identical to that corrupted state instead).
    const after = await (await fetch(`${BASE}/documents/${id}`)).text();
    assert.notEqual(after, corruptedXml, 'document is byte-identical to the pre-rewire corrupted state -- rewire() looks like it never ran (or was wrongly rolled back)');
  });
