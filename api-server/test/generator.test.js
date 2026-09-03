// Non-régression du GÉNÉRATEUR : ces circuits sont à 0 erreur (checker JS)
// et LVS conforme — toute régression du moteur doit casser ce test.
// (Le juge de référence reste tools/check.py, plus strict, dans le benchmark.)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDocument, getPage } from '../lib/model.js';
import { importNetlist2 } from '../lib/place2.js';
import { routePage } from '../lib/route.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { compare } from '../lib/lvs.js';
import { checkDocument } from '../lib/check.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NETS = path.join(HERE, '../benchmark/netlists30');

const STABLE = ['rc-filter', 'vco-lc', 'ota-cmos', 'lc-match', 'pi-attenuator',
  'source-follower', 'diffpair-resistive', 'ring-vco3', 'class-ab-out', 'ota-2stage-pmos'];

for (const name of STABLE) {
  test(`générateur: ${name} -> LVS conforme et 0 erreur checker JS`, async () => {
    const cir = fs.readFileSync(path.join(NETS, name + '.cir'), 'utf8');
    const parsed = parseSpice(cir);
    const doc = newDocument();
    const m = getPage(doc);
    const placed = importNetlist2(m, parsed, {});
    await routePage(m, placed.wires, {});
    const lvs = compare(extractNetlist(m), parsed);
    assert.ok(lvs.match, `LVS mismatch: ${JSON.stringify(lvs).slice(0, 200)}`);
    // règle 30 exclue : version JS plus fruste que le juge Python
    const errs = checkDocument(m).violations
      .filter((v) => v.severity === 'error' && v.rule !== '30');
    assert.strictEqual(errs.length, 0,
      `erreurs checker JS: ${errs.map((e) => e.rule + ':' + e.message).join(' | ').slice(0, 300)}`);
  });
}
