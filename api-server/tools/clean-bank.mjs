#!/usr/bin/env node
/**
 * clean-bank.mjs — measurement-bank hygiene decided by Eric (2026-10-09).
 *
 * 1. FLATTENED BLOCKS: an AnalogGenie entry whose ORIGINAL netlist
 *    (Dataset/<n>/<n>.cir) repeats an instance name (MM0 ... MM0) carries a
 *    sub-block flattened into the top level; the bank copy renamed the
 *    duplicates (MM0_2), so the defect is invisible there. Such entries are
 *    removed from measurement: <bank>/excluded-analoggenie-flat.jsonl, read by
 *    lib/sealed.js bankExclusions() like every excluded*.jsonl.
 * 2. SAMPLER / SWITCHED-CAPACITOR family (one of the never-seen families, thin
 *    once the flattened entries are gone): circuits of sources never tuned on
 *    (dvd-natif, openpdk) are relabelled sampler-sc when
 *      - dvd-natif: the figure caption names a sample-and-hold, track-and-hold,
 *        S/H, T/H or a switched-capacitor circuit (not a switched-capacitor
 *        bank of a VCO);
 *      - openpdk: the cell name says bootstrapped S/H switch, SC integrator or
 *        switched-capacitor CMFB.
 *    Written to <bank>/family-overrides.jsonl, applied by inventory-bank.mjs.
 * Entries with a shared AnalogGenie image stay as netlists (their image is
 * never shown: tools/eric-pairs-batch.mjs). Nothing of the corpus goes to Git:
 * only these rules; the id lists stay in the bank.
 * Usage: node tools/clean-bank.mjs [--bank DIR]   then   node tools/inventory-bank.mjs
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BANK = arg('--bank', '/AI/datasets/netlists/bank');
const AG = '/AI/datasets/netlists/AnalogGenie/Dataset';
const NATIF = '/AI/datasets/IEEE/derived/schemas-natif-2026-10-08.jsonl';
const jsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const manifests = fs.readdirSync(BANK).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${BANK}/${f}`));

// 1. flattened AnalogGenie blocks
const flat = [];
for (const r of manifests.filter((m) => m.source === 'analoggenie')) {
  const k = r.id.slice(r.id.indexOf('/') + 1), f = `${AG}/${k}/${k}.cir`;
  if (!fs.existsSync(f)) continue;
  const refs = fs.readFileSync(f, 'utf8').split('\n').filter((l) => /^[MQRCLDX]/i.test(l)).map((l) => l.split(/\s+/)[0].toUpperCase());
  if (new Set(refs).size !== refs.length) flat.push({ id: r.id, reason: 'flattened-block', filter: 'clean-bank' });
}
fs.writeFileSync(`${BANK}/excluded-analoggenie-flat.jsonl`, flat.map((x) => JSON.stringify(x)).join('\n') + '\n');

// 2. sampler / switched-capacitor relabelling
const CAPTION = /sample[- ]?and[- ]?hold|track[- ]?and[- ]?hold|\bS\/H\b|\bT\/H\b|switched[- ]capacitor (integrator|filter|amplifier|circuit|common[- ]mode|cmfb)|opamp and switched-capacitor/i;
const NOT = /capacitor bank/i;
const NAME = /(^|[_-])sh_bsw|sc_integrator|cmfb_sc|output_switched_cap/i;
const ids = new Set(manifests.map((m) => m.id));
const over = [];
if (fs.existsSync(NATIF)) for (const r of jsonl(NATIF)) {
  const id = 'dvd-natif/' + `${r.paper_id}_p${r.page}_r${r.rang}`.replace(/[^A-Za-z0-9]+/g, '_');
  if (ids.has(id) && CAPTION.test(r.legende || '') && !NOT.test(r.legende || '')) over.push({ id, family: 'sampler-sc', why: 'figure caption' });
}
for (const m of manifests.filter((m) => m.source === 'openpdk' && NAME.test(m.id))) over.push({ id: m.id, family: 'sampler-sc', why: 'cell name' });
fs.writeFileSync(`${BANK}/family-overrides.jsonl`, over.map((x) => JSON.stringify(x)).join('\n') + '\n');
console.log(`flattened AnalogGenie entries excluded: ${flat.length}; relabelled sampler-sc: ${over.length} (dvd-natif ${over.filter((o) => o.id.startsWith('dvd-natif/')).length}, openpdk ${over.filter((o) => o.id.startsWith('openpdk/')).length})`);
