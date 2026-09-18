#!/usr/bin/env node
/**
 * motif-coverage.mjs — which motifs (lib/motifs.js) a corpus of netlists
 * contains, and which components fall under NO motif: the map of where the
 * template-based placer has nothing to say.
 * Usage: node tools/motif-coverage.mjs <dir-or-files…> [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSpice } from '../lib/netlist.js';
import { detectMotifs, MOTIFS } from '../lib/motifs.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter((a) => !a.startsWith('--')).flatMap((p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.cir')).sort().map((f) => path.join(p, f)) : [p]);
const rows = [];
const totals = {};
for (const f of files) {
  try {
    const r = detectMotifs(parseSpice(fs.readFileSync(f, 'utf8')));
    rows.push({ name: path.basename(f, '.cir'), coverage: r.coverage, activeCoverage: r.activeCoverage, blocks: r.blocks.length, uncoveredActive: r.uncoveredActive, summary: r.summary });
    for (const [k, v] of Object.entries(r.summary)) totals[k] = (totals[k] || 0) + v;
  } catch (e) { rows.push({ name: path.basename(f, '.cir'), error: String(e.message || e) }); }
}
if (json) { console.log(JSON.stringify({ motifs: MOTIFS.map((m) => m.name), rows, totals }, null, 1)); process.exit(0); }
for (const r of rows) {
  if (r.error) { console.log(`${r.name.padEnd(40)} ERROR ${r.error}`); continue; }
  console.log(`${r.name.padEnd(40)} cov=${String(r.coverage).padEnd(5)} act=${String(r.activeCoverage).padEnd(5)} blocks=${r.blocks} ${Object.entries(r.summary).map(([k, v]) => k + (v > 1 ? '×' + v : '')).join(', ')}${r.uncoveredActive.length ? '  UNCOVERED: ' + r.uncoveredActive.join(',') : ''}`);
}
const ok = rows.filter((r) => !r.error);
console.log(`\n${ok.length} circuits — mean coverage ${(ok.reduce((s, r) => s + r.coverage, 0) / ok.length).toFixed(3)}, mean active coverage ${(ok.reduce((s, r) => s + r.activeCoverage, 0) / ok.length).toFixed(3)}, ${ok.filter((r) => r.uncoveredActive.length).length} with uncovered actives`);
console.log('motif totals:', Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
