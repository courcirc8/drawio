/**
 * sealed.js — the guard that keeps the 50 sealed evaluation circuits (and their
 * variants) out of every tuning and measuring tool.
 *
 * benchmark/sealed-50.json (in the repository) holds only the sha256 and WL
 * fingerprint of each sealed netlist; the files and their variant fingerprints
 * live in SEALED_DIR on the station (tools/seal-eval.mjs). A tool that loads a
 * netlist for tuning calls assertNotSealed(text); a tool that walks the bank
 * calls bankExclusions() and skips those ids.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseSpice } from './netlist.js';
import { fingerprint, variantSimilarity } from './fingerprint.js';
import { detectMotifs } from './motifs.js';

const MANIFEST = new URL('../benchmark/sealed-50.json', import.meta.url);
let SEALED = undefined;

function load() {
  if (SEALED !== undefined) return SEALED;
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    let fps = [];
    try { fps = JSON.parse(fs.readFileSync(`${m.sealedDir}/fingerprints.json`, 'utf8')); } catch { /* not on the station: hashes only */ }
    SEALED = { sha: new Set(m.circuits.map((c) => c.sha256)), wl: new Set(m.circuits.map((c) => c.wl)), fps, rule: m.variantRule };
  } catch { SEALED = null; }
  return SEALED;
}

/** 'sealed', 'variant' or null for a netlist text. `family` (a SOURCE label,
 *  not a recognizer guess) makes the motif-signature rule the same as the one
 *  tools/seal-eval.mjs applied (same family required); without it the rule is
 *  applied across families — stricter, used when the family is unknown. */
export function sealedStatus(text, { family = null } = {}) {
  const s = load();
  if (s == null) return null;
  if (s.sha.has(crypto.createHash('sha256').update(text).digest('hex'))) return 'sealed';
  let p; try { p = parseSpice(text); } catch { return null; }
  const f = fingerprint(p);
  if (s.wl.has(f.wl)) return 'sealed';
  const sig = [...new Set(detectMotifs(p).instances.map((i) => i.motif))].sort().join('+');
  const parts = p.components.length;
  for (const d of s.fps) {
    if (variantSimilarity(d.local, f.local) >= s.rule.localSimilarity) return 'variant';
    if ((family == null || d.family === family) && d.motifSig === sig && Math.abs(d.parts - parts) <= s.rule.sameFamilyMotifsSizeTol * Math.max(d.parts, parts)) return 'variant';
  }
  return null;
}

/** Throws when a tuning tool is about to use a sealed circuit or a variant. */
export function assertNotSealed(text, where = '', opts = {}) {
  const st = sealedStatus(text, opts);
  if (st) throw new Error(`refused: ${st} evaluation circuit${where ? ' (' + where + ')' : ''} — sealed for the final human rating`);
}

/** Set of bank ids excluded by tools/seal-eval.mjs (excluded.jsonl) and by
 *  tools/filter-sealed.mjs for later sources (excluded-<source>.jsonl). */
export function bankExclusions(bank = '/AI/datasets/netlists/bank') {
  const ids = new Set();
  let names = [];
  try { names = fs.readdirSync(bank).filter((n) => /^excluded(-[\w-]+)?\.jsonl$/.test(n)); } catch { return ids; }
  for (const n of names) {
    for (const l of fs.readFileSync(`${bank}/${n}`, 'utf8').split('\n')) if (l.trim()) ids.add(JSON.parse(l).id);
  }
  return ids;
}
