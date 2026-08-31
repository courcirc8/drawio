/**
 * optimize.js — recherche locale sur les paramètres de place2 : chaque
 * candidat est régénéré (placement + routage), rejeté si le LVS round-trip ne
 * matche pas (gate de correction), puis noté par beauty.py ; on garde le
 * meilleur (hill-climbing avec redémarrages aléatoires légers).
 */
import { newDocument, getPage, normalizeOrigin } from './model.js';
import { importNetlist2 } from './place2.js';
import { importNetlist3 } from './place3.js';
import { routePage } from './route.js';
import { extractNetlist } from './netlist.js';
import { compare } from './lvs.js';
import { scoreDocument } from './beauty.js';

/**
 * score_raw is beauty.py's score BEFORE the [0,100] clamp (tools/beauty.py,
 * 2026-08-28). On any drawing whose penalties exceed 100 — every RF netlist
 * this optimizer sees — score_partial/score clamp to exactly 0.0, so
 * `cand.score > best.score` in optimizeNetlist() below was always `0 > 0`:
 * false, every candidate rejected, ?optimize=N returning the plain import
 * byte-for-byte. Rank on score_raw (unclamped, can be negative/over 100),
 * falling back to score_partial/score only when a candidate's beauty.py run
 * did not produce score_raw (e.g. an older beauty.py, or the missing-PNG
 * path) — see rankValue().
 */
function rankValue(b) {
  if (b == null) return -Infinity;
  if (b.score_raw != null) return b.score_raw;
  if (b.score != null) return b.score;
  if (b.score_partial != null) return b.score_partial;
  return -Infinity;
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

async function evaluate(parsed, params, reference, engine) {
  const doc = newDocument();
  const m = getPage(doc);
  // Anything other than 'v3' reproduces exactly today's behaviour (place2) —
  // server.js's ?optimize=N path always used place2 regardless of `engine`
  // before this change, and gen_baseline.py's 'opt' row never passes an
  // engine query param at all, so both must keep landing here.
  const placed = engine === 'v3' ? importNetlist3(m, parsed, params) : importNetlist2(m, parsed, params);
  await routePage(m, placed.wires, {});
  // Same normalisation the /netlist/import path applies -- and it must happen
  // BEFORE scoreDocument(), which renders a PNG and would otherwise score a
  // clipped image (cv2 terms) while the geometry terms saw the full model.
  normalizeOrigin(m);
  const lvs = compare(extractNetlist(m), parsed);
  if (!lvs.match) return { ok: false, reason: 'lvs', lvs };
  const b = await scoreDocument(doc, m, { reference });
  return { ok: true, doc, placed, score: b.score, score_raw: b.score_raw, score_partial: b.score_partial,
    metrics: b.metrics, params };
}

function perturb(rnd, base, placedInfo) {
  const p = { ...base, order: [...(base.order || [])], flip: { ...(base.flip || {}) },
    flipPairs: [...(base.flipPairs || [])], rowOffset: { ...(base.rowOffset || {}) } };
  const roots = placedInfo.roots || [];
  const flippable = placedInfo.flippable || [];
  const pairs = placedInfo.pairs || [];
  // place2 never sets `secondaryRows` (its layout has no equivalent — the
  // "rows" there are fixed conduction levels, not a repositionable chain),
  // so `rows.length` is always 0 for a v2 candidate and `n` below reduces to
  // exactly the old `pairs.length ? 5 : 4` — v2's RNG draw sequence, and
  // therefore its whole optimize trajectory for a given seed, is unchanged.
  const rows = placedInfo.secondaryRows || [];
  const n = (pairs.length ? 5 : 4) + (rows.length ? 1 : 0);
  const move = Math.floor(rnd() * n);
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
  } else if (move === (pairs.length ? 5 : 4) && rows.length) {
    // place3-only move: nudge how far a source-less secondary chain (e.g.
    // the RX branch hanging off the shared node in matching_915/2446) sits
    // from the axis it hangs off. place2 candidates never reach here (rows
    // is always empty for them, see comment above).
    const rid = rows[Math.floor(rnd() * rows.length)];
    const cur = p.rowOffset[rid] || 0;
    p.rowOffset[rid] = Math.max(-120, Math.min(120, cur + (rnd() < 0.5 ? -20 : 20)));
  } else {
    // symétriser/désymétriser une paire différentielle (flip miroir) — the
    // original catch-all; unchanged, including its behaviour when
    // `pairs` is empty (pairs[NaN] -> undefined pushed into flipPairs is a
    // pre-existing quirk, kept bug-for-bug for v2 compatibility).
    const key = pairs[Math.floor(rnd() * pairs.length)];
    const i = p.flipPairs.indexOf(key);
    if (i >= 0) p.flipPairs.splice(i, 1); else p.flipPairs.push(key);
  }
  return p;
}

export async function optimizeNetlist(parsed, { iterations = 10, reference = null, seed = 42, engine } = {}) {
  const rnd = mulberry(seed);
  const history = [];
  let best = await evaluate(parsed, {}, reference, engine);
  if (!best.ok) throw new Error('placement initial rejeté par le LVS: ' + JSON.stringify(best.lvs).slice(0, 300));
  history.push({ iter: 0, score: best.score, score_raw: best.score_raw, accepted: true });
  let bestRank = rankValue(best);
  for (let i = 1; i <= iterations; i++) {
    const cand = await evaluate(parsed, perturb(rnd, best.params, best.placed), reference, engine);
    const candRank = cand.ok ? rankValue(cand) : -Infinity;
    const accepted = cand.ok && candRank > bestRank;
    history.push({ iter: i, score: cand.ok ? cand.score : null, score_raw: cand.ok ? cand.score_raw : null,
      accepted, rejected: cand.ok ? undefined : cand.reason });
    if (accepted) { best = cand; bestRank = candRank; }
  }
  return { best, history };
}
