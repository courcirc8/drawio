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
