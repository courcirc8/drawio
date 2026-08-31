/**
 * stencils.js — shape catalog parsed from the fork's electrical stencil
 * libraries (src/main/webapp/stencils/electrical/*.xml). Style keys follow
 * mxStencilRegistry.parseStencilSet (Graph.js): package name lowercased +
 * "." + shape name with spaces replaced by "_", lowercased.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STENCIL_DIR = path.resolve(HERE, '../../src/main/webapp/stencils/electrical');

/**
 * Synthetic (non-stencil) shapes.
 *
 * DEFECT (2026-08-28, api-hardening, round 2): the port glyph was first
 * added as a new <shape> in src/main/webapp/stencils/electrical/
 * signal_sources.xml. That broke the fork's one invariant: it is a SIDECAR
 * over upstream drawio — `git diff --stat <upstream> HEAD -- ':!api-server'`
 * must stay at the single .gitignore line, so it rebases cleanly onto any
 * upstream release. A new stencil in src/ conflicts on the next upstream
 * touch of that file; api-server/ is the only place this project may diverge.
 *
 * Fix: a synthetic shape needs NO stencil XML and NO registration at all —
 * it is a catalog entry carrying a literal, already-complete mxGraph style
 * string built from PLAIN built-in shapes (`ellipse;...` is a core mxGraph
 * shape, not a stencil; the same idiom already used for junction dots, see
 * the `JCT` constant in place2.js/place3.js). loadCatalog() merges these in
 * below, keyed the same way stencil records are, so every existing caller
 * (getShape, getPin, activePins, addVertex) needs NO special-casing — a
 * synthetic record looks exactly like a stencil-parsed one to them, just
 * with `.style` set (the literal render style) instead of only geometry.
 *
 * `SYNTHETIC_SHAPE_STYLE_KEY` is a style key mxGraph ignores (same trick as
 * `drawioApiJunction=1` on JCT) that carries the catalog key back out of a
 * cell's style on read-back — see components.js shapeKeyOf(). It survives a
 * human editing unrelated style properties (fillColor, a drag/resize) because
 * it is looked up by KEY in the parsed style map, not by matching the whole
 * style string.
 */
export const SYNTHETIC_SHAPE_STYLE_KEY = 'apiShape';

export const SYNTHETIC_SHAPES = {
  // Open (unfilled) circle — deliberately NOT a filled triangle, so it can
  // never be misread as `signal_ground` (see components.js PORT_SHAPES and
  // the defect writeup there). "ellipse" leading the style string is what
  // makes mxGraph render this as a plain ellipse with no stencil at all.
  port: {
    name: 'Port', w: 24, h: 24, aspect: 'fixed',
    // Four cardinal pins, not just 'N'. A port's wire must leave from the side
    // that FACES its anchor (place3 portExit) or the stub crosses back through
    // the glyph; with only 'N' declared, every other exit was an unnamed anchor
    // and erc.js flagged it as `anchor-off-pin` -- 5 errors on 915, 4 on 2446.
    pins: [{ name: 'N', x: 0.5, y: 0 }, { name: 'S', x: 0.5, y: 1 },
           { name: 'W', x: 0, y: 0.5 }, { name: 'E', x: 1, y: 0.5 }],
    // DEFECT (2026-08-28) — and note the ROOT CAUSE below is NOT the one a
    // first pass concluded. Symptom: in the shipped 915 render the port label
    // `rx_Bn` painted as `rx  Bn`, its underscore apparently missing, while the
    // identical string on an EDGE label rendered fine in the same diagram.
    //
    // The glyph was never missing. It is painted at every style tested; it
    // landed on EXACTLY the same two pixel rows as the port's own horizontal
    // connector stub, so it was swallowed by a wire.
    //
    // Proven, not argued: move the port up 6 diagram units (12 device px) so
    // the label clears the stub, render with the pre-fix style and with this
    // style, and the two row-ink profiles are IDENTICAL — underscore present
    // in both, 15/16 px wide, immediately below the wire band. Row arithmetic
    // on the unmoved shipped PNG then places the underscore at exactly the
    // wire's rows. The companion claim that `n_c6` was also losing its
    // underscore was simply false: it is measurable in the pre-fix PNG.
    //
    // `spacingTop=1` is therefore a MITIGATION, not a fix: it shifts the label
    // 2 px clear of the stub in this geometry. It will not save a layout where
    // the stub happens to land 2 px lower. The real defect is that a port label
    // is placed over its own connector wire with nothing checking for overlap;
    // fixing it properly belongs in the placer, not in a style string. Kept
    // because it is free — LVS/ERC unchanged, `score_raw` identical on both
    // bands (915 -33.5, 2446 -59.7), `label_overlap` still 0.
    //
    // Two hypotheses that were tested and are NOT the cause, kept so nobody
    // re-tests them: dropping `whiteSpace=wrap` (no effect), and an mxText
    // clip/box theory in which a style-key change forces redrawLabel to
    // recreate `state.text` (no clip exists — the glyph was always painted).
    // The SVG export does contain the underscore, which is consistent with
    // "always painted" and was mis-read as "PNG clips it".
    // `apiShape=port` is untouched — that is the key components.js
    // shapeKeyOf()/getShape() resolve on.
    style: `ellipse;whiteSpace=wrap;html=1;fillColor=none;strokeColor=default;` +
      `verticalLabelPosition=bottom;verticalAlign=top;spacingTop=1;${SYNTHETIC_SHAPE_STYLE_KEY}=port;`,
  },
};

