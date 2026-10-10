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
import fs from 'node:fs';
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
import * as preplace from './lib/preplace.js';
import * as annotate from './lib/annotate.js';
import * as critic from './lib/critic.js';
import * as exportAsc from './lib/export-asc.js';
import { rewire } from './lib/rewire.js';

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
    // the server's base URL is computed IN THE BROWSER from the page address,
    // so the editor also works behind a path prefix (ai-station portal:
    // https://<host>/drawio/editor/, prefix stripped by tailscale serve)
    const inject = `<script>
window.EDA_VALIDATE_SERVER = location.origin + location.pathname.replace(/\\/editor(\\/index\\.html|\\/)?$/, '');
(function () {
  var iv = setInterval(function () {
    if (window.Draw && typeof window.Draw.loadPlugin === 'function') {
      clearInterval(iv);
      var s = document.createElement('script');
      s.src = window.EDA_VALIDATE_SERVER + '/plugin/eda-validate.js';
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
      .replace('<head>', `<head>\n<script>document.write('<base href="' + location.pathname.replace(/(\\/editor)(\\/index\\.html|\\/)?$/, '$1/') + '">');</script>`)
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

// Netlist-correction page (lib/correct.js): one figure at a time, the
// vision netlist to confirm, fix or reject; batches by tools/dvd-rf-batch.mjs
const { mountCorrect } = await import('./lib/correct.js');
mountCorrect(app, wrap);
const { mountCompare } = await import('./lib/compare.js');
mountCompare(app, wrap);
// Eric checks a reading of a figure (lib/verify.js): figure, drawing, netlist, verdict
const { mountVerify } = await import('./lib/verify.js');
mountVerify(app, wrap);
// read-only review sets for the orchestrator (lib/review.js, tools/review-batch.mjs)
const { mountReview } = await import('./lib/review.js');
mountReview(app, wrap);
// simulation results on the drawing (simulator <-> drawio bridge, lib/sim-annotate.js):
// body = a drawio-sim-annotations/1 object, or {sim, netlist}; ?show=nodes,devices,summary
const { annotateSim, clearSim } = await import('./lib/sim-annotate.js');
app.post('/documents/:id/annotations/sim', wrap(async (req, res) => {
  const entry = documents.getDoc(req.params.id);
  const m = model.getPage(entry.doc, req.query.page);
  const b = req.body || {};
  const sim = b.sim || b;
  const text = b.netlist || (entry.importNetlist || {})[req.query.page || ''] || null;
  const show = new Set(String(req.query.show || 'nodes,devices,summary').split(',').map((x) => x.trim()));
  const out = annotateSim(m, sim, { netlist: text, show });
  res.json({ ...out, netlist: text ? 'ok' : 'absente : seuls les noms identiques sont reliés' });
}));
app.delete('/documents/:id/annotations/sim', wrap(async (req, res) => {
  const entry = documents.getDoc(req.params.id);
  res.json({ removed: clearSim(model.getPage(entry.doc, req.query.page)) });
}));
// Eric's before/after page (tools/eric-pairs-batch.mjs): the blind /compare page
// on the eric-paires batch; relative redirect so it works behind /drawio/
// (the newest eric-paires* batch; earlier batches keep their answers)
app.get('/eric-paires', (req, res) => {
  const root = process.env.COMPARE_ROOT || '/AI/datasets/judge/compare';
  const latest = fs.readdirSync(root).filter((d) => /^eric-paires(-\d+)?$/.test(d))
    .sort((a, b) => Number(a.split('-')[2] || 1) - Number(b.split('-')[2] || 1)).pop() || 'eric-paires';
  res.redirect((req.query.export != null ? 'compare/export?batch=' : 'compare?batch=') + encodeURIComponent(latest));
});

// home page for the ai-station portal (https://<host>/drawio/ -> 127.0.0.1:8770/,
// prefix stripped by tailscale serve): relative links only, shared bar optional
app.get('/', (req, res) => res.type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>drawio — schémas</title>
<link rel="stylesheet" href="/commun/style.css"><script src="/commun/menu.js" defer></script>
<style>body{font-family:system-ui,sans-serif;margin:16px;max-width:40em}li{margin:.5em 0}</style>
<h1>drawio — schémas électroniques</h1><ul>
<li><a href="correct?batch=rf-1">Correction des netlists (lot rf-1)</a></li>
<li><a href="eric-paires">Avant / après : 10 paires à juger</a> (<a href="eric-paires?export">réponses et commentaires</a>)</li>
<li><a href="eric-lectures">Vérification des lectures de figures</a> (<a href="eric-lectures?export">verdicts</a>)</li>
<li><a href="compare">Comparaison à l'aveugle de deux dessins</a></li>
<li><a href="compare/gallery?batch=exemples-1">Galerie d'exemples : auto et recuit (sa)</a></li>
<li><a href="editor/">Éditeur drawio</a></li>
<li><a href="health">État du serveur</a></li></ul>`));

