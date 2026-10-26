// D2 (PLAN-HIERARCHIE §3.2, 2026-10-26): an X instance of a DEFINED .subckt that
// is an amplifier is drawn as a triangle on the page that instantiates it: '+'
// and '−' on the left, the output on the apex, power on top, ground and extra
// pins (ibias) below. The choice is explicit (opts.symbols, `*.symbol` in the
// .subckt) or comes from the role (input pair on two pins + mirror diode + an
// output pin); a generic box otherwise. The block correspondence (apiBlock) is
// kept: LVS per page and global stay green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importHier, hierReading } from '../lib/hier.js';
import { getPage, allCells, cellInfo } from '../lib/model.js';
import { geoLvs } from '../lib/geo-lvs.js';

const ota = fs.readFileSync(new URL('./fixtures/hier-rails/ota_rails.cir', import.meta.url), 'utf8');
const cell = (m, ref) => allCells(m).map(cellInfo).find((c) => String(c.refdes || c.id).toUpperCase() === ref);
const pinsOf = (c) => Object.fromEntries((c.style.map.get('apiBlockPins') || '').split('|').map((t) => { const [n, xy] = t.split('@'); const [x, y] = xy.split(',').map(Number); return [decodeURIComponent(n), { x, y }]; }));

test('an OTA subckt (pair + mirror + out) becomes a triangle: + / − left, out on the apex, power up, ground and ibias down', async () => {
  const r = await importHier(ota);
  assert.deepEqual(r.lvs.pages, { tb_ota: true, ota: true });
  assert.equal(r.lvs.global, true);
  const top = getPage(r.doc), c = cell(top, 'XOTA');
  assert.match(c.styleRaw, /^triangle;/);
  assert.equal(c.style.map.get('apiSymbol'), 'ota');
  const p = pinsOf(c);
  assert.deepEqual([p.inp.x, p.inn.x, p.out.x, p.out.y], [0, 0, 1, 0.5]);
  assert.ok(p.inp.y < p.inn.y, '+ above −');
  assert.ok(p.power_ana.y < 0.5 && Math.abs(p.power_ana.y - p.power_ana.x / 2) < 1e-9, 'power on the upper side');
  for (const n of ['ground_ana', 'ibias']) assert.ok(p[n].y > 0.5 && Math.abs(p[n].y - (1 - p[n].x / 2)) < 1e-9, `${n} on the lower side`);
  assert.equal(geoLvs(top).ok, true, JSON.stringify(geoLvs(top).errors.slice(0, 3)));
});

test('the choice is explicit when given: opts.symbols or *.symbol in the .subckt wins over the role', async () => {
  const box = await importHier(ota, { symbols: { ota: 'box' } });
  assert.doesNotMatch(cell(getPage(box.doc), 'XOTA').styleRaw, /^triangle;/);
  assert.equal(box.lvs.global, true);
  const hinted = ota.replace('.subckt ota inp inn out ibias power_ana ground_ana', '.subckt ota inp inn out ibias power_ana ground_ana\n*.symbol box');
  assert.doesNotMatch(cell(getPage((await importHier(hinted)).doc), 'XOTA').styleRaw, /^triangle;/);
  // a resistor divider named like an amplifier stays a box without a hint, a triangle with one
  const div = `.subckt amp in out power ground
R1 power out 10k
R2 out in 10k
R3 in ground 10k
.ends amp
XA a b vdd 0 amp
RL b 0 1k
V1 vdd 0 1
V2 a 0 1
.end`;
  assert.equal([...hierReading(div).defs.values()][0].symbol, 'box');
  assert.equal([...hierReading(div, { symbols: { AMP: 'opamp' } }).defs.values()][0].symbol, 'ota');
});

