/**
 * bom.js — bill of materials extraction.
 */
import { allCells, cellInfo } from './model.js';
import { classify } from './components.js';

export function bom(model) {
  const rows = [];
  for (const c of allCells(model).map(cellInfo)) {
    if (c.kind !== 'vertex') continue;
    const cls = classify(c);
    if (cls.role !== 'component') continue;
    rows.push({ ref: c.id, type: cls.mapping ? cls.mapping.label : (cls.shape ? cls.shape.name : 'unknown'),
      value: c.value || '', shape: cls.shape ? cls.shape.key : null });
  }
  rows.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  return rows;
}

export function bomCsv(rows) {
  const esc = (s) => /[",\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s);
  return 'ref,type,value,shape\n' + rows.map((r) => [r.ref, r.type, r.value, r.shape].map(esc).join(',')).join('\n') + '\n';
}
