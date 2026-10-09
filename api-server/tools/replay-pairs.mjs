#!/usr/bin/env node
/**
 * replay-pairs.mjs — Eric's blind pair series replayed with auto as it is now:
 * for every answered pair (a preference, not "equal"), the netlist is drawn
 * again and the candidate auto now keeps is compared with the two labels of
 * the pair. Agrees = auto keeps the drawing Eric preferred; disagrees = it
 * keeps the one he rejected; other = a third candidate (not judged).
 * Old behaviour: AUTO_CRITERION=checker AUTO_STAGES=0 AUTO_POLISH=0 AUTO_WIRE_NAMES=0.
 * Usage: node tools/replay-pairs.mjs [--batches eric-paires,eric-paires-2,eric-paires-3]
 */
import fs from 'node:fs';
import { parseSpice } from '../lib/netlist.js';
import { autoPlace } from '../lib/auto.js';
import { sealedStatus } from '../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BATCHES = arg('--batches', 'eric-paires,eric-paires-2,eric-paires-3').split(',');
const BANK = '/AI/datasets/netlists/bank', C = '/AI/datasets/judge/compare';
const jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const man = new Map(fs.readdirSync(BANK).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${BANK}/${f}`)).map((r) => [r.id, r]));
const tot = { agree: 0, disagree: 0, other: 0 };
for (const b of BATCHES) {
  const items = new Map(jsonl(`${C}/${b}/items.jsonl`).map((x) => [x.n, x]));
  const st = { agree: 0, disagree: 0, other: 0 };
  for (const a of jsonl(`${C}/${b}/answers.jsonl`)) {
    const it = items.get(a.n);
    if (!it || !['base', 'new'].includes(a.preferred) || !man.has(it.id)) continue;
    const text = fs.readFileSync(man.get(it.id).file, 'utf8');
    if (sealedStatus(text)) continue;
    let r; try { r = await autoPlace(parseSpice(/\.end\b/i.test(text) ? text : text + '\n.end')); } catch { continue; }
    // the grid suffix (@230x220) is not a different drawing style: ignored
    const eng = (l) => String(l).replace(/@.*$/, '');
    const want = it.labels[a.preferred], not = it.labels[a.preferred === 'base' ? 'new' : 'base'];
    const k = eng(r.label) === eng(want) ? 'agree' : eng(r.label) === eng(not) ? 'disagree' : 'other';
    st[k]++; tot[k]++;
    console.error(`${b} #${a.n} ${it.id} ${it.parts} comp. : Eric ${want} / rejeté ${not} -> auto ${r.label} (${k})`);
  }
  console.log(`${b}: d'accord ${st.agree}, contre ${st.disagree}, autre candidat ${st.other}`);
}
console.log(`total: d'accord ${tot.agree}, contre ${tot.disagree}, autre candidat ${tot.other}`);
process.exit(0);
