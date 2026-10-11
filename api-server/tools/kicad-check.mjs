#!/usr/bin/env node
/**
 * kicad-check.mjs — netlist SPICE → KiCad .kicad_sch, then KiCad's OWN
 * netlister (`kicad-cli sch export netlist`, kicadsexpr) re-reads the file and
 * lib/lvs.js compares its connectivity with the source deck (step 3 of
 * docs/export-multi-outils.md: a wrong file is never delivered).
 * Usage: node tools/kicad-check.mjs deck.sp [out.kicad_sch]
 *        node tools/kicad-check.mjs --bank N   (OUT_DIR=…)
 * Env: KICAD_CLI (default ~/ClaudeCode/simulation/bin/kicad-cli, a Flatpak wrapper).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseSpice } from '../lib/netlist.js';
import { compare } from '../lib/lvs.js';
import { exportKicad } from '../lib/export-kicad.js';
import { canonMos } from './xschem-check.mjs';

const CLI = process.env.KICAD_CLI || path.join(os.homedir(), 'ClaudeCode/simulation/bin/kicad-cli');
// SPICE node order of each prefix → KiCad pin numbers of the symbols used (lib/export-kicad.js PROFILE)
const ORDER = { R: ['1', '2'], C: ['1', '2'], L: ['1', '2'], V: ['1', '2'], I: ['1', '2'], M: ['1', '2', '3', '4'] };

/** KiCad's netlist of a .kicad_sch, as our parsed components (nets by name). */
export function kicadNetlist(schFile, deck) {
  const dir = path.dirname(schFile), out = schFile.replace(/\.kicad_sch$/, '.net');
  try { execFileSync(CLI, ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '--output', path.basename(out), path.basename(schFile)], { cwd: dir, stdio: 'pipe', timeout: 120000, env: { ...process.env, PWD: dir } }); } catch (e) { if (!fs.existsSync(out)) throw new Error('kicad-cli wrote no netlist: ' + String(e.stderr || e.message).slice(0, 300)); }
  const t = fs.readFileSync(out, 'utf8'), pinNet = new Map();
  // (net (code "1") (name "/out") … (node (ref "R1") (pin "1") …) …), spread over lines
  const chunks = t.split(/\(net\s+\(code\s/).slice(1);
  for (const ch of chunks) {
    const name = (/\(name\s+"([^"]*)"/.exec(ch) || [])[1]; if (name == null) continue;
    for (const n of ch.matchAll(/\(node\s+\(ref\s+"([^"]+)"\)\s*\(pin\s+"([^"]+)"\)/g)) pinNet.set(`${n[1]}.${n[2]}`, name.replace(/^\//, ''));
  }
  const values = new Map([...t.matchAll(/\(comp\s+\(ref\s+"([^"]+)"\)\s*\(value\s+"([^"]*)"\)/g)].map((m) => [m[1], m[2]]));
  const components = deck.components.map((c) => {
    const pins = ORDER[c.prefix] || [], nodes = pins.map((p) => pinNet.get(`${c.ref}.${p}`) ?? '?');
    return { ref: c.ref, prefix: c.prefix, nodes: nodes.slice(0, c.nodes.length), fullNodes: nodes, value: values.get(c.ref) ?? '' };
  });
  return { netlist: t, parsed: { components } };
}

export function kicadLvs(schFile, deck) {
  const k = kicadNetlist(schFile, deck);
  return compare({ components: canonMos(k.parsed, deck).components, issues: [] }, canonMos(structuredClone(deck)));
}

/** DELIVERY (no wrong file ever leaves): the .kicad_sch is written to a
 *  temporary name, re-read by kicad-cli, and renamed to `outFile` only when
 *  its LVS matches; otherwise it is deleted and the export throws. */
export async function deliverKicad(parsed, outFile) {
  const r = await exportKicad(parsed), tmp = outFile.replace(/\.kicad_sch$/, '') + '.tmp-check.kicad_sch';
  fs.writeFileSync(tmp, r.sch);
  let lvs;
  try { lvs = kicadLvs(tmp, parsed); } catch (e) { lvs = { match: false, error: String(e.message || e) }; }
  for (const x of [tmp.replace(/\.kicad_sch$/, '.net')]) fs.rmSync(x, { force: true });
  if (!lvs.match) { fs.rmSync(tmp, { force: true }); throw Object.assign(new Error('kicad: the file KiCad reads back does not redraw the deck — not delivered'), { lvs }); }
  fs.renameSync(tmp, outFile);
  return { ...r, file: outFile, lvs: true };
}

const MAIN = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const [deck, outArg] = MAIN ? process.argv.slice(2) : [];
if (deck && deck !== '--bank') {
  const parsed = parseSpice(fs.readFileSync(deck, 'utf8') + '\n.end');
  const file = path.resolve(outArg || deck.replace(/\.\w+$/, '') + '.kicad_sch');
  try {
    const r = await deliverKicad(parsed, file);
    console.log(JSON.stringify({ file, engine: r.label, gate: r.gate, warnings: r.warnings, lvs: true }, null, 1));
    process.exit(0);
  } catch (e) { console.log(JSON.stringify({ file: null, refused: e.message, detail: e.lvs }, null, 1)); process.exit(1); }
}
if (deck === '--bank') {
  const { bankExclusions, sealedStatus } = await import('../lib/sealed.js');
  const B = '/AI/datasets/netlists/bank', jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ex = bankExclusions(B), man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
  const inv = jsonl(`${B}/inventory.jsonl`).filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && r.parts >= 3 && r.parts <= 25 && !/regulator|sampler-sc|data-converter/.test(r.family));
  const OUT = process.env.OUT_DIR || path.join(os.homedir(), 'kicad-bench'); fs.mkdirSync(OUT, { recursive: true });
  const n = Number(outArg || 40), rows = [];
  for (const r of inv) {
    if (rows.length >= n) break;
    let t; try { t = fs.readFileSync(man.get(r.id), 'utf8'); } catch { continue; }
    if (sealedStatus(t)) continue;
    let p; try { p = parseSpice(/\.end\b/i.test(t) ? t : t + '\n.end'); } catch { continue; }
    if (!p.components.length || !p.components.every((c) => 'RCLVIM'.includes(c.prefix))) continue;
    const row = { id: r.id, parts: r.parts };
    try {
      const file = `${OUT}/${r.id.replace(/[^\w.-]+/g, '_')}.kicad_sch`, x = await deliverKicad(p, file);
      row.file = file; row.engine = x.label; row.gate = x.gate; row.grid = x.neutral.target.grid; if (x.warnings?.length) row.warnings = x.warnings;
      row.lvs = true;
    } catch (e) { row.error = String(e.message || e).slice(0, 200); }
    rows.push(row); console.error(JSON.stringify(row));
  }
  const c = (f) => rows.filter(f).length;
  console.log(JSON.stringify({ circuits: rows.length, exported: c((x) => x.file), lvs: c((x) => x.lvs), gate: c((x) => x.gate?.pass), errors: c((x) => x.error), grid5: c((x) => x.grid === 5), warned: c((x) => x.warnings) }));
  fs.writeFileSync(`${OUT}/rows.jsonl`, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  process.exit(0);
}
