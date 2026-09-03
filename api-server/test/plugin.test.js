/**
 * Regression test for the eda-validate draw.io plugin (plugin/eda-validate.js)
 * loaded through the /editor route (server.js) -- the supported end-user path.
 *
 * History, see plugin/README.md for the full account:
 * - The plugin was written and shipped with NO browser ever having loaded it.
 * - First browser pass (2026-08-28) found BOTH documented loading paths are
 *   no-ops in this fork's build: `p=<url>` is a registry-key lookup, not a
 *   URL loader (App.js:1653), and the Extras > Plugins... dialog's "Custom
 *   URL" button only renders `if (ALLOW_CUSTOM_PLUGINS)`, which defaults
 *   false and nothing in this fork sets true (Dialogs.js:15799, Init.js:76).
 * - `/editor` (server.js) was added to close that gap: it serves the fork's
 *   own index.html from the API's own origin, rewriting the response (never
 *   the file on disk) to add `<base href="/editor/">` and inject the plugin
 *   via `Draw.loadPlugin` (App.js:161, no security gate of its own).
 * - Two more bugs turned up testing /editor itself, both fixed in server.js,
 *   both covered here so they can't silently regress:
 *   (a) a plain `<script src="/plugin/eda-validate.js">` right before
 *       </body> threw `ReferenceError: Draw is not defined` 100% of the
 *       time -- `window.Draw` isn't created until deep in App.js's async
 *       bootstrap (App.js:1015/1627), well after index.html's own
 *       synchronous last script (js/main.js) returns. Fixed by polling for
 *       `window.Draw.loadPlugin` before fetching the plugin file.
 *   (b) the plugin's hardcoded default `SERVER` (eda-validate.js:26,
 *       'http://127.0.0.1:8770') silently pointed at the wrong origin on any
 *       /editor port other than 8770 -- undetected in manual testing only
 *       because another api-server instance happened to be listening on
 *       8770 at the time. Fixed by having /editor inject
 *       `window.EDA_VALIDATE_SERVER` set to the REQUEST's own origin, so it
 *       is correct on whatever port the server actually runs on. This test
 *       does NOT set EDA_VALIDATE_SERVER itself, on purpose -- it must pass
 *       using only what /editor injects, otherwise it would not catch (b).
 *
 * Runtime budget: this whole file must finish in well under 2 minutes
 * (AGENTS.md "no local CPU-heavy jobs").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Deliberately NOT 8770 -- picking a random, non-default port is what
// exercises bug (b) above (the hardcoded-default regression).
const API_PORT = 9000 + Math.floor(Math.random() * 1000);
const API_BASE = `http://127.0.0.1:${API_PORT}`;

const RC = 'R1 in mid 1k\nR2 mid out 1k\nC1 out 0 1p\n';

// findChrome() lives in lib/render.js, which -- at the time of writing this
// test -- is being actively edited by another agent working on the
// placement/routing engine. Import it dynamically and defensively: a
// transient missing/renamed export must make this test SKIP, not crash
// `bun test` for the whole repo.
let findChrome = () => null;
try {
  ({ findChrome } = await import('../lib/render.js'));
} catch { /* render.js mid-edit or otherwise broken -- treated as "no chrome" below */ }

let HAS_CHROME = false;
try { HAS_CHROME = typeof findChrome === 'function' && findChrome() != null; } catch { HAS_CHROME = false; }

let apiProc;

