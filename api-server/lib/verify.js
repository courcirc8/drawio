/**
 * verify.js — Eric checks a READING of a figure (Eric 2026-10-09, via the
 * orchestrator): for each reading, the cropped original figure, the drawing
 * drawio makes from the netlist read, the netlist as text, and a verdict
 * (juste / partiel / faux) with an optional dictated comment.
 * Batches are built by tools/lectures-batch.mjs into VERIFY_ROOT/<batch>/
 * (items.jsonl, img/<n>-ref.png, img/<n>-draw.png); verdicts are appended to
 * answers.jsonl. Station only; the readings stay out of every measurement
 * until Eric's verdict. Dictation goes through the /compare relay (stt-ornith,
 * audio never stored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.VERIFY_ROOT || '/AI/datasets/judge/lectures';
const SAFE = /^[A-Za-z0-9_-]+$/;
const PAGE = fileURLToPath(new URL('../verify-ui/index.html', import.meta.url));
const VERDICTS = ['juste', 'partiel', 'faux'];

function batchDir(b) {
  if (!SAFE.test(String(b || ''))) { const e = new Error('bad batch name'); e.status = 400; throw e; }
  return path.join(ROOT, b);
}
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

export function mountVerify(app, wrap) {
  // batches lectures-1, lectures-2 ...; each keeps its verdicts
  app.get('/eric-lectures', (req, res) => {
    // the OLDEST batch Eric has not finished (a new batch does not hide an
    // unfinished one), else the newest
    let latest = 'lectures-1';
    try {
      const all = fs.readdirSync(ROOT).filter((d) => /^lectures-\d+$/.test(d)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
      const open = all.find((d) => readJsonl(path.join(ROOT, d, 'answers.jsonl')).length < readJsonl(path.join(ROOT, d, 'items.jsonl')).length);
      latest = open || all.pop() || latest;
    } catch { /* none yet */ }
    res.redirect((req.query.export != null ? 'verify/export?batch=' : 'verify?batch=') + encodeURIComponent(latest));
  });
  app.get('/verify', (req, res) => res.sendFile(PAGE));
  app.get('/verify/api/next', wrap(async (req, res) => {
    const dir = batchDir(req.query.batch);
    const items = readJsonl(path.join(dir, 'items.jsonl'));
    const done = new Set(readJsonl(path.join(dir, 'answers.jsonl')).map((a) => a.n));
    const it = items.find((x) => !done.has(x.n));
    if (!it) return res.json({ finished: true, total: items.length, done: done.size });
    const { n, ref, netlist, lvs, note } = it;
    res.json({ n, total: items.length, done: done.size, ref, netlist, lvs, note });
  }));
  app.get('/verify/img/:batch/:n-:kind.png', wrap(async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || !['ref', 'draw'].includes(req.params.kind)) return res.status(400).end();
    res.sendFile(path.join(batchDir(req.params.batch), 'img', `${n}-${req.params.kind}.png`));
  }));
  app.post('/verify/api/answer', wrap(async (req, res) => {
    const { batch, n, verdict } = req.body || {};
    if (!VERDICTS.includes(verdict)) return res.status(400).json({ error: 'verdict: juste | partiel | faux' });
    const comment = String((req.body || {}).comment || '').trim().slice(0, 4000);
    const dir = batchDir(batch);
    const it = readJsonl(path.join(dir, 'items.jsonl')).find((x) => x.n === Number(n));
    if (!it) return res.status(404).json({ error: 'no such item' });
    fs.appendFileSync(path.join(dir, 'answers.jsonl'), JSON.stringify({ n: it.n, key: it.key, paper_id: it.ref?.paper_id, page: it.ref?.page, rang: it.ref?.rang, version: it.version || null, verdict, ...(comment ? { comment } : {}), at: new Date().toISOString() }) + '\n');
    res.json({ saved: true });
  }));
  // readable export of the verdicts (HTML; ?format=md | json)
  app.get('/verify/export', wrap(async (req, res) => {
    const batch = req.query.batch, dir = batchDir(batch);
    const items = new Map(readJsonl(path.join(dir, 'items.jsonl')).map((x) => [x.n, x]));
    const rows = readJsonl(path.join(dir, 'answers.jsonl')).map((a) => ({ ...a, title: items.get(a.n)?.ref?.title || '' }));
    const md = [`# ${batch} — verdicts (${rows.length})`, '', '| lecture | clé | verdict | commentaire |', '|---|---|---|---|',
      ...rows.map((r) => `| ${r.n} | ${r.key || ''} | ${r.verdict} | ${String(r.comment || '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n');
    if (req.query.format === 'md') return res.type('text/markdown; charset=utf-8').send(md + '\n');
    if (req.query.format === 'json') return res.json(rows);
    const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Verdicts ${esc(batch)}</title>
<style>body{font-family:system-ui,sans-serif;margin:10px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 6px;vertical-align:top}</style>
<h2>${esc(batch)} — ${rows.length} verdicts</h2><p><a href="export?batch=${encodeURIComponent(batch)}&format=md">Markdown</a> · <a href="export?batch=${encodeURIComponent(batch)}&format=json">JSON</a></p>
<table><tr><th>lecture</th><th>clé</th><th>verdict</th><th>commentaire</th></tr>${rows.map((r) => `<tr><td>${r.n}</td><td>${esc(r.key)}</td><td>${esc(r.verdict)}</td><td>${esc(r.comment || '')}</td></tr>`).join('')}</table>`);
  }));
}
