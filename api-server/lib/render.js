/**
 * render.js — headless export via the fork's own export page
 * (src/main/webapp/export3.html + js/export.js render(data)), the same page
 * draw.io's image export service drives. Completion is signalled by a
 * #LoadingComplete div carrying the pixel bounds (export.js ~line 1100).
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { allCells, cellInfo, serialize } from './model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_PAGE = 'file://' + path.resolve(HERE, '../../src/main/webapp/export3.html');
// Chrome discovery. The system paths below are only the common Linux packages;
// on a workstation where Chrome was installed by puppeteer or Playwright (which
// is the usual case on a machine with no root), the binary lives under a
// versioned cache directory instead and NONE of the system paths exist. Probing
// only the system paths made three separate agents conclude "no Chromium on this
// host" while a working Chrome for Testing 147 sat in ~/.cache/puppeteer -- and a
// missing render silently drops ~46 points of scoring weight (see tools/BEAUTY.md).
// So: glob the caches too, newest version first.
function cacheCandidates() {
  const home = process.env.HOME || '';
  const roots = [
    [path.join(home, '.cache/puppeteer/chrome'), 'chrome-linux64/chrome'],
    [path.join(home, '.cache/puppeteer/chrome-headless-shell'), 'chrome-headless-shell-linux64/chrome-headless-shell'],
    [path.join(home, '.cache/ms-playwright'), 'chrome-linux64/chrome'],
    [path.join(home, '.cache/ms-playwright'), 'chrome-linux/chrome'],
  ];
  const found = [];
  for (const [root, tail] of roots) {
    let versions = [];
    try { versions = fs.readdirSync(root).sort().reverse(); } catch { continue; }
    for (const v of versions) found.push(path.join(root, v, tail));
  }
  return found;
}

export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium',
  '/snap/bin/chromium', '/usr/bin/google-chrome',
  ...cacheCandidates(),
].filter(Boolean);

/** The Chrome this host would actually use, or null. Single source of truth --
 *  test/e2e.test.js used to carry its OWN hard-coded system-path list and so
 *  skipped the export test on a host where render.js finds Chrome perfectly. */
export function findChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

let browserPromise = null;

function launch() {
  if (browserPromise == null) {
    const executablePath = findChrome();
    if (executablePath == null) throw new Error('no Chromium/Chrome found; set CHROME_PATH');
    browserPromise = puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--allow-file-access-from-files', '--hide-scrollbars'],
    });
    browserPromise.then((b) => b.on('disconnected', () => { browserPromise = null; }));
  }
  return browserPromise;
}

export async function closeBrowser() {
  warmPage = null;
  if (browserPromise != null) {
    const b = await browserPromise;
    browserPromise = null;
    await b.close().catch(() => {});
  }
}

/** Diagram-space bounding-box origin of a page's content (for region mapping). */
function contentOrigin(model) {
  let minX = Infinity, minY = Infinity;
  for (const c of allCells(model).map(cellInfo)) {
    if (c.kind === 'vertex' && c.x != null) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); }
    if (c.kind === 'edge') for (const p of c.points || []) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
  }
  return (minX === Infinity) ? { x: 0, y: 0 } : { x: minX, y: minY };
}

/**
 * Export a document. format: png|pdf|svg. Returns {buffer, contentType}.
 * region: {x,y,w,h} in diagram coordinates (png only).
 */
// WARM PAGE (2026-09-18). Measured on this host: `page.goto(export3.html)`
// costs ~1000 ms (the whole drawio bundle loads) while `render(data)` +
// screenshot cost ~90 ms. The optimizer renders 4 finalists per circuit, so
// the page load alone was ~4 s of every ~7.5 s `?optimize=N`. One page is
// kept loaded and REUSED: `document.body.innerHTML = ''` between renders
// removes everything render() appended (graph container, #LoadingComplete
// marker); the PNG produced this way was verified byte-identical to a
// fresh-page render (same clip, same 61 744 bytes). Renders are serialised
// through `pageLock` (they already were in practice, and four concurrent
// pages measured 30x SLOWER on snap Chromium); any error discards the page
// so the next call starts clean. `RENDER_FRESH_PAGE=1` restores the old
// new-page-per-render behaviour for A/B checks.
let warmPage = null;
let pageLock = Promise.resolve();

async function acquirePage(timeoutMs) {
  const browser = await launch();
  if (process.env.RENDER_FRESH_PAGE === '1' || warmPage == null || warmPage.isClosed()) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
    await page.goto(EXPORT_PAGE, { waitUntil: 'networkidle0', timeout: timeoutMs });
    if (process.env.RENDER_FRESH_PAGE === '1') return { page, fresh: true };
    warmPage = page;
    return { page, fresh: false };
  }
  await warmPage.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  await warmPage.evaluate(() => { document.body.innerHTML = ''; });
  return { page: warmPage, fresh: false };
}

export async function exportDocument(doc, model, opts = {}) {
  // serialise: one render at a time on the shared page
  const run = pageLock.then(() => exportDocumentImpl(doc, model, opts));
  pageLock = run.catch(() => {});
  return run;
}

