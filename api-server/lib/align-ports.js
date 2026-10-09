/**
 * align-ports.js — every PORT on the same horizontal as the pin it drives,
 * outside the part, joined by one straight wire (Eric 2026-10-09 on the CML
 * comparator: "il ne reste plus qu'à aligner les ports d'entrée … avec les
 * grilles"; VIN1/M1, VIN2/M2, CLK/M5, CLKB/M6, BIAS/M7 — a general rule).
 *
 * For a port wired by ONE wire to a pin on the left or right side of a part:
 * the port is moved so that its tip (anchor 1,0.5, mirrored when flipped) is
 * at the pin's height, STUB px out on the pin's side, pointing at the pin; the
 * wire becomes straight. Each move is kept only if the port overlaps nothing,
 * the straight wire crosses no part, and tools/check.py finds no more errors
 * (opts.errorCount, as in lib/straighten.js); otherwise the port stays.
 * Geometry only: the same wire joins the same two cells.
 */
import { allCells, cellInfo, updateCell } from './model.js';
import { classify } from './components.js';
import { pinAbs } from './route.js';

const STUB = 40;

export async function alignPorts(model, { errorCount } = {}) {
  let errs = errorCount ? await errorCount(model) : null;
  let moved = 0;
  const ports = allCells(model).map(cellInfo).filter((c) => c.kind === 'vertex' && classify(c).role === 'port');
  for (const p0 of ports) {
    const cs = allCells(model).map(cellInfo), byId = new Map(cs.map((c) => [c.id, c]));
    const port = byId.get(p0.id);
    const es = cs.filter((e) => e.kind === 'edge' && (e.source === port.id || e.target === port.id));
    if (es.length !== 1) continue;
    const e = es[0], atSource = e.source === port.id;
    const part = byId.get(atSource ? e.target : e.source);
    if (!part || classify(part).role !== 'component') continue;
    const end = atSource ? 'entry' : 'exit';
    const pin = pinAbs(part, { x: Number(e.style.map.get(end + 'X') ?? 0.5), y: Number(e.style.map.get(end + 'Y') ?? 0.5) });
    const left = Math.abs(pin.x - part.x) < 2, right = Math.abs(pin.x - (part.x + part.w)) < 2;
    if (!left && !right) continue;
    // the tip of the port faces the pin: unflipped (pointing east) on the left,
    // flipped (pointing west) on the right
    const flip = right ? 1 : 0;
    const x = left ? pin.x - STUB - port.w : pin.x + STUB, y = pin.y - port.h / 2;
    const portEnd = atSource ? 'exit' : 'entry';
    const already = Math.abs(port.x - x) < 0.5 && Math.abs(port.y - y) < 0.5 && Number(port.style.map.get('flipH') || 0) === flip
      && e.points.length === 0 && Number(e.style.map.get(portEnd + 'X')) === 1 && Number(e.style.map.get(portEnd + 'Y')) === 0.5;
    if (already) continue;
    // free room: the port box and the straight wire touch no other vertex
    const box = { x0: Math.min(x, pin.x) + (left ? 0 : 1), x1: Math.max(x + port.w, pin.x) - (left ? 1 : 0), y0: y, y1: y + port.h };
    const hits = cs.some((v) => v.kind === 'vertex' && v.id !== port.id && v.id !== part.id && v.x != null && !String(v.id).startsWith('LBL_')
      && classify(v).role !== 'junction' && v.style.map.get('contactDot') !== '1'
      && v.x < box.x1 && v.x + v.w > box.x0 && v.y < box.y1 && v.y + v.h > box.y0);
    if (hits) continue;
    const saved = { x: port.x, y: port.y, flipH: port.style.map.get('flipH') ?? null, points: e.points,
      style: Object.fromEntries(['exitX', 'exitY', 'entryX', 'entryY', 'edgeStyle', 'drawioApiFixedRoute'].map((k) => [k, e.style.map.get(k) ?? null])) };
    updateCell(model, port.id, { x, y, style: { flipH: flip } });
    updateCell(model, e.id, { points: [], style: { [portEnd + 'X']: 1, [portEnd + 'Y']: 0.5, edgeStyle: 'orthogonalEdgeStyle', drawioApiFixedRoute: 1 } });
    let ok = true;
    if (errorCount) { const e2 = await errorCount(model); ok = errs != null && e2 != null && e2 <= errs; if (ok) errs = e2; }
    if (!ok) {
      updateCell(model, port.id, { x: saved.x, y: saved.y, style: { flipH: saved.flipH } });
      updateCell(model, e.id, { points: saved.points, style: saved.style });
      continue;
    }
    moved++;
  }
  return { moved };
}

/** Ports not yet at their pin's height with a straight wire (quality gate). */
export function misalignedPorts(model) {
  const cs = allCells(model).map(cellInfo), byId = new Map(cs.map((c) => [c.id, c])), out = [];
  for (const port of cs.filter((c) => c.kind === 'vertex' && classify(c).role === 'port')) {
    const es = cs.filter((e) => e.kind === 'edge' && (e.source === port.id || e.target === port.id));
    if (es.length !== 1) continue;
    const e = es[0], atSource = e.source === port.id, part = byId.get(atSource ? e.target : e.source);
    if (!part || classify(part).role !== 'component') continue;
    const end = atSource ? 'entry' : 'exit', portEnd = atSource ? 'exit' : 'entry';
    const pin = pinAbs(part, { x: Number(e.style.map.get(end + 'X') ?? 0.5), y: Number(e.style.map.get(end + 'Y') ?? 0.5) });
    if (Math.abs(pin.x - part.x) >= 2 && Math.abs(pin.x - (part.x + part.w)) >= 2) continue;   // a top / bottom pin
    const tip = pinAbs(port, { x: Number(e.style.map.get(portEnd + 'X') ?? 0.5), y: Number(e.style.map.get(portEnd + 'Y') ?? 0.5) });
    const outside = Math.abs(pin.x - part.x) < 2 ? tip.x <= pin.x : tip.x >= pin.x;
    if (Math.abs(tip.y - pin.y) > 0.5 || e.points.length || !outside) out.push(String(port.value || port.id));
  }
  return out;
}
