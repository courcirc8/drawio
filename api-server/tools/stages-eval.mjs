#!/usr/bin/env node
/**
 * stages-eval.mjs — coverage of lib/stages.js on the measurement perimeter
 * (≤ 25 parts, exact netlists: every bank exclusion applied, sealed refused):
 * share of transistors with a role, share of parts in a stage, roles left
 * 'unknown' by source, and a few full readings to check by hand.
 * Usage: node tools/stages-eval.mjs [--max-parts 25] [--show N] [--ids a,b]
 */
import fs from 'node:fs';
import { parseSpice } from '../lib/netlist.js';
import { analyseStages } from '../lib/stages.js';
import { bankExclusions, sealedStatus } from '../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const B = '/AI/datasets/netlists/bank', MAX = Number(arg('--max-parts', 25)) || Infinity, SHOW = Number(arg('--show', 0));
const IDS = arg('--ids') ? new Set(arg('--ids').split(',')) : null;
const ex = bankExclusions(B);
const man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(`${B}/${f}`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).map((r) => [r.id, r.file]));
const inv = fs.readFileSync(`${B}/inventory.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && r.parts <= MAX && (!IDS || IDS.has(r.id)));
const tot = { n: 0, act: 0, actR: 0, parts: 0, inStage: 0, withRole: 0, fail: 0 }, unk = {}, roleCount = {}, bySrc = {};
const shown = [];
for (const r of inv) {
  const text = fs.readFileSync(man.get(r.id), 'utf8');
  if (sealedStatus(text)) continue;
  let a; try { a = analyseStages(parseSpice(text)); } catch (e) { tot.fail++; continue; }
  tot.n++; const c = a.coverage;
  tot.act += c.actives; tot.actR += c.activesWithRole; tot.parts += c.parts; tot.inStage += c.partsInStage; tot.withRole += c.partsWithRole;
  const s = (bySrc[r.source] ||= { act: 0, actR: 0 }); s.act += c.actives; s.actR += c.activesWithRole;
  for (const [ref, role] of Object.entries(a.roles)) { roleCount[role] = (roleCount[role] || 0) + 1; if (role === 'unknown') unk[r.source] = (unk[r.source] || 0) + 1; }
  if (shown.length < SHOW || IDS) shown.push({ id: r.id, family: r.family, stages: a.stages.map((st) => `${st.id} r${st.rank} ${st.kind} [${st.columns.map((col) => col.join('>')).join(' | ')}]`), roles: a.roles });
}
const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(1) + ' %';
console.log(`circuits ${tot.n} (échecs ${tot.fail}) — transistors avec rôle ${pct(tot.actR, tot.act)} (${tot.act}) ; composants avec rôle ${pct(tot.withRole, tot.parts)} ; composants dans un étage ${pct(tot.inStage, tot.parts)}`);
console.log('par source (transistors avec rôle):', Object.fromEntries(Object.entries(bySrc).map(([k, v]) => [k, pct(v.actR, v.act)])));
console.log('rôles:', Object.entries(roleCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
for (const s of shown) console.log('\n' + s.id, s.family, '\n  ' + s.stages.join('\n  ') + '\n  rôles: ' + Object.entries(s.roles).map(([k, v]) => `${k}=${v}`).join(' '));
