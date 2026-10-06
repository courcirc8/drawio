/**
 * compare.js — routes of the blind pairwise page (/compare): two drawings of the
 * same circuit, Eric taps the one he prefers (or "equal"), next one follows.
 * Batches are built by tools/compare-batch.mjs into COMPARE_ROOT/<batch>/
 * (items.jsonl with the hidden side mapping, img/<n>-<L|R>.png); answers are
 * appended to answers.jsonl. Our own renders only (no corpus image); stays on
 * the station, never committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.COMPARE_ROOT || '/AI/datasets/judge/compare';
const SAFE = /^[A-Za-z0-9_-]+$/;
const PAGE = fileURLToPath(new URL('../compare-ui/index.html', import.meta.url));

function batchDir(b) {
  if (!SAFE.test(String(b || ''))) { const e = new Error('bad batch name'); e.status = 400; throw e; }
  return path.join(ROOT, b);
}
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

export function mountCompare(app, wrap) {
  app.get('/compare', (req, res) => res.sendFile(PAGE));
  // gallery: every pair of a batch, LABELLED (examples to look at, nothing recorded)
  app.get('/compare/gallery', wrap(async (req, res) => {
    const batch = req.query.batch;
    const items = readJsonl(path.join(batchDir(batch), 'items.jsonl'));
    const name = { base: 'auto (actuel)', sa: 'recuit (sa)', new: 'auto (nouveau)', rules: 'auto + règles' };
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const rows = items.map((it) => `<h3>${it.n}. ${esc(it.family)} — ${it.parts} composants</h3>` + ['L', 'R'].map((sd) =>
      `<figure><figcaption>${esc(name[it.sides[sd]] || it.sides[sd])}</figcaption><img src="img/${encodeURIComponent(batch)}/${it.n}-${sd}.png"></figure>`).join('')).join('');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Exemples</title>
<style>body{font-family:system-ui,sans-serif;margin:8px;background:#f4f4f4}figure{margin:6px 0 14px;background:#fff;border:1px solid #ccc;border-radius:6px;padding:4px}figcaption{font-weight:600;margin:2px 4px}img{width:100%;display:block}</style>
<h2>Exemples : auto actuel et recuit (sa)</h2>${rows}`);
  }));
  // next unanswered pair; the side mapping is never sent to the page (blind)
  app.get('/compare/api/next', wrap(async (req, res) => {
    const dir = batchDir(req.query.batch);
    const items = readJsonl(path.join(dir, 'items.jsonl'));
    const done = new Set(readJsonl(path.join(dir, 'answers.jsonl')).map((a) => a.n));
    const it = items.find((x) => !done.has(x.n));
    if (!it) return res.json({ finished: true, total: items.length, done: done.size });
    res.json({ n: it.n, total: items.length, done: done.size });
  }));
  app.get('/compare/img/:batch/:n-:side.png', wrap(async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || !['L', 'R'].includes(req.params.side)) return res.status(400).end();
    res.sendFile(path.join(batchDir(req.params.batch), 'img', `${n}-${req.params.side}.png`));
  }));
  app.post('/compare/api/answer', wrap(async (req, res) => {
    const { batch, n, choice } = req.body || {};
    if (!['L', 'R', 'equal'].includes(choice)) return res.status(400).json({ error: 'choice: L | R | equal' });
    const dir = batchDir(batch);
    const it = readJsonl(path.join(dir, 'items.jsonl')).find((x) => x.n === Number(n));
    if (!it) return res.status(404).json({ error: 'no such item' });
    const preferred = choice === 'equal' ? 'equal' : it.sides[choice];
    fs.appendFileSync(path.join(dir, 'answers.jsonl'), JSON.stringify({ n: it.n, id: it.id, choice, preferred, at: new Date().toISOString() }) + '\n');
    res.json({ saved: true });
  }));
}
