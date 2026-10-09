/**
 * review.js — READ-ONLY review sets for the orchestrator (built by
 * tools/review-batch.mjs into REVIEW_ROOT/<batch>/: index.json, img/*.png).
 * Nothing here is shown to Eric; no answers are collected.
 *   GET /review                       the page to read a set (?batch=…)
 *   GET /review/index.json            the latest batch's index (image URLs made absolute)
 *   GET /review/<batch>/index.json    one batch's index
 *   GET /review/<batch>/img/<file>    its PNGs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../review-ui/index.html', import.meta.url));

const ROOT = process.env.REVIEW_ROOT || '/AI/datasets/judge/review';
const SAFE = /^[A-Za-z0-9_-]+$/, FILE = /^[A-Za-z0-9_.-]+\.png$/;

export function mountReview(app, wrap) {
  // the page to READ a set (phone-friendly): reference and drawing side by side
  app.get(['/review', '/review/'], (req, res) => res.sendFile(PAGE));
  const batches = () => (fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((d) => SAFE.test(d) && fs.existsSync(path.join(ROOT, d, 'index.json'))) : [])
    .sort((a, b) => fs.statSync(path.join(ROOT, a, 'index.json')).mtimeMs - fs.statSync(path.join(ROOT, b, 'index.json')).mtimeMs);
  const send = (req, res, b) => {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, b, 'index.json'), 'utf8'));
    // URLs relative to where the portal serves this API (/drawio/ behind it)
    const base = (req.headers['x-forwarded-prefix'] || (req.query.base ?? '/drawio')) + `/review/${b}/`;
    for (const it of j.items || []) { it.refUrl = base + it.ref; it.drawioUrl = base + it.drawio; if (it.before) it.beforeUrl = base + it.before; }
    j.batches = batches();
    res.json(j);
  };
  app.get('/review/index.json', wrap(async (req, res) => {
    const all = batches();
    if (!all.length) { res.status(404).json({ error: 'no review batch yet' }); return; }
    send(req, res, all[all.length - 1]);
  }));
  app.get('/review/:batch/index.json', wrap(async (req, res) => {
    const b = req.params.batch;
    if (!SAFE.test(b) || !fs.existsSync(path.join(ROOT, b, 'index.json'))) { res.status(404).json({ error: 'no such batch' }); return; }
    send(req, res, b);
  }));
  app.get('/review/:batch/img/:file', (req, res) => {
    const { batch, file } = req.params;
    if (!SAFE.test(batch) || !FILE.test(file)) { res.status(400).end(); return; }
    const f = path.join(ROOT, batch, 'img', file);
    if (!fs.existsSync(f)) { res.status(404).end(); return; }
    res.sendFile(f);
  });
}
