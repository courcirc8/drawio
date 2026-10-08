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
import express from 'express';

const ROOT = process.env.COMPARE_ROOT || '/AI/datasets/judge/compare';
const STT = (process.env.COMPARE_STT || 'http://127.0.0.1:8798').replace(/\/$/, '');
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
    // the REFERENCE figure (Eric 2026-10-08): the figure the netlist comes from,
    // shown first with its citation; ref null = no reference, said on the page
    res.json({ n: it.n, total: items.length, done: done.size, ref: it.ref || null });
  }));
  app.get('/compare/img/:batch/:n-:side.png', wrap(async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || !['L', 'R', 'ref'].includes(req.params.side)) return res.status(400).end();
    res.sendFile(path.join(batchDir(req.params.batch), 'img', `${n}-${req.params.side}.png`));
  }));
  // dictation: the audio is relayed IN MEMORY to the local transcriber
  // (stt-ornith, faster-whisper, the one the /chat page uses) and never stored
  app.post('/compare/api/transcrire', express.raw({ type: () => true, limit: '10mb' }), wrap(async (req, res) => {
    if (!req.body || !req.body.length) return res.status(400).json({ erreur: 'audio absent' });
    try {
      const r = await fetch(`${STT}/transcrire`, { method: 'POST', headers: { 'Content-Type': req.get('Content-Type') || 'application/octet-stream' }, body: req.body, signal: AbortSignal.timeout(180000) });
      res.status(r.status).json(await r.json());
    } catch (e) { res.status(502).json({ erreur: `service de transcription injoignable (${e.message || e})` }); }
  }));
  app.post('/compare/api/answer', wrap(async (req, res) => {
    const { batch, n, choice } = req.body || {};
    if (!['L', 'R', 'equal'].includes(choice)) return res.status(400).json({ error: 'choice: L | R | equal' });
    const comment = String((req.body || {}).comment || '').trim().slice(0, 4000);
    const dir = batchDir(batch);
    const it = readJsonl(path.join(dir, 'items.jsonl')).find((x) => x.n === Number(n));
    if (!it) return res.status(404).json({ error: 'no such item' });
    const preferred = choice === 'equal' ? 'equal' : it.sides[choice];
    fs.appendFileSync(path.join(dir, 'answers.jsonl'), JSON.stringify({ n: it.n, id: it.id, choice, preferred, ...(comment ? { comment } : {}), at: new Date().toISOString() }) + '\n');
    res.json({ saved: true });
  }));
  // readable export of the answers and comments (to guide the next tuning):
  // one line per pair, the hidden sides resolved; ?format=md for Markdown
  app.get('/compare/export', wrap(async (req, res) => {
    const batch = req.query.batch, dir = batchDir(batch);
    const items = new Map(readJsonl(path.join(dir, 'items.jsonl')).map((x) => [x.n, x]));
    const rows = readJsonl(path.join(dir, 'answers.jsonl')).map((a) => {
      const it = items.get(a.n) || {};
      return { n: a.n, family: it.family, parts: it.parts, id: a.id, preferred: a.preferred, labels: it.labels, comment: a.comment || '', at: a.at };
    });
    const name = { base: 'auto d\'avant', new: 'auto d\'aujourd\'hui', equal: 'égal' };
    const md = [`# ${batch} — réponses (${rows.length})`, '', '| paire | famille | composants | préféré | commentaire |', '|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.n} | ${r.family || ''} | ${r.parts || ''} | ${name[r.preferred] || r.preferred} | ${r.comment.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n');
    if (req.query.format === 'md') return res.type('text/markdown; charset=utf-8').send(md + '\n');
    if (req.query.format === 'json') return res.json(rows);
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Réponses ${esc(batch)}</title>
<style>body{font-family:system-ui,sans-serif;margin:10px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 6px;vertical-align:top}</style>
<h2>${esc(batch)} — ${rows.length} réponses</h2><p><a href="export?batch=${encodeURIComponent(batch)}&format=md">Markdown</a> · <a href="export?batch=${encodeURIComponent(batch)}&format=json">JSON</a></p>
<table><tr><th>paire</th><th>famille</th><th>composants</th><th>préféré</th><th>commentaire</th></tr>${rows.map((r) => `<tr><td>${r.n}</td><td>${esc(r.family || '')}</td><td>${r.parts || ''}</td><td>${esc(name[r.preferred] || r.preferred)}</td><td>${esc(r.comment)}</td></tr>`).join('')}</table>`);
  }));
}