// Motif registry (lib/motifs.js): every recognised analogue motif of a
// netlist, the macro-blocks they induce and the components NO motif covers.
app.post('/motifs', wrap(async (req, res) => {
  const spice = typeof req.body === 'string' ? req.body : (req.body || {}).spice;
  if (spice == null || spice === '') throw model.httpError(400, 'SPICE netlist required');
  const { detectMotifs, MOTIFS } = await import('./lib/motifs.js');
  res.json({ registry: MOTIFS, ...detectMotifs(netlist.parseSpice(spice)) });
}));

// Function recognition (lib/function.js + lib/recognize-llm.js): circuit type
// ranked from the IEEE statistics, published schematics with the same motifs,
// then the local LLM checked against both. ?llm=0 skips the LLM.
app.post('/recognize', wrap(async (req, res) => {
  const spice = typeof req.body === 'string' ? req.body : (req.body || {}).spice;
  if (spice == null || spice === '') throw model.httpError(400, 'SPICE netlist required');
  const { recognize } = await import('./lib/recognize-llm.js');
  res.json(await recognize(netlist.parseSpice(spice), { llm: req.query.llm !== '0' }));
}));

// Drawing conventions of published schematics of the same function
// (lib/conventions.js): weighted checks on the page, ?type= forces the type.
app.post('/documents/:id/conventions', wrap(async (req, res) => {
  const { model: m } = pageOf(req);
  const spice = typeof req.body === 'string' ? req.body : (req.body || {}).spice;
  if (spice == null || spice === '') throw model.httpError(400, 'SPICE netlist (the reference) required');
  const { conventionReport } = await import('./lib/conventions.js');
  res.json(conventionReport(m, netlist.parseSpice(spice), { type: req.query.type || null }));
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
  // kept with the document: the simulation annotations (lib/sim-annotate.js)
  // find nodes through the netlist that was drawn
  (entry.importNetlist ||= {})[req.query.page || ''] = spice;
  const engine = req.query.engine || 'v1';
  const iters = parseInt(req.query.optimize || '0', 10);
  // ?seed=<name> — seeded pre-placement from the frozen hand-drawn reference
  // (api-server/seeds/<name>.json, see lib/preplace.js). Only place3 honours it;
  // an unknown name degrades to a warning, never a 4xx.
  const seed = req.query.seed || null;
  const seedScale = req.query.seedScale != null ? parseFloat(req.query.seedScale) : null;
  const force = req.query.force === '1' || req.query.force === 'true';
  // Seed sidecar loaded once here (not just inside place3/preplace) so the
  // ANNOTATION LAYER (lib/annotate.js) can read its own `annotations` key
  // and reuse the exact same scale `devices` was placed at — an annotation
  // anchor and the component it names are declared in the same raw
  // reference-coordinate space (see seeds/matching_2446.json's own note),
  // so they must be scaled identically or a text/block drifts off the part
  // it is meant to label as soon as ?seedScale= overrides the default.
  const seedDoc = seed ? preplace.loadSeed(seed) : null;
  const annScale = seedScale ?? (seedDoc && seedDoc.scale) ?? 1;
  if (iters > 0) {
    // optimize.optimizeNetlist already gates every candidate on an internal
    // LVS round-trip (lib/optimize.js:evaluate) — a returned `best` is
    // guaranteed to match, so no separate mandatory-LVS check is needed here.
    // `engine` passthrough: optimize.optimizeNetlist defaults to place2 for
    // anything other than 'v3' (see lib/optimize.js), so an omitted engine
    // or 'v1'/'v2' here reproduces exactly today's behaviour — only
    // engine=v3 changes which placer the hill-climb regenerates candidates
    // with.
    const { best, history, engine: usedEngine } = await optimize.optimizeNetlist(parsed,
      { iterations: iters, reference: req.query.reference || null, engine, preseed: seed, preseedScale: seedScale });
    entry.doc = best.doc;
    // ANNOTATION LAYER — applied AFTER optimize/route has already picked and
    // routed the final placement (optimize.optimizeNetlist routes every
    // candidate internally). Never before: an annotation cell added earlier
    // would be visible to route.js's obstacle list and could move a wire it
    // has no business influencing. See lib/annotate.js's module docstring
    // for the full inertness + DRC-safety argument.
    let annReport = null;
    if (seedDoc && seedDoc.annotations) {
      annReport = annotate.applyAnnotations(model.getPage(entry.doc), seedDoc, { scale: annScale });
    }
    const lvsReport = lvs.compare(netlist.extractNetlist(model.getPage(entry.doc)), parsed);
    if (!lvsReport.match) throw model.httpError(422, 'final optimized document failed strict LVS');
    return res.status(201).json({ engine: (usedEngine === 'v3' ? 'place3+optimize' : String(usedEngine).startsWith('v4') ? 'place4+optimize' : 'place2+optimize') + (engine === 'auto' ? ' (auto)' : ''), score: best.score,
      metrics: best.metrics, params: best.params, history, lvs: lvsReport,
      components: best.placed.components, wires: best.placed.wires,
      ...(annReport ? { annotations: annReport } : {}) });
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
    placed = place3.importNetlist3(m, parsed, seed ? { seed, ...(seedScale ? { seedScale } : {}) } : {});
  } else if (engine === 'auto') {
    // lib/auto.js: AUTO_CANDIDATES x AUTO_SPACINGS, fewest check.js errors,
    // then published conventions, then the earlier candidate
    const { autoPlace } = await import('./lib/auto.js');
    let win;
    try { win = await autoPlace(parsed); } catch (e) { throw model.httpError(e.status || 500, e.message); }
    entry.doc = win.doc;
    placed = { ...win.placed, engine: win.label + ' (auto)', auto: win.trials };
    const extracted = netlist.extractNetlist(model.getPage(entry.doc));
    const report = lvs.compare(extracted, parsed);
    const decision = lvs.gate(report, { force });
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error, report });
    return res.status(decision.status).json({ ...placed, routed: placed.wires.length, lvs: report });
  } else if (engine === 'v4') {
    // macro-blocks + hierarchical routing (lib/place4.js): blocks placed and
    // routed by place2 in isolation, composed by signal flow, inter-block
    // nets routed last. Routes its own wires; routePage below re-routes
    // nothing (empty list) but still runs the page-wide cleanup passes.
    const { importNetlist4 } = await import('./lib/place4.js');
    placed = await importNetlist4(m, parsed);
  } else {
    placed = engine === 'v2' ? place2.importNetlist2(m, parsed) : place.importNetlist(m, parsed);
  }
  const routed = engine === 'v4' ? { ids: placed.wires } : await route.routePage(m, placed.wires, {});
  // After routing, not before: edge waypoints are absolute too (see
  // model.normalizeOrigin -- negative coordinates were being clipped off the
  // exported PNG without any error).
  model.normalizeOrigin(m);
  // ANNOTATION LAYER — same placement as the optimize branch above: after
  // routing/normalizeOrigin, so annotation cells are never seen as routing
  // obstacles. Only engine=v3 threads a seed through at all.
  let annReport = null;
  if (engine === 'v3' && seedDoc && seedDoc.annotations) {
    annReport = annotate.applyAnnotations(m, seedDoc, { scale: annScale });
  }
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
  if (annReport) payload.annotations = annReport;
  res.status(decision.status).json(payload);
}));

