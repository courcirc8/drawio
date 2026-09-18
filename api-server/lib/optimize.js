/**
 * optimize.js — recherche locale sur les paramètres de place2 : chaque
 * candidat est régénéré (placement + routage), rejeté si le LVS round-trip ne
 * matche pas (gate de correction), puis noté par beauty.py ; on garde le
 * meilleur (hill-climbing avec redémarrages aléatoires légers).
 */
import { newDocument, getPage, serialize, parseDrawio, normalizeOrigin } from './model.js';
import { importNetlist2 } from './place2.js';
import { importNetlist3 } from './place3.js';
import { routePage } from './route.js';
import { extractNetlist } from './netlist.js';
import { compare } from './lvs.js';
import { scoreDocument } from './beauty.js';
import { compactPage, fastScore } from './compact.js';
import { checkDocument } from './check.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE2 = path.dirname(fileURLToPath(import.meta.url));
let chkSeq = 0;
/** Erreurs du checker Python indépendant (tools/check.py) sur un document.
 * C'est LE juge final : un candidat plus joli mais fautif ne gagne jamais. */
function checkErrors(doc) {
  // async (2026-09-18) : spawnSync bloquait la boucle d'événements pendant
  // que les autres finalistes attendaient leur rendu Chrome ; en parallèle
  // (Promise.all ci-dessous) le juge tourne pendant les rendus.
  return new Promise((resolve) => {
    let tmp = null;
    try {
      tmp = path.join(os.tmpdir(), `optchk-${process.pid}-${++chkSeq}.xml`);
      fs.writeFileSync(tmp, serialize(doc));
      const r = spawn('python3', [path.join(HERE2, '../tools/check.py'), tmp, '--json']);
      let so = '';
      r.stdout.on('data', (d) => { so += d; });
      r.stderr.on('data', () => {});
      const timer = setTimeout(() => { r.kill(); }, 15000);
      r.on('close', () => {
        clearTimeout(timer);
        try { fs.unlinkSync(tmp); } catch { /* déjà supprimé */ }
        try { const j = JSON.parse(so || '{}'); resolve(Number.isInteger(j.errors) ? j.errors : 99); }
        catch { resolve(99); }
      });
      r.on('error', () => { clearTimeout(timer); resolve(99); });
    } catch { if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } } resolve(99); }
  });
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
  let placed, r;
  if (engine === 'v4') {
    // macro-blocks (lib/place4.js): the params (order/flip/colW/rowH) reach
    // place2 INSIDE every block; v4 routes hierarchically itself, so no
    // page-wide re-route here (it would erase the frozen intra-block routes)
    const { importNetlist4 } = await import('./place4.js');
    try { placed = await importNetlist4(m, parsed, params); } catch (e) { return { ok: false, reason: 'v4:' + String(e.message || e).slice(0, 80) }; }
    r = placed.routed === false ? { failed: 'v4-route' } : { ids: placed.wires };
  } else {
    placed = engine === 'v3' ? importNetlist3(m, parsed, params) : importNetlist2(m, parsed, params);
    r = await routePage(m, placed.wires, {});
  }
  if (r.failed != null) return { ok: false, reason: r.failed };
  // REGRESSION (2026-08-31 merge): server.js normalises the origin on the plain
  // import path, but the ?optimize=N path returns a document built HERE and
  // never went through it -- the pre-merge optimize.js called this itself and
  // taking feature/api-server's version wholesale dropped the call. place3
  // legitimately emits negative coordinates, and the headless export clamps the
  // clip at 0: measured on matching_2446, C8 sat at y=-52 of its 60 height and
  // came out of the PNG with its top 87% sheared off. After routing, not
  // before: edge waypoints are absolute too.
  normalizeOrigin(m);
  const lvs = compare(extractNetlist(m), parsed);
  if (!lvs.match) return { ok: false, reason: 'lvs', lvs };
  if (fast) {
    // score géométrique seul (~10x plus rapide) : pré-filtre du faisceau,
    // PÉNALISÉ par le checker JS — les wraps/superpositions/through étaient
    // invisibles au score et le faisceau convergeait vers des fautifs que
    // seul le gate final (3 finalistes) pouvait encore écarter
    const s = await fastScore(m);
    // DEFECT (2026-09-06) : fastScore() garantit un nombre fini, mais une
    // erreur d'exécution ou un output malformé pourrait produire NaN/Infinite.
    // Rejeter le candidat ici évite que b.score - a.score trie des NaN
    // (comportement du faisceau qui rend l'optimisation aveugle).
    if (!Number.isFinite(s)) return { ok: false, reason: 'score' };
    let jsErrs = 0;
    try {
      // règle 30 exclue : sa version JS (comptage de branches) sur-flagge
      // là où la version Python (directions) ne voit rien
      jsErrs = checkDocument(m).violations
        .filter((v) => v.severity === 'error' && v.rule !== '30').length;
    } catch { return { ok: false, reason: 'checker-unavailable' }; }
    return { ok: true, doc, m, placed, score: s - 30 * jsErrs, jsErrs, params, fast: true };
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

export async function optimizeNetlist(parsed, { iterations = 10, reference = null, seed = 42, engine = 'v2', preseed = null, preseedScale = null } = {}) {
  const rnd = mulberry(seed);
  const history = [];
  // ---- recherche à FAISCEAU sur score rapide (géométrie seule)
  const beamW = 4;
  const generations = Math.max(2, Math.round(iterations / 4));
  // `preseed` (seeded pre-placement, lib/preplace.js) rides in the params of
  // EVERY candidate: it is a starting geometry, not a post-hoc filter, so the
  // beam must explore perturbations OF the reference layout, not of a layout
  // the reference then overwrites.
  const base = preseed ? { seed: preseed, ...(preseedScale ? { seedScale: preseedScale } : {}) } : {};
  // engine=auto (2026-09-18): the macro-block engine (v4) wins on multi-stage
  // netlists the templates of place2 do not cover and loses on the
  // single-structure circuits place2 was tuned for. Choosing on the SEEDS
  // was measured wrong (benchmark 43: 3 -> 8 errors, the optimizer would have
  // repaired v2's seed defects); both engines are optimised fully and the
  // better FINAL result wins: fewer checker errors, then rank value — the
  // same ordering the finalists already use.
  if (engine === 'auto') {
    const runs = [];
    for (const eng of ['v2', 'v4']) {
      try { runs.push({ eng, ...(await optimizeNetlist(parsed, { iterations, reference, seed, engine: eng, preseed, preseedScale })) }); }
      catch (e) { runs.push({ eng, error: String(e.message || e).slice(0, 120) }); }
    }
    const ok = runs.filter((r) => r.best != null);
    if (!ok.length) throw new Error('auto: both engines failed: ' + runs.map((r) => r.eng + ':' + r.error).join(' | '));
    ok.sort((a, b) => (a.best.checkErrors - b.best.checkErrors) || (rankValue(b.best) - rankValue(a.best)));
    const win = ok[0];
    return { best: win.best, engine: win.eng, history: [{ iter: 'auto', chosen: win.eng, candidates: runs.map((r) => ({ engine: r.eng, errors: r.best?.checkErrors, score: r.best?.score, error: r.error })) }, ...win.history] };
  }
  const seed0 = await evaluate(parsed, base, reference, true, engine);
  // Message d'erreur du fork conservé: `reason` nomme QUELLE porte a rejeté le
  // placement initial (lvs, checker, ERC), et `|| {}` évite un "undefined" quand
  // le rejet n'est pas un échec LVS. Sans ça un rejet checker se lisait comme un
  // rejet LVS avec un objet vide.
  if (!seed0.ok) throw new Error('placement initial rejeté (' + seed0.reason + '): ' + JSON.stringify(seed0.lvs || {}).slice(0, 300));
  let beam = [seed0];
  history.push({ iter: 'g0', score: seed0.score, accepted: true });
  for (let g = 1; g <= generations; g++) {
    const cands = [...beam];
    // PARALLÈLE (2026-09-18) : les paramètres de TOUS les candidats sont tirés
    // d'abord, dans l'ordre historique (le générateur `rnd` n'est consommé
    // que par perturb, la séquence est donc identique à l'ancienne boucle
    // séquentielle), puis évalués ensemble : routage réparti sur le pool de
    // (route.js) et scores python se recouvrent. L'ordre de `cands` est
    // conservé, donc le tri et le faisceau sont byte-identiques au
    // séquentiel — seul le temps change (mesuré : 8 évaluations rapides
    // 376 ms → 111 ms ; le gros du temps reste les rendus des finalistes).
    const paramSets = [];
    for (const parent of beam) {
      for (let k = 0; k < Math.ceil(8 / beam.length); k++) paramSets.push(perturb(rnd, parent.params, parent.placed));
    }
    const evals = await Promise.all(paramSets.map((ps) => evaluate(parsed, ps, reference, true, engine)));
    for (const c of evals) if (c.ok) cands.push(c);
    cands.sort((a, b) => b.score - a.score);
    beam = cands.slice(0, beamW);
    history.push({ iter: 'g' + g, score: beam[0].score, beam: beam.map((b) => b.score) });
  }
  // ---- finalistes : score complet (rendu + OpenCV)
  let best = null;
  const finReasons = [];
  const finalists = [seed0, ...beam.slice(0, 3).filter((b) => b !== seed0)];
  // Les finalistes sont rendus EN SÉQUENCE : mesuré le 2026-09-18, quatre
  // pages Chrome (snap Chromium) en parallèle prennent 149 s contre 5 s en
  // série — ne pas « optimiser » ceci sans re-mesurer sur l'hôte cible. Le
  // juge python, lui, est asynchrone et ne bloque plus la boucle.
  const fulls = [];
  for (const fin of finalists) {
    const full = await evaluate(parsed, fin.params, reference, false, engine);
    if (full.ok) full.checkErrors = await checkErrors(full.doc);
    fulls.push(full);
  }
  for (const full of fulls) {
    if (!full.ok) { finReasons.push(full.reason); continue; }
    if (best == null || full.checkErrors < best.checkErrors ||
        (full.checkErrors === best.checkErrors && rankValue(full) > rankValue(best))) best = full;
  }
  if (best == null) throw new Error('aucun finaliste valide: ' + finReasons.join(','));
  history.push({ iter: 'final', score: best.score, checkErrors: best.checkErrors, accepted: true });
  // S3 : compaction finale, gardée par LVS + score (avec restauration)
  const backup = serialize(best.doc);
  try {
    const m = getPage(best.doc);
    const before = rankValue(best);
    await compactPage(m);
    normalizeOrigin(m); // compaction moves cells; it can push them negative again
    const lvs = compare(extractNetlist(m), parsed);
    const b = lvs.match ? await scoreDocument(best.doc, m, { reference }) : null;
    const cAfter = b != null ? await checkErrors(best.doc) : 99;
    if (b != null && rankValue(b) >= before && cAfter <= (best.checkErrors ?? 99)) {
      best = { ...best, score: b.score, score_raw: b.score_raw, metrics: b.metrics, checkErrors: cAfter };
      history.push({ iter: 'compact', score: b.score, accepted: true });
    } else {
      best.doc = parseDrawio(backup);
      history.push({ iter: 'compact', score: b ? b.score : null, accepted: false });
    }
  } catch (e) { best.doc = parseDrawio(backup); history.push({ iter: 'compact', accepted: false, rejected: String(e).slice(0, 120) }); }
  return { best, history, engine };
}
