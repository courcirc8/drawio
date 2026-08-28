/**
 * optimize.js — recherche locale sur les paramètres de place2 : chaque
 * candidat est régénéré (placement + routage), rejeté si le LVS round-trip ne
 * matche pas (gate de correction), puis noté par beauty.py ; on garde le
 * meilleur (hill-climbing avec redémarrages aléatoires légers).
 */
import { newDocument, getPage, serialize, parseDrawio } from './model.js';
import { importNetlist2 } from './place2.js';
import { routePage } from './route.js';
import { extractNetlist } from './netlist.js';
import { compare } from './lvs.js';
import { scoreDocument } from './beauty.js';
import { compactPage } from './compact.js';

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function evaluate(parsed, params, reference) {
  const doc = newDocument();
  const m = getPage(doc);
  const placed = importNetlist2(m, parsed, params);
  await routePage(m, placed.wires, {});
  const lvs = compare(extractNetlist(m), parsed);
  if (!lvs.match) return { ok: false, reason: 'lvs', lvs };
  const b = await scoreDocument(doc, m, { reference });
  return { ok: true, doc, placed, score: b.score, metrics: b.metrics, params };
}

function perturb(rnd, base, placedInfo) {
  const p = { ...base, order: [...(base.order || [])], flip: { ...(base.flip || {}) },
    flipPairs: [...(base.flipPairs || [])] };
  const roots = placedInfo.roots || [];
  const flippable = placedInfo.flippable || [];
  const pairs = placedInfo.pairs || [];
  const move = Math.floor(rnd() * (pairs.length ? 5 : 4));
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
  } else {
    // symétriser/désymétriser une paire différentielle (flip miroir)
    const key = pairs[Math.floor(rnd() * pairs.length)];
    const i = p.flipPairs.indexOf(key);
    if (i >= 0) p.flipPairs.splice(i, 1); else p.flipPairs.push(key);
  }
  return p;
}

export async function optimizeNetlist(parsed, { iterations = 10, reference = null, seed = 42 } = {}) {
  const rnd = mulberry(seed);
  const history = [];
  let best = await evaluate(parsed, {}, reference);
  if (!best.ok) throw new Error('placement initial rejeté par le LVS: ' + JSON.stringify(best.lvs).slice(0, 300));
  history.push({ iter: 0, score: best.score, accepted: true });
  for (let i = 1; i <= iterations; i++) {
    const cand = await evaluate(parsed, perturb(rnd, best.params, best.placed), reference);
    const accepted = cand.ok && cand.score > best.score;
    history.push({ iter: i, score: cand.ok ? cand.score : null, accepted, rejected: cand.ok ? undefined : cand.reason });
    if (accepted) best = cand;
  }
  // S3 : compaction finale, gardée par LVS + score (avec restauration)
  try {
    const backup = serialize(best.doc);
    const m = getPage(best.doc);
    const before = best.score;
    await compactPage(m);
    const lvs = compare(extractNetlist(m), parsed);
    const b = lvs.match ? await scoreDocument(best.doc, m, { reference }) : null;
    if (b != null && b.score >= before) {
      best = { ...best, score: b.score, metrics: b.metrics };
      history.push({ iter: 'compact', score: b.score, accepted: true });
    } else {
      best.doc = parseDrawio(backup);
      history.push({ iter: 'compact', score: b ? b.score : null, accepted: false });
    }
  } catch (e) { history.push({ iter: 'compact', accepted: false, rejected: String(e).slice(0, 120) }); }
  return { best, history };
}