// ------------------------------------------------------------- rewire
// Re-wire an ALREADY-PLACED document from a netlist, using the model's own
// junction dots as the only intermediate routing nodes. Never re-places —
// component/ground/port/dot geometry is byte-identical before and after
// (only edge cells are touched: deleted, then re-added). See lib/rewire.js.
// LAYER 2 (see migration/06-cursor-infra-migration or the task that added
// this): /rewire is the ONE endpoint diagnosed to actually have bitten LVS —
// chaining it after an /optimize run produced 13 "terminal unreachable"
// warnings and LVS `false` with nothing objecting. It already receives the
// reference .cir as its own request body, so it can gate itself with no API
// change: made transactional here, snapshotting the whole document (not
// just the page) before rewiring and rolling back to that exact snapshot if
// the call flips a passing LVS to a failing one. Deliberately NOT a
// connectivityFingerprint() check (invariant.js, layer 1) — rewire() is
// SUPPOSED to change connectivity, that's its entire job; the correct check
// here is the real thing, compare() against the caller's own reference.
// Fails CLOSED (409, rolled back), never just a warning. If LVS was ALREADY
// false before the call, no rollback: the caller may be deliberately
// repairing a broken document, and silently reverting their starting point
// would be worse than doing nothing.
app.post('/documents/:id/rewire', wrap((req, res) => {
  const { entry, model: m } = pageOf(req);
  const spice = typeof req.body === 'string' ? req.body : (req.body || {}).spice;
  if (spice == null || spice === '') throw model.httpError(400, 'SPICE netlist required (text body or {"spice": …})');
  // allowFlip: opt-in, default OFF (see lib/rewire.js module contract) — via
  // ?allowFlip=1 on the query string, or {"allowFlip":true} in a JSON body
  // (only reachable when the netlist itself also travels inside that JSON
  // body as `spice`, same as the existing `tolerance` option below).
  const allowFlip = req.query.allowFlip === '1' || req.query.allowFlip === 'true' ||
    (req.body && req.body.allowFlip === true);
  const opts = {};
  if (req.body && req.body.tolerance != null) opts.tolerance = req.body.tolerance;
  if (allowFlip) opts.allowFlip = true;

  const golden = netlist.parseSpice(spice);
  const lvsBefore = lvs.compare(netlist.extractNetlist(m), golden);
  const snapshotXml = model.serialize(entry.doc); // whole document, not just this page

  const { wires, warnings, unreachable, flipped, straightened } = rewire(m, spice, opts);
  const extracted = netlist.extractNetlist(m);
  const lvsReport = lvs.compare(extracted, golden);

  if (lvsBefore.match && !lvsReport.match) {
    entry.doc = model.parseDrawio(snapshotXml); // roll back: byte-identical to pre-call
    return res.status(409).json({
      error: 'rewire would break LVS (was passing, would now fail) — rolled back, document unchanged',
      lvs_before: lvsBefore, lvs_after: lvsReport, warnings, unreachable,
    });
  }
  res.json({ wires, warnings, lvs: lvsReport, lvs_before: lvsBefore, unreachable, flipped, straightened });
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

// Task C (2026-08-31): bind a free wire endpoint to a junction cell it merely
// coincides with (a hand-drawn waypoint the user meant to attach to, but the
// GUI drag missed the cell). TIGHT default tolerance (2 px, ?tolerance=N to
// override) -- see lib/bind-endpoints.js module doc for why proximity binding
// is otherwise exactly the positional-mapping mistake AGENTS.md domain
// correction #1 warns about, and why every free endpoint is reported (bound
// or not) rather than silently skipped.
app.post('/documents/:id/bind-endpoints', wrap(async (req, res) => {
  const { model: m } = pageOf(req);
  const { bindEndpoints } = await import('./lib/bind-endpoints.js');
  const opts = {};
  if (req.query.tolerance != null) opts.tolerance = req.query.tolerance;
  else if (req.body && req.body.tolerance != null) opts.tolerance = req.body.tolerance;
  res.json(bindEndpoints(m, opts));
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

// Visual critique by a multimodal model (lib/critic.js): renders the page,
// asks the model for readability defects the geometry judge cannot see,
// returns findings bound to existing refdes. OPT-IN, never on the optimizer
// path. Body: {backend?: 'anthropic'|'openai', model?, netlist?}.
app.post('/documents/:id/critique', wrap(async (req, res) => {
  const { entry, model: m } = pageOf(req);
  const b = req.body || {};
  res.json(await critic.critique(entry.doc, m, { backend: b.backend, modelName: b.model, netlist: b.netlist || null }));
}));

// ------------------------------------------------------------- export
app.get('/documents/:id/export', wrap(async (req, res) => {
  const { entry, model: m } = pageOf(req);
  const format = req.query.format || 'png';
  if (format === 'xml') return res.type('application/xml').send(model.serialize(entry.doc));
  if (format === 'asc') {
    // LTspice schematic (lib/export-asc.js): symbols at the drawing's
    // positions, connectivity by named FLAGs, round-trip LVS verified —
    // a failed round-trip is a 409, never a silently different circuit.
    const r = exportAsc.exportAsc(m, { title: req.query.title || null, scale: req.query.scale != null ? parseFloat(req.query.scale) : 0.8 });
    if (!r.verified && req.query.force !== '1') {
      return res.status(409).json({ error: 'asc round-trip LVS failed', report: r.report, skipped: r.skipped });
    }
    res.set('X-Asc-Skipped', String(r.skipped.length));
    return res.type('text/plain').send(r.asc);
  }
  if (!['png', 'svg', 'pdf'].includes(format)) throw model.httpError(400, 'format must be png|svg|pdf|xml|asc');
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
