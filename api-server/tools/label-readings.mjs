#!/usr/bin/env node
/**
 * label-readings.mjs — circuit-type labels for the vision readings of the IEEE
 * figure catalogue (RAG session, ai-station), by lib/function.js
 * recognizeFromLabels (motifs + component kinds of each reading; the readings'
 * netlists are NOT used, their nodes are unreliable).
 *
 * Reads figures.sqlite READ-ONLY, writes one JSONL line per readable figure
 * OUTSIDE the repository (format agreed with the RAG session):
 *   {"paper_id","page","rang","types":[{type,p}×3],"motifs":[…],"version"}
 * Nothing of the corpus is printed: the report holds counts only.
 *
 * Report: agreement of the first type with the CAPTION type (figures.type,
 * independent of the readings), per type —
 *   in-sample: statistics of data/ieee-motifs.json (built from these same
 *              readings, hence optimistic);
 *   2-fold CV: statistics rebuilt from half of the PAPERS, scored on the other half.
 *
 * Usage: node tools/label-readings.mjs [--db PATH] [--out PATH]
 * Requires node >= 22.13 (node:sqlite).
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { recognizeFromLabels, STATS } from '../lib/function.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DB = arg('--db', '/AI/datasets/IEEE/derived/figures.sqlite');
const OUT = arg('--out', '/AI/datasets/IEEE/derived/etiquettes-recognize.jsonl');
const VERSION = 'recognize-1';

const db = new DatabaseSync(DB, { readOnly: true });
const rows = [];
for (const r of db.prepare(`SELECT l.paper_id, l.page, l.rang, l.lecture, f.type AS ctype
  FROM lectures l LEFT JOIN figures f USING (paper_id, page, rang) WHERE l.erreur IS NULL`).all()) {
  let j; try { j = JSON.parse(r.lecture); } catch { continue; }
  if (!j.readable) continue;
  const motifs = [...new Set((j.motifs || []).filter((m) => typeof m === 'string'))];
  const kinds = [...new Set((j.components || []).map((c) => c && c.kind).filter(Boolean))];
  const counts = {};
  for (const c of j.components || []) if (c && c.kind) counts[c.kind] = (counts[c.kind] || 0) + 1;
  rows.push({ paper_id: r.paper_id, page: r.page, rang: r.rang, ctype: r.ctype || null, motifs, kinds, counts });
}

/** Statistics in the shape of data/ieee-motifs.json, rebuilt from `rs`. */
function buildStats(rs) {
  const by = {};
  for (const r of rs) {
    if (!r.ctype) continue;
    const t = (by[r.ctype] ||= { schematics: 0, m: {}, k: {} });
    t.schematics++;
    for (const m of r.motifs) t.m[m] = (t.m[m] || 0) + 1;
    for (const [k, n] of Object.entries(r.counts)) t.k[k] = (t.k[k] || 0) + n;
  }
  const out = { by_type: {} };
  for (const [t, v] of Object.entries(by)) out.by_type[t] = {
    schematics: v.schematics,
    motif_share: Object.fromEntries(Object.entries(v.m).map(([m, n]) => [m, n / v.schematics])),
    component_share: Object.fromEntries(Object.entries(v.k).map(([k, n]) => [k, n / v.schematics])),
  };
  return out;
}

function agreement(rs, statsFor) {
  const per = {};
  let n = 0, top1 = 0, top3 = 0;
  for (const r of rs) {
    if (!r.ctype) continue;
    const ranked = recognizeFromLabels(r, statsFor(r)).types.map((t) => t.type);
    const p = (per[r.ctype] ||= { n: 0, top1: 0 });
    p.n++; n++;
    if (ranked[0] === r.ctype) { p.top1++; top1++; }
    if (ranked.slice(0, 3).includes(r.ctype)) top3++;
  }
  return { n, top1, top3, per };
}

// labels (full statistics)
const fd = fs.openSync(OUT, 'w');
for (const r of rows) {
  const rec = recognizeFromLabels(r);
  fs.writeSync(fd, JSON.stringify({ paper_id: r.paper_id, page: r.page, rang: r.rang,
    types: rec.types.slice(0, 3).map((t) => ({ type: t.type, p: t.p })), motifs: r.motifs, version: VERSION }) + '\n');
}
fs.closeSync(fd);

// agreement with the caption type
const inS = agreement(rows, () => STATS);
const papers = [...new Set(rows.map((r) => r.paper_id))].sort();
const fold = new Map(papers.map((p, i) => [p, i % 2]));
const stats = [0, 1].map((k) => buildStats(rows.filter((r) => fold.get(r.paper_id) !== k)));
const cv = agreement(rows, (r) => stats[fold.get(r.paper_id)]);
const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + ' %' : '-');
console.log(`${rows.length} readable figures labelled -> ${OUT}`);
console.log(`caption-typed figures: ${inS.n}; untyped (labels are new information there): ${rows.length - inS.n}`);
console.log(`agreement with the caption type, top-1 / top-3: in-sample ${pct(inS.top1, inS.n)} / ${pct(inS.top3, inS.n)}; 2-fold CV by paper ${pct(cv.top1, cv.n)} / ${pct(cv.top3, cv.n)}`);
console.log('per type (CV top-1):', Object.entries(cv.per).sort((a, b) => b[1].n - a[1].n).map(([t, v]) => `${t} ${pct(v.top1, v.n)} (${v.n})`).join(', '));
