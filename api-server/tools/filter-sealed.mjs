#!/usr/bin/env node
/**
 * filter-sealed.mjs — explicit sealed-circuit filter for a newly imported bank
 * source (orchestrator 2026-10-08: the DVD readings of the RAG are filtered
 * against the 50 sealed circuits BEFORE any use).
 *
 * Every usable netlist of the source goes through lib/sealed.js sealedStatus
 * in its STRICT form (family = null: the motif-signature rule applied across
 * families, since the family of a reading is only the figure type): exact
 * sha256, WL connectivity fingerprint (the netlist-level counterpart of
 * lib/invariant.js, which fingerprints drawn documents and depends on refdes),
 * local-similarity variants, same-motif variants. Hits are appended to
 * <bank>/excluded-<source>.jsonl, read by bankExclusions() like excluded.jsonl.
 *
 * Usage: node tools/filter-sealed.mjs --source dvd-natif [--bank DIR]
 */
import fs from 'node:fs';
import { sealedStatus } from '../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BANK = arg('--bank', '/AI/datasets/netlists/bank');
const SOURCE = arg('--source');
if (!SOURCE) { console.error('usage: --source NAME [--bank DIR]'); process.exit(1); }

const rows = fs.readFileSync(`${BANK}/inventory.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.source === SOURCE);
const files = new Map(fs.readFileSync(`${BANK}/manifest-${SOURCE.replace(/-/g, '')}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m.file]));
const hits = [];
let checked = 0;
for (const r of rows) {
  const f = files.get(r.id);
  if (!f) continue;
  checked++;
  const st = sealedStatus(fs.readFileSync(f, 'utf8'), { family: null });
  if (st) hits.push({ id: r.id, reason: st === 'sealed' ? 'sealed' : 'near-variant', filter: 'filter-sealed strict' });
}
fs.writeFileSync(`${BANK}/excluded-${SOURCE}.jsonl`, hits.map((h) => JSON.stringify(h)).join('\n') + (hits.length ? '\n' : ''));
console.log(`${SOURCE}: ${checked} checked, ${hits.length} refused (sealed ${hits.filter((h) => h.reason === 'sealed').length}, variants ${hits.filter((h) => h.reason !== 'sealed').length}) -> ${BANK}/excluded-${SOURCE}.jsonl`);
