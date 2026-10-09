/**
 * wirenames.js — no CONNECTION BY NAME (Eric 2026-10-09: "on ne veut pas de
 * connexions par nom", on readings and on auto's drawings): an internal net
 * drawn as two or more port labels of the same name (v4 joins its blocks that
 * way) is redrawn with wires. The labels and their stubs are removed and the
 * pins they served are joined by a Manhattan minimum spanning tree, routed by
 * route.js. Supply and ground keep their symbols; a net with a single label
 * (a real input / output) keeps it.
 * Connectivity is unchanged (same pins, same net): the caller's LVS gate
 * checks it anyway.
 */
import { allCells, cellInfo, addWire, deleteCell } from './model.js';
import { classify } from './components.js';
import { routePage, pinAbs } from './route.js';

const RAILNAME = /^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss|v\+|v-)$/i;

export async function wireNamedNets(model) {
  const cells = allCells(model).map(cellInfo);
  const byName = new Map();
  for (const c of cells) {
    if (c.kind !== 'vertex' || classify(c).role !== 'port') continue;
    const n = String(c.value || '').trim().toUpperCase();
    if (!n || RAILNAME.test(n)) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(c);
  }
  const added = [];
  for (const [, ports] of byName) {
    if (ports.length < 2) continue;
    const ids = new Set(ports.map((p) => p.id));
    // the pins each label served (far ends of its stubs)
    const pins = [];
    for (const e of cells.filter((x) => x.kind === 'edge' && (ids.has(x.source) || ids.has(x.target)))) {
      const farIsTarget = ids.has(e.source);
      const v = farIsTarget ? e.target : e.source;
      if (ids.has(v)) continue;
      const pre = farIsTarget ? 'entry' : 'exit';
      const rel = { x: Number(e.style.map.get(pre + 'X') ?? 0.5), y: Number(e.style.map.get(pre + 'Y') ?? 0.5) };
      const cell = cells.find((x) => x.id === v);
      if (!cell) continue;
      if (!pins.some((q) => q.v === v && Math.abs(q.rel.x - rel.x) < 0.01 && Math.abs(q.rel.y - rel.y) < 0.01)) pins.push({ v, rel, at: pinAbs(cell, rel) });
    }
    if (pins.length < 2) continue;
    for (const p of ports) deleteCell(model, p.id);   // the labels and their stubs
    // Manhattan minimum spanning tree over the pins (Prim)
    const inTree = [pins[0]], rest = pins.slice(1);
    while (rest.length) {
      let best = null;
      for (const a of inTree) for (const [k, b] of rest.entries()) {
        const d = Math.abs(a.at.x - b.at.x) + Math.abs(a.at.y - b.at.y);
        if (!best || d < best.d) best = { a, b, k, d };
      }
      const w = addWire(model, { source: best.a.v, target: best.b.v, sourcePin: best.a.rel, targetPin: best.b.rel });
      added.push(w.getAttribute('id'));
      inTree.push(best.b); rest.splice(best.k, 1);
    }
  }
  if (added.length) await routePage(model, added, {});
  return { wired: added.length };
}
