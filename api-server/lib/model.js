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
import { getShape } from './stencils.js';

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

// T4: a "cell" at the top level of <root> is either a bare <mxCell> or a
// <mxCell> wrapped in a drawio user-data <object refdes="…" spice_value="…"
// id="…"><mxCell .../></object> (the standard "Edit Data" representation —
// js/grapheditor/Dialogs.js EditDataDialog / mxCodec write user attributes on
// the OUTER <object>, id included, while style/vertex/edge/parent/geometry
// stay on the inner <mxCell>, which itself carries no id). Wrapping is opt-in
// per addVertex() call (via `refdes`/`data`) so every existing bare-mxCell
// document and all pre-T4 callers keep working unchanged. mxCellOf()/geomOf()
// below are the single place that resolves "the real mxCell" so the rest of
// this module (and cellInfo callers) don't have to care which shape a given
// top-level node has.
function mxCellOf(node) {
  if (node.nodeName === 'mxCell') return node;
  for (let c = node.firstChild; c != null; c = c.nextSibling) {
    if (c.nodeType === 1 && c.nodeName === 'mxCell') return c;
  }
  return null;
}

export function allCells(model) {
  return Array.from(rootEl(model).childNodes)
    .filter((n) => n.nodeType === 1 && (n.nodeName === 'mxCell' || n.nodeName === 'object'));
}

export function getCell(model, id) {
  return allCells(model).find((c) => c.getAttribute('id') === String(id)) || null;
}

export function requireCell(model, id) {
  const c = getCell(model, id);
  if (c == null) throw httpError(404, 'cell not found: ' + id);
  return c;
}

/** The <mxCell> that carries style/vertex/edge/geometry for a top-level cell node (itself if bare). */
export function mxCellPart(node) {
  return mxCellOf(node);
}

/** style string of a cell node, resolving the object-wrapper indirection. */
export function styleOf(node) {
  const mx = mxCellOf(node);
  return (mx && mx.getAttribute('style')) || '';
}

function geomOf(node) {
  const cell = mxCellOf(node);
  if (cell == null) return null;
  for (let c = cell.firstChild; c != null; c = c.nextSibling) {
    if (c.nodeType === 1 && c.nodeName === 'mxGeometry') return c;
  }
  return null;
}

