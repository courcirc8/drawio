/**
 * layout-rules.js — judge v2b in the engine: readable layout conventions of
 * published schematics (data/layout-rules.json, measured on the IEEE DVD
 * figures by tools/judge/layout-rules.py: per part-count bucket, the published
 * level and the no-convention baseline of each trait). Computed here on the
 * EXACT geometry of our drawing, with the same definitions as
 * tools/judge/layout-stats.py (parts = MOS, R, C, I/V sources; unit = median
 * part size; same row/column = centres within 0.3 unit).
 *
 * Satisfaction of a rule = clamp((value - baseline) / (level - baseline), 0, 1):
 * one-sided and capped at the published level, so a drawing more regular than
 * the scans is never penalised. Score = mean satisfaction weighted by
 * level - baseline; null when no rule applies.
 * Used by lib/auto.js only behind AUTO_RULES=1 (measurement, not adopted).
 */
import fs from 'node:fs';
import { allCells, cellInfo } from './model.js';
import { classify, shapeKeyOf } from './components.js';

const TABLE = JSON.parse(fs.readFileSync(new URL('../data/layout-rules.json', import.meta.url), 'utf8')).rules;
const MOS_RULES = new Set(['mos_pair_row', 'mos_mirror_sym', 'mos_stack']);

function partsOf(model) {
  const parts = [], rails = [];
  for (const c of allCells(model).map(cellInfo)) {
    if (c.kind !== 'vertex' || c.x == null) continue;
    const cl = classify(c), key = shapeKeyOf(c) || '';
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    if (cl.role === 'ground') rails.push({ k: 'gnd', y: cy });
    else if (cl.role === 'power') rails.push({ k: /^(vss|gnd|0|vee|avss|dvss)/i.test(String(cl.net)) ? 'gnd' : 'vdd', y: cy });
    else if (cl.role === 'component') {
      const k = /transistors\.(n|p)mos/.test(key) ? 'MOS' : ({ R: 'R', C: 'C', I: 'SRC', V: 'SRC' })[cl.prefix];
      if (k) parts.push({ k, x: cx, y: cy, s: Math.max(c.w, c.h) });
    }
  }
  return { parts, rails };
}

const median = (a) => { const s = [...a].sort((p, q) => p - q); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;

export function layoutTraits(model) {
  const { parts, rails } = partsOf(model);
  if (parts.length < 3) return null;
  const u = median(parts.map((p) => p.s)) || 1;
  const P = parts.map((p) => ({ k: p.k, x: p.x / u, y: p.y / u }));
  const others = (i) => P.filter((_, j) => j !== i);
  const col = mean(P.map((p, i) => (others(i).some((q) => Math.abs(q.x - p.x) < 0.3) ? 1 : 0)));
  const row = mean(P.map((p, i) => (others(i).some((q) => Math.abs(q.y - p.y) < 0.3) ? 1 : 0)));
  const mos = P.filter((p) => p.k === 'MOS');
  let pair = 0, sym = 0;
  if (mos.length >= 2) {
    const cx = mean(mos.map((p) => p.x));
    pair = mean(mos.map((p, i) => (mos.some((q, j) => j !== i && Math.abs(q.y - p.y) < 0.3 && Math.abs(q.x - p.x) < 3) ? 1 : 0)));
    sym = mean(mos.map((p, i) => (mos.some((q, j) => j !== i && Math.abs((q.x - cx) + (p.x - cx)) < 0.4 && Math.abs(q.y - p.y) < 0.3) ? 1 : 0)));
  }
  const my = mean((mos.length ? mos : P).map((p) => p.y));
  const vdd = rails.filter((r) => r.k === 'vdd'), gnd = rails.filter((r) => r.k === 'gnd');
  return {
    n: P.length, nMos: mos.length,
    col_share: col, row_share: row, mos_pair_row: pair, mos_mirror_sym: sym,
    vdd_above: vdd.length ? mean(vdd.map((r) => (r.y / u < my ? 1 : 0))) : 0.5,
    gnd_below: gnd.length ? mean(gnd.map((r) => (r.y / u > my ? 1 : 0))) : 0.5,
  };
}

export const sizeBucket = (n) => (n <= 6 ? '3-6' : n <= 12 ? '7-12' : n <= 25 ? '13-25' : '26+');

/** {score, satisfied:{rule: 0..1}, bucket} or {score:null}. */
export function layoutRulesScore(model) {
  const t = layoutTraits(model);
  if (t == null) return { score: null };
  const rules = TABLE[sizeBucket(t.n)] || {};
  const sat = {}; let num = 0, den = 0;
  for (const [name, [lv, bl]] of Object.entries(rules)) {
    if (MOS_RULES.has(name) && t.nMos < 2) continue;
    const v = t[name];
    if (v == null || ((name === 'vdd_above' || name === 'gnd_below') && v === 0.5)) continue;
    const s = Math.max(0, Math.min(1, (v - bl) / (lv - bl)));
    sat[name] = s; num += s * (lv - bl); den += lv - bl;
  }
  return den ? { score: num / den, satisfied: sat, bucket: sizeBucket(t.n) } : { score: null };
}
