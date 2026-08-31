#!/usr/bin/env node
/**
 * drawio-api-server — REST API on a dedicated port exposing the drawio fork
 * for programmatic schematic work: full editing, SPICE netlist import with
 * auto-placement + libavoid autorouting, netlist extraction, LVS, ERC, BOM,
 * and pixel-perfect headless export through the fork's own export page.
 *
 * Usage: node server.js [--port 8770]
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fsp from 'node:fs/promises';
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
import * as place3 from './lib/place3.js';
import * as optimize from './lib/optimize.js';
import * as route from './lib/route.js';
import * as render from './lib/render.js';
import * as beauty from './lib/beauty.js';

const argPort = process.argv.indexOf('--port');
const PORT = argPort > -1 ? parseInt(process.argv[argPort + 1], 10)
  : parseInt(process.env.DRAWIO_API_PORT || '8770', 10);

const app = express();

// --- draw.io plugin support -------------------------------------------------
// The eda-validate plugin (plugin/eda-validate.js) runs INSIDE a draw.io page,
// which is a different origin from this server (the webapp is served from
// wherever it is hosted; this API listens on 127.0.0.1:8770). Both the plugin
// fetch and every fetch() the plugin makes back to /documents/... are therefore
// cross-origin. Without these headers each call fails with an opaque CORS error
// that is indistinguishable, from the browser's side, from the server being
// down -- so the plugin would permanently report "api-server unreachable" even
// though the same endpoints work fine from curl.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Serve plugin/ so draw.io can load it by URL:
//   https://<drawio-host>/?p=http://127.0.0.1:8770/plugin/eda-validate.js
app.use('/plugin', express.static(fileURLToPath(new URL('./plugin', import.meta.url))));

// --- /editor : the fork's own draw.io, with the plugin already loaded --------
// BUG (found 2026-08-28 by loading the plugin in a real browser for the first
// time): NEITHER documented end-user loading path works in this build.
//   * `?p=<url>` is a REGISTRY-KEY lookup (App.loadPlugins, src/main/webapp/js/
//     diagramly/App.js:1653, keyed into App.pluginRegistry) -- it never fetches
//     a URL, it logs "Unknown plugin" and loads nothing.
//   * the Extras > Plugins... dialog's "Custom URL" button is rendered only
//     `if (ALLOW_CUSTOM_PLUGINS)` (Dialogs.js:15799), which defaults false
//     (Init.js:76) and nothing in this fork sets it true -- the button is not
//     in the dialog at all.
// The only mechanism that works is Draw.loadPlugin (App.js:161), a
// queue-then-invoke with no gate of its own. Rather than patch App.js or flip
// ALLOW_CUSTOM_PLUGINS -- both of which would edit src/ and break the
// sidecar property (`git diff` against upstream outside api-server/ must stay
// empty) -- serve the webapp from THIS origin and inject the script tag on the
// way out. Nothing on disk is modified; the rewrite is per-response.
const WEBAPP = fileURLToPath(new URL('../src/main/webapp', import.meta.url));
// BUG (found 2026-08-28, browser test of THIS route): a plain
// `<script src="/plugin/eda-validate.js">` placed right before </body> threw
// `ReferenceError: Draw is not defined` on every load -- 100% reproducible,
// not a timing flake. index.html's own last script (js/main.js, also right
// before </body>) is a synchronous, blocking <script src>: the browser runs
// it to completion, in source order, before moving on to our injected tag
// immediately after it. But js/main.js is only the entry point for this
// fork's unbundled dev build -- it does not itself build the App/EditorUi
// instance. `window.Draw` is created by `App.initPluginCallback()`
// (App.js:1627), called from deep inside App's own async bootstrap
// (App.js:1015, behind config/mxSettings loading that the surrounding code
// comments say can be deferred) -- well after js/main.js's synchronous
// script tag has already returned. So `Draw` genuinely does not exist yet at
// the point our tag runs; this is not fixable by re-ordering the injection
// point relative to </body>, since App.js's own async chain, not DOM
// position, decides when Draw appears.
// Fix: don't call Draw.loadPlugin ourselves -- poll for it (same technique
// already proven live for the addScriptTag-after-networkidle2 path in
// test/plugin.test.js) and only then fetch the real plugin file. This is a
// wrong-load-hook bug in the injected snippet, not in eda-validate.js
// itself, which is untouched.
//
// BUG #2 (found 2026-08-28, same browser session): the plugin's own default
// `SERVER` (eda-validate.js:26) is a HARDCODED 'http://127.0.0.1:8770' --
// correct only when the api-server happens to run on its historical default
// port. /editor is designed to be same-origin with the API (the comment
// above this block says so), but nothing was actually setting
// `window.EDA_VALIDATE_SERVER` to match. On a non-8770 port this went
// undetected in manual testing only because ANOTHER drawio-api-server
// happened to be running on 8770 at the time -- the plugin posted the
// canvas XML there instead, and got back matching cell ids purely because
// mxfile cell ids (R1, R2, ...) are embedded in the posted XML itself, not
// server-assigned, so the ERC result looked right by coincidence. On a host
// with nothing listening on 8770, this silently degrades to "api-server
// unreachable" pointing at the WRONG port while /editor's own, reachable,
// server sits one line above it. Fix: derive the origin from the request
// (proxy-safe -- respects X-Forwarded-* via express's trust proxy setting,
// same as `req.protocol`/`req.get('host')` always do) and set
// `window.EDA_VALIDATE_SERVER` before the plugin script loads.
function wrapEditor(req, res, next) {
  fsp.readFile(path.join(WEBAPP, 'index.html'), 'utf8').then((html) => {
    if (!html.includes('</body>') || !html.includes('<head>')) {
      return next(new Error('index.html is not the shape this rewrite expects (<head> + </body>)'));
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    const inject = `<script>
window.EDA_VALIDATE_SERVER = ${JSON.stringify(origin)};
(function () {
  var iv = setInterval(function () {
    if (window.Draw && typeof window.Draw.loadPlugin === 'function') {
      clearInterval(iv);
      var s = document.createElement('script');
      s.src = '/plugin/eda-validate.js';
      document.body.appendChild(s);
    }
  }, 20);
})();
</script>
</body>`;
    // <base> rather than a redirect to '/editor/': express 4 routes '/editor'
    // and '/editor/' to the SAME handler (strict routing is off), so a redirect
    // from one to the other loops forever -- observed, 301 to itself. With the
    // base tag index.html's relative asset paths (js/bootstrap.js, ...) resolve
    // under /editor/ whichever form the user typed.
    res.type('html').send(html
      .replace('<head>', '<head>\n<base href="/editor/">')
      .replace('</body>', inject));
  }).catch(next);
}
app.get(['/editor', '/editor/', '/editor/index.html'], wrapEditor);
// Same origin as the injected script AND as the API, so the plugin's fetches
// are same-origin here and the CORS headers above are belt-and-braces.
app.use('/editor', express.static(WEBAPP));
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
      // T4: `cell` may be a refdes-wrapped <object>; style lives on the inner
      // <mxCell> — styleOf() resolves that indirection (raw getAttribute
      // would silently return null for a wrapped component).
      const shapeKey = model.parseStyle(model.styleOf(cell)).map.get('shape');
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
  const force = req.query.force === '1' || req.query.force === 'true';
  if (iters > 0) {
    // optimize.optimizeNetlist already gates every candidate on an internal
    // LVS round-trip (lib/optimize.js:evaluate) — a returned `best` is
    // guaranteed to match, so no separate mandatory-LVS check is needed here.
    // `engine` passthrough: optimize.optimizeNetlist defaults to place2 for
    // anything other than 'v3' (see lib/optimize.js), so an omitted engine
    // or 'v1'/'v2' here reproduces exactly today's behaviour — only
    // engine=v3 changes which placer the hill-climb regenerates candidates
    // with.
    const { best, history } = await optimize.optimizeNetlist(parsed,
      { iterations: iters, reference: req.query.reference || null, engine });
    entry.doc = best.doc;
    const lvsReport = lvs.compare(netlist.extractNetlist(model.getPage(best.doc)), parsed);
    return res.status(201).json({ engine: (engine === 'v3' ? 'place3+optimize' : 'place2+optimize'), score: best.score,
      metrics: best.metrics, params: best.params, history, lvs: lvsReport,
      components: best.placed.components, wires: best.placed.wires });
  }
  // Four engines now, from two lines of work merged 2026-08-31: v1/v2 and elk
  // from feature/api-server, v3 (place3, source-less RF chains) from the RF
  // branch. Kept as a single dispatch rather than nested ternaries because
  // `elk` is the only async one.
  let placed;
  if (engine === 'elk') {
    const { importNetlistElk } = await import('./lib/place-elk.js');
    placed = await importNetlistElk(m, parsed);
  } else if (engine === 'v3') {
    placed = place3.importNetlist3(m, parsed);
  } else {
    placed = engine === 'v2' ? place2.importNetlist2(m, parsed) : place.importNetlist(m, parsed);
  }
  const routed = await route.routePage(m, placed.wires, {});
  // After routing, not before: edge waypoints are absolute too (see
  // model.normalizeOrigin -- negative coordinates were being clipped off the
  // exported PNG without any error).
  model.normalizeOrigin(m);
  // T1: LVS is now mandatory on import — extract the netlist back out of the
  // document we just built and compare against the input. A mismatch used to
  // be silently returned as a 201 success with only ?optimize=N or an
  // explicit POST /lvs catching it; now the endpoint itself fails closed.
  // The document is kept either way (so it can still be inspected/fixed),
  // but the HTTP response reflects the failure unless ?force=1 downgrades it.
  const extracted = netlist.extractNetlist(m);
  const report = lvs.compare(extracted, parsed);
  const decision = lvs.gate(report, { force });
  if (!decision.ok) return res.status(decision.status).json({ error: decision.error, report });
  const payload = { ...placed, routed: routed.ids.length, lvs: report };
  if (decision.warnings) payload.warnings = decision.warnings;
  res.status(decision.status).json(payload);
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

app.post('/documents/:id/compact', wrap(async (req, res) => {
  const { entry, model: m } = pageOf(req);
  const { compactPage } = await import('./lib/compact.js');
  const r = await compactPage(m, req.body || {});
  res.json(r);
}));

app.post('/documents/:id/check', wrap(async (req, res) => {
  const { model: m } = pageOf(req);
  const { checkDocument } = await import('./lib/check.js');
  res.json(checkDocument(m));
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
