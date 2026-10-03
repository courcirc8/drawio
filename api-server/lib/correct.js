/**
 * correct.js — routes of the netlist-correction page (/correct): one figure at
 * a time, the vision netlist to check or fix, three answers. Batches are built
 * by tools/dvd-rf-batch.mjs into CORRECT_ROOT/<batch>/ (items.jsonl, img/);
 * answers are appended to CORRECT_ROOT/<batch>/answers.jsonl. Everything stays
 * on the station; nothing of the batch is ever committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealedStatus } from './sealed.js';

const ROOT = process.env.CORRECT_ROOT || '/AI/datasets/IEEE/derived/correction';
const SAFE = /^[A-Za-z0-9_-]+$/;
const PAGE = fileURLToPath(new URL('../correct-ui/index.html', import.meta.url));
const FAMILY = { LNA: 'lna', mixer: 'mixer', PA: 'pa', PLL: 'pll', VCO: 'oscillator' };

function batchDir(b) {
  if (!SAFE.test(String(b || ''))) { const e = new Error('bad batch name'); e.status = 400; throw e; }
  return path.join(ROOT, b);
}
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

export function mountCorrect(app, wrap) {
  app.get('/correct', (req, res) => res.sendFile(PAGE));
  // next item without an answer (or a given n), with progress
  app.get('/correct/api/next', wrap(async (req, res) => {
    const dir = batchDir(req.query.batch);
    const items = readJsonl(path.join(dir, 'items.jsonl'));
    const done = new Set(readJsonl(path.join(dir, 'answers.jsonl')).map((a) => a.n));
    const it = req.query.n ? items.find((x) => x.n === Number(req.query.n)) : items.find((x) => !done.has(x.n));
    if (!it) return res.json({ finished: true, total: items.length, done: done.size });
    res.json({ n: it.n, type: it.type, netlist: it.netlist, flags: it.flags || [], total: items.length, done: done.size });
  }));
  app.get('/correct/img/:batch/:n.png', wrap(async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n)) return res.status(400).end();
    res.sendFile(path.join(batchDir(req.params.batch), 'img', `${n}.png`));
  }));
  app.post('/correct/api/answer', wrap(async (req, res) => {
    const { batch, n, verdict, netlist } = req.body || {};
    if (!['ok', 'fixed', 'reject'].includes(verdict)) return res.status(400).json({ error: 'verdict: ok | fixed | reject' });
    const dir = batchDir(batch);
    const it = readJsonl(path.join(dir, 'items.jsonl')).find((x) => x.n === Number(n));
    if (!it) return res.status(404).json({ error: 'no such item' });
    const text = verdict === 'fixed' ? String(netlist || '') : it.netlist;
    // a corrected netlist must never coincide with a sealed evaluation circuit
    const sealed = verdict === 'reject' ? null : sealedStatus(text, { family: FAMILY[it.type] || null });
    fs.appendFileSync(path.join(dir, 'answers.jsonl'), JSON.stringify({ n: it.n, key: it.key, type: it.type, verdict, netlist: verdict === 'reject' ? null : text, sealed, at: new Date().toISOString() }) + '\n');
    res.json({ saved: true, sealed });
  }));
}