async function exportDocumentImpl(doc, model, { format = 'png', scale = 2, border = 10, bg = '#ffffff', pageId, region, timeoutMs = 30000 } = {}) {
  const { page, fresh } = await acquirePage(timeoutMs);
  let failed = false;
  try {
    const data = {
      xml: serialize(doc),
      format: format === 'svg' ? 'png' : format, // svg: rendered DOM is captured below
      scale, border, bg,
      w: 0, h: 0,
    };
    if (pageId != null) data.pageId = pageId;
    // MAPPING HOOK (2026-09-18): export.js positions the view with
    // graph.view.scaleAndTranslate(s, tx, ty) where tx/ty come from the
    // graph bounds INCLUDING labels (which contentOrigin() below ignores —
    // measured 6 x 20 diagram units off on ota-5t). Recording those arguments
    // gives the exact diagram->pixel transform px = (x + tx) * s - clip.x,
    // returned as `mapping` for label/box generators (tools/gen-yolo-dataset).
    await page.evaluate(() => {
      if (window.__drawioApiXf == null) {
        const orig = mxGraphView.prototype.scaleAndTranslate;
        mxGraphView.prototype.scaleAndTranslate = function (s, tx, ty) { window.__drawioApiXf = { s, tx, ty }; return orig.apply(this, arguments); };
        const origT = mxGraphView.prototype.setTranslate;
        mxGraphView.prototype.setTranslate = function (tx, ty) { window.__drawioApiXf = { s: this.scale, tx, ty }; return origT.apply(this, arguments); };
        window.__drawioApiXf = { s: 1, tx: 0, ty: 0 };
      } else window.__drawioApiXf = { s: 1, tx: 0, ty: 0 };
    });
    await page.evaluate((d) => { render(d); }, data);
    await page.waitForSelector('#LoadingComplete', { timeout: timeoutMs });
    const xf = await page.evaluate(() => window.__drawioApiXf);
    const bounds = JSON.parse(await page.$eval('#LoadingComplete', (el) => el.getAttribute('bounds')));

    if (format === 'svg') {
      const svg = await page.evaluate(() => {
        const s = document.body.getElementsByTagName('svg')[0];
        if (s == null) return null;
        s.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        s.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
        return s.outerHTML;
      });
      if (svg == null) throw new Error('no SVG produced');
      return { buffer: Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' + svg, 'utf8'), contentType: 'image/svg+xml' };
    }

    // BUG (2026-08-28): this used to clamp the clip origin with
    // `Math.max(0, floor(bounds.x))`. When export3.html reports a NEGATIVE
    // bounds origin the clamp silently ate the left/top border and everything
    // outside it -- a capacitor plate sheared off at y=0, a wire that appeared
    // to run off the page. Raising `border` did not help: it pushes bounds.x
    // further negative, so the clamp just ate more. Measured on
    // matching_2446 (engine=v3): a 94 px vertical wire segment sitting exactly
    // on column 0 of the PNG, at border=10 AND at border=40.
    // Ask the live DOM for the rendered SVG's box instead -- it is the actual
    // painted extent, borders included, and it cannot be negative.
    const domBox = await page.evaluate(() => {
      const s = document.body.getElementsByTagName('svg')[0];
      if (s == null) return null;
      const r = s.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    });
    const src = (domBox != null && domBox.width > 0 && domBox.height > 0) ? domBox : bounds;
    let clip = {
      x: Math.max(0, Math.floor(src.x || 0)),
      y: Math.max(0, Math.floor(src.y || 0)),
      width: Math.ceil(src.width),
      height: Math.ceil(src.height),
    };
    if (region != null) {
      // pixel = (diagram_pt - content_origin) * scale + border
      const o = contentOrigin(model);
      clip = {
        x: Math.max(0, Math.floor((region.x - o.x) * scale + border)),
        y: Math.max(0, Math.floor((region.y - o.y) * scale + border)),
        width: Math.ceil(region.w * scale),
        height: Math.ceil(region.h * scale),
      };
    }
    await page.setViewport({
      width: Math.max(clip.x + clip.width, 10),
      height: Math.max(clip.y + clip.height, 10),
      deviceScaleFactor: 1,
    });

    const mapping = { scale: xf.s, tx: xf.tx, ty: xf.ty, clipX: clip.x, clipY: clip.y, width: clip.width, height: clip.height };
    if (format === 'pdf') {
      const buffer = await page.pdf({
        printBackground: true,
        width: clip.width + 'px', height: clip.height + 'px',
        pageRanges: '1', margin: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      return { buffer: Buffer.from(buffer), contentType: 'application/pdf' };
    }
    const buffer = await page.screenshot({ type: 'png', clip });
    return { buffer: Buffer.from(buffer), contentType: 'image/png', mapping };
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (fresh || failed) {
      if (page === warmPage) warmPage = null;
      await page.close().catch(() => {});
    }
  }
}
