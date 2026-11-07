// readability rule (Eric, 2026-11-07, replaces the 24.10 bias labels for this case): a PMOS bias mirror whose
// gate net stays in one frame is drawn as one wire. 1. the reference (the diode XM11) sits LEFT of the tail it
// mirrors; 2. every gate on its net is joined by wires, no net label, the bus at the level of the reference's
// gate-drain connection; 3. an upright input port entering the reference drain from below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice } from '../lib/netlist.js';
import { newDocument, getPage, allCells, cellInfo } from '../lib/model.js';
import { classify, activePins } from '../lib/components.js';
import { pinAbs } from '../lib/route.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { importNetlistManuel } from '../lib/place-manuel.js';

const fx = (n) => withGroundAlias(parseSpice(fs.readFileSync(new URL(`./fixtures/bias-mirror/${n}.sp`, import.meta.url), 'utf8')));
const channelX = (c) => {
  const xs = activePins(classify(c)).filter((p) => p.y !== 0.5).map((p) => pinAbs(c, p).x);
  return xs.reduce((a, b) => a + b, 0) / xs.length;
};

test('manuel: PMOS bias mirror drawn as one wire with a bias input port (ota_miller_pbias)', () => {
  const page = getPage(newDocument());
  const r = importNetlistManuel(page, fx('ota_miller_pbias'));
  assert.ok(r.geo.ok, JSON.stringify(r.geo.errors));
  assert.deepEqual(r.frames, ['core'], 'drawn by the textbook rules, not the fallback with a bias frame');
  const cells = allCells(page).map(cellInfo);
  const v = new Map(cells.filter((c) => c.kind === 'vertex').map((c) => [String(c.id).toUpperCase(), c]));
  // 1. the reference left of the tail it mirrors
  assert.ok(channelX(v.get('XM11')) < channelX(v.get('XM10')), 'XM11 (reference) left of XM10 (tail)');
  // 2. no vbp label: the gates are one wire
  const vbp = cells.filter((c) => c.kind === 'vertex' && c.value === 'vbp' && /apiShape=port/.test(c.styleRaw));
  const label = vbp.filter((c) => !/shape=singleArrow/.test(c.styleRaw));
  assert.equal(label.length, 0, 'no vbp net label');
  // 3. one input port on vbp, at the reference's drain level
  const port = vbp.filter((c) => /shape=singleArrow/.test(c.styleRaw));
  assert.equal(port.length, 1, 'one vbp port');
  assert.match(port[0].styleRaw, /portDirection=input/);
  const xm11 = v.get('XM11');
  // from below, upright, its tip pointing up into the reference's drain (Eric 07.11)
  assert.match(port[0].styleRaw, /direction=north/);
  assert.ok(port[0].y >= xm11.y + xm11.h, 'the port below the reference');
  // the bus to the other gates at the level of the gate-drain connection: the diode node (right above the port)
  // and the drop from the gate bar share one junction row
  const dots = cells.filter((c) => c.kind === 'vertex' && /ellipse/.test(c.styleRaw));
  const px = port[0].x + port[0].w / 2;
  const node = dots.find((d) => Math.abs(d.x + d.w / 2 - px) < 1 && d.y > xm11.y + xm11.h && d.y < port[0].y);
  assert.ok(node && px >= xm11.x && px <= xm11.x + xm11.w, 'the port right under the diode node, on the reference drain line');
  assert.ok(dots.filter((d) => d.y === node.y && d.x > node.x && d.x < channelX(v.get('XM10'))).length >= 1, 'the gate-bar drop meets the bus on the same level');
});
