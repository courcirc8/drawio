/**
 * model.js — mxGraphModel XML primitives (no drawio runtime needed).
 *
 * A .drawio file is <mxfile><diagram>…</diagram></mxfile> where each diagram
 * holds an <mxGraphModel> either as a plain child element or as
 * base64(deflateRaw(encodeURIComponent(xml))) text. We normalize to
 * uncompressed on load and always save uncompressed (drawio reads both).
 */
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import zlib from 'node:zlib';

const parser = new DOMParser();
const serializer = new XMLSerializer();

export function parseXml(text) {
  return parser.parseFromString(text, 'text/xml');
}

export function serialize(node) {
  return serializer.serializeToString(node);
}

/** Decompress drawio diagram text content -> mxGraphModel XML string. */
export function inflateDiagram(b64) {
  const data = zlib.inflateRawSync(Buffer.from(b64.trim(), 'base64')).toString('utf8');
  return decodeURIComponent(data);
}

const EMPTY_MODEL =
  '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" ' +
  'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" ' +
  'pageHeight="1100" math="0" shadow="0"><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

/** Create a new empty document (mxfile DOM with one page). */
export function newDocument(pageName = 'Page-1') {
  return parseXml(
    `<mxfile host="drawio-api-server" modified="" agent="drawio-api-server" version="1">` +
    `<diagram id="page-1" name="${pageName}">${EMPTY_MODEL}</diagram></mxfile>`);
}

/**
 * Parse any accepted input (.drawio mxfile, bare mxGraphModel, compressed
 * diagrams) into a normalized mxfile DOM with uncompressed pages.
 */
export function parseDrawio(text) {
  const doc = parseXml(text);
  const root = doc.documentElement;
  if (root == null) throw new Error('invalid XML');
  if (root.nodeName === 'mxGraphModel') {
    const wrapped = newDocument();
    const dia = wrapped.getElementsByTagName('diagram')[0];
    while (dia.firstChild) dia.removeChild(dia.firstChild);
    dia.appendChild(wrapped.importNode(root, true));
    return wrapped;
  }
  if (root.nodeName !== 'mxfile') throw new Error('expected <mxfile> or <mxGraphModel> root, got <' + root.nodeName + '>');
  const diagrams = Array.from(root.getElementsByTagName('diagram'));
  if (diagrams.length === 0) throw new Error('mxfile has no <diagram>');
  for (const dia of diagrams) {
    let model = childElement(dia, 'mxGraphModel');
    if (model == null) {
      const txt = (dia.textContent || '').trim();
      if (txt === '') {
        dia.appendChild(doc.importNode(parseXml(EMPTY_MODEL).documentElement, true));
      } else {
        const xml = inflateDiagram(txt);
        while (dia.firstChild) dia.removeChild(dia.firstChild);
        dia.appendChild(doc.importNode(parseXml(xml).documentElement, true));
      }
    }
  }
  return doc;
}

function childElement(node, name) {
  for (let c = node.firstChild; c != null; c = c.nextSibling) {
    if (c.nodeType === 1 && c.nodeName === name) return c;
  }
  return null;
}

export function listPages(doc) {
  return Array.from(doc.getElementsByTagName('diagram')).map((d, i) => ({
    index: i, id: d.getAttribute('id'), name: d.getAttribute('name'),
  }));
}

/** Resolve a page by index, id or name (default: first page) -> mxGraphModel element. */
export function getPage(doc, page) {
  const diagrams = Array.from(doc.getElementsByTagName('diagram'));
  let dia = diagrams[0];
  if (page != null && page !== '') {
    dia = diagrams[parseInt(page, 10)] ??
      diagrams.find((d) => d.getAttribute('id') === String(page) || d.getAttribute('name') === String(page));
    if (dia == null) throw httpError(404, 'page not found: ' + page);
  }
  const model = childElement(dia, 'mxGraphModel');
  if (model == null) throw new Error('page has no mxGraphModel');
  return model;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------------------------------------------------------------- styles

/** Parse a drawio style string into {leading, map} (leading = bare first token like "ellipse"). */
export function parseStyle(style) {
  const map = new Map();
  let leading = null;
  for (const tok of String(style || '').split(';')) {
    if (tok === '') continue;
    const eq = tok.indexOf('=');
    if (eq < 0) {
      if (map.size === 0 && leading == null) leading = tok; else map.set(tok, null);
    } else {
      map.set(tok.slice(0, eq), tok.slice(eq + 1));
    }
  }
  return { leading, map };
}

export function formatStyle({ leading, map }) {
  const parts = [];
  if (leading != null) parts.push(leading);
  for (const [k, v] of map) parts.push(v == null ? k : k + '=' + v);
  return parts.join(';') + (parts.length ? ';' : '');
}

/** Merge {key: value|null} into a style string (null deletes the key). */
export function mergeStyle(style, patch) {
  const s = parseStyle(style);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null) s.map.delete(k); else s.map.set(k, String(v));
  }
  return formatStyle(s);
}

