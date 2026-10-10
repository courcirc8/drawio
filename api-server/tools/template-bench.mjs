#!/usr/bin/env node
/**
 * template-bench.mjs — non-regression of the placement templates on the bank
 * (orchestrator 2026-10-10: "chaque PR de gabarit doit vérifier que les
 * gabarits déjà actifs ne reculent pas"; the pair template had slipped from
 * 20 to 18 gate passes unseen).
 *
 * Every usable bank circuit (3-25 parts, not sealed, not excluded) that a
 * template recognises is drawn ONCE by auto with the default settings; for
 * each template: circuits it reads, times auto chose it, drawings passing the
 * quality gate, quality-gate checks failed in total, LVS matches. No render.
 *
 *   node tools/template-bench.mjs                 measure, print JSON
 *   node tools/template-bench.mjs --write         … and freeze it as the baseline
 *   node tools/template-bench.mjs --check         … and exit 1 if a template
 *                                                 regressed against the baseline
 *   --only pair,vco                               restrict to these templates
 *
 * Baseline: test/fixtures/template-bench.json (aggregates only, no circuit
 * id). Per-circuit rows: /AI/datasets/judge/template-bench/last.jsonl.
 * A regression = fewer gate passes, more failed checks, fewer LVS matches,
 * or (when the reader did not change) a different number of circuits read.
 * Being chosen more or less often is reported, not failed: it follows from the
 * selection rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { compare } from '../lib/lvs.js';
import { bankExclusions, sealedStatus } from '../lib/sealed.js';
import { qualityGate } from '../lib/quality.js';
import { latchReading } from '../lib/place-latch.js';
import { otaReading, millerReading } from '../lib/place-ota.js';
import { lnaReading } from '../lib/place-lna.js';
import { pairReading, vcoReading } from '../lib/place-pair.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(HERE, '..', 'test', 'fixtures', 'template-bench.json');
const B = '/AI/datasets/netlists/bank', ROWS = process.env.BENCH_ROWS || '/AI/datasets/judge/template-bench';
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
// the active templates and their readers (a template is listed once Eric approved it)
const READERS = { latch: latchReading, ota: otaReading, miller: millerReading, lna: lnaReading, pair: pairReading, vco: vcoReading };
const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
const engines = Object.keys(READERS).filter((e) => !only || only.has(e));

const jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ex = bankExclusions(B);
const man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
const inv = jsonl(`${B}/inventory.jsonl`).filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && r.parts >= 3 && r.parts <= 25);

const agg = Object.fromEntries(engines.map((e) => [e, { circuits: 0, chosen: 0, gatePass: 0, fails: 0, lvs: 0 }]));
const rows = [];
for (const r of inv) {
  let text; try { text = fs.readFileSync(man.get(r.id), 'utf8'); } catch { continue; }
  if (sealedStatus(text)) continue;
  let p; try { p = parseSpice(/\.end\b/i.test(text) ? text : text + '\n.end'); } catch { continue; }
  const read = engines.filter((e) => { try { return !!READERS[e](p); } catch { return false; } });
  if (!read.length) continue;
  let res;
  try {
    const a = await autoPlace(p), m = getPage(a.doc), q = qualityGate(m, p);
    res = { label: a.label, pass: q.pass, fails: Object.values(q.checks).filter((c) => !c.ok).length, lvs: compare(extractNetlist(m), p).match };
  } catch (e) { res = { label: 'error', pass: false, fails: 10, lvs: false, error: String(e.message || e) }; }
  rows.push({ id: r.id, read, ...res });
  for (const e of read) {
    const s = agg[e]; s.circuits++; if (res.label === e) s.chosen++; if (res.pass) s.gatePass++; s.fails += res.fails; if (res.lvs) s.lvs++;
  }
}
try { fs.mkdirSync(ROWS, { recursive: true }); fs.writeFileSync(`${ROWS}/last.jsonl`, rows.map((x) => JSON.stringify(x)).join('\n') + '\n'); } catch { /* rows are a convenience */ }
console.log(JSON.stringify(agg));

if (argv.includes('--write')) {
  const old = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : {};
  fs.writeFileSync(BASE, JSON.stringify({ ...old, ...agg }, null, 1) + '\n');
}
if (argv.includes('--check')) {
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8')), bad = [];
  for (const e of engines) {
    const b = base[e], n = agg[e]; if (!b) continue;
    if (n.gatePass < b.gatePass) bad.push(`${e}: gate ${b.gatePass} -> ${n.gatePass}`);
    if (n.fails > b.fails) bad.push(`${e}: failed checks ${b.fails} -> ${n.fails}`);
    if (n.lvs < b.lvs) bad.push(`${e}: LVS ${b.lvs} -> ${n.lvs}`);
    if (n.circuits !== b.circuits) console.error(`${e}: circuits read ${b.circuits} -> ${n.circuits} (reader changed?)`);
    if (n.chosen !== b.chosen) console.error(`${e}: chosen ${b.chosen} -> ${n.chosen}`);
  }
  if (bad.length) { console.error('REGRESSION\n' + bad.join('\n')); process.exit(1); }
  console.error('no regression');
}
process.exit(0);
