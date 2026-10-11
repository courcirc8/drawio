import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpice } from '../lib/netlist.js';
import { exportKicad, kxform, kicadPins, KICAD_SYMBOLS, MM } from '../lib/export-kicad.js';

const HAVE = !!KICAD_SYMBOLS;
const DECK = 'M1 out in 0 0 nmos W=2u L=0.13u\nR1 vdd out 1k\nC1 out 0 1p\n.end';

test('kicad transform: 10 units per 1.27 mm, symbol y up → schematic y down, the 8 cases distinct', () => {
  assert.equal(MM, 0.127);
  assert.deepEqual(kxform([0, 3.81], 0, null).map((v) => Math.round(v) + 0), [0, -30]);           // a resistor's pin 1: on top
  assert.deepEqual(kxform([0, 3.81], 90, null).map((v) => Math.round(v) + 0), [-30, 0]);   // lying: pin 1 on the left
  const seen = new Set(); for (const a of [0, 90, 180, 270]) for (const m of [null, 'x']) seen.add(kxform([2.54, 5.08], a, m).map(Math.round).join(','));
  assert.equal(seen.size, 8);
});

test('kicad export: a CS stage gives a .kicad_sch with KiCad symbols on the 1.27 mm grid', { skip: !HAVE && 'KiCad symbol libraries not installed' }, async () => {
  assert.ok(kicadPins('Device', 'R')['1']);
  const r = await exportKicad(parseSpice(DECK));
  assert.match(r.sch, /^\(kicad_sch \(version \d+\)/);
  assert.match(r.sch, /\(lib_id "Simulation_SPICE:NMOS_Substrate"\)/);
  assert.match(r.sch, /\(lib_id "Device:R"\)/);
  for (const m of r.sch.matchAll(/\(wire \(pts \(xy ([-\d.]+) ([-\d.]+)\)/g)) for (const v of [m[1], m[2]]) assert.ok(Math.abs(Number(v) / 0.635 - Math.round(Number(v) / 0.635)) < 1e-6, `${v} on the 0.635 mm half grid`);
});

test('kicad export checked by KiCad itself (kicad-cli netlist + LVS)', { skip: !process.env.KICAD_CHECK && 'KICAD_CHECK=1 to run kicad-cli' }, async () => {
  const { kicadLvs } = await import('../tools/kicad-check.mjs');
  const p = parseSpice(DECK), dir = fs.mkdtempSync(path.join(os.homedir(), 'kct-')), file = path.join(dir, 'cs.kicad_sch');
  fs.writeFileSync(file, (await exportKicad(p)).sch);
  try { assert.ok(kicadLvs(file, p).match); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
