#!/usr/bin/env node
/**
 * critique.mjs — visual critique of a saved .drawio/.xml by a vision model.
 * Usage: node tools/critique.mjs <schema.xml> [--netlist c.cir] [--backend anthropic|openai] [--model NAME]
 * Env: ANTHROPIC_API_KEY (or `ant auth login`) | CRITIC_URL + CRITIC_MODEL for an
 * OpenAI-compatible local VLM. CHROME_PATH for the render. Prints JSON.
 */
import fs from 'node:fs';
import { parseDrawio, getPage } from '../lib/model.js';
import { critique } from '../lib/critic.js';
import { closeBrowser } from '../lib/render.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
if (!file) { console.error('usage: critique.mjs <schema.xml> [--netlist c.cir] [--backend anthropic|openai] [--model NAME]'); process.exit(1); }
const doc = parseDrawio(fs.readFileSync(file, 'utf8'));
const netlist = opt('netlist') ? fs.readFileSync(opt('netlist'), 'utf8') : null;
try {
  const r = await critique(doc, getPage(doc), { backend: opt('backend'), modelName: opt('model'), netlist });
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.findings.some((f) => f.severity === 'error') ? 2 : 0);
} finally { await closeBrowser(); }
