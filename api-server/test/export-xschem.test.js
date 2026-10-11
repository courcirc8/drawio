import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpice } from '../lib/netlist.js';
import { compare } from '../lib/lvs.js';
import { exportXschem, xform, readSymbolPins, PROFILE, XSCHEM_DEVICES } from '../lib/export-xschem.js';

const HAVE_LIB = fs.existsSync(path.join(XSCHEM_DEVICES, 'res.sym'));

test('xschem transform: mirror then rotation, the 8 cases distinct', () => {
  const seen = new Set();
  for (let r = 0; r < 4; r++) for (const f of [0, 1]) seen.add(xform([20, -30], r, f).join(','));
  assert.equal(seen.size, 8);
  assert.deepEqual(xform([0, -30], 1, 0), [30, 0]);   // the IHP test bench's ammeter at rot 1
});

test('xschem export: a CS stage gives a .sch whose instances sit on their drawn pins', { skip: !HAVE_LIB && 'xschem symbol library not installed' }, async () => {
  const p = parseSpice('M1 out in 0 0 nmos W=2u L=0.13u\nR1 vdd out 1k\nC1 out 0 1p\n.end');
  const r = await exportXschem(p);
  assert.match(r.sch, /^v \{xschem version=/);
  assert.match(r.sch, /C \{sg13g2_pr\/sg13_lv_nmos\.sym\} \S+ \S+ [0-3] [01] \{name=M1/);
  assert.match(r.sch, /C \{res\.sym\}/);
  assert.ok([10, 5].includes(r.neutral.target.grid));
  assert.ok(r.sch.split('\n').filter((l) => l.startsWith('N ')).every((l) => l.split(' ').slice(1, 5).every((v) => Number(v) % 5 === 0)));
  assert.ok(Object.keys(readSymbolPins(PROFILE[Object.keys(PROFILE)[0]].file)).length === 2);
});

test('xschem export checked by xschem itself (netlister + LVS)', { skip: !process.env.XSCHEM_CHECK && 'XSCHEM_CHECK=1 to run xschem' }, async () => {
  const { xschemNetlist, canonMos } = await import('../tools/xschem-check.mjs');
  const p = parseSpice('M1 out in 0 0 nmos W=2u L=0.13u\nR1 vdd out 1k\nC1 out 0 1p\n.end');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xst-')), 'cs.sch');
  fs.writeFileSync(file, (await exportXschem(p)).sch);
  const x = xschemNetlist(file);
  assert.ok(compare({ components: canonMos(x.parsed, p).components, issues: [] }, canonMos(structuredClone(p))).match);
});
