#!/usr/bin/env node
/**
 * cli.mjs — netlist SPICE → schema.py + schema.il for Cadence Virtuoso.
 * Usage: node exporters/cadence/cli.mjs deck.sp [--out DIR] [--cell NAME] [--profile profile.json]
 * --profile: the file written by the script at the user's site (--write-profile /
 * ?writeProfile): the engine then places on the symbols' real pins. Local file:
 * read here, never copied anywhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSpice } from '../../lib/netlist.js';
import { exportCadence } from './index.js';

const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const deck = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!deck) { console.error('usage: cli.mjs deck.sp [--out DIR] [--cell NAME] [--profile profile.json]'); process.exit(2); }
const text = fs.readFileSync(deck, 'utf8');
const profile = opt('--profile') ? JSON.parse(fs.readFileSync(opt('--profile'), 'utf8')) : undefined;
const cell = opt('--cell') || path.basename(deck).replace(/\.\w+$/, '').replace(/\W+/g, '_') + '_drawio';
const r = await exportCadence(parseSpice(/\.end\b/i.test(text) ? text : text + '\n.end'), { cell, profile });
const out = opt('--out') || '.';
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'schema.py'), r.python);
fs.writeFileSync(path.join(out, 'schema.il'), r.skill);
console.log(JSON.stringify({ out, cell, engine: r.label, plan: r.plan.id, profile: profile ? (r.profileUsed ? 'used' : 'not used (fallback)') : 'none' }));