test('a fully differential OTA (outp / outn): ota_fd triangle, both outputs on the right, LVS green', async () => {
  const fd = `.subckt otafd inp inn outp outn vcmref power ground
M1 outn inp t ground nmos
M2 outp inn t ground nmos
M3 outn vb power power pmos
M4 outp vb power power pmos
M5 t vcmref ground ground nmos
M6 vb vb power power pmos
R1 vb ground 100k
.ends otafd
XFD a b op on cm vdd 0 otafd
V1 vdd 0 1.8
V2 a 0 0.9
V3 b 0 0.9
V4 cm 0 0.5
RL op on 10k
.end`;
  const r = await importHier(fd);
  assert.equal(r.lvs.global, true, JSON.stringify(r.lvs));
  const c = cell(getPage(r.doc), 'XFD'), p = pinsOf(c);
  assert.equal(c.style.map.get('apiSymbol'), 'ota_fd');
  assert.ok(p.outp.y < p.outn.y && p.outp.x > 0.5 && p.outn.x > 0.5);
  assert.equal(geoLvs(getPage(r.doc)).ok, true);
});

test('an amplifier whose pins do not fit a triangle (three inputs) stays a box', async () => {
  const t = ota.replace(/ota inp inn out ibias/g, 'ota inp inn in3 out ibias').replace('XOTA vin fb vout nb', 'XOTA vin fb vin vout nb').replace('M1 n1 inp t', 'M1 n1 inp t').replace('.ends ota', 'R9 in3 ground_ana 1k\n.ends ota');
  const r = await importHier(t);
  assert.doesNotMatch(cell(getPage(r.doc), 'XOTA').styleRaw, /^triangle;/);
  assert.equal(r.lvs.global, true);
});

test('acceptance: the Brokaw split as in the plan (ota + demarrage subckts): triangle XOTA, box XDEM, LVS per page and global green', async () => {
  const r = await importHier(fs.readFileSync(new URL('./fixtures/hier-brokaw/brokaw_hier.cir', import.meta.url), 'utf8'));
  assert.ok(Object.values(r.lvs.pages).every(Boolean), JSON.stringify(r.lvs.pages));
  assert.equal(r.lvs.global, true);
  const top = getPage(r.doc);
  const ota = cell(top, 'XOTA'), dem = cell(top, 'XDEM'), p = pinsOf(ota);
  assert.equal(ota.style.map.get('apiSymbol'), 'ota');
  assert.ok(p.inp.x === 0 && p.inn.x === 0 && p.inp.y < p.inn.y, '+ = inp (c2) above − = inn (c1)');
  assert.deepEqual([p.out.x, p.out.y], [1, 0.5]);
  assert.ok(p.power.y < 0.5 && p.ground.y > 0.5 && p.ibias.y > 0.5);
  assert.doesNotMatch(dem.styleRaw, /^triangle;/);
  assert.equal(geoLvs(top).ok, true);
  assert.equal(r.map['XOTA.XM1'].page, 'ota');
  assert.equal(r.map['XDEM.XMPL4'].page, 'demarrage');
});

test('no + / − on the triangle when the pin names do not give the polarity (V2I: inputcm_VNI / inputcm_VPI)', async () => {
  const v2i = `.subckt v2i inputcm_VNI inputcm_VPI out power ground
M1 d1 inputcm_VNI t ground nmos
M2 out inputcm_VPI t ground nmos
M3 d1 d1 power power pmos
M4 out d1 power power pmos
M5 t vb ground ground nmos
M6 vb vb ground ground nmos
R1 power vb 100k
.ends v2i
XV a b o vdd 0 v2i
V1 vdd 0 1.8
V2 a 0 0.9
V3 b 0 0.9
RL o 0 10k
.end`;
  const r = await importHier(v2i);
  const top = getPage(r.doc);
  assert.match(cell(top, 'XV').styleRaw, /^triangle;/);
  const signs = allCells(top).map(cellInfo).filter((c) => /^\s*[+−]\s*$/.test(String(c.value || '').replace(/<[^>]+>/g, '')));
  assert.deepEqual(signs.map((c) => c.value), [], 'no polarity sign');
  assert.equal(r.lvs.global, true);
  // with names that give it, the signs are there (inp / inn)
  const named = await importHier(v2i.replaceAll('inputcm_VNI', 'inn').replaceAll('inputcm_VPI', 'inp'));
  assert.equal(allCells(getPage(named.doc)).map(cellInfo).filter((c) => /^\s*[+−]\s*$/.test(String(c.value || '').replace(/<[^>]+>/g, ''))).length, 2);
});