test.before(async () => {
  if (!HAS_CHROME) return; // nothing to set up if we're going to skip anyway

  // Same subprocess pattern as test/e2e.test.js (T5: spawn under whatever
  // runtime is running the test, this host has no `node` binary).
  apiProc = spawn(process.execPath, [path.join(HERE, '../server.js'), '--port', String(API_PORT)], { stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(API_BASE + '/health')).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.after(() => { if (apiProc) apiProc.kill('SIGTERM'); });

// Shared browser/page setup: capture the `ui` instance the plugin registers
// with, by wrapping Draw.loadPlugin before any app script runs. draw.io
// reassigns window.Draw.loadPlugin at least twice (a queueing stub, then an
// immediate-invoke bound function once the App/EditorUi instance exists --
// App.js ~line 161) -- re-wrap on every tick, guarded by a marker, so the
// later reassignment doesn't silently drop the wrapper.
async function openEditorAndCapture(page) {
  await page.evaluateOnNewDocument(() => {
    window.__capturedUi = null;
    const tryWrap = () => {
      if (window.Draw && window.Draw.loadPlugin && !window.Draw.loadPlugin.__captureWrap) {
        const orig = window.Draw.loadPlugin;
        const wrapped = function (cb) {
          return orig.call(this, function (ui) { window.__capturedUi = ui; return cb(ui); });
        };
        wrapped.__captureWrap = true;
        window.Draw.loadPlugin = wrapped;
      }
    };
    setInterval(tryWrap, 10);
  });
  // Note: no window.EDA_VALIDATE_SERVER override here -- see file header,
  // bug (b). The /editor route must supply the right origin on its own.
  await page.goto(API_BASE + '/editor/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => window.__capturedUi != null, { timeout: 15000 });
}

// TIMEOUT (2026-08-31): these two tests carry an EXPLICIT timeout because the
// runner's default is 5000 ms and neither test can finish inside it — each
// launches headless Chrome and loads the whole draw.io webapp through
// /editor, which measured ~8.7 s wall on this host with a 1.6 s api-server
// start on top. The `timeout: 30000` passed to page.goto() below is
// PUPPETEER's navigation timeout and does not raise the runner's.
//
// This is the "flaky plugin test" that was blamed on headless-Chrome bring-up
// for several sessions and re-diagnosed three times (an undefined
// `test.before`, a flooded stdio pipe, an un-awaited async hook — all three
// checked and refuted: node:test's hooks exist under bun, the server writes
// ~60 bytes, and an async before hook IS awaited). It was never a race in the
// browser: on a warm run the editor loaded in under 5 s and both tests passed,
// on a cold one the first test was killed at exactly 5000 ms — and killing it
// fires test.after(), which SIGTERMs the shared api-server, so the SECOND test
// then failed with ConnectionRefused on a port that had been alive moments
// earlier. That cascade is why the failure signature differed on every run.
test('eda-validate plugin via /editor: boots, registers UI, no page errors', { timeout: 120000 }, async () => {
  if (!HAS_CHROME) { console.log('  skipped: no chromium found (findChrome() returned null)'); return; }

  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const badResponses = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    // Anything the <base href="/editor/"> rewrite might break (a stencil,
    // stylesheet, or image resolving 404 or off-origin) shows up here.
    page.on('response', (res) => { if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`); });
    page.on('requestfailed', (req) => badResponses.push(`FAILED ${req.url()} ${req.failure()?.errorText || ''}`));

    await openEditorAndCapture(page);

    assert.deepEqual(pageErrors, [], 'plugin/page threw during load: ' + pageErrors.join('; '));
    assert.deepEqual(badResponses, [], '4xx/5xx or failed request while loading /editor/: ' + badResponses.join('; '));

    const result = await page.evaluate(() => {
      const ui = window.__capturedUi;
      const action = ui.actions.get('edaValidate');
      const toolbarBtn = Array.from(document.querySelectorAll('[title]'))
        .find((e) => e.getAttribute('title') === 'Check schematic (LVS/ERC)');
      return {
        hasAction: action != null,
        actionIsFunction: typeof action?.funct === 'function',
        hasToolbarButton: toolbarBtn != null,
        baseHref: document.baseURI,
      };
    });

    assert.equal(result.hasAction, true, 'plugin did not register the edaValidate action');
    assert.equal(result.actionIsFunction, true, 'edaValidate action has no funct()');
    assert.equal(result.hasToolbarButton, true, 'no toolbar button with title "Check schematic (LVS/ERC)"');
    assert.equal(result.baseHref, API_BASE + '/editor/', '<base href> did not resolve as expected');
  } finally {
    await browser.close();
  }
});

test('eda-validate plugin via /editor: check against a broken netlist paints overlays', { timeout: 120000 }, async () => {
  if (!HAS_CHROME) { console.log('  skipped: no chromium found (findChrome() returned null)'); return; }

  // Build a document with a floating pin via the SAME api-server instance
  // /editor is served from -- this is what proves bug (b) is fixed: if the
  // plugin were still talking to the wrong origin, this document (and its
  // findings) simply wouldn't exist there.
  const created = await (await fetch(`${API_BASE}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const id = created.id;
  await fetch(`${API_BASE}/documents/${id}/netlist/import?engine=v1&force=1`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: RC });
  const cells = await (await fetch(`${API_BASE}/documents/${id}/cells`)).json();
  const wireToBreak = cells.find((c) => c.kind === 'edge' && c.source === 'R2');
  assert.ok(wireToBreak, 'expected a wire out of R2 in the imported netlist');
  await fetch(`${API_BASE}/documents/${id}/cells/${wireToBreak.id}`, { method: 'DELETE' });
  const docXml = await (await fetch(`${API_BASE}/documents/${id}`)).text();

  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await openEditorAndCapture(page);

    await page.evaluate((xml) => {
      const ui = window.__capturedUi;
      const node = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
      ui.editor.setGraphXml(node.getElementsByTagName('mxGraphModel')[0]);
    }, docXml);

    await page.evaluate(() => { window.__capturedUi.actions.get('edaValidate').funct(); });

    await page.waitForFunction(() => {
      for (const el of document.querySelectorAll('div')) {
        if (el.textContent && el.textContent.indexOf('ERC:') === 0) return true;
      }
      return false;
    }, { timeout: 15000 });

    const overlayCount = await page.evaluate((sourceId) => {
      const ui = window.__capturedUi;
      const graph = ui.editor.graph;
      const cell = graph.model.getCell(sourceId);
      return cell ? (graph.getCellOverlays(cell) || []).length : -1;
    }, wireToBreak.source);

    assert.ok(overlayCount > 0, `expected a setCellWarning overlay on ${wireToBreak.source}, got count=${overlayCount}`);
  } finally {
    await browser.close();
  }
});
