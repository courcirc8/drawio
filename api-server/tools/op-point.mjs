#!/usr/bin/env node
/**
 * op-point.mjs — « point d'essai » of a SPICE netlist: drawn by auto, its
 * operating point computed by ngspice with simple models (lib/sim-op.js),
 * annotated on the drawing (lib/sim-annotate.js), rendered as PNG.
 * Usage: node tools/op-point.mjs deck.sp out.png [--vdd 1.8] [--json out.sim.json] [--deck out.cir]
 */
import fs from 'node:fs';
import { parseSpice } from '../lib/netlist.js';
import { getPage } from '../lib/model.js';
import { autoPlace } from '../lib/auto.js';
import { exportDocument } from '../lib/render.js';
import { annotateSim } from '../lib/sim-annotate.js';
import { operatingPoint } from '../lib/sim-op.js';

const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const [deckFile, png] = argv;
const text = fs.readFileSync(deckFile, 'utf8'), parsed = parseSpice(/\.end\b/i.test(text) ? text : text + '\n.end');
const { sim, deck } = operatingPoint(parsed, { vdd: Number(arg('--vdd') || 1.8) });
if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(sim, null, 1));
if (arg('--deck')) fs.writeFileSync(arg('--deck'), deck);
const r = await autoPlace(parsed), m = getPage(r.doc);
const out = annotateSim(m, sim, { netlist: text });
if (png) fs.writeFileSync(png, (await exportDocument(r.doc, m, { format: 'png', scale: 1.6 })).buffer);
console.log(JSON.stringify({ engine: r.label, annotated: out, summary: sim.summary_extra, devices: Object.fromEntries(Object.entries(sim.devices).map(([k, d]) => [k, `${d.region || ''} Id=${(d.Id ?? d.Ic ?? 0).toExponential(2)}`])) }, null, 1));
process.exit(0);
