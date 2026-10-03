#!/usr/bin/env node
/**
 * inventory-bank.mjs — what the quality bank (tools/import-corpora.py) really
 * holds: parsable, drawable, family, size, and a TOPOLOGY FINGERPRINT.
 *
 * Fingerprint: Weisfeiler-Lehman hashing (3 rounds) of the bipartite
 * device/net graph, devices labelled by kind (nmos/pmos/npn/pnp/R/C/L/D/V/I/S/X),
 * nets by role (ground, supply, other) — names and values ignored. `wl` (the
 * full multiset hash) is equal for the same topology; `wlSet` (the label set)
 * lets near variants be found by Jaccard similarity (used to seal circuits).
 *
 * Usable = parsed, 3..150 parts, every part drawable (no unknown subcircuit, no
 * parser warning). Family: the source's label (AnalogGenie id ranges), else
 * the first type of lib/function.js recognizeFunction (a WEAK label, flagged).
 *
 * Writes <bank>/inventory.jsonl; prints counts only.
 * Usage: node tools/inventory-bank.mjs [--bank /AI/datasets/netlists/bank]
 */
import fs from 'node:fs';
import { parseSpice } from '../lib/netlist.js';
import { fingerprint } from '../lib/fingerprint.js';
import { recognizeFunction } from '../lib/function.js';
import { detectMotifs } from '../lib/motifs.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BANK = arg('--bank', '/AI/datasets/netlists/bank');
const DRAWABLE = new Set(['R', 'C', 'L', 'D', 'V', 'I', 'M', 'Q', 'J', 'S', 'E', 'F', 'G', 'B']);

const man = fs.readFileSync(`${BANK}/manifest.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const out = fs.openSync(`${BANK}/inventory.jsonl`, 'w');
const stat = {};
const bump = (k, sub) => { stat[k] ||= {}; stat[k][sub] = (stat[k][sub] || 0) + 1; };
const seenWl = new Map();
for (const r of man) {
  const rec = { id: r.id, source: r.source, family: r.family, familyWeak: false };
  try {
    const p = parseSpice(fs.readFileSync(r.file, 'utf8'));
    const comps = p.components;
    rec.parts = comps.length;
    rec.undrawable = comps.filter((c) => !DRAWABLE.has(c.prefix)).length + (p.warnings || []).length;
    rec.usable = comps.length >= 3 && comps.length <= 150 && rec.undrawable === 0;
    if (rec.usable) {
      const f = fingerprint(p);
      rec.wl = f.wl; rec.wlSet = f.wlSet; rec.local = f.local;
      try { rec.motifSig = [...new Set(detectMotifs(p).instances.map((i) => i.motif))].sort().join('+'); } catch { rec.motifSig = ''; }
      rec.duplicateOf = seenWl.get(f.wl) || null;
      if (!rec.duplicateOf) seenWl.set(f.wl, r.id);
      if (!rec.family) { try { rec.family = recognizeFunction(p).types[0].type; rec.familyWeak = true; } catch { rec.family = 'unknown'; rec.familyWeak = true; } }
    }
  } catch { rec.usable = false; rec.parseError = true; }
  fs.writeSync(out, JSON.stringify(rec) + '\n');
  bump(r.source, rec.parseError ? 'parse-error' : !rec.usable ? 'not-usable' : rec.duplicateOf ? 'duplicate' : 'usable-unique');
}
fs.closeSync(out);
console.log('per source:', JSON.stringify(stat));
