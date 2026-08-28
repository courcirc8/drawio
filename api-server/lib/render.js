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

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium',
  '/snap/bin/chromium', '/usr/bin/google-chrome',
  ...cacheCandidates(),
].filter(Boolean);

let browserPromise = null;

function launch() {
  if (browserPromise == null) {
    const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
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
export async function exportDocument(doc, model, { format = 'png', scale = 2, border = 10, bg = '#ffffff', pageId, region, timeoutMs = 30000 } = {}) {
  const browser = await launch();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
    await page.goto(EXPORT_PAGE, { waitUntil: 'networkidle0', timeout: timeoutMs });
    const data = {
      xml: serialize(doc),
      format: format === 'svg' ? 'png' : format, // svg: rendered DOM is captured below
      scale, border, bg,
      w: 0, h: 0,
    };
    if (pageId != null) data.pageId = pageId;
    await page.evaluate((d) => { render(d); }, data);
    await page.waitForSelector('#LoadingComplete', { timeout: timeoutMs });
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

    let clip = {
      x: Math.max(0, Math.floor(bounds.x || 0)),
      y: Math.max(0, Math.floor(bounds.y || 0)),
      width: Math.ceil(bounds.width),
      height: Math.ceil(bounds.height),
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

    if (format === 'pdf') {
      const buffer = await page.pdf({
        printBackground: true,
        width: clip.width + 'px', height: clip.height + 'px',
        pageRanges: '1', margin: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      return { buffer: Buffer.from(buffer), contentType: 'application/pdf' };
    }
    const buffer = await page.screenshot({ type: 'png', clip });
    return { buffer: Buffer.from(buffer), contentType: 'image/png' };
  } finally {
    await page.close().catch(() => {});
  }
}