// ---------------------------------------------------------------- cells

function rootEl(model) {
  const r = childElement(model, 'root');
  if (r == null) throw new Error('mxGraphModel has no <root>');
  return r;
}

export function allCells(model) {
  return Array.from(rootEl(model).childNodes).filter((n) => n.nodeType === 1 && n.nodeName === 'mxCell');
}

export function getCell(model, id) {
  return allCells(model).find((c) => c.getAttribute('id') === String(id)) || null;
}

export function requireCell(model, id) {
  const c = getCell(model, id);
  if (c == null) throw httpError(404, 'cell not found: ' + id);
  return c;
}

function geomOf(cell) {
  for (let c = cell.firstChild; c != null; c = c.nextSibling) {
    if (c.nodeType === 1 && c.nodeName === 'mxGeometry') return c;
  }
  return null;
}

export function cellInfo(cell) {
  const g = geomOf(cell);
  const style = cell.getAttribute('style') || '';
  const s = parseStyle(style);
  const info = {
    id: cell.getAttribute('id'),
    kind: cell.getAttribute('edge') === '1' ? 'edge' : (cell.getAttribute('vertex') === '1' ? 'vertex' : 'other'),
    value: cell.getAttribute('value') || '',
    style: s,
    styleRaw: style,
  };
  if (info.kind === 'vertex' && g != null) {
    info.x = num(g.getAttribute('x'));
    info.y = num(g.getAttribute('y'));
    info.w = num(g.getAttribute('width'));
    info.h = num(g.getAttribute('height'));
    info.rotation = num(s.map.get('rotation')) || 0;
    info.flipH = s.map.get('flipH') === '1';
    info.flipV = s.map.get('flipV') === '1';
  }
  if (info.kind === 'edge') {
    info.source = cell.getAttribute('source');
    info.target = cell.getAttribute('target');
    const pts = [];
    if (g != null) {
      for (const arr of Array.from(g.childNodes)) {
        if (arr.nodeType === 1 && arr.nodeName === 'Array' && arr.getAttribute('as') === 'points') {
          for (const p of Array.from(arr.childNodes)) {
            if (p.nodeType === 1 && p.nodeName === 'mxPoint') pts.push({ x: num(p.getAttribute('x')), y: num(p.getAttribute('y')) });
          }
        }
      }
    }
    info.points = pts;
  }
  return info;
}

function num(v) { return v == null || v === '' ? null : parseFloat(v); }

let idCounter = 0;
export function freshId(model, prefix = 'c') {
  const used = new Set(allCells(model).map((c) => c.getAttribute('id')));
  let id;
  do { id = prefix + (++idCounter); } while (used.has(id));
  return id;
}

/** Add a vertex. shape may be a stencil key (mxgraph.…) or a full style string. */
export function addVertex(model, { id, shape, style, x = 0, y = 0, w = 80, h = 80, rotation, value = '' }) {
  if (id != null && getCell(model, id) != null) throw httpError(409, 'cell id already exists: ' + id);
  const doc = model.ownerDocument;
  const cell = doc.createElement('mxCell');
  cell.setAttribute('id', id != null ? String(id) : freshId(model, 'v'));
  cell.setAttribute('value', String(value));
  let st = style != null ? style : (shape != null && shape.startsWith('mxgraph.')
    ? `shape=${shape};html=1;verticalLabelPosition=bottom;verticalAlign=top;fillColor=none;strokeColor=default;`
    : (shape || 'rounded=0;whiteSpace=wrap;html=1;'));
  if (rotation != null && rotation !== 0) st = mergeStyle(st, { rotation });
  cell.setAttribute('style', st);
  cell.setAttribute('vertex', '1');
  cell.setAttribute('parent', '1');
  const g = doc.createElement('mxGeometry');
  g.setAttribute('x', String(x));
  g.setAttribute('y', String(y));
  g.setAttribute('width', String(w));
  g.setAttribute('height', String(h));
  g.setAttribute('as', 'geometry');
  cell.appendChild(g);
  rootEl(model).appendChild(cell);
  return cell;
}

/**
 * Add a wire (edge). sourcePin/targetPin are optional {x,y} fixed anchors in
 * relative shape coordinates (0..1) — from the stencil pin catalog.
 */
