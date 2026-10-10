// Non-regression of the active templates on the bank (tools/template-bench.mjs).
// Slow (every bank circuit a template reads is drawn by auto) and needs the
// bank on ai-station: opt-in, TEMPLATE_BENCH=1 npm test — or npm run bench:templates.
// Every template PR runs it before review (orchestrator 2026-10-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
test('active templates do not regress on the bank', { skip: process.env.TEMPLATE_BENCH !== '1', timeout: 3 * 3600e3 }, () => {
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'tools', 'template-bench.mjs'), '--check'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr.split('\n').filter((l) => /REGRESSION|->/.test(l)).join('\n'));
});
