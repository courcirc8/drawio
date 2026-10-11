#!/usr/bin/env node
/**
 * ltspice-check.mjs — netlist SPICE → LTspice .asc with wires
 * (lib/export-ltspice.js), re-read by tools/asc2spice.mjs (an independent .asc
 * reader with LTspice's rules: pins / flags / wire ends and points on a wire
 * join; LTspice itself is not installed here) and compared with the deck by
 * lib/lvs.js. deliverLtspice writes the file only when that LVS matches.
 * Usage: node tools/ltspice-check.mjs deck.sp [out.asc] | --bank N (OUT_DIR=…)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSpice } from '../lib/netlist.js';
import { compare } from '../lib/lvs.js';
import { exportLtspice } from '../lib/export-ltspice.js';
import { ascToSpice } from './asc2spice.mjs';
import { canon } from './qucs-check.mjs';

export function ascLvs(asc, deck) {
  const r = ascToSpice(asc), spice = typeof r === 'string' ? r : (r.spice || r.netlist || '');
  const p = parseSpice(spice.replace(/^\.end\s*$/im, '') + '\n.end');
  return compare({ components: canon(p, deck).components, issues: [] }, canon(structuredClone(deck)));
}

/** DELIVERY: the .asc is written under `outFile` only when its re-read netlist redraws the deck. */
export async function deliverLtspice(parsed, outFile) {
  const r = await exportLtspice(parsed);
  let lvs; try { lvs = ascLvs(r.asc, parsed); } catch (e) { lvs = { match: false, error: String(e.message || e) }; }
  if (!lvs.match) throw Object.assign(new Error('ltspice: the .asc read back does not redraw the deck — not delivered'), { lvs });
  fs.writeFileSync(outFile, r.asc);
  return { ...r, file: outFile, lvs: true };
}

const MAIN = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const [deck, outArg] = MAIN ? process.argv.slice(2) : [];
if (deck && deck !== '--bank') {
  const parsed = parseSpice(fs.readFileSync(deck, 'utf8') + '\n.end');
  const file = path.resolve(outArg || deck.replace(/\.\w+$/, '') + '.asc');
  try { const r = await deliverLtspice(parsed, file); console.log(JSON.stringify({ file, engine: r.label, gate: r.gate, lvs: true }, null, 1)); process.exit(0); }
  catch (e) { console.log(JSON.stringify({ file: null, refused: e.message, detail: e.lvs }, null, 1)); process.exit(1); }
}
if (deck === '--bank') {
  const { bankExclusions, sealedStatus } = await import('../lib/sealed.js');
  const B = '/AI/datasets/netlists/bank', jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ex = bankExclusions(B), man = new Map(fs.readdirSync(B).filter((f) => /^manifest.*\.jsonl$/.test(f)).flatMap((f) => jsonl(`${B}/${f}`)).map((r) => [r.id, r.file]));
  const inv = jsonl(`${B}/inventory.jsonl`).filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && r.parts >= 3 && r.parts <= 25 && !/regulator|sampler-sc|data-converter/.test(r.family));
  const OUT = process.env.OUT_DIR || path.join(os.homedir(), 'ltspice-bench'); fs.mkdirSync(OUT, { recursive: true });
  const n = Number(outArg || 40), rows = [];
  for (const r of inv) {
    if (rows.length >= n) break;
    let t; try { t = fs.readFileSync(man.get(r.id), 'utf8'); } catch { continue; }
    if (sealedStatus(t)) continue;
    let p; try { p = parseSpice(/\.end\b/i.test(t) ? t : t + '\n.end'); } catch { continue; }
    if (!p.components.length || !p.components.every((c) => 'RCLVIM'.includes(c.prefix))) continue;
    const row = { id: r.id, parts: r.parts };
    try { const file = `${OUT}/${r.id.replace(/[^\w.-]+/g, '_')}.asc`, x = await deliverLtspice(p, file); row.file = file; row.engine = x.label; row.gate = x.gate; row.grid = x.neutral.target.grid; row.lvs = true; }
    catch (e) { row.error = String(e.message || e).slice(0, 200); }
    rows.push(row); console.error(JSON.stringify(row));
  }
  const c = (f) => rows.filter(f).length;
  console.log(JSON.stringify({ circuits: rows.length, delivered: c((x) => x.lvs), refused: c((x) => x.error), grid5: c((x) => x.grid === 5) }));
  fs.writeFileSync(`${OUT}/rows.jsonl`, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  process.exit(0);
}
