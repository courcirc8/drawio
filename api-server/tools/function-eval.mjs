#!/usr/bin/env node
/**
 * function-eval.mjs — accuracy of lib/function.js recognizeFunction on the
 * hand-labelled TUNING circuits (benchmark/function-labels.json).
 * Usage: node tools/function-eval.mjs [--verbose] [--llm]
 *   --llm : also score retrieval-only, raw LLM and controlled LLM (lib/recognize-llm.js)
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSpice } from '../lib/netlist.js';
import { recognizeFunction } from '../lib/function.js';
import { recognize } from '../lib/recognize-llm.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const B = path.join(HERE, '../benchmark');
const labels = JSON.parse(fs.readFileSync(path.join(B, 'function-labels.json'), 'utf8'));
const dirs = ['netlists30', 'netlists', 'generalization-v1', 'generalization-v2', 'power-v1', 'bjt-v1'];
const verbose = process.argv.includes('--verbose');
let n = 0, top1 = 0, top3 = 0;
const withLLM = process.argv.includes('--llm');
const alt = { neighbours: 0, llmRaw: 0, llmControlled: 0, llmErrors: 0 };
const seen = new Set();
const confusion = {};
for (const d of dirs) for (const f of fs.readdirSync(path.join(B, d)).filter((x) => x.endsWith('.cir'))) {
  const name = f.replace(/\.cir$/, '');
  if (!(name in labels) || seen.has(name)) continue;
  seen.add(name);
  const r = recognizeFunction(parseSpice(fs.readFileSync(path.join(B, d, f), 'utf8')));
  const ranked = r.types.map((t) => t.type);
  const want = labels[name];
  n++; if (ranked[0] === want) top1++; if (ranked.slice(0, 3).includes(want)) top3++;
  if (ranked[0] !== want) confusion[`${want} -> ${ranked[0]}`] = (confusion[`${want} -> ${ranked[0]}`] || 0) + 1;
  if (withLLM) {
    const full = await recognize(parseSpice(fs.readFileSync(path.join(B, d, f), 'utf8')));
    if ((full.neighbours.types[0] || {}).type === want) alt.neighbours++;
    if (full.llm && full.llm.type === want) alt.llmRaw++;
    if (full.type === want) alt.llmControlled++;
    if (full.llm && full.llm.error) alt.llmErrors++;
    if (verbose || full.type !== want) console.log(`  llm ${name.padEnd(26)} want ${want.padEnd(9)} final ${full.type} (${full.source}) llm=${full.llm?.type}${full.llm?.accepted === false ? ' REJECTED' : ''} neighbours=${(full.neighbours.types[0] || {}).type}`);
  }
  if (verbose || ranked[0] !== want) console.log(`${ranked[0] === want ? 'ok  ' : 'MISS'} ${name.padEnd(26)} want ${want.padEnd(9)} got ${r.types.slice(0, 3).map((t) => `${t.type}:${t.p}`).join(' ')}`);
}
console.log(`\n${n} labelled circuits — top-1 ${top1}/${n} (${(100 * top1 / n).toFixed(0)} %), top-3 ${top3}/${n} (${(100 * top3 / n).toFixed(0)} %)`);
console.log('confusions:', JSON.stringify(confusion));
if (withLLM) console.log(`retrieval-only top-1 ${alt.neighbours}/${n}, raw LLM ${alt.llmRaw}/${n}, controlled (final) ${alt.llmControlled}/${n}, LLM errors ${alt.llmErrors}`);
