#!/usr/bin/env node
/**
 * export-asc.mjs — .drawio/.xml -> LTspice .asc with round-trip LVS proof.
 * Usage: node tools/export-asc.mjs <schema.xml> [out.asc] [--scale 0.8] [--force]
 * Exit 2 when the round-trip LVS fails (file still written with --force).
 */
import fs from 'node:fs';
import { parseDrawio, getPage } from '../lib/model.js';
import { exportAsc } from '../lib/export-asc.js';

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
if (!files[0]) { console.error('usage: export-asc.mjs <schema.xml> [out.asc] [--scale 0.8] [--force]'); process.exit(1); }
const doc = parseDrawio(fs.readFileSync(files[0], 'utf8'));
const r = exportAsc(getPage(doc), { title: files[0], scale: opt('scale') ? parseFloat(opt('scale')) : 0.8 });
if (!r.verified) console.error('round-trip LVS FAILED: ' + JSON.stringify(r.report).slice(0, 500));
if (r.skipped.length) console.error('skipped: ' + JSON.stringify(r.skipped));
if (r.verified || args.includes('--force')) {
  if (files[1]) fs.writeFileSync(files[1], r.asc); else process.stdout.write(r.asc);
}
process.exit(r.verified ? 0 : 2);
