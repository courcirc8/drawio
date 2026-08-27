#!/usr/bin/env node
/**
 * drawio-api-server — REST API on a dedicated port exposing the drawio fork
 * for programmatic schematic work: full editing, SPICE netlist import with
 * auto-placement + libavoid autorouting, netlist extraction, LVS, ERC, BOM,
 * and pixel-perfect headless export through the fork's own export page.
 *
 * Usage: node server.js [--port 8770]
 */
import express from 'express';
import * as model from './lib/model.js';
import * as documents from './lib/documents.js';
import * as stencils from './lib/stencils.js';
import * as netlist from './lib/netlist.js';
import * as lvs from './lib/lvs.js';
import * as erc from './lib/erc.js';
import * as bomLib from './lib/bom.js';
import * as place from './lib/place.js';
import * as place2 from './lib/place2.js';
import * as optimize from './lib/optimize.js';
import * as route from './lib/route.js';
import * as render from './lib/render.js';
import * as beauty from './lib/beauty.js';

const argPort = process.argv.indexOf('--port');
const PORT = argPort > -1 ? parseInt(process.argv[argPort + 1], 10)
  : parseInt(process.env.DRAWIO_API_PORT || '8770', 10);

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.text({ type: ['application/xml', 'text/xml', 'text/plain'], limit: '20mb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const cellJson = ({ style, styleRaw, ...c }) => ({ ...c, style: styleRaw });
const pageOf = (req) => {
  const entry = documents.getDoc(req.params.id);
  return { entry, model: model.getPage(entry.doc, req.query.page) };
};

app.get('/health', (req, res) => res.json({ ok: true, service: 'drawio-api-server' }));

// ------------------------------------------------------------- documents
app.get('/documents', (req, res) => res.json(documents.listDocuments()));

app.post('/documents', wrap((req, res) => {
  const body = typeof req.body === 'string' ? { xml: req.body } : (req.body || {});
  const { id, entry } = documents.createDocument(body);
  res.status(201).json({ id, pages: model.listPages(entry.doc) });
}));

app.get('/documents/:id', wrap((req, res) => {
  const entry = documents.getDoc(req.params.id);
  res.type('application/xml').send(model.serialize(entry.doc));
}));

app.delete('/documents/:id', wrap((req, res) => {
  documents.deleteDocument(req.params.id);
  res.json({ deleted: req.params.id });
}));

app.put('/documents/:id/save', wrap((req, res) => {
  const p = documents.saveDocument(req.params.id, (req.body || {}).path);
  res.json({ saved: p });
}));

app.get('/documents/:id/pages', wrap((req, res) => {
  res.json(model.listPages(documents.getDoc(req.params.id).doc));
}));

// ------------------------------------------------------------- shapes
app.get('/shapes', wrap((req, res) => {
  if (req.query.key != null) {
    const s = stencils.getShape(req.query.key);
    if (s == null) throw model.httpError(404, 'shape not found: ' + req.query.key);
    return res.json(s);
  }
  res.json(stencils.searchShapes(req.query.q || '', parseInt(req.query.limit || '25', 10)));
}));

// ------------------------------------------------------------- cells
app.get('/documents/:id/cells', wrap((req, res) => {
  const { model: m } = pageOf(req);
  const cells = model.allCells(m).map(model.cellInfo)
    .filter((c) => c.kind !== 'other')
    .map(cellJson);
  res.json(cells);
}));

app.post('/documents/:id/cells', wrap((req, res) => {
  const { model: m } = pageOf(req);
  const b = req.body || {};
  if (b.shape != null && b.shape.startsWith('mxgraph.')) {
    const s = stencils.getShape(b.shape);
    if (s == null) throw model.httpError(404, 'unknown shape: ' + b.shape);
    if (b.w == null) b.w = s.w;
    if (b.h == null) b.h = s.h;
  }
  const cell = model.addVertex(m, b);
  res.status(201).json(cellJson(model.cellInfo(cell)));
}));

app.patch('/documents/:id/cells/:cid', wrap((req, res) => {
  const { model: m } = pageOf(req);
  const cell = model.updateCell(m, req.params.cid, req.body || {});
  res.json(cellJson(model.cellInfo(cell)));
}));

app.delete('/documents/:id/cells/:cid', wrap((req, res) => {
  const { model: m } = pageOf(req);
  res.json({ deleted: model.deleteCell(m, req.params.cid) });
}));

// ------------------------------------------------------------- wires
app.post('/documents/:id/wires', wrap((req, res) => {
  const { model: m } = pageOf(req);
  const b = req.body || {};
  // {from: {cell, pin}, to: {cell, pin}} — pin resolved via the stencil catalog
  const resolve = (end, which) => {
    if (end == null) throw model.httpError(400, `missing "${which}"`);
    const cell = model.requireCell(m, end.cell);
    let pin = null;
    if (end.pin != null) {
      const shapeKey = model.parseStyle(cell.getAttribute('style')).map.get('shape');
      pin = stencils.getPin(shapeKey, end.pin) ||
        (typeof end.pin === 'object' ? end.pin : null);
      if (pin == null) throw model.httpError(404, `pin "${end.pin}" not found on ${end.cell}`);
    }
    return { cell: end.cell, pin };
  };
  const from = resolve(b.from, 'from');
  const to = resolve(b.to, 'to');
  const cell = model.addWire(m, {
    id: b.id, source: from.cell, target: to.cell,
    sourcePin: from.pin, targetPin: to.pin, style: b.style, points: b.points,
  });
  res.status(201).json(cellJson(model.cellInfo(cell)));
}));

app.post('/structures', wrap(async (req, res) => {
  const spice = typeof req.body === 'string' ? req.body : (req.body || {}).spice;
  if (spice == null || spice === '') throw model.httpError(400, 'SPICE netlist required');
  const { detectStructures } = await import('./lib/patterns.js');
  res.json(detectStructures(netlist.parseSpice(spice)));
}));

// ------------------------------------------------------------- routing
app.post('/documents/:id/route', wrap(async (req, res) => {
  const { model: m } = pageOf(req);
  const b = req.body || {};
  const result = await route.routePage(m, b.wires || null, b.options || {});
  res.json(result);
}));

// ------------------------------------------------------------- EDA
app.post('/documents/:id/netlist/import', wrap(async (req, res) => {
  const entry = documents.getDoc(req.params.id);
  const m = model.getPage(entry.doc, req.query.page);
  const spice = typeof req.body === 'string' ? req.body : (req.body || {}).spice;
  if (spice == null || spice === '') throw model.httpError(400, 'SPICE netlist required (text body or {"spice": …})');
  const parsed = netlist.parseSpice(spice);
  const engine = req.query.engine || 'v1';
  const iters = parseInt(req.query.optimize || '0', 10);
  if (iters > 0) {
    const { best, history } = await optimize.optimizeNetlist(parsed,
      { iterations: iters, reference: req.query.reference || null });
    entry.doc = best.doc;
    return res.status(201).json({ engine: 'place2+optimize', score: best.score,
      metrics: best.metrics, params: best.params, history,
      components: best.placed.components, wires: best.placed.wires });
  }
  const placed = engine === 'v2' ? place2.importNetlist2(m, parsed) : place.importNetlist(m, parsed);
  const routed = await route.routePage(m, placed.wires, {});
  res.status(201).json({ ...placed, routed: routed.ids.length });
}));

app.get('/documents/:id/netlist', wrap((req, res) => {
  const { model: m } = pageOf(req);
  const out = netlist.extractNetlist(m);
  if ((req.query.format || 'spice') === 'json') return res.json(out);
  res.type('text/plain').send(out.spice);
}));

app.post('/documents/:id/lvs', wrap((req, res) => {
  const { model: m } = pageOf(req);
  const spice = typeof req.body === 'string' ? req.body : (req.body || {}).spice;
  if (spice == null || spice === '') throw model.httpError(400, 'reference SPICE netlist required');
  const golden = netlist.parseSpice(spice);
  const extracted = netlist.extractNetlist(m);
  const report = lvs.compare(extracted, golden);
  res.json({ ...report, extraction_issues: extracted.issues });
}));

app.get('/documents/:id/erc', wrap((req, res) => {
  const { model: m } = pageOf(req);
  res.json(erc.check(m));
}));

app.get('/documents/:id/bom', wrap((req, res) => {
  const { model: m } = pageOf(req);
  const rows = bomLib.bom(m);
  if ((req.query.format || 'json') === 'csv') return res.type('text/csv').send(bomLib.bomCsv(rows));
  res.json(rows);
}));

app.post('/documents/:id/beauty', wrap(async (req, res) => {
  const { entry, model: m } = pageOf(req);
  const b = req.body || {};
  res.json(await beauty.scoreDocument(entry.doc, m, { reference: b.reference }));
}));

// ------------------------------------------------------------- export
app.get('/documents/:id/export', wrap(async (req, res) => {
  const { entry, model: m } = pageOf(req);
  const format = req.query.format || 'png';
  if (format === 'xml') return res.type('application/xml').send(model.serialize(entry.doc));
  if (!['png', 'svg', 'pdf'].includes(format)) throw model.httpError(400, 'format must be png|svg|pdf|xml');
  let region = null;
  if (req.query.region != null) {
    const [x, y, w, h] = String(req.query.region).split(',').map(Number);
    if ([x, y, w, h].some(Number.isNaN)) throw model.httpError(400, 'region must be x,y,w,h');
    region = { x, y, w, h };
  }
  const out = await render.exportDocument(entry.doc, m, {
    format,
    scale: req.query.scale != null ? parseFloat(req.query.scale) : 2,
    border: req.query.border != null ? parseInt(req.query.border, 10) : 10,
    bg: req.query.bg || '#ffffff',
    pageId: req.query.pageId,
    region,
  });
  res.type(out.contentType).send(out.buffer);
}));

// ------------------------------------------------------------- checkpoints
app.post('/documents/:id/checkpoints', wrap((req, res) => {
  res.status(201).json({ checkpoints: documents.checkpoint(req.params.id, (req.body || {}).name) });
}));

app.post('/documents/:id/checkpoints/:name/restore', wrap((req, res) => {
  documents.restore(req.params.id, req.params.name);
  res.json({ restored: req.params.name });
}));

// ------------------------------------------------------------- errors
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`drawio-api-server listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGINT', async () => { await render.closeBrowser(); server.close(); process.exit(0); });
process.on('SIGTERM', async () => { await render.closeBrowser(); server.close(); process.exit(0); });

export default app;
