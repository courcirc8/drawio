/**
 * ranker.js — learned choice between candidate drawings of ONE netlist.
 *
 * WHY: engine=auto picks among its candidates with check.js, the fast in-process
 * checker; the reference judge is tools/check.py, stricter and different (it
 * counts rule 30, wrap-around, pin-clearance…), and the two disagree on ties
 * and near-ties. The ranker learns, from the tuning sets only, which cheap
 * features of a page predict FEWER check.py errors (then a better convention
 * score), and scores each candidate; the highest score wins.
 *
 * Model: linear, trained pairwise (logistic on feature differences between two
 * candidates of the same circuit), tools/ranker-train.py -> data/ranker.json.
 * Features: candidate identity, check.js rule counts, convention checks,
 * geometry (area, aspect, wire length, bends, wires). All computed here, in JS.
 */
import fs from 'node:fs';
import { allCells, cellInfo } from './model.js';
import { checkDocument } from './check.js';
import { conventionReport } from './conventions.js';
import { pinAbs } from './route.js';

const RULES = ['through', 'wrap-around', '22', '22-contact', 'pin-clearance', 'comp-overlap', '30', '29', 'diagonal', 'dangling', 'edge-hug', 'label-on-wire', 'excess-bends', 'unlabeled-net'];

/** Feature vector (object) of a placed page. `cand` = {eng, restMode, colW, rowH}. */
export function rankFeatures(model, parsed, cand = {}) {
  const f = {};
  f.cand_v2 = cand.eng === 'v2' ? 1 : 0;
  f.cand_split = cand.restMode === 'split' ? 1 : 0;
  f.cand_one = cand.restMode === 'one' ? 1 : 0;
  f.cand_absorb = cand.restMode === 'absorb+split' ? 1 : 0;
  f.colW = ((cand.colW ?? 190) - 190) / 40;
  f.rowH = ((cand.rowH ?? 180) - 180) / 40;
  const v = checkDocument(model).violations;
  f.js_errors = v.filter((x) => x.severity === 'error' && x.rule !== '30').length;
  f.js_warnings = v.filter((x) => x.severity !== 'error').length;
  for (const r of RULES) f['js_' + r] = v.filter((x) => x.rule === r).length;
  let conv = null;
  try { conv = conventionReport(model, parsed); } catch { /* no geometry */ }
  f.conv = conv?.score ?? 1;
  f.conv_failed = conv ? conv.failed.length : 0;
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const verts = cells.filter((c) => c.kind === 'vertex' && c.x != null);
  const xs = verts.flatMap((c) => [c.x, c.x + c.w]), ys = verts.flatMap((c) => [c.y, c.y + c.h]);
  const W = Math.max(...xs) - Math.min(...xs), H = Math.max(...ys) - Math.min(...ys);
  const n = Math.max(1, parsed.components.length);
  f.area_per_part = (W * H) / n / 1e4;
  f.aspect = Math.log(Math.max(1, W) / Math.max(1, H));
  let len = 0, bends = 0, wires = 0;
  for (const e of cells.filter((c) => c.kind === 'edge')) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) continue;
    const pin = (cell, pre) => ({ x: Number(e.style.map.get(pre + 'X') ?? 0.5), y: Number(e.style.map.get(pre + 'Y') ?? 0.5) });
    const pts = [pinAbs(s, pin(s, 'exit')), ...e.points, pinAbs(t, pin(t, 'entry'))];
    for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    bends += Math.max(0, pts.length - 2); wires++;
  }
  f.wire_per_part = len / n / 100;
  f.bends_per_wire = wires ? bends / wires : 0;
  f.wires_per_part = wires / n;
  return f;
}

let MODEL = undefined;
function loadModel() {
  if (MODEL !== undefined) return MODEL;
  try { MODEL = JSON.parse(fs.readFileSync(new URL('../data/ranker.json', import.meta.url), 'utf8')); } catch { MODEL = null; }
  return MODEL;
}

/** Score of a feature object (higher = better); null when no model is trained. */
export function rankScore(f) {
  const m = loadModel();
  if (m == null) return null;
  let s = 0;
  m.features.forEach((k, i) => { s += m.w[i] * (((f[k] ?? 0) - m.mean[i]) / (m.std[i] || 1)); });
  return s;
}
export function rankerAvailable() { return loadModel() != null; }