let catalog = null; // key -> shape record

export function loadCatalog() {
  if (catalog != null) return catalog;
  catalog = new Map();
  const parser = new DOMParser();
  for (const file of fs.readdirSync(STENCIL_DIR).filter((f) => f.endsWith('.xml'))) {
    const doc = parser.parseFromString(fs.readFileSync(path.join(STENCIL_DIR, file), 'utf8'), 'text/xml');
    const root = doc.documentElement;
    const pkg = (root.getAttribute('name') || '').toLowerCase();
    for (const shape of Array.from(root.getElementsByTagName('shape'))) {
      const name = shape.getAttribute('name');
      if (name == null) continue;
      const key = pkg + '.' + name.replace(/ /g, '_').toLowerCase();
      const pins = [];
      for (const c of Array.from(shape.getElementsByTagName('constraint'))) {
        pins.push({ name: c.getAttribute('name'), x: parseFloat(c.getAttribute('x')), y: parseFloat(c.getAttribute('y')) });
      }
      catalog.set(key, {
        key, name, library: file.replace(/\.xml$/, ''),
        w: parseFloat(shape.getAttribute('w') || '80'),
        h: parseFloat(shape.getAttribute('h') || '80'),
        aspect: shape.getAttribute('aspect') || 'variable',
        pins,
      });
    }
  }
  // Merge synthetic shapes in AFTER the XML parse — same Map, same record
  // shape (key/name/library/w/h/aspect/pins) plus `.style` for addVertex.
  for (const [key, spec] of Object.entries(SYNTHETIC_SHAPES)) {
    catalog.set(key, { key, name: spec.name, library: 'synthetic',
      w: spec.w, h: spec.h, aspect: spec.aspect, pins: spec.pins, style: spec.style });
  }
  return catalog;
}

export function getShape(key) {
  return loadCatalog().get(key) || null;
}

/** Resolve a pin by name on a shape, tolerantly (case-insensitive). */
export function getPin(shapeKey, pinName) {
  const shape = getShape(shapeKey);
  if (shape == null) return null;
  return shape.pins.find((p) => p.name === pinName) ||
    shape.pins.find((p) => (p.name || '').toLowerCase() === String(pinName).toLowerCase()) || null;
}

export function searchShapes(q, limit = 25) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const shape of loadCatalog().values()) {
    const hay = (shape.name + ' ' + shape.library + ' ' + shape.key).toLowerCase();
    if (terms.every((t) => hay.includes(t))) {
      out.push(shape);
      if (out.length >= limit) break;
    }
  }
  return out;
}
