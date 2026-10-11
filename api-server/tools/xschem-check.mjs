#!/usr/bin/env node
/**
 * xschem-check.mjs — netlist SPICE → xschem .sch (IHP), then xschem's OWN
 * netlister re-reads the file and lib/lvs.js compares its netlist with the
 * source deck (step 2 of docs/export-multi-outils.md: a file that does not
 * redraw the deck is never delivered).
 * Usage: node tools/xschem-check.mjs deck.sp [out.sch]
 * Env: SIM_ROOT (xschem build + IHP kit; default ~/ClaudeCode/simulation).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSpice } from '../lib/netlist.js';
import { compare } from '../lib/lvs.js';
import { exportXschem } from '../lib/export-xschem.js';

const SIM = process.env.SIM_ROOT || path.join(os.homedir(), 'ClaudeCode/simulation');
const PDK = `${SIM}/references/IHP-GmbH_IHP-Open-PDK`, XS = `${SIM}/opt/xschem/bin/xschem`;

/** xschem's netlist of a .sch, parsed back to our form (X-prefixed IHP devices unwrapped). */
export function xschemNetlist(schFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsn-'));
  const log = path.join(dir, 'xschem.log');
  // xschem exits 10 on mere warnings (undriven nodes): its log decides — a
  // short between two nets is an error
  try {
    execFileSync(XS, ['-n', '-s', '-q', '-x', '--rcfile', `${PDK}/ihp-sg13g2/libs.tech/xschem/xschemrc`, '-o', dir, '-l', log, schFile],
      { env: { ...process.env, PDK_ROOT: PDK, PDK: 'ihp-sg13g2', PWD: path.dirname(schFile) }, cwd: path.dirname(schFile), stdio: 'pipe', timeout: 60000 });
  } catch { /* judged below */ }
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const shorts = [...text.matchAll(/Net shorted:[^\n]*/g)].map((m) => m[0]);
  const out = path.join(dir, path.basename(schFile).replace(/\.sch$/, '.spice'));
  if (!fs.existsSync(out)) throw new Error('xschem wrote no netlist: ' + text.slice(-300));
  if (shorts.length) throw new Error('xschem: ' + shorts.join('; '));
  const spice = fs.readFileSync(out, 'utf8');
  // keep device lines; XM1 d g s b sg13_lv_nmos … → M1 d g s b nmos …
  const body = spice.split('\n').filter((l) => /^[A-Za-z]/.test(l) && !/^\.(lib|include|param|end|subckt|ends|option|control)/i.test(l))
    .map((l) => l.replace(/^X(M\S+)\s+(\S+\s+\S+\s+\S+\s+\S+)\s+sg13_lv_(n|p)mos/i, (m, ref, nodes, t) => `${ref} ${nodes} ${t}mos`)).join('\n');
  return { spice, parsed: parseSpice(body + '\n.end') };
}

/** MOS values compared on model and on the w / l / m the SOURCE gives (xschem
 *  adds ng=1 m=1 mm_ok=1; a deck without w / l gets the kit's defaults). */
export function canonMos(p, src = p) {
  const kvOf = (v) => Object.fromEntries([...String(v || '').matchAll(/\b([wlm])\s*=\s*([^\s]+)/gi)].map((m) => [m[1].toLowerCase(), m[2].toLowerCase()]));
  const given = new Map(src.components.filter((c) => c.prefix === 'M').map((c) => [String(c.ref).toUpperCase(), Object.keys(kvOf(c.value))]));
  for (const c of p.components) if (c.prefix === 'M') {
    const kv = kvOf(c.value), keys = (given.get(String(c.ref).toUpperCase()) || []).sort();
    c.value = [String(c.value || '').split(/\s+/)[0].toLowerCase(), ...keys.map((k) => `${k}=${kv[k] ?? (k === 'm' ? '1' : '?')}`)].join(' ');
  }
  return p;
}

const [deck, out] = process.argv.slice(2);
if (deck && deck !== '--bank') {
  const parsed = parseSpice(fs.readFileSync(deck, 'utf8') + '\n.end');
  const r = await exportXschem(parsed);
  const file = path.resolve(out || deck.replace(/\.\w+$/, '') + '.sch');
  fs.writeFileSync(file, r.sch);
  const x = xschemNetlist(file);
  const lvs = compare({ components: canonMos(x.parsed, parsed).components, issues: [] }, canonMos(structuredClone(parsed)));
  console.log(JSON.stringify({ file, engine: r.label, gate: r.gate, lvs: lvs.match, ...(lvs.match ? {} : { detail: lvs }) }, null, 1));
  process.exit(lvs.match ? 0 : 1);
}

// --bank N: the first N usable bank circuits made only of R C L V I M (not sealed)
if (deck === '--bank') {
  const { bankExclusions, sealedStatus } = await import('../lib/sealed.js');
  const B = '/AI/datasets/netlists/bank', jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ex = bankExclusions(B), man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
  const inv = jsonl(`${B}/inventory.jsonl`).filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && r.parts >= 3 && r.parts <= 25 && !/regulator|sampler-sc|data-converter/.test(r.family));
  const OUT = process.env.OUT_DIR || '/tmp/xschem-bench'; fs.mkdirSync(OUT, { recursive: true });
  const n = Number(out || 40), rows = [];
  for (const r of inv) {
    if (rows.length >= n) break;
    let t; try { t = fs.readFileSync(man.get(r.id), 'utf8'); } catch { continue; }
    if (sealedStatus(t)) continue;
    let p; try { p = parseSpice(/\.end\b/i.test(t) ? t : t + '\n.end'); } catch { continue; }
    if (!p.components.length || !p.components.every((c) => 'RCLVIM'.includes(c.prefix))) continue;
    const row = { id: r.id, parts: r.parts };
    try {
      const x = await exportXschem(p), file = `${OUT}/${r.id.replace(/[^\w.-]+/g, '_')}.sch`;
      fs.writeFileSync(file, x.sch); row.file = file; row.engine = x.label; row.gate = x.gate; row.grid = x.neutral.target.grid;
      const nl = xschemNetlist(file); row.lvs = compare({ components: canonMos(nl.parsed, p).components, issues: [] }, canonMos(structuredClone(p))).match;
    } catch (e) { row.error = String(e.message || e).slice(0, 200); }
    rows.push(row); console.error(JSON.stringify(row));
  }
  const c = (f) => rows.filter(f).length;
  console.log(JSON.stringify({ circuits: rows.length, exported: c((x) => x.file), lvs: c((x) => x.lvs), gate: c((x) => x.gate?.pass), errors: c((x) => x.error), grid5: c((x) => x.grid === 5) }));
  fs.writeFileSync(`${OUT}/rows.jsonl`, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  process.exit(0);
}