export function cellInfo(node) {
  const isObj = node.nodeName === 'object';
  const cell = mxCellOf(node);
  const g = geomOf(node);
  const style = (cell && cell.getAttribute('style')) || '';
  const s = parseStyle(style);
  const attrs = {};
  if (isObj) {
    for (const a of Array.from(node.attributes)) {
      if (a.name === 'id' || a.name === 'label') continue;
      attrs[a.name] = a.value;
    }
  }
  const info = {
    id: node.getAttribute('id'),
    kind: cell.getAttribute('edge') === '1' ? 'edge' : (cell.getAttribute('vertex') === '1' ? 'vertex' : 'other'),
    value: isObj ? (node.getAttribute('label') || '') : (cell.getAttribute('value') || ''),
    style: s,
    styleRaw: style,
    // refdes/attrs are null for a plain (non-wrapped) cell — see components.js
    // identityOf() for the "prefer refdes, fall back to id" rule this enables.
    refdes: isObj && attrs.refdes != null && attrs.refdes !== '' ? attrs.refdes : null,
    attrs: isObj ? attrs : null,
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

/**
 * Add a vertex. shape may be a stencil key (mxgraph.…) or a full style string.
 *
 * T4: `refdes` / `data` opt a component cell into the drawio "Edit Data"
 * <object> wrapper (id + refdes + spice_value + any other `data` attrs on the
 * OUTER node, style/vertex/geometry on the inner <mxCell>) so identity
 * survives a GUI rename of the id-bearing cell, and — the more dangerous case
 * — a copy/paste, which reassigns mxCell ids but carries the <object>'s
 * custom attributes along unchanged. Omitting both keeps producing a bare
 * <mxCell> exactly as before T4, so every pre-existing document/call site is
 * unaffected.
 */
export function addVertex(model, { id, shape, style, x = 0, y = 0, w = 80, h = 80, rotation, value = '', refdes, data }) {
  if (id != null && getCell(model, id) != null) throw httpError(409, 'cell id already exists: ' + id);
  const doc = model.ownerDocument;
  const cellId = id != null ? String(id) : freshId(model, 'v');
  const cell = doc.createElement('mxCell');
  // DEFECT (2026-08-28, api-hardening, round 2): a `shape` that is neither a
  // `mxgraph.*` stencil key nor already a literal style string can now ALSO
  // be a SYNTHETIC catalog key (lib/stencils.js SYNTHETIC_SHAPES — e.g.
  // 'port') — a plain built-in mxGraph shape with no stencil registration,
  // added so the fork's sidecar invariant (nothing outside api-server/
  // diverges from upstream drawio) doesn't get violated by a new stencil XML
  // file just to draw a port marker. getShape() resolves stencil AND
  // synthetic keys identically; only synthetic records carry `.style`.
  const synthetic = (style == null && shape != null && !shape.startsWith('mxgraph.')) ? getShape(shape) : null;
  let st = style != null ? style : (shape != null && shape.startsWith('mxgraph.')
    ? `shape=${shape};html=1;verticalLabelPosition=bottom;verticalAlign=top;fillColor=none;strokeColor=default;`
    : (synthetic != null && synthetic.style != null ? synthetic.style : (shape || 'rounded=0;whiteSpace=wrap;html=1;')));
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

  const extra = { ...(data || {}) };
  if (refdes != null) extra.refdes = String(refdes);
  let top;
  if (Object.keys(extra).length > 0) {
    const obj = doc.createElement('object');
    obj.setAttribute('id', cellId);
    obj.setAttribute('label', String(value));
    for (const [k, v] of Object.entries(extra)) obj.setAttribute(k, String(v));
    obj.appendChild(cell);
    top = obj;
  } else {
    cell.setAttribute('id', cellId);
    cell.setAttribute('value', String(value));
    top = cell;
  }
  rootEl(model).appendChild(top);
  return top;
}

/**
 * Add a wire (edge). sourcePin/targetPin are optional {x,y,name} fixed
 * anchors in relative shape coordinates (0..1) — from the stencil pin
 * catalog. When a `name` is given (the stencil's <constraint name="…">), it
 * is ALSO persisted as exitName/entryName.
 *
 * Why: mxGraph itself only ever saves exitX/exitY/exitDx/exitDy/exitPerimeter
 * in the edge style (mxgraph/src/view/mxGraph.js:7153-7185) — the constraint
 * NAME is never written by the stock editor, and getConnectionConstraint()
 * (:7104-7136) always comes back with name=null. So today's read path
 * (netlist.js endpointKey) has to recover gate-vs-drain identity by nearest-
 * coordinate match, which is exactly the positional pin mapping AGENTS.md
 * domain correction #1 warns against for DSPF/schematic ports — a human
 * re-dragging an endpoint by a few px can silently reassign it to the wrong
 * pin. exitName/entryName are unknown keys to mxGraph, but mxGraph style
 * strings are opaque `key=value;` lists and unknown keys survive a GUI edit
 * and a save (js/grapheditor/Dialogs.js "Edit Data" pattern relies on the
 * same property). netlist.js prefers the name when present and still
 * cross-checks it against the live coordinates (see anchor-name-stale).
 */
export function addWire(model, { id, source, target, sourcePin, targetPin, style, points, value }) {
  if (id != null && getCell(model, id) != null) throw httpError(409, 'cell id already exists: ' + id);
  if (source != null) requireCell(model, source);
  if (target != null) requireCell(model, target);
  const doc = model.ownerDocument;
  const cell = doc.createElement('mxCell');
  cell.setAttribute('id', id != null ? String(id) : freshId(model, 'w'));
  let st = style || 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;jettySize=auto;endArrow=none;endFill=0;';
  const anchors = {};
  if (sourcePin != null) {
    anchors.exitX = sourcePin.x; anchors.exitY = sourcePin.y; anchors.exitDx = 0; anchors.exitDy = 0; anchors.exitPerimeter = 0;
    if (sourcePin.name != null) anchors.exitName = sourcePin.name;
  }
  if (targetPin != null) {
    anchors.entryX = targetPin.x; anchors.entryY = targetPin.y; anchors.entryDx = 0; anchors.entryDy = 0; anchors.entryPerimeter = 0;
    if (targetPin.name != null) anchors.entryName = targetPin.name;
  }
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
  // A wire label NAMES its net: netlist.js's connectivity() reads it back
  // (labelOf, netlist.js ~:182) in preference to the anonymous n1/n2/... it
  // would otherwise mint. Without it a round-trip loses every internal node
  // name (`Up`, `n_pi1_out`, `ANT` -> n1, n2, n3), which passes LVS
  // structurally while making the drawing impossible to discuss.
  if (value != null && String(value) !== '') cell.setAttribute('value', String(value));
  rootEl(model).appendChild(cell);
  return cell;
}

/**
 * Translate every vertex and every edge waypoint on a page so the content's
 * top-left sits at (margin, margin).
 *
 * BUG (2026-08-28): place3 legitimately produces NEGATIVE coordinates (a
 * secondary chain row placed above the axis, a shunt hanging up-left) --
 * measured min x = -166, min y = -52 on matching_2446. The headless export
 * clips with `Math.max(0, floor(bounds.x))` (render.js), so everything left of
 * or above the origin was SILENTLY CUT OFF the PNG: a capacitor plate sheared
 * at y=0, and a wire that appeared to run off the page instead of reaching its
 * node. Raising the export `border` does not help -- it pads the clip, it does
 * not move the content. Normalising the model is the fix, and it also makes the
 * document open sanely in the editor instead of scrolled off-canvas.
 *
 * Call AFTER routing: edge waypoints are absolute and must be translated too.
 */
export function normalizeOrigin(model, margin = 40) {
  let minX = Infinity, minY = Infinity;
  const cells = allCells(model);
  for (const el of cells) {
    const c = mxCellOf(el);
    const g = geomOf(el);
    if (g == null) continue;
    if (c.getAttribute('vertex') === '1') {
      minX = Math.min(minX, parseFloat(g.getAttribute('x') || '0'));
      minY = Math.min(minY, parseFloat(g.getAttribute('y') || '0'));
    }
    for (const pt of Array.from(g.getElementsByTagName('mxPoint'))) {
      if (pt.getAttribute('as') != null) continue; // sourcePoint/targetPoint: relative
      minX = Math.min(minX, parseFloat(pt.getAttribute('x') || '0'));
      minY = Math.min(minY, parseFloat(pt.getAttribute('y') || '0'));
    }
  }
  if (!isFinite(minX) || !isFinite(minY)) return { dx: 0, dy: 0 };
  const dx = margin - minX, dy = margin - minY;
  if (dx === 0 && dy === 0) return { dx: 0, dy: 0 };
  for (const el of cells) {
    const c = mxCellOf(el);
    const g = geomOf(el);
    if (g == null) continue;
    if (c.getAttribute('vertex') === '1') {
      g.setAttribute('x', String(parseFloat(g.getAttribute('x') || '0') + dx));
      g.setAttribute('y', String(parseFloat(g.getAttribute('y') || '0') + dy));
    }
    for (const pt of Array.from(g.getElementsByTagName('mxPoint'))) {
      if (pt.getAttribute('as') != null) continue;
      pt.setAttribute('x', String(parseFloat(pt.getAttribute('x') || '0') + dx));
      pt.setAttribute('y', String(parseFloat(pt.getAttribute('y') || '0') + dy));
    }
  }
  return { dx, dy };
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
    mxCellOf(cell).appendChild(g); // NOT cell.appendChild: cell may be an <object> wrapper
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
  const node = requireCell(model, id);
  const mx = mxCellOf(node);
  const g = geomOf(node);
  if (g != null && mx.getAttribute('vertex') === '1') {
    const cur = (a) => parseFloat(g.getAttribute(a) || '0');
    if (patch.dx != null) g.setAttribute('x', String(cur('x') + patch.dx));
    if (patch.dy != null) g.setAttribute('y', String(cur('y') + patch.dy));
    if (patch.x != null) g.setAttribute('x', String(patch.x));
    if (patch.y != null) g.setAttribute('y', String(patch.y));
    if (patch.w != null) g.setAttribute('width', String(patch.w));
    if (patch.h != null) g.setAttribute('height', String(patch.h));
  }
  if (patch.rotation != null) {
    mx.setAttribute('style', mergeStyle(mx.getAttribute('style'),
      { rotation: patch.rotation === 0 ? null : patch.rotation }));
  }
  // value lives on the outer <object> (as `label`) for a T4-wrapped cell,
  // on the <mxCell> itself otherwise.
  if (patch.value != null) {
    if (node.nodeName === 'object') node.setAttribute('label', String(patch.value));
    else mx.setAttribute('value', String(patch.value));
  }
  if (patch.style != null) mx.setAttribute('style', mergeStyle(mx.getAttribute('style'), patch.style));
  if (patch.points != null) setEdgePoints(node, patch.points);
  if (patch.source !== undefined && mx.getAttribute('edge') === '1') {
    if (patch.source == null) mx.removeAttribute('source'); else mx.setAttribute('source', String(patch.source));
  }
  if (patch.target !== undefined && mx.getAttribute('edge') === '1') {
    if (patch.target == null) mx.removeAttribute('target'); else mx.setAttribute('target', String(patch.target));
  }
  return node;
}

/** Delete a cell; for vertices also deletes attached edges. Returns deleted ids. */
export function deleteCell(model, id) {
  const node = requireCell(model, id);
  const mx = mxCellOf(node);
  const deleted = [];
  if (mx.getAttribute('vertex') === '1') {
    for (const e of allCells(model)) {
      const em = mxCellOf(e);
      if (em.getAttribute('edge') === '1' &&
          (em.getAttribute('source') === String(id) || em.getAttribute('target') === String(id))) {
        e.parentNode.removeChild(e);
        deleted.push(e.getAttribute('id'));
      }
    }
  }
  node.parentNode.removeChild(node);
  deleted.push(String(id));
  return deleted;
}
