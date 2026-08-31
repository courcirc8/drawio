/**
 * Le checker Python indépendant (tools/check.py) est LE juge des règles :
 * ce test rejoue son harnais d'exigences (fixtures figées de benchmark/
 * regression + faux négatifs synthétiques de la revue adversariale).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('checker python : harnais d\'exigences complet', () => {
  const r = spawnSync('python3', [path.join(HERE, '../tools/test-check.py')],
    { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
