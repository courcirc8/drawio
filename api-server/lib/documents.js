/**
 * documents.js — in-memory document store with file persistence and named
 * checkpoints. Documents are held as normalized mxfile DOMs (see model.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDrawio, newDocument, serialize, httpError } from './model.js';

const docs = new Map(); // id -> {doc, path, checkpoints: Map<name, xml>}
let seq = 0;

export function createDocument({ xml, path: filePath, name } = {}) {
  const id = 'doc' + (++seq);
  let doc;
  let p = null;
  if (xml != null && xml !== '') {
    doc = parseDrawio(xml);
  } else if (filePath != null) {
    p = path.resolve(filePath);
    if (!fs.existsSync(p)) throw httpError(404, 'file not found: ' + p);
    doc = parseDrawio(fs.readFileSync(p, 'utf8'));
  } else {
    doc = newDocument(name || 'Page-1');
  }
  docs.set(id, { doc, path: p, checkpoints: new Map() });
  return { id, entry: docs.get(id) };
}

export function getDoc(id) {
  const entry = docs.get(id);
  if (entry == null) throw httpError(404, 'document not found: ' + id);
  return entry;
}

export function listDocuments() {
  return Array.from(docs.entries()).map(([id, e]) => ({
    id, path: e.path, checkpoints: Array.from(e.checkpoints.keys()),
  }));
}

export function deleteDocument(id) {
  if (!docs.delete(id)) throw httpError(404, 'document not found: ' + id);
}

export function saveDocument(id, filePath) {
  const entry = getDoc(id);
  const p = filePath != null ? path.resolve(filePath) : entry.path;
  if (p == null) throw httpError(400, 'no path: document was not loaded from a file, pass {"path": …}');
  fs.writeFileSync(p, serialize(entry.doc), 'utf8');
  entry.path = p;
  return p;
}

export function checkpoint(id, name) {
  const entry = getDoc(id);
  if (name == null || name === '') throw httpError(400, 'checkpoint name required');
  entry.checkpoints.set(String(name), serialize(entry.doc));
  return Array.from(entry.checkpoints.keys());
}

export function restore(id, name) {
  const entry = getDoc(id);
  const xml = entry.checkpoints.get(String(name));
  if (xml == null) throw httpError(404, 'checkpoint not found: ' + name);
  entry.doc = parseDrawio(xml);
  return entry;
}
