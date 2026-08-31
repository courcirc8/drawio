/**
 * optimize.js — recherche locale sur les paramètres de place2 : chaque
 * candidat est régénéré (placement + routage), rejeté si le LVS round-trip ne
 * matche pas (gate de correction), puis noté par beauty.py ; on garde le
 * meilleur (hill-climbing avec redémarrages aléatoires légers).
 */
import { newDocument, getPage, serialize, parseDrawio } from './model.js';
import { importNetlist2 } from './place2.js';
import { importNetlist3 } from './place3.js';
import { routePage } from './route.js';
import { extractNetlist } from './netlist.js';
import { compare } from './lvs.js';
import { scoreDocument } from './beauty.js';
import { compactPage, fastScore } from './compact.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE2 = path.dirname(fileURLToPath(import.meta.url));
let chkSeq = 0;
/** Erreurs du checker Python indépendant (tools/check.py) sur un document.
 * C'est LE juge final : un candidat plus joli mais fautif ne gagne jamais. */
function checkErrors(doc) {
  try {
    const tmp = path.join(os.tmpdir(), `optchk-${process.pid}-${++chkSeq}.xml`);
    fs.writeFileSync(tmp, serialize(doc));
    const r = spawnSync('python3', [path.join(HERE2, '../tools/check.py'), tmp, '--json'],
      { encoding: 'utf8', timeout: 15000 });
    fs.unlinkSync(tmp);
    const j = JSON.parse(r.stdout || '{}');
    return Number.isInteger(j.errors) ? j.errors : 99;
  } catch { return 99; }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `engine` passthrough restored in the 2026-08-31 merge. Anything other than
 * 'v3' regenerates candidates with place2 exactly as before; 'v3' uses place3
 * (source-less RF chains), which is the placer the RF netlists need — without
 * this, `?optimize=N&engine=v3` silently optimised a place2 layout and then
 * returned it, so the answer had nothing to do with the requested engine.
 */
async function evaluate(parsed, params, reference, fast = false, engine = 'v2') {
  const doc = newDocument();
  const m = getPage(doc);
  const placed = engine === 'v3' ? importNetlist3(m, parsed, params) : importNetlist2(m, parsed, params);
  const r = await routePage(m, placed.wires, {});
  if (r.failed != null) return { ok: false, reason: r.failed };
  const lvs = compare(extractNetlist(m), parsed);
  if (!lvs.match) return { ok: false, reason: 'lvs', lvs };
  if (fast) {
    // score géométrique seul (~10x plus rapide) : pré-filtre du faisceau
    const s = await fastScore(m);
    return { ok: true, doc, m, placed, score: s, params, fast: true };
  }
  const b = await scoreDocument(doc, m, { reference });
  return { ok: true, doc, m, placed, score: b.score, score_raw: b.score_raw, metrics: b.metrics, params };
}

function perturb(rnd, base, placedInfo) {
  const p = { ...base, order: [...(base.order || [])], flip: { ...(base.flip || {}) },
    flipPairs: [...(base.flipPairs || [])],
    childOrder: JSON.parse(JSON.stringify(base.childOrder || {})) };
  const roots = placedInfo.roots || [];
  const flippable = placedInfo.flippable || [];
  const structured = new Set(placedInfo.structuredRefs || []);
  const fanouts = placedInfo.fanouts || {};
  // seuls les fanouts SANS structure reconnue sont permutables : les paires,
  // quads, miroirs et queues sont des INVARIANTS (règles utilisateur)
  const fanoutNets = Object.keys(fanouts).filter((n) => !fanouts[n].some((r) => structured.has(r)));
  const nMoves = 4 + (fanoutNets.length ? 1 : 0);
  const move = Math.floor(rnd() * nMoves);
  if (move === 0 && roots.length > 1) {
    const order = p.order.length ? p.order : [...roots];
    const i = Math.floor(rnd() * order.length);
    const j = Math.floor(rnd() * order.length);
    [order[i], order[j]] = [order[j], order[i]];
    p.order = order;
  } else if (move === 1 && flippable.length) {
    const r = flippable[Math.floor(rnd() * flippable.length)];
    p.flip[r] = !p.flip[r];
  } else if (move === 2) {
    p.colW = Math.max(150, Math.min(260, (p.colW || 190) + (rnd() < 0.5 ? -20 : 20)));
  } else if (move === 3) {
    p.rowH = Math.max(150, Math.min(240, (p.rowH || 180) + (rnd() < 0.5 ? -20 : 20)));
  } else if (fanoutNets.length) {
    // permuter deux colonnes SŒURS sous un même fanout (ex: quad du Gilbert)
    const net = fanoutNets[Math.floor(rnd() * fanoutNets.length)];
    const cur = p.childOrder[net] || [...fanouts[net]];
    const i = Math.floor(rnd() * cur.length);
    const j = Math.floor(rnd() * cur.length);
    [cur[i], cur[j]] = [cur[j], cur[i]];
    p.childOrder[net] = cur;
  }
  return p;
}

/**
 * Rank on the UNCLAMPED score when beauty.py provides one. `score` is clamped
 * to [0,100]; on a drawing that scores badly enough every candidate pins to
 * exactly 0.0 and any `a.score > b.score` tie-break goes inert -- that is what
 * made `?optimize=N` return a byte-identical document on the RF netlists.
 */
const rankValue = (r) => (r == null ? -Infinity : (r.score_raw != null ? r.score_raw : r.score));

export async function optimizeNetlist(parsed, { iterations = 10, reference = null, seed = 42, engine = 'v2' } = {}) {
  const rnd = mulberry(seed);
  const history = [];
  // ---- recherche à FAISCEAU sur score rapide (géométrie seule)
  const beamW = 4;
  const generations = Math.max(2, Math.round(iterations / 4));
  const seed0 = await evaluate(parsed, {}, reference, true, engine);
  if (!seed0.ok) throw new Error('placement initial rejeté par le LVS: ' + JSON.stringify(seed0.lvs).slice(0, 300));
  let beam = [seed0];
  history.push({ iter: 'g0', score: seed0.score, accepted: true });
  for (let g = 1; g <= generations; g++) {
    const cands = [...beam];
    for (const parent of beam) {
      for (let k = 0; k < Math.ceil(8 / beam.length); k++) {
        const c = await evaluate(parsed, perturb(rnd, parent.params, parent.placed), reference, true, engine);
        if (c.ok) cands.push(c);
      }
    }
    cands.sort((a, b) => b.score - a.score);
    beam = cands.slice(0, beamW);
    history.push({ iter: 'g' + g, score: beam[0].score, beam: beam.map((b) => b.score) });
  }
  // ---- finalistes : score complet (rendu + OpenCV)
  let best = null;
  const finReasons = [];
  const finalists = [seed0, ...beam.slice(0, 3).filter((b) => b !== seed0)];
  for (const fin of finalists) {
    const full = await evaluate(parsed, fin.params, reference, false, engine);
    if (!full.ok) { finReasons.push(full.reason); continue; }
    // gate du checker indépendant : moins d'erreurs d'abord, score ensuite
    full.checkErrors = checkErrors(full.doc);
    if (best == null || full.checkErrors < best.checkErrors ||
        (full.checkErrors === best.checkErrors && rankValue(full) > rankValue(best))) best = full;
  }
  if (best == null) throw new Error('aucun finaliste valide: ' + finReasons.join(','));
  history.push({ iter: 'final', score: best.score, checkErrors: best.checkErrors, accepted: true });
  // S3 : compaction finale, gardée par LVS + score (avec restauration)
  try {
    const backup = serialize(best.doc);
    const m = getPage(best.doc);
    const before = rankValue(best);
    await compactPage(m);
    const lvs = compare(extractNetlist(m), parsed);
    const b = lvs.match ? await scoreDocument(best.doc, m, { reference }) : null;
    const cAfter = b != null ? checkErrors(best.doc) : 99;
    if (b != null && rankValue(b) >= before && cAfter <= (best.checkErrors ?? 99)) {
      best = { ...best, score: b.score, score_raw: b.score_raw, metrics: b.metrics };
      history.push({ iter: 'compact', score: b.score, accepted: true });
    } else {
      best.doc = parseDrawio(backup);
      history.push({ iter: 'compact', score: b ? b.score : null, accepted: false });
    }
  } catch (e) { history.push({ iter: 'compact', accepted: false, rejected: String(e).slice(0, 120) }); }
  return { best, history };
}
