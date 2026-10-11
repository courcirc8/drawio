import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, getPage, addVertex, addWire, updateCell, allCells, cellInfo } from '../lib/model.js';
import { exportDocument } from '../lib/render.js';
import { pinAbs } from '../lib/route.js';

// The engine's pin position (pinAbs) must be where draw.io itself draws a wire
// end, for every mirror x rotation of a part. Measured 2026-10-11: 32/32 agree
// (the ~10 px jog seen on a flipped + rotated resistor in the cs template came
// from the orthogonal edge style leaving the pin in its exit direction, not
// from pinAbs; that template now draws such lines with straight wires).
// Measure: a wire from the part's pin to a small reference box at a known
// place; in draw.io's own SVG, the wire's far end gives the SVG offset, its
// near end the pin.
const REF = { x: 600, y: 600, w: 20, h: 20 };   // reference box; wire ends at its left middle (600, 610)

async function drawnPin(flipH, flipV, rotation, pin) {
  const doc = newDocument(), page = getPage(doc);
  addVertex(page, { id: 'R1', shape: 'mxgraph.electrical.resistors.resistor_2', x: 200, y: 200, w: 100, h: 20 });
  updateCell(page, 'R1', { style: { flipH: flipH ? 1 : null, flipV: flipV ? 1 : null, rotation: rotation || null } });
  addVertex(page, { id: 'T1', style: 'rounded=0;whiteSpace=wrap;html=1;', ...REF });
  addWire(page, { id: 'W1', source: 'R1', target: 'T1', sourcePin: pin, targetPin: { x: 0, y: 0.5 }, style: 'edgeStyle=none;endArrow=none;html=1;' });
  const svg = String((await exportDocument(doc, page, { format: 'svg' })).buffer);
  // the SVG offset from the reference box (the only 20 x 20 rect), then the
  // wire end that is NOT on the box: the pin as draw.io drew it
  // the export is scaled: the reference box (the only square rect) gives scale and offset
  const rect = [...svg.matchAll(/<rect[^>]*>/g)].map((m) => Object.fromEntries([...m[0].matchAll(/\s(x|y|width|height)="([-\d.]+)"/g)].map((a) => [a[1], Number(a[2])]))).find((r) => r.width > 0 && Math.abs(r.width - r.height) < 0.6);
  assert.ok(rect, 'reference box found in the SVG');
  const k = rect.width / REF.w, off = { x: rect.x - REF.x * k, y: rect.y - REF.y * k };
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1].match(/-?\d+(?:\.\d+)?/g).map(Number)).filter((n) => n.length === 4);
  const cell = allCells(page).map(cellInfo).find((c) => c.id === 'R1');
  const want = pinAbs(cell, pin), refEnd = { x: REF.x * k + off.x, y: (REF.y + REF.h / 2) * k + off.y };
  let best = null;
  for (const [x1, y1, x2, y2] of paths) for (const [a, b] of [[[x1, y1], [x2, y2]], [[x2, y2], [x1, y1]]]) {
    if (Math.hypot(b[0] - refEnd.x, b[1] - refEnd.y) > 2) continue;   // b must be the end on the box
    const at = { x: (a[0] - off.x) / k, y: (a[1] - off.y) / k }, d = Math.hypot(at.x - want.x, at.y - want.y);
    if (best == null || d < best.d) best = { d, at };
  }
  assert.ok(best, 'wire found');
  return { drawn: best.at, want };
}

// 32 renders by the headless draw.io (~10 min): opt-in, PIN_RENDER=1
const SKIP = !process.env.PIN_RENDER && 'PIN_RENDER=1 to render the 32 cases';
for (const flipH of [0, 1]) for (const flipV of [0, 1]) for (const rotation of [0, 90, 180, 270]) {
  for (const pin of [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]) {
    test(`pinAbs = draw.io wire end: flipH=${flipH} flipV=${flipV} rotation=${rotation} pin=(${pin.x},${pin.y})`, { skip: SKIP }, async () => {
      const { drawn, want } = await drawnPin(flipH, flipV, rotation, pin);
      assert.ok(Math.hypot(drawn.x - want.x, drawn.y - want.y) < 1.5, `drawn (${drawn.x.toFixed(1)}, ${drawn.y.toFixed(1)}) vs pinAbs (${want.x.toFixed(1)}, ${want.y.toFixed(1)})`);
    });
  }
}
