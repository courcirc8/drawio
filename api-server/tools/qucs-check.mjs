#!/usr/bin/env node
/**
 * qucs-check.mjs — netlist SPICE → Qucs-S .sch, then Qucs-S's OWN netlister
 * (`qucs-s -n --ngspice`, headless in the sim-gui container + Xvfb, bounded in
 * time) re-reads the file and lib/lvs.js compares it with the source deck
 * (step 4 of docs/export-multi-outils.md). deliverQucs writes the file under
 * its final name only when that LVS matches.
 * Usage: node tools/qucs-check.mjs deck.sp [out.sch] | --bank N (OUT_DIR=…, under the home)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseSpice } from '../lib/netlist.js';
import { compare } from '../lib/lvs.js';
import { exportQucs } from '../lib/export-qucs.js';

const SIM = process.env.SIM_ROOT || path.join(os.homedir(), 'ClaudeCode/simulation');

/** Qucs-S's SPICE netlist of a .sch (the file's directory must be under the home: mounted in the container). */
export function qucsNetlist(schFile) {
  const dir = path.dirname(schFile), out = schFile.replace(/\.sch$/, '.cir');
  fs.rmSync(out, { force: true });
  try {
    execFileSync('docker', ['run', '--rm', '-u', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp', '-v', `${SIM}:${SIM}`, '-v', `${dir}:${dir}`, '-w', dir, 'sim-gui:noble',
      'timeout', '90', 'xvfb-run', '-a', `${SIM}/opt/qucs-s/squashfs-root/AppRun`, '-n', '-i', path.basename(schFile), '-o', path.basename(out), '--ngspice'], { stdio: 'pipe', timeout: 150000 });
  } catch { /* the netlist decides */ }
  if (!fs.existsSync(out)) throw new Error('qucs-s wrote no netlist');
  const text = fs.readFileSync(out, 'utf8');
  const models = new Map([...text.matchAll(/^\.MODEL\s+(\S+)\s+(\w+)/gim)].map((m) => [m[1].toUpperCase(), m[2].toLowerCase()]));
  const body = text.split('\n').filter((l) => /^[RCLVIM]\S*\s/i.test(l)).map((l) => {
    const t = l.trim().split(/\s+/);
    if (/^M/i.test(t[0])) { const type = models.get(String(t[5]).toUpperCase()) || t[5]; return [t[0], ...t.slice(1, 5), type, ...t.slice(6)].join(' '); }
    return l.trim();
  }).join('\n');
  return { netlist: text, parsed: parseSpice(body + '\n.end') };
}

/** Values compared loosely: R / C / L / V / I on their number (case, a leading "dc" ignored), MOS on type + the w / l the source gives. */
export function canon(p, src = p) {
  const kvOf = (v) => Object.fromEntries([...String(v || '').matchAll(/\b([wl])\s*=\s*([^\s]+)/gi)].map((m) => [m[1].toLowerCase(), m[2].toLowerCase()]));
  const given = new Map(src.components.filter((c) => c.prefix === 'M').map((c) => [String(c.ref).toUpperCase(), Object.keys(kvOf(c.value)).sort()]));
  for (const c of p.components) {
    if (c.prefix === 'M') { const kv = kvOf(c.value); c.value = [String(c.value || '').split(/\s+/)[0].toLowerCase(), ...(given.get(String(c.ref).toUpperCase()) || []).map((k) => `${k}=${kv[k] ?? '?'}`)].join(' '); }
    else c.value = String(c.value || '').replace(/^\s*dc\s+/i, '').split(/\s+/)[0].toLowerCase();
  }
  return p;
}

export function qucsLvs(schFile, deck) {
  const q = qucsNetlist(schFile);
  return compare({ components: canon(q.parsed, deck).components, issues: [] }, canon(structuredClone(deck)));
}

/** DELIVERY: written to a temporary name, re-read by Qucs-S, renamed only when its LVS matches. */
export async function deliverQucs(parsed, outFile) {
  const r = await exportQucs(parsed), tmp = outFile.replace(/\.sch$/, '') + '.tmp-check.sch';
  fs.writeFileSync(tmp, r.sch);
  let lvs;
  try { lvs = qucsLvs(tmp, parsed); } catch (e) { lvs = { match: false, error: String(e.message || e) }; }
  fs.rmSync(tmp.replace(/\.sch$/, '.cir'), { force: true });
  if (!lvs.match) { fs.rmSync(tmp, { force: true }); throw Object.assign(new Error('qucs: the file Qucs-S reads back does not redraw the deck — not delivered'), { lvs }); }
  fs.renameSync(tmp, outFile);
  return { ...r, file: outFile, lvs: true };
}

const MAIN = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const [deck, outArg] = MAIN ? process.argv.slice(2) : [];
if (deck && deck !== '--bank') {
  const parsed = parseSpice(fs.readFileSync(deck, 'utf8') + '\n.end');
  const file = path.resolve(outArg || deck.replace(/\.\w+$/, '') + '.sch');
  try { const r = await deliverQucs(parsed, file); console.log(JSON.stringify({ file, engine: r.label, gate: r.gate, warnings: r.warnings, lvs: true }, null, 1)); process.exit(0); }
  catch (e) { console.log(JSON.stringify({ file: null, refused: e.message, detail: e.lvs }, null, 1)); process.exit(1); }
}
if (deck === '--bank') {
  const { bankExclusions, sealedStatus } = await import('../lib/sealed.js');
  const B = '/AI/datasets/netlists/bank', jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ex = bankExclusions(B), man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
  const inv = jsonl(`${B}/inventory.jsonl`).filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && r.parts >= 3 && r.parts <= 25 && !/regulator|sampler-sc|data-converter/.test(r.family));
  const OUT = process.env.OUT_DIR || path.join(os.homedir(), 'qucs-bench'); fs.mkdirSync(OUT, { recursive: true });
  const n = Number(outArg || 40), rows = [];
  for (const r of inv) {
    if (rows.length >= n) break;
    let t; try { t = fs.readFileSync(man.get(r.id), 'utf8'); } catch { continue; }
    if (sealedStatus(t)) continue;
    let p; try { p = parseSpice(/\.end\b/i.test(t) ? t : t + '\n.end'); } catch { continue; }
    if (!p.components.length || !p.components.every((c) => 'RCLVIM'.includes(c.prefix))) continue;
    const row = { id: r.id, parts: r.parts };
    try {
      const file = `${OUT}/${r.id.replace(/[^\w.-]+/g, '_')}.sch`, x = await deliverQucs(p, file);
      row.file = file; row.engine = x.label; row.gate = x.gate; row.grid = x.neutral.target.grid; if (x.warnings?.length) row.warnings = x.warnings; row.lvs = true;
    } catch (e) { row.error = String(e.message || e).slice(0, 200); }
    rows.push(row); console.error(JSON.stringify(row));
  }
  const c = (f) => rows.filter(f).length;
  console.log(JSON.stringify({ circuits: rows.length, delivered: c((x) => x.lvs), refused: c((x) => x.error), grid5: c((x) => x.grid === 5) }));
  fs.writeFileSync(`${OUT}/rows.jsonl`, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  process.exit(0);
}
