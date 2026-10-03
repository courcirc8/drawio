#!/usr/bin/env node
/**
 * seal-eval.mjs — draw and SEAL the 50 circuits of the final human rating,
 * before any tuning on the bank (plan validated by Eric, 2026-10-03).
 *
 *   - candidates: usable, unique bank circuits with a SOURCE family label
 *     (not a recognizer guess), 4..60 parts, not 'misc', and not close
 *     (same WL, or a variant by isVariant below) to any circuit of benchmark/ (already
 *     seen during the earlier tuning and measurement);
 *   - stratified random draw, fixed seed: per family max(2, round(50·√n/Σ√n)),
 *     trimmed to exactly 50;
 *   - sealed files copied to SEALED_DIR (mode 0700), never into the repository;
 *     the repository gets benchmark/sealed-50.json: sha256 of each file and its
 *     WL fingerprint ONLY (no id, no name), plus the seed and the rules;
 *   - every bank circuit that is a sealed one or a near variant of one is
 *     written to <bank>/excluded.jsonl: tuning tools must skip them
 *     (lib/sealed.js).
 * Prints counts only — the person tuning never sees which circuits were drawn.
 *
 * Also fixes the family split: HOLDOUT_FAMILIES are never used for tuning.
 * Usage: node tools/seal-eval.mjs [--bank DIR] [--sealed DIR] [--seed N] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSpice } from '../lib/netlist.js';
import { fingerprint, variantSimilarity } from '../lib/fingerprint.js';
import { detectMotifs } from '../lib/motifs.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BANK = arg('--bank', '/AI/datasets/netlists/bank');
const SEALED_DIR = arg('--sealed', '/AI/datasets/netlists/sealed');
const SEED = Number(arg('--seed', 20261003));
const N = 50, NEAR = 0.5, SIZE_TOL = 0.3;
/** Variant rule (conservative, measured 2026-10-03: excludes ~30 % of the bank
 *  for 50 sealed circuits): local-neighbourhood similarity >= NEAR, or same
 *  family + same motif set + size within SIZE_TOL. WL Jaccard alone did not
 *  separate known variants (0.10-0.33) from unrelated circuits (0.08-0.19). */
const isVariant = (a, b, sameFamilyNeeded = true) =>
  variantSimilarity(a.local, b.local) >= NEAR ||
  ((!sameFamilyNeeded || a.family === b.family) && a.motifSig === b.motifSig && Math.abs(a.parts - b.parts) <= SIZE_TOL * Math.max(a.parts, b.parts));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, '../benchmark/sealed-50.json');
export const HOLDOUT_FAMILIES = ['regulator', 'sampler-sc', 'data-converter'];
if (fs.existsSync(OUT) && !process.argv.includes('--force')) { console.error('sealed set already exists (benchmark/sealed-50.json): refusing to redraw'); process.exit(1); }

const famOf = (f) => (f === 'adc' || f === 'dac' ? 'data-converter' : f);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const inv = fs.readFileSync(`${BANK}/inventory.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const man = new Map(fs.readFileSync(`${BANK}/manifest.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r]));
// everything already seen: all benchmark netlists of the repository
const seen = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.cir$/.test(e.name)) { try { const pr = parseSpice(fs.readFileSync(p, 'utf8')); seen.push({ ...fingerprint(pr), parts: pr.components.length, motifSig: [...new Set(detectMotifs(pr).instances.map((i) => i.motif))].sort().join('+') }); } catch { /* unparsable */ } } } };
walk(path.join(HERE, '../benchmark'));
const closeToSeen = (r) => seen.some((f) => f.wl === r.wl || isVariant(f, r, false));

const cand = inv.filter((r) => r.usable && !r.duplicateOf && !r.familyWeak && r.family && r.family !== 'misc' && r.parts >= 4 && r.parts <= 60 && !closeToSeen(r));
const byFam = new Map();
for (const r of cand) { const f = famOf(r.family); if (!byFam.has(f)) byFam.set(f, []); byFam.get(f).push(r); }
const fams = [...byFam.keys()].sort();
const sq = fams.map((f) => Math.sqrt(byFam.get(f).length)), S = sq.reduce((a, b) => a + b, 0);
const quota = new Map(fams.map((f, i) => [f, Math.min(byFam.get(f).length, Math.max(2, Math.round(N * sq[i] / S)))]));
while ([...quota.values()].reduce((a, b) => a + b, 0) > N) { const f = [...quota].sort((a, b) => b[1] - a[1])[0][0]; quota.set(f, quota.get(f) - 1); }
while ([...quota.values()].reduce((a, b) => a + b, 0) < N) { const f = fams.find((x) => quota.get(x) < byFam.get(x).length); quota.set(f, quota.get(f) + 1); }

const drawn = [];
for (const f of fams) {
  const pool = [...byFam.get(f)].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let k = 0; k < quota.get(f) && pool.length; k++) {
    // never two near variants in the sealed set itself
    let i = Math.floor(rnd() * pool.length), tries = 0;
    while (tries++ < pool.length && drawn.some((d) => isVariant(d, pool[i]))) i = (i + 1) % pool.length;
    drawn.push({ ...pool[i], fam: f });
    pool.splice(i, 1);
  }
}
fs.mkdirSync(SEALED_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(SEALED_DIR, 0o700);
const entries = [];
drawn.forEach((r, k) => {
  const text = fs.readFileSync(man.get(r.id).file, 'utf8');
  fs.writeFileSync(path.join(SEALED_DIR, `S${String(k + 1).padStart(2, '0')}.cir`), text, { mode: 0o600 });
  entries.push({ slot: k + 1, family: r.fam, sha256: sha(text), wl: r.wl });
});
fs.writeFileSync(path.join(SEALED_DIR, 'fingerprints.json'), JSON.stringify(drawn.map((r) => ({ local: r.local, motifSig: r.motifSig, parts: r.parts, family: r.family }))), { mode: 0o600 });
// exclusions in the bank: sealed + near variants
const ex = fs.openSync(`${BANK}/excluded.jsonl`, 'w');
let nEx = 0;
for (const r of inv) {
  if (!r.local) continue;
  const hit = drawn.find((d) => d.wl === r.wl || isVariant(d, r));
  if (hit) { fs.writeSync(ex, JSON.stringify({ id: r.id, reason: hit.id === r.id ? 'sealed' : 'near-variant' }) + '\n'); nEx++; }
}
fs.closeSync(ex);
fs.writeFileSync(OUT, JSON.stringify({
  doc: 'The 50 circuits of the final human rating, sealed before any tuning on the bank. Files live outside the repository (SEALED_DIR, 0700); here only hashes. Tools must refuse them and their near variants (lib/sealed.js).',
  created: new Date().toISOString().slice(0, 10), seed: SEED, variantRule: { localSimilarity: NEAR, sameFamilyMotifsSizeTol: SIZE_TOL }, sealedDir: SEALED_DIR,
  holdoutFamilies: HOLDOUT_FAMILIES, quota: Object.fromEntries(quota), circuits: entries,
}, null, 1));
console.log(`candidates ${cand.length} in ${fams.length} families; sealed ${entries.length}; bank circuits excluded (sealed + near variants): ${nEx}`);
console.log('quota per family:', JSON.stringify(Object.fromEntries(quota)));
