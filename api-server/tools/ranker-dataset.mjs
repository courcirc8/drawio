#!/usr/bin/env node
/**
 * ranker-dataset.mjs — candidate drawings of every netlist of a corpus, with
 * their ranking features (lib/ranker.js) and the reference judge's verdict
 * (tools/check.py errors/warnings). One JSON line per candidate.
 * Usage: node tools/ranker-dataset.mjs out.jsonl <dir-or-files…>
 * Candidates: AUTO_CANDIDATES × colW {190, 230} × rowH {180, 220}.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { newDocument, getPage, normalizeOrigin, serialize } from '../lib/model.js';
import { parseSpice } from '../lib/netlist.js';
import { importNetlist2 } from '../lib/place2.js';
import { importNetlist4, AUTO_CANDIDATES } from '../lib/place4.js';
import { routePage } from '../lib/route.js';
import { rankFeatures } from '../lib/ranker.js';

const [out, ...inputs] = process.argv.slice(2);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const files = inputs.flatMap((p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.cir')).sort().map((f) => path.join(p, f)) : [p]);
const tmp = path.join('/tmp', `rk-${process.pid}.xml`);
const fd = fs.openSync(out, 'w');
let n = 0;
for (const f of files) {
  const circuit = path.basename(path.dirname(f)) + '/' + path.basename(f, '.cir');
  const parsed = parseSpice(fs.readFileSync(f, 'utf8'));
  for (const [eng, restMode] of AUTO_CANDIDATES) for (const colW of [190, 230]) for (const rowH of [180, 220]) {
    const doc = newDocument(); const m = getPage(doc);
    try {
      if (eng === 'v2') { const p = importNetlist2(m, parsed, { colW, rowH }); await routePage(m, p.wires, {}); normalizeOrigin(m); }
      else await importNetlist4(m, parsed, { restMode, colW, rowH });
    } catch { continue; }
    const features = rankFeatures(m, parsed, { eng, restMode, colW, rowH });
    fs.writeFileSync(tmp, serialize(doc));
    const r = spawnSync('python3', [path.join(HERE, 'check.py'), tmp, '--netlist', f, '--json'], { encoding: 'utf8', timeout: 60000 });
    let j; try { j = JSON.parse(r.stdout); } catch { continue; }
    fs.writeSync(fd, JSON.stringify({ circuit, cand: `${eng}:${restMode || '-'}:${colW}:${rowH}`, features, py_errors: j.errors, py_warnings: j.warnings }) + '\n');
    n++;
  }
}
fs.closeSync(fd);
console.log(`${n} candidates from ${files.length} circuits -> ${out}`);
