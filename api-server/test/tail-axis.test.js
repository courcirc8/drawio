// readability rule (Eric, 2026-10-25): the tail of a differential pair sits on
// the pair's axis of symmetry, centred between the two transistors (above a P
// pair fed from the top, below an N pair). Measured on the CHANNEL x (drain /
// source pins), what the eye reads; the symbol box is offset by its gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice } from '../lib/netlist.js';
import { newDocument, getPage, allCells, cellInfo } from '../lib/model.js';
import { classify, activePins } from '../lib/components.js';
import { pinAbs } from '../lib/route.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { importNetlistManuel } from '../lib/place-manuel.js';
import { autoPlace } from '../lib/auto.js';

const GRID = 10;
const fx = (n) => parseSpice(fs.readFileSync(new URL(`./fixtures/tail-axis/${n}.sp`, import.meta.url), 'utf8'));
function pinOn(c, rel) {            // as lib/geo-lvs.js: anchors turn with direction=
  const d = c.style.map.get('direction'); let { x, y } = rel;
  if (d === 'west') { x = 1 - x; y = 1 - y; } else if (d === 'north') [x, y] = [y, 1 - x]; else if (d === 'south') [x, y] = [1 - y, x];
  return pinAbs(c, { x, y });
}
const channelX = (c) => { const xs = activePins(classify(c)).filter((p) => p.y !== 0.5).map((p) => pinOn(c, p).x); return xs.reduce((a, b) => a + b, 0) / xs.length; };
/** every tail (a transistor whose drain is the common source of a pair) -> offset from the pair's mean x */
export function tailOffsets(parsed, model) {
  const M = parsed.components.filter((c) => c.prefix === 'M');
  const cells = new Map(allCells(model).map(cellInfo).filter((c) => c.kind === 'vertex').map((c) => [String(c.id).toUpperCase(), c]));
  const x = (r) => channelX(cells.get(r.toUpperCase()));
  const out = [];
  for (const t of M) {
    const pr = M.filter((c) => c !== t && c.nodes[2] === t.nodes[0] && c.nodes[1] !== c.nodes[0]);
    if (pr.length !== 2 || pr[0].nodes[1] === pr[1].nodes[1]) continue;
    out.push({ tail: t.ref, dx: x(t.ref) - (x(pr[0].ref) + x(pr[1].ref)) / 2 });
  }
  return out;
}
const CASES = ['ota_miller', 'ota_miller_p', 'ota_5t', 'ota_5t_p', 'strongarm', 'folded'];
for (const n of CASES) {
  test(`auto: tail centred under/over the pair (${n})`, async () => {
    const p = fx(n), r = await autoPlace(p), off = tailOffsets(p, getPage(r.doc));
    assert.equal(off.length, 1, `one tail expected (${r.label})`);
    assert.ok(Math.abs(off[0].dx) <= GRID, `${r.label}: ${off[0].tail} off axis by ${off[0].dx}`);
  });
}
for (const n of ['ota_miller', 'ota_miller_p', 'ota_5t', 'ota_5t_p']) {
  test(`manuel: tail on the axis (${n})`, () => {
    const p = fx(n), m = getPage(newDocument());
    importNetlistManuel(m, withGroundAlias(p));
    const off = tailOffsets(p, m);
    assert.equal(off.length, 1);
    assert.ok(Math.abs(off[0].dx) <= GRID, `${off[0].tail} off axis by ${off[0].dx}`);
  });
}
