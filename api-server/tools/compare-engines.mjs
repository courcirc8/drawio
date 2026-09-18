#!/usr/bin/env node
/**
 * compare-engines.mjs — place2 (v2) vs macro-blocks (v4) on a corpus, no
 * optimizer, same judge (tools/check.py) : LVS, errors, warnings per circuit.
 * Usage: node tools/compare-engines.mjs <dir-or-files…> [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { newDocument, getPage, normalizeOrigin, serialize } from '../lib/model.js';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { importNetlist2 } from '../lib/place2.js';
import { importNetlist4 } from '../lib/place4.js';
import { routePage } from '../lib/route.js';
import { compare } from '../lib/lvs.js';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--json').flatMap((p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.cir')).sort().map((f) => path.join(p, f)) : [p]);
const HERE = path.dirname(new URL(import.meta.url).pathname);
function judge(doc, cirPath) {
  const tmp = path.join('/tmp', `cmp-${process.pid}.xml`); fs.writeFileSync(tmp, serialize(doc));
  const r = spawnSync('python3', [path.join(HERE, 'check.py'), tmp, '--netlist', cirPath, '--json'], { encoding: 'utf8', timeout: 60000 });
  try { const j = JSON.parse(r.stdout); return { errors: j.errors, warnings: j.warnings }; } catch { return { errors: -1, warnings: -1 }; }
}
const rows = [];
for (const f of files) {
  const name = path.basename(f, '.cir');
  const parsed = parseSpice(fs.readFileSync(f, 'utf8'));
  const row = { name };
  for (const eng of ['v2', 'v4']) {
    const doc = newDocument(); const m = getPage(doc);
    try {
      let placed;
      if (eng === 'v2') { placed = importNetlist2(m, parsed); await routePage(m, placed.wires, {}); normalizeOrigin(m); }
      else placed = await importNetlist4(m, parsed);
      const lvs = compare(extractNetlist(m), parsed).match;
      row[eng] = { lvs, ...judge(doc, f), blocks: eng === 'v4' ? placed.blocks.length : 1 };
    } catch (e) { row[eng] = { lvs: false, errors: -1, warnings: -1, error: String(e.message || e).slice(0, 100) }; }
  }
  rows.push(row);
  const d = (row.v4.errors - row.v2.errors);
  console.log(`${name.padEnd(40)} v2 lvs=${row.v2.lvs} err=${String(row.v2.errors).padStart(3)}  v4 lvs=${row.v4.lvs} err=${String(row.v4.errors).padStart(3)} blocks=${row.v4.blocks} ${d < 0 ? 'BETTER ' + d : d > 0 ? 'WORSE +' + d : '='}`);
}
const sum = (k, e) => rows.filter((r) => r[e].errors >= 0).reduce((s, r) => s + r[e][k], 0);
const zero = (e) => rows.filter((r) => r[e].errors === 0).length;
const lvsOk = (e) => rows.filter((r) => r[e].lvs).length;
const multi = rows.filter((r) => r.v4.blocks > 1);
console.log(`\n${rows.length} circuits | v2: lvs ${lvsOk('v2')} zero ${zero('v2')} errors ${sum('errors', 'v2')} warnings ${sum('warnings', 'v2')} | v4: lvs ${lvsOk('v4')} zero ${zero('v4')} errors ${sum('errors', 'v4')} warnings ${sum('warnings', 'v4')}`);
console.log(`multi-block (${multi.length}): v2 errors ${multi.reduce((s, r) => s + Math.max(0, r.v2.errors), 0)} -> v4 errors ${multi.reduce((s, r) => s + Math.max(0, r.v4.errors), 0)}; better ${multi.filter((r) => r.v4.errors < r.v2.errors).length}, worse ${multi.filter((r) => r.v4.errors > r.v2.errors).length}, equal ${multi.filter((r) => r.v4.errors === r.v2.errors).length}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
process.exit(0);