export function addWire(model, { id, source, target, sourcePin, targetPin, style, points }) {
  if (id != null && getCell(model, id) != null) throw httpError(409, 'cell id already exists: ' + id);
  if (source != null) requireCell(model, source);
  if (target != null) requireCell(model, target);
  const doc = model.ownerDocument;
  const cell = doc.createElement('mxCell');
  cell.setAttribute('id', id != null ? String(id) : freshId(model, 'w'));
  let st = style || 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;jettySize=auto;endArrow=none;endFill=0;';
  const anchors = {};
  if (sourcePin != null) { anchors.exitX = sourcePin.x; anchors.exitY = sourcePin.y; anchors.exitDx = 0; anchors.exitDy = 0; anchors.exitPerimeter = 0; }
  if (targetPin != null) { anchors.entryX = targetPin.x; anchors.entryY = targetPin.y; anchors.entryDx = 0; anchors.entryDy = 0; anchors.entryPerimeter = 0; }
  st = mergeStyle(st, anchors);
  cell.setAttribute('style', st);
  cell.setAttribute('edge', '1');
  cell.setAttribute('parent', '1');
  if (source != null) cell.setAttribute('source', String(source));
  if (target != null) cell.setAttribute('target', String(target));
  const g = doc.createElement('mxGeometry');
  g.setAttribute('relative', '1');
  g.setAttribute('as', 'geometry');
  cell.appendChild(g);
  if (points && points.length) setEdgePoints(cell, points);
  rootEl(model).appendChild(cell);
  return cell;
}

export function setEdgePoints(cell, points) {
  if (process.env.TRACE_DIAG === '1' && points && points.length &&
      /edgeStyle=none/.test(cell.getAttribute('style') || '')) {
    console.error('[TRACE_DIAG] points sur diagonale ' + cell.getAttribute('id') + ' :', JSON.stringify(points), new Error().stack.split('\n').slice(2, 5).join(' | '));
  }
  const doc = cell.ownerDocument;
  let g = geomOf(cell);
  if (g == null) {
    g = doc.createElement('mxGeometry');
    g.setAttribute('relative', '1');
    g.setAttribute('as', 'geometry');
    cell.appendChild(g);
  }
  for (const arr of Array.from(g.childNodes)) {
    if (arr.nodeType === 1 && arr.nodeName === 'Array' && arr.getAttribute('as') === 'points') g.removeChild(arr);
  }
  if (points && points.length) {
    const arr = doc.createElement('Array');
    arr.setAttribute('as', 'points');
    for (const p of points) {
      const pt = doc.createElement('mxPoint');
      pt.setAttribute('x', String(Math.round(p.x * 100) / 100));
      pt.setAttribute('y', String(Math.round(p.y * 100) / 100));
      arr.appendChild(pt);
    }
    g.appendChild(arr);
  }
}

/** Patch a cell: x/y/w/h absolute or dx/dy relative move, rotation, value, style merge, edge points. */
export function updateCell(model, id, patch) {
  const cell = requireCell(model, id);
  const g = geomOf(cell);
  if (g != null && cell.getAttribute('vertex') === '1') {
    const cur = (a) => parseFloat(g.getAttribute(a) || '0');
    if (patch.dx != null) g.setAttribute('x', String(cur('x') + patch.dx));
    if (patch.dy != null) g.setAttribute('y', String(cur('y') + patch.dy));
    if (patch.x != null) g.setAttribute('x', String(patch.x));
    if (patch.y != null) g.setAttribute('y', String(patch.y));
    if (patch.w != null) g.setAttribute('width', String(patch.w));
    if (patch.h != null) g.setAttribute('height', String(patch.h));
  }
  if (patch.rotation != null) {
    cell.setAttribute('style', mergeStyle(cell.getAttribute('style'),
      { rotation: patch.rotation === 0 ? null : patch.rotation }));
  }
  if (patch.value != null) cell.setAttribute('value', String(patch.value));
  if (patch.style != null) cell.setAttribute('style', mergeStyle(cell.getAttribute('style'), patch.style));
  if (patch.points != null) setEdgePoints(cell, patch.points);
  if (patch.source !== undefined && cell.getAttribute('edge') === '1') {
    if (patch.source == null) cell.removeAttribute('source'); else cell.setAttribute('source', String(patch.source));
  }
  if (patch.target !== undefined && cell.getAttribute('edge') === '1') {
    if (patch.target == null) cell.removeAttribute('target'); else cell.setAttribute('target', String(patch.target));
  }
  return cell;
}

/** Delete a cell; for vertices also deletes attached edges. Returns deleted ids. */
export function deleteCell(model, id) {
  const cell = requireCell(model, id);
  const deleted = [];
  if (cell.getAttribute('vertex') === '1') {
    for (const e of allCells(model)) {
      if (e.getAttribute('edge') === '1' &&
          (e.getAttribute('source') === String(id) || e.getAttribute('target') === String(id))) {
        e.parentNode.removeChild(e);
        deleted.push(e.getAttribute('id'));
      }
    }
  }
  cell.parentNode.removeChild(cell);
  deleted.push(String(id));
  return deleted;
}
