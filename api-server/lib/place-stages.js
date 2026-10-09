/**
 * place-stages.js — engine "stages": placement driven by the topological
 * reading of lib/stages.js (Eric 2026-10-09: "la reconnaissance topologique
 * est toujours la clef d'un schéma lisible"; step C of the plan in ETAT.md).
 *
 *   1. lib/stages.js reads the netlist: roles, DC branches (supply -> ground),
 *      stages (branches joined by a drain / source node) and their rank along
 *      the signal.
 *   2. Initial positions, in units of the median part size:
 *        x — stages left to right by rank (bias / reference stages first, on
 *            the left), each branch of a stage one column, the columns of a
 *            pair side by side; a part shared by two columns (tail) between them;
 *        y — the part's place in its branch, supply on top, ground at the
 *            bottom (Eric's rules: every DC branch a column, rails top / bottom).
 *      Parts outside any branch (coupling, feedback, bias passives, sources)
 *      sit next to the parts they join.
 *   3. lib/place-sa.js takes these positions (opts.saInit) and only refines
 *      them (short, cold annealing), then imposes its rows / columns, flips
 *      pairs and mirrors, and wires the nets.
 * Only for circuits whose reading is SURE (stagesConfident): the others keep
 * the other engines. A candidate of engine=auto behind AUTO_STAGES=1, OFF by
 * default (Eric decides after the blind series 3).
 */
import { analyseStages } from './stages.js';
import { importNetlistSA } from './place-sa.js';

const COL = Number(process.env.STG_COL ?? 2.0), STAGE_GAP = Number(process.env.STG_GAP ?? 1.2), ROW = Number(process.env.STG_ROW ?? 1.7);   // units of the median part size (STG_* to tune)

/** Is the reading of this netlist sure enough to drive the placement? */
export function stagesConfident(parsed, a = analyseStages(parsed)) {
  const n = parsed.components.length;
  if (n > 25 || n < 3) return false;
  if (Object.values(a.roles).includes('unknown')) return false;
  if (a.coverage.partsInStage / Math.max(1, a.coverage.parts) < 0.6) return false;
  return a.stages.every((s) => s.columns.length <= 8);
}

/** Initial centres (units) for every part, from the stage reading. */
export function stageLayout(parsed, a = analyseStages(parsed)) {
  const pos = new Map();
  const comps = parsed.components;
  // order: rank, then bias-like stages first within a rank
  const biasLike = (s) => ['mirror-ref', 'current-source', 'diode'].includes(s.kind) ? 0 : 1;
  const stages = [...a.stages].sort((x, y) => x.rank - y.rank || biasLike(x) - biasLike(y));
  let x = 0;
  for (const st of stages) {
    // columns of the stage: each part keeps its FIRST column; a part met in
    // several columns (tail, shared load) goes between them
    const seen = new Map();
    const cols = st.columns.map((col) => col.filter((r) => st.refs.includes(r)));
    // a pair's two halves side by side: sort columns so the ones sharing parts are adjacent
    cols.forEach((col, k) => col.forEach((r, depth) => {
      if (!seen.has(r)) seen.set(r, { ks: [], depths: [] });
      seen.get(r).ks.push(k); seen.get(r).depths.push(depth);
    }));
    const firstCol = new Map();
    let slot = 0;
    cols.forEach((col, k) => {
      const own = col.filter((r) => seen.get(r).ks[0] === k);
      if (!own.length) return;
      firstCol.set(k, slot++);
    });
    const span = Math.max(1, slot);
    // a chain read from ground has its bottom on the ground row: shift it down
    const L = Math.max(...st.columns.map((c) => c.length));
    for (const [k, col] of st.columns.entries()) if (col.fromGround) col.forEach((r) => { const i = seen.get(r)?.ks.indexOf(k); if (i != null && i >= 0) seen.get(r).depths[i] += L - col.length; });
    for (const [r, info] of seen) {
      const slots = info.ks.map((k) => firstCol.get(k)).filter((v) => v != null);
      const cx = x + COL * (slots.length ? slots.reduce((p, q) => p + q, 0) / slots.length : 0);
      const depth = Math.max(...info.depths);
      pos.set(r, { x: cx, y: ROW * depth });
    }
    x += COL * span + STAGE_GAP;
  }
  // parts outside the branches: next to what they join (mean of the placed
  // parts on their nets), a little below
  const byNet = new Map();
  for (const c of comps) for (const n of c.nodes) { if (!byNet.has(n)) byNet.set(n, []); byNet.get(n).push(c.ref); }
  for (let pass = 0; pass < 3; pass++) for (const c of comps) {
    if (pos.has(c.ref)) continue;
    const near = c.nodes.flatMap((n) => byNet.get(n) || []).filter((r) => r !== c.ref && pos.has(r)).map((r) => pos.get(r));
    if (!near.length) continue;
    const mx = near.reduce((p, q) => p + q.x, 0) / near.length, my = near.reduce((p, q) => p + q.y, 0) / near.length;
    const role = a.roles[c.ref];
    pos.set(c.ref, { x: mx + (role === 'coupling' ? COL / 2 : 0.6), y: my + (role === 'feedback' ? ROW : role === 'bias' ? 0 : 0.8) });
  }
  // anything still unplaced: a row below everything
  let maxY = 0; for (const p of pos.values()) maxY = Math.max(maxY, p.y);
  let k = 0;
  for (const c of comps) if (!pos.has(c.ref)) pos.set(c.ref, { x: COL * k++, y: maxY + ROW * 1.5 });
  return pos;
}

/** Engine "stages": the stage layout refined and wired by place-sa. */
export async function importNetlistStages(model, parsed, opts = {}) {
  const a = analyseStages(parsed);
  const saInit = stageLayout(parsed, a);
  return importNetlistSA(model, parsed, { ...opts, saInit, saT0: opts.saT0 ?? 0.15, saIters: opts.saIters ?? Math.min(8000, 250 * parsed.components.length) });
}
